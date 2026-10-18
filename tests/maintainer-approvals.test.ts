import { describe, expect, it } from 'bun:test';
import {
  MaintainerApprovalService,
  computeIntentFingerprint,
  determineImpactLevel,
} from '@/lib/maintainer-approvals/service';
import {
  type MaintainerActor,
  type MaintainerIntentPayload,
} from '@/lib/maintainer-approvals/types';

describe('Maintainer Action Approval Flow & Signed Intent Receipts', () => {
  const maintainerKeys = MaintainerApprovalService.generateEd25519Keypair();
  const validMaintainer: MaintainerActor = {
    id: 'maintainer-1',
    publicKey: maintainerKeys.publicKeyHex,
    role: 'maintainer',
    walletType: 'freighter',
  };

  const adminKeys = MaintainerApprovalService.generateEd25519Keypair();
  const validAdmin: MaintainerActor = {
    id: 'admin-1',
    publicKey: adminKeys.publicKeyHex,
    role: 'admin',
    walletType: 'ledger',
  };

  const invalidContributor: MaintainerActor = {
    id: 'contributor-1',
    publicKey: MaintainerApprovalService.generateEd25519Keypair().publicKeyHex,
    // @ts-expect-error test non-maintainer role
    role: 'contributor',
  };

  it('determines action impact level correctly', () => {
    expect(determineImpactLevel('emergency_pause')).toBe('tier_3_critical');
    expect(determineImpactLevel('emergency_resume')).toBe('tier_3_critical');
    expect(determineImpactLevel('rotate_signing_keys')).toBe('tier_3_critical');
    expect(determineImpactLevel('treasury_disbursement')).toBe('tier_2_sensitive');
    expect(determineImpactLevel('run_retention_cleanup')).toBe('tier_2_sensitive');
    expect(determineImpactLevel('bulk_data_import')).toBe('tier_1_standard');
  });

  it('generates canonical fingerprint stable across object key order', () => {
    const payload1: MaintainerIntentPayload = {
      action: 'emergency_pause',
      environment: 'production',
      targetResource: 'soroban-pool-01',
      parameters: { b: 2, a: 1 },
      justification: 'Critical exploit prevention in pool logic',
      nonce: 'nonce-12345678',
      timestamp: 100000,
      expiresAt: 200000,
    };

    const payload2: MaintainerIntentPayload = {
      targetResource: 'soroban-pool-01',
      parameters: { a: 1, b: 2 },
      justification: 'Critical exploit prevention in pool logic',
      environment: 'production',
      action: 'emergency_pause',
      nonce: 'nonce-12345678',
      expiresAt: 200000,
      timestamp: 100000,
    };

    const fp1 = computeIntentFingerprint(payload1);
    const fp2 = computeIntentFingerprint(payload2);

    expect(fp1.fingerprint).toBe(fp2.fingerprint);
    expect(fp1.canonicalJson).toBe(fp2.canonicalJson);
  });

  it('requires explicit intent schema with minimum justification length', () => {
    const service = new MaintainerApprovalService();

    expect(() => {
      service.createIntentPayload({
        action: 'emergency_pause',
        environment: 'production',
        targetResource: 'pool-1',
        parameters: {},
        justification: 'short', // < 10 chars
      });
    }).toThrow();
  });

  it('signs and verifies intent with Ed25519 maintainer keypair and mints receipt', () => {
    const telemetryEvents: any[] = [];
    const service = new MaintainerApprovalService({
      onTelemetryEvent: (e) => telemetryEvents.push(e),
    });

    const payload = service.createIntentPayload({
      action: 'emergency_pause',
      environment: 'production',
      targetResource: 'pool-1',
      parameters: { pauseDurationMinutes: 60 },
      justification: 'Applying circuit breaker due to oracle latency anomaly',
    });

    const receipt = service.approveAndSignIntent({
      payload,
      maintainer: validMaintainer,
      signerPrivateKey: maintainerKeys.privateKeyHex,
    });

    expect(receipt.receiptId).toBeDefined();
    expect(receipt.status).toBe('approved');
    expect(receipt.impactLevel).toBe('tier_3_critical');
    expect(receipt.signature).toBeDefined();
    expect(receipt.maintainer.publicKey).toBe(maintainerKeys.publicKeyHex);

    // Verify audit log was recorded
    const audits = service.getAuditTrail(receipt.receiptId);
    expect(audits.length).toBe(1);
    expect(audits[0].action).toBe('emergency_pause');
    expect(audits[0].actor.id).toBe('maintainer-1');

    // Verify telemetry event emitted
    expect(telemetryEvents.length).toBe(1);
    expect(telemetryEvents[0].type).toBe('maintainer_intent_approved');
  });

  it('prevents replay attacks by returning existing receipt for identical intent', () => {
    const service = new MaintainerApprovalService();
    const payload = service.createIntentPayload({
      action: 'treasury_disbursement',
      environment: 'staging',
      targetResource: 'treasury-vault',
      parameters: { amount: '5000' },
      justification: 'Grant distribution batch approval',
    });

    const receipt1 = service.approveAndSignIntent({
      payload,
      maintainer: validMaintainer,
      signerPrivateKey: maintainerKeys.privateKeyHex,
    });

    const receipt2 = service.approveAndSignIntent({
      payload,
      maintainer: validMaintainer,
      signerPrivateKey: maintainerKeys.privateKeyHex,
    });

    expect(receipt1.receiptId).toBe(receipt2.receiptId);
    expect(receipt1.intentFingerprint).toBe(receipt2.intentFingerprint);
  });

  it('refuses expired intent approval', () => {
    let nowTime = 1000;
    const service = new MaintainerApprovalService({
      now: () => nowTime,
    });

    const payload = service.createIntentPayload({
      action: 'rotate_signing_keys',
      environment: 'production',
      targetResource: 'multisig-threshold',
      parameters: {},
      justification: 'Quarterly key rotation policy mandate',
      ttlMs: 500, // Expires at 1500
    });

    // Advance time past expiry
    nowTime = 2000;

    expect(() => {
      service.approveAndSignIntent({
        payload,
        maintainer: validMaintainer,
        signerPrivateKey: maintainerKeys.privateKeyHex,
      });
    }).toThrow(/expired intent/);
  });

  it('refuses non-maintainer / non-admin actors', () => {
    const service = new MaintainerApprovalService();
    const payload = service.createIntentPayload({
      action: 'emergency_pause',
      environment: 'production',
      targetResource: 'pool-1',
      parameters: {},
      justification: 'Attempting pause without maintainer credentials',
    });

    expect(() => {
      service.approveAndSignIntent({
        payload,
        maintainer: invalidContributor,
        signerPrivateKey: MaintainerApprovalService.generateEd25519Keypair().privateKeyHex,
      });
    }).toThrow(/Unauthorized/);
  });

  it('handles execution lifecycle and records externalTxRef and telemetry', async () => {
    const telemetryEvents: any[] = [];
    const service = new MaintainerApprovalService({
      onTelemetryEvent: (e) => telemetryEvents.push(e),
    });

    const payload = service.createIntentPayload({
      action: 'treasury_disbursement',
      environment: 'production',
      targetResource: 'treasury-vault',
      parameters: { recipient: 'G...', amount: '100' },
      justification: 'Treasury payment for infrastructure audit',
    });

    const receipt = service.approveAndSignIntent({
      payload,
      maintainer: validMaintainer,
      signerPrivateKey: maintainerKeys.privateKeyHex,
    });

    const completed = await service.executeApprovedAction(receipt.receiptId, async () => {
      return {
        externalTxRef: 'tx-stellar-hash-abc-123',
        result: { feePaid: '100', ledgerSequence: 49201 },
      };
    });

    expect(completed.status).toBe('completed');
    expect(completed.externalTxRef).toBe('tx-stellar-hash-abc-123');
    expect(completed.completedAt).toBeDefined();

    // Review audit log
    const audits = service.getAuditTrail(receipt.receiptId);
    expect(audits.some((a) => a.status === 'completed')).toBe(true);

    // Verify telemetry
    expect(telemetryEvents.some((e) => e.type === 'maintainer_action_completed')).toBe(true);
  });

  it('records diagnostic failure receipt when execution fails and allows review', async () => {
    const service = new MaintainerApprovalService();
    const payload = service.createIntentPayload({
      action: 'emergency_resume',
      environment: 'production',
      targetResource: 'pool-1',
      parameters: {},
      justification: 'Resuming pool operations following validation',
    });

    const receipt = service.approveAndSignIntent({
      payload,
      maintainer: validAdmin,
      signerPrivateKey: adminKeys.privateKeyHex,
    });

    await expect(
      service.executeApprovedAction(receipt.receiptId, async () => {
        throw new Error('RPC_NODE_TIMEOUT: Horizon node unreachable');
      }),
    ).rejects.toThrow('RPC_NODE_TIMEOUT');

    // Receipt should be marked failed with failureReason
    const failedReceipt = service.getReceiptForReview(receipt.receiptId, validAdmin);
    expect(failedReceipt?.status).toBe('failed');
    expect(failedReceipt?.failureReason).toContain('RPC_NODE_TIMEOUT');

    // Audit logs should record failure
    const logs = service.getAuditTrail(receipt.receiptId);
    const failureLog = logs.find((l) => l.status === 'failed');
    expect(failureLog).toBeDefined();
    expect(failureLog?.error).toContain('RPC_NODE_TIMEOUT');
  });

  it('supports offline queueing and background sync replay', async () => {
    const service = new MaintainerApprovalService();
    const payload = service.createIntentPayload({
      action: 'run_retention_cleanup',
      environment: 'staging',
      targetResource: 'telemetry-records-stale',
      parameters: { olderThanDays: 30 },
      justification: 'Automated data retention sanitization schedule',
    });

    // Sign offline
    const offlineReceipt = service.approveAndSignIntent({
      payload,
      maintainer: validMaintainer,
      signerPrivateKey: maintainerKeys.privateKeyHex,
      isOffline: true,
    });

    expect(offlineReceipt.status).toBe('queued_offline');

    // Sync queue once online
    const syncResult = await service.syncOfflineQueue(async () => {
      return {
        externalTxRef: 'tx-synced-retention-999',
        result: { rowsDeleted: 450 },
      };
    });

    expect(syncResult.synced).toEqual([offlineReceipt.receiptId]);
    expect(syncResult.failed).toEqual([]);

    const syncedReceipt = service.getReceiptForReview(offlineReceipt.receiptId, validMaintainer);
    expect(syncedReceipt?.status).toBe('completed');
    expect(syncedReceipt?.externalTxRef).toBe('tx-synced-retention-999');
  });

  it('supports rollback with auditable compensation receipt', () => {
    const service = new MaintainerApprovalService();
    const payload = service.createIntentPayload({
      action: 'bulk_data_import',
      environment: 'staging',
      targetResource: 'dataset-registry-v1',
      parameters: { count: 50 },
      justification: 'Bulk import of agent benchmark schemas',
    });

    const receipt = service.approveAndSignIntent({
      payload,
      maintainer: validMaintainer,
      signerPrivateKey: maintainerKeys.privateKeyHex,
    });

    const rolledBack = service.rollbackAction(
      receipt.receiptId,
      validAdmin,
      'Schema corruption detected in source data',
    );

    expect(rolledBack.status).toBe('rolled_back');
    expect(rolledBack.failureReason).toContain('Rolled back: Schema corruption detected');

    const logs = service.getAuditTrail(receipt.receiptId);
    expect(logs.some((l) => l.status === 'rolled_back')).toBe(true);
  });
});
