import {
  DEFAULT_PROTOCOL_CONFIG_REGISTRY,
  type ProtocolConfigRegistry,
} from '@/lib/protocol/config-versioning';
import {
  InMemoryPauseAuditLog,
  MemoryPauseStore,
  PauseManager,
} from '@/lib/protocol/emergency-pause';
import {
  accountSequenceFreshnessRule,
  ALWAYS_RULES,
  isSubmittable,
  OPERATION_RULES,
  OPERATION_RULES as RULES,
  runPreflight,
  type PreflightRequest,
} from '@/lib/protocol/preflight';
import type { ProtocolActor } from '@/lib/protocol/operations';

const baseRequest: PreflightRequest = {
  operation: 'transfer_funds',
  environment: 'production',
  actorId: 'wallet-1',
  payload: { amount: '50', destination: 'GABC...' },
  state: {
    configVersions: {
      commission_tiers: '2.0.0',
      claim_link_rules: '1.2.0',
      governance_thresholds: '1.0.0',
    },
    balances: { XLM: '100' },
  },
};

function makePauseManager(): PauseManager {
  return new PauseManager({
    store: new MemoryPauseStore(),
    auditLog: new InMemoryPauseAuditLog(),
    now: () => 1_000,
    generateId: (() => {
      let n = 0;
      return () => `id-${(n += 1)}`;
    })(),
  });
}

describe('preflight (#175)', () => {
  describe('determinism', () => {
    it('produces identical results for identical requests', () => {
      const a = runPreflight(baseRequest, { now: () => 5 });
      const b = runPreflight(baseRequest, { now: () => 5 });
      expect(a).toEqual(b);
      expect(a.requestId).toBe(b.requestId);
    });

    it('keeps the same request id regardless of evaluation order or time', () => {
      const a = runPreflight(baseRequest, { now: () => 1 });
      const b = runPreflight(baseRequest, { now: () => 999_999 });
      expect(a.requestId).toBe(b.requestId);
    });
  });

  describe('successful preflight', () => {
    it('passes a well-formed operation with no warnings', () => {
      const result = runPreflight(baseRequest, { now: () => 5 });
      expect(result.status).toBe('success');
      expect(result.blockers).toEqual([]);
      expect(result.warnings).toEqual([]);
      expect(isSubmittable(result)).toBe(true);
    });
  });

  describe('warning preflight', () => {
    it('surfaces user-safe message and remediation for a payout without allowance', () => {
      const result = runPreflight(
        {
          ...baseRequest,
          operation: 'claim_payout',
          state: { ...baseRequest.state, allowanceOk: false },
        },
        { now: () => 5 },
      );
      expect(result.status).toBe('warning');
      expect(result.warnings[0].code).toBe('ALLOWANCE_REQUIRED');
      expect(result.warnings[0].message).toMatch(/not yet approved/i);
      expect(result.warnings[0].remediation).toMatch(/approve/i);
      // Warnings do not block submission — that is the deliberate policy.
      expect(isSubmittable(result)).toBe(true);
    });

    it('warns on an outlier mint fee', () => {
      const result = runPreflight(
        {
          ...baseRequest,
          operation: 'mint_agent',
          state: { ...baseRequest.state, estimatedFeeStroops: '200000000' },
        },
        { now: () => 5 },
      );
      expect(result.status).toBe('warning');
      expect(result.warnings[0].code).toBe('FEE_OUTLIER');
    });
  });

  describe('blocked preflight', () => {
    it('blocks an over-balanced transfer before submission', () => {
      const result = runPreflight(
        {
          ...baseRequest,
          payload: { ...baseRequest.payload, amount: '1000' },
        },
        { now: () => 5 },
      );
      expect(result.status).toBe('blocked');
      expect(result.blockers[0].code).toBe('INSUFFICIENT_BALANCE');
      expect(result.blockers[0].message).toMatch(/exceeds your available/i);
      expect(isSubmittable(result)).toBe(false);
    });

    it('blocks stale-state requests (sequence moved since composition)', () => {
      const result = runPreflight(
        {
          ...baseRequest,
          state: {
            ...baseRequest.state,
            sequenceAtComposition: '100',
            currentSequence: '101',
          },
        },
        { now: () => 5 },
      );
      expect(result.status).toBe('blocked');
      const stale = result.blockers.find((b) => b.code === 'STALE_STATE');
      expect(stale).toBeDefined();
      expect(stale?.remediation).toMatch(/reload/i);
    });
  });

  describe('pause integration (#177)', () => {
    it('blocks a paused operation even when every other rule passes', () => {
      const pauses = makePauseManager();
      pauses.pause({
        scope: { operation: 'transfer_funds', environment: 'production' },
        reason: 'incident',
        actor: { id: 'admin-1', role: 'admin' },
      });
      const result = runPreflight(baseRequest, { pauseManager: pauses, now: () => 5 });
      expect(result.status).toBe('blocked');
      expect(result.blockers[0].code).toBe('OPERATION_PAUSED');
      expect(result.blockers[0].message).toMatch(/temporarily unavailable/i);
    });

    it('does not affect operations outside the pause scope', () => {
      const pauses = makePauseManager();
      pauses.pause({
        scope: { operation: 'transfer_funds', environment: 'staging' },
        reason: 'incident',
        actor: { id: 'admin-1', role: 'admin' },
      });
      const result = runPreflight(baseRequest, { pauseManager: pauses, now: () => 5 });
      expect(result.status).toBe('success');
    });
  });

  describe('config compatibility integration (#178)', () => {
    it('blocks operations built against incompatible config versions', () => {
      const result = runPreflight(
        {
          ...baseRequest,
          operation: 'claim_payout',
          state: {
            ...baseRequest.state,
            configVersions: { commission_tiers: '1.0.0' },
          },
        },
        { configRegistry: DEFAULT_PROTOCOL_CONFIG_REGISTRY, now: () => 5 },
      );
      expect(result.status).toBe('blocked');
      expect(result.blockers[0].code).toBe('CONFIG_INCOMPATIBLE');
      expect(result.blockers[0].message).toMatch(/too old/i);
    });

    it('warns (but does not block) on deprecated-but-compatible config', () => {
      const result = runPreflight(
        {
          ...baseRequest,
          operation: 'claim_payout',
          state: {
            ...baseRequest.state,
            configVersions: { commission_tiers: '1.1.0' },
          },
        },
        { configRegistry: DEFAULT_PROTOCOL_CONFIG_REGISTRY, now: () => 5 },
      );
      expect(result.status).toBe('warning');
      expect(result.configWarnings).toHaveLength(1);
      expect(result.configWarnings[0].code).toBe('CONFIG_DEPRECATED');
    });

    it('warns for a future-unknown config version handled by the compat layer', () => {
      const result = runPreflight(
        {
          ...baseRequest,
          operation: 'claim_payout',
          state: {
            ...baseRequest.state,
            configVersions: { commission_tiers: '9.0.0' },
          },
        },
        { configRegistry: DEFAULT_PROTOCOL_CONFIG_REGISTRY, now: () => 5 },
      );
      expect(result.status).toBe('blocked');
      expect(result.blockers[0].code).toBe('CONFIG_INCOMPATIBLE');
    });
  });

  describe('rule declaration', () => {
    it('always runs the pause, config and freshness gates first', () => {
      expect(ALWAYS_RULES.map((rule) => rule.name)).toEqual([
        'pauseGateRule',
        'configCompatibilityRule',
        'accountSequenceFreshnessRule',
      ]);
    });

    it('declares rules for every protocol operation', () => {
      for (const rules of Object.values(RULES)) {
        expect(Array.isArray(rules)).toBe(true);
      }
      expect(OPERATION_RULES.transfer_funds.length).toBeGreaterThan(0);
    });

    it('accountSequenceFreshnessRule passes when sequence data is absent', () => {
      const result = accountSequenceFreshnessRule({
        ...baseRequest,
        state: { configVersions: {} },
      });
      expect(result.status).toBe('pass');
    });
  });

  describe('extra rules and folding', () => {
    it('lets deployment-specific rules block the operation', () => {
      const result = runPreflight(baseRequest, {
        now: () => 5,
        extraRules: [
          () => ({
            ruleId: 'deployment_freeze',
            status: 'block',
            code: 'FROZEN',
            message: 'Deploy freeze is active.',
            remediation: 'Wait for the freeze to lift.',
          }),
        ],
      });
      expect(result.status).toBe('blocked');
      expect(result.blockers[0].code).toBe('FROZEN');
    });
  });
});
