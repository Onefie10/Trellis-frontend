import {
  DEFAULT_PROTOCOL_CONFIG_REGISTRY,
} from '@/lib/protocol/config-versioning';
import {
  InMemoryPauseAuditLog,
  MemoryPauseStore,
  PauseManager,
} from '@/lib/protocol/emergency-pause';
import {
  executeGuardedOperation,
  PreflightBlockedError,
  type GuardedOperationRequest,
} from '@/lib/protocol/guard';
import {
  MemoryReceiptStore,
  ReceiptService,
} from '@/lib/protocol/operation-receipts';
import type { ProtocolActor } from '@/lib/protocol/operations';

const actor: ProtocolActor = { id: 'wallet-1', role: 'contributor' };

const goodVersions = {
  commission_tiers: '2.0.0',
  claim_link_rules: '1.2.0',
  governance_thresholds: '1.0.0',
};

function makeGuard() {
  let n = 0;
  const pauses = new PauseManager({
    store: new MemoryPauseStore(),
    auditLog: new InMemoryPauseAuditLog(),
    now: () => 1_000,
    generateId: () => `id-${(n += 1)}`,
  });
  const receiptStore = new MemoryReceiptStore();
  const receipts = new ReceiptService({
    store: receiptStore,
    now: () => 2_000,
    generateId: () => `rcpt-${(n += 1)}`,
  });
  return {
    pauses,
    receipts,
    receiptStore,
    options: {
      configRegistry: DEFAULT_PROTOCOL_CONFIG_REGISTRY,
      pauseManager: pauses,
      receipts,
      now: () => 3_000,
    },
  };
}

const baseRequest: GuardedOperationRequest = {
  operation: 'claim_payout',
  environment: 'production',
  actorId: 'wallet-1',
  actor,
  payload: { rewardId: 'reward-9', amount: '25' },
  configVersions: goodVersions,
};

describe('guarded operation chain (#175 + #176 + #177 + #178)', () => {
  it('passes a healthy request and mints exactly one receipt', () => {
    const { options, receiptStore } = makeGuard();
    const result = executeGuardedOperation(baseRequest, options);
    expect(result.blocked).toBe(false);
    expect(result.preflight.status).toBe('success');
    expect(result.receipt?.status).toBe('received');
    expect(receiptStore.size).toBe(1);
  });

  it('resolves a duplicate submission to the same receipt (#176)', () => {
    const { options } = makeGuard();
    const first = executeGuardedOperation(baseRequest, options);
    const second = executeGuardedOperation(baseRequest, options);
    expect(second.receipt?.receiptId).toBe(first.receipt?.receiptId);
  });

  it('blocks on incompatible config versions before minting a receipt (#178)', () => {
    const { options, receiptStore } = makeGuard();
    expect(() =>
      executeGuardedOperation(
        { ...baseRequest, configVersions: { commission_tiers: '1.0.0' } },
        options,
      ),
    ).toThrow(PreflightBlockedError);
    expect(receiptStore.size).toBe(0);
  });

  it('blocks paused operations with the user-safe pause message (#177)', () => {
    const { options, pauses } = makeGuard();
    pauses.pause({
      scope: { operation: 'claim_payout', environment: 'production' },
      reason: 'incident-42',
      actor: { id: 'admin-1', role: 'admin' },
    });
    try {
      executeGuardedOperation(baseRequest, options);
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(PreflightBlockedError);
      const err = error as PreflightBlockedError;
      expect(err.result.blockers[0].code).toBe('OPERATION_PAUSED');
      expect(err.message).toMatch(/temporarily unavailable/i);
      expect(err.message).not.toContain('incident-42');
    }
  });

  it('blocks known-invalid operations before submission (#175)', () => {
    const { options } = makeGuard();
    expect(() =>
      executeGuardedOperation(
        {
          ...baseRequest,
          operation: 'transfer_funds',
          payload: { amount: '9999', destination: 'GABC' },
          state: { balances: { XLM: '10' } },
        },
        options,
      ),
    ).toThrow(PreflightBlockedError);
  });

  it('allows warning-level results through to receipt creation (#175 policy)', () => {
    const { options } = makeGuard();
    const result = executeGuardedOperation(
      {
        ...baseRequest,
        state: { allowanceOk: false },
      },
      options,
    );
    expect(result.blocked).toBe(false);
    expect(result.preflight.status).toBe('warning');
    expect(result.receipt).not.toBeNull();
  });

  it('triggers step-up challenge error when abuse risk is elevated and does not mint receipt', () => {
    const { options, receiptStore } = makeGuard();
    expect(() =>
      executeGuardedOperation(
        {
          ...baseRequest,
          historySnapshot: {
            operationCountLastHour: 15,
            failedAttemptsLast15Minutes: 3,
          },
        },
        options,
      ),
    ).toThrow();
    expect(receiptStore.size).toBe(0);
  });

  it('allows high-risk operation with valid stepUpProof and mints receipt', () => {
    const { options, receiptStore } = makeGuard();
    const result = executeGuardedOperation(
      {
        ...baseRequest,
        historySnapshot: {
          operationCountLastHour: 15,
          failedAttemptsLast15Minutes: 3,
        },
        stepUpProof: {
          token: 'valid-token',
          verified: true,
          challengeType: 'mfa_totp',
        },
      },
      options,
    );
    expect(result.blocked).toBe(false);
    expect(result.receipt).not.toBeNull();
    expect(receiptStore.size).toBe(1);
    expect(result.abuseEvaluation?.action).toBe('allow');
  });
});
