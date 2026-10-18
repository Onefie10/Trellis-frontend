import {
  canPause,
  canResume,
  InMemoryPauseAuditLog,
  MemoryPauseStore,
  OperationPausedError,
  PauseManager,
} from '@/lib/protocol/emergency-pause';
import type { ProtocolActor } from '@/lib/protocol/operations';

const admin: ProtocolActor = { id: 'admin-1', role: 'admin' };
const maintainer: ProtocolActor = { id: 'maint-1', role: 'maintainer' };
const contributor: ProtocolActor = { id: 'contrib-1', role: 'contributor' };

function makeManager(): PauseManager {
  return new PauseManager({
    store: new MemoryPauseStore(),
    auditLog: new InMemoryPauseAuditLog(),
    now: () => 1_000_000,
    generateId: (() => {
      let n = 0;
      return () => `id-${(n += 1)}`;
    })(),
  });
}

describe('emergency pause (#177)', () => {
  describe('pause creation and permissions', () => {
    it('maintainers and admins may pause', () => {
      expect(canPause(admin)).toBe(true);
      expect(canPause(maintainer)).toBe(true);
      expect(canPause(contributor)).toBe(false);
    });

    it('only admins may resume', () => {
      expect(canResume(admin)).toBe(true);
      expect(canResume(maintainer)).toBe(false);
      expect(canResume(contributor)).toBe(false);
    });

    it('pauses an operation scope with actor and reason', () => {
      const manager = makeManager();
      const record = manager.pause({
        scope: { operation: 'transfer_funds', environment: 'production' },
        reason: 'suspected exploit',
        actor: maintainer,
      });
      expect(record.operation).toBe('transfer_funds');
      expect(record.environment).toBe('production');
      expect(record.reason).toBe('suspected exploit');
      expect(record.pausedBy).toEqual(maintainer);
      expect(record.pausedAt).toBe(1_000_000);
      expect(manager.activePauses()).toHaveLength(1);
    });

    it('rejects an empty reason', () => {
      const manager = makeManager();
      expect(() =>
        manager.pause({
          scope: { operation: 'claim_payout', environment: 'production' },
          reason: '   ',
          actor: admin,
        }),
      ).toThrow(/reason/i);
    });

    it('is idempotent for an identical active pause', () => {
      const manager = makeManager();
      const scope = { operation: 'claim_payout' as const, environment: 'production' as const };
      manager.pause({ scope, reason: 'first', actor: admin });
      const again = manager.pause({ scope, reason: 'second', actor: admin });
      expect(again.reason).toBe('first');
      expect(manager.activePauses()).toHaveLength(1);
    });

    it('refuses pause creation for unauthorized actors', () => {
      const manager = makeManager();
      expect(() =>
        manager.pause({
          scope: { operation: 'mint_agent', environment: 'production' },
          reason: 'not allowed',
          actor: contributor,
        }),
      ).toThrow(/maintainers and admins/i);
    });
  });

  describe('scoped enforcement', () => {
    it('blocks the paused operation with a user-safe error', () => {
      const manager = makeManager();
      manager.pause({
        scope: { operation: 'transfer_funds', environment: 'production' },
        reason: 'incident-1234',
        actor: admin,
      });
      expect(() =>
        manager.assertOperationAllowed({
          operation: 'transfer_funds',
          environment: 'production',
        }),
      ).toThrow(OperationPausedError);

      try {
        manager.assertOperationAllowed({
          operation: 'transfer_funds',
          environment: 'production',
        });
      } catch (error) {
        const err = error as OperationPausedError;
        expect(err.code).toBe('OPERATION_PAUSED');
        expect(err.rejection.message).toMatch(/temporarily unavailable/i);
        // User-safe: never leaks the internal reason or the pausing actor.
        expect(err.rejection.message).not.toContain('incident-1234');
        expect(err.rejection.message).not.toContain(maintainer.id);
      }
    });

    it('keeps unrelated operations working outside the pause scope', () => {
      const manager = makeManager();
      manager.pause({
        scope: { operation: 'transfer_funds', environment: 'production' },
        reason: 'incident',
        actor: admin,
      });
      // Different operation, same environment.
      expect(() =>
        manager.assertOperationAllowed({
          operation: 'claim_payout',
          environment: 'production',
        }),
      ).not.toThrow();
      // Same operation, different environment.
      expect(() =>
        manager.assertOperationAllowed({
          operation: 'transfer_funds',
          environment: 'staging',
        }),
      ).not.toThrow();
    });

    it('honours subject-scoped pauses', () => {
      const manager = makeManager();
      manager.pause({
        scope: {
          operation: 'transfer_funds',
          environment: 'production',
          subjectId: 'wallet-hot',
        },
        reason: 'compromised key',
        actor: admin,
      });
      expect(() =>
        manager.assertOperationAllowed({
          operation: 'transfer_funds',
          environment: 'production',
          subjectId: 'wallet-hot',
        }),
      ).toThrow(OperationPausedError);
      expect(() =>
        manager.assertOperationAllowed({
          operation: 'transfer_funds',
          environment: 'production',
          subjectId: 'wallet-fine',
        }),
      ).not.toThrow();
    });

    it('blocks every subject for a subject-less pause', () => {
      const manager = makeManager();
      manager.pause({
        scope: { operation: 'mint_agent', environment: 'staging' },
        reason: 'contract upgrade in flight',
        actor: admin,
      });
      expect(() =>
        manager.assertOperationAllowed({
          operation: 'mint_agent',
          environment: 'staging',
          subjectId: 'any-wallet',
        }),
      ).toThrow(OperationPausedError);
    });
  });

  describe('audited resume', () => {
    it('resumes with actor and reason, and the scope works again', () => {
      const manager = makeManager();
      const scope = { operation: 'claim_payout' as const, environment: 'production' as const };
      manager.pause({ scope, reason: 'incident', actor: maintainer });

      const result = manager.resume({ scope, reason: 'resolved', actor: admin });
      expect(result.resumed).toBe(true);
      expect(result.record?.resumedBy).toEqual(admin);
      expect(result.record?.resumeReason).toBe('resolved');
      expect(manager.activePauses()).toHaveLength(0);
      expect(() =>
        manager.assertOperationAllowed({ operation: 'claim_payout', environment: 'production' }),
      ).not.toThrow();
    });

    it('refuses and audits an unauthorized resume attempt', () => {
      const manager = makeManager();
      const scope = { operation: 'transfer_funds' as const, environment: 'production' as const };
      manager.pause({ scope, reason: 'incident', actor: admin });

      const result = manager.resume({ scope, reason: 'let me through', actor: maintainer });
      expect(result.resumed).toBe(false);

      const audit = manager.audit();
      const denied = audit.find((entry) => entry.action === 'resume_denied');
      expect(denied).toBeDefined();
      expect(denied?.actor).toEqual(maintainer);
      expect(denied?.reason).toBe('let me through');
      // The pause is still in effect.
      expect(manager.activePauses()).toHaveLength(1);
      expect(() =>
        manager.assertOperationAllowed({ operation: 'transfer_funds', environment: 'production' }),
      ).toThrow(OperationPausedError);
    });

    it('records pause, resume and denied entries in one auditable trail', () => {
      const manager = makeManager();
      const scope = { operation: 'update_governance' as const, environment: 'staging' as const };
      manager.pause({ scope, reason: 'upgrade', actor: maintainer });
      manager.resume({ scope, reason: 'nope', actor: contributor }); // denied
      manager.resume({ scope, reason: 'done', actor: admin }); // ok

      const trail = manager.audit().map((entry) => entry.action);
      expect(trail).toEqual(['pause', 'resume_denied', 'resume']);
      const entries = manager.audit();
      expect(entries[0].actor).toEqual(maintainer);
      expect(entries[1].actor).toEqual(contributor);
      expect(entries[2].actor).toEqual(admin);
      expect(entries[2].reason).toBe('done');
    });

    it('returns resumed:false when resuming a scope that was never paused', () => {
      const manager = makeManager();
      const result = manager.resume({
        scope: { operation: 'retry_operation', environment: 'development' },
        reason: 'nothing paused',
        actor: admin,
      });
      expect(result.resumed).toBe(false);
      expect(result.record).toBeNull();
    });
  });
});
