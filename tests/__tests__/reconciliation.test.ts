import {
  ReconciliationRepairError,
  applyReconciliationRepair,
  createMemoryProjectionStore,
  reconcileAndRepair,
  renderReconciliationTextReport,
  rollbackReconciliationRepair,
  runReconciliation,
  type ReconciliationProjectionState,
  type ReconciliationSourceState,
  type RollbackSnapshot,
} from '@/lib/reconciliation';
import { parseReconcileArgs, runCli } from '@/scripts/reconcile-projections';

const WALLET_ALICE = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';
const WALLET_BOB = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const WALLET_ORPHAN = 'GCCD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA6';

function buildHealthyFixture(): {
  source: ReconciliationSourceState;
  projection: ReconciliationProjectionState;
} {
  return {
    source: {
      affiliate: {
        referralCodes: [
          {
            code: 'ASTRALICE1',
            ownerWallet: WALLET_ALICE,
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        ],
        referrals: [
          {
            id: 'ref-1',
            referralCode: 'ASTRALICE1',
            referredUserAddress: WALLET_BOB,
            referredUserName: 'Bob Builder',
            status: 'converted',
            commissionRate: 10,
            commissionAmount: '200.00',
            createdAt: '2026-01-02T00:00:00.000Z',
            convertedAt: '2026-01-03T00:00:00.000Z',
          },
          {
            id: 'ref-2',
            referralCode: 'ASTRALICE1',
            referredUserAddress: WALLET_ORPHAN,
            status: 'active',
            commissionRate: 10,
            commissionAmount: '50.00',
            createdAt: '2026-01-04T00:00:00.000Z',
          },
        ],
        payouts: [
          {
            id: 'pay-1',
            walletAddress: WALLET_ALICE,
            amount: '120.00',
            status: 'completed',
            requestedAt: '2026-01-05T00:00:00.000Z',
            processedAt: '2026-01-05T00:05:00.000Z',
            transactionHash: 'tx-hash-1',
          },
        ],
        vanitySlugs: [
          {
            slug: 'alice-bot',
            ownerWallet: WALLET_ALICE,
            targetAgentId: 'ag-1',
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        ],
        linkEvents: [
          {
            id: 'ev-1',
            kind: 'view',
            slug: 'alice-bot',
            targetAgentId: 'ag-1',
            timestamp: '2026-01-02T10:00:00.000Z',
            referrerSource: 'twitter',
            deviceType: 'desktop',
            conversionStatus: 'none',
          },
          {
            id: 'ev-2',
            kind: 'click',
            slug: 'alice-bot',
            targetAgentId: 'ag-1',
            timestamp: '2026-01-02T10:01:00.000Z',
            referrerSource: 'twitter',
            deviceType: 'desktop',
            conversionStatus: 'converted',
          },
        ],
      },
      searchIndex: {
        records: [
          {
            record: {
              id: 'ag-1',
              name: 'Canopy Predictor',
              description: 'Volatility model',
              status: 'active',
            },
            permissions: { isPublic: true },
            updatedAt: 1700000000000,
          },
        ],
      },
      telemetry: {
        idempotencyEvents: [
          { ts: 1700000001000, scope: 'payouts', kind: 'hit', reason: 'replayed' },
          { ts: 1700000002000, scope: 'payouts', kind: 'collision', reason: 'fingerprint_mismatch' },
        ],
        abuseEvents: [
          {
            eventType: 'abuse_evaluated',
            operation: 'claim_payout',
            environment: 'production',
            timestamp: 1700000001000,
            actorId: WALLET_ALICE,
            riskScore: 15,
            action: 'allow',
            signals: [],
          },
          {
            eventType: 'abuse_blocked',
            operation: 'claim_payout',
            environment: 'production',
            timestamp: 1700000002000,
            actorId: WALLET_BOB,
            riskScore: 85,
            action: 'block',
            signals: [],
          },
        ],
      },
    },
    projection: {
      affiliate: {
        earningsLedger: [{ wallet: WALLET_ALICE, earnedXlm: 200 }],
        walletStats: {
          [WALLET_ALICE]: {
            totalReferrals: 2,
            activeReferrals: 2,
            totalEarnings: '200.00',
            pendingEarnings: '80.00',
            totalPayouts: '120.00',
            conversionRate: 50,
          },
        },
        clickMetricsByWallet: {
          [WALLET_ALICE]: {
            totalImpressions: 1,
            totalClicks: 1,
            totalConversions: 1,
            clickThroughRate: 1,
            conversionRate: 1,
            bySource: [
              {
                source: 'twitter',
                impressions: 1,
                clicks: 1,
                conversions: 1,
                ctr: 1,
              },
            ],
            byDevice: [
              {
                deviceType: 'desktop',
                impressions: 1,
                clicks: 1,
                conversions: 1,
                ctr: 1,
              },
            ],
            series: [
              {
                date: '2026-01-02',
                impressions: 1,
                clicks: 1,
                conversions: 1,
                ctr: 1,
              },
            ],
          },
        },
      },
      searchIndex: {
        indexedRecords: [
          {
            id: 'ag-1',
            name: 'Canopy Predictor',
            description: 'Volatility model',
            status: 'active',
            visibility: 'public',
            indexed_at: 1700000000000,
          },
        ],
      },
      telemetry: {
        idempotencyCounters: {
          idempotency_requests: 2,
          idempotency_hits: 1,
          idempotency_collisions: 1,
          idempotency_retries: 0,
          idempotency_expired: 0,
        },
        abuseCounters: {
          totalEvaluations: 2,
          lowRiskAllowed: 1,
          stepUpChallenges: 0,
          quarantinedReviews: 0,
          criticalBlocks: 1,
        },
      },
    },
  };
}

describe('Projection Reconciliation Job', () => {
  it('reports clean status and zero drift on a synchronized source and projection state', () => {
    const { source, projection } = buildHealthyFixture();
    const report = runReconciliation(source, projection, {
      nowIso: '2026-02-01T00:00:00.000Z',
    });

    expect(report.ok).toBe(true);
    expect(report.status).toBe('clean');
    expect(report.mode).toBe('dry-run');
    expect(report.findings).toHaveLength(0);
    expect(report.repairPlan.operations).toHaveLength(0);
    expect(report.summary.driftedCount).toBe(0);
    expect(renderReconciliationTextReport(report)).toContain('Zero projection drift detected');
  });

  it('detects affiliate ledger, wallet stats, and click metrics drift with root-cause hints', () => {
    const { source, projection } = buildHealthyFixture();

    // Introduce multiple affiliate projection drifts:
    // 1. Alice's earningsLedger is under-credited (100 instead of 200) -> PARTIAL_SIDE_EFFECT_WRITE
    // 2. Orphan wallet exists in earningsLedger with no referral code -> UNFLUSHED_DELETION_TOMBSTONE
    // 3. Alice's cached pendingEarnings is stale (200 instead of 80 after payout) -> PAYOUT_RESERVATION_MISMATCH
    // 4. Alice's clickMetrics over-counted clicks (5 instead of 1) -> DUPLICATE_EVENT_REPLAY
    projection.affiliate!.earningsLedger = [
      { wallet: WALLET_ALICE, earnedXlm: 100 },
      { wallet: WALLET_ORPHAN, earnedXlm: 45 },
    ];
    projection.affiliate!.walletStats![WALLET_ALICE].pendingEarnings = '200.00';
    projection.affiliate!.clickMetricsByWallet![WALLET_ALICE].totalClicks = 5;

    const report = runReconciliation(source, projection);

    expect(report.ok).toBe(false);
    expect(report.status).toBe('drift_detected');

    const byId = new Map(report.findings.map((f) => [f.id, f]));

    const aliceEarnings = byId.get(`drift:affiliate-ledger:earnings:${WALLET_ALICE}:mismatch`);
    expect(aliceEarnings).toBeDefined();
    expect(aliceEarnings?.rootCauseHint.code).toBe('PARTIAL_SIDE_EFFECT_WRITE');
    expect(aliceEarnings?.expected).toBe(200);
    expect(aliceEarnings?.observed).toBe(100);
    expect(aliceEarnings?.repairable).toBe(true);

    const orphanEarnings = byId.get(`drift:affiliate-ledger:earnings:${WALLET_ORPHAN}:orphaned`);
    expect(orphanEarnings).toBeDefined();
    expect(orphanEarnings?.rootCauseHint.code).toBe('UNFLUSHED_DELETION_TOMBSTONE');
    expect(orphanEarnings?.plannedAction).toBe('delete');

    const aliceStats = byId.get(`drift:affiliate-ledger:stats:${WALLET_ALICE}:mismatch`);
    expect(aliceStats).toBeDefined();
    expect(aliceStats?.rootCauseHint.code).toBe('PAYOUT_RESERVATION_MISMATCH');

    const aliceClicks = byId.get(`drift:referral-click-metrics:${WALLET_ALICE}:mismatch`);
    expect(aliceClicks).toBeDefined();
    expect(aliceClicks?.rootCauseHint.code).toBe('DUPLICATE_EVENT_REPLAY');
  });

  it('flags overpaid affiliate ledgers as critical manual-review findings instead of auto-overwriting', () => {
    const { source, projection } = buildHealthyFixture();
    // Make completed payout (300 XLM) exceed converted referral earnings (200 XLM)
    source.affiliate!.payouts![0].amount = '300.00';
    projection.affiliate!.earningsLedger = [{ wallet: WALLET_ALICE, earnedXlm: 300 }];

    const report = runReconciliation(source, projection, {
      domains: ['affiliate-ledger'],
    });

    const mismatch = report.findings.find(
      (f) => f.id === `drift:affiliate-ledger:earnings:${WALLET_ALICE}:mismatch`,
    );
    expect(mismatch).toBeDefined();
    expect(mismatch?.severity).toBe('critical');
    expect(mismatch?.repairable).toBe(false);
    expect(mismatch?.plannedAction).toBe('manual_review');
    expect(mismatch?.rootCauseHint.code).toBe('PAYOUT_EXCEEDS_SOURCE_EARNINGS');
    expect(report.repairPlan.manualReviewFindings).toHaveLength(1);
  });

  it('detects search index visibility leaks, orphaned deletions, missing entries, and stale watermarks', () => {
    const { source, projection } = buildHealthyFixture();

    source.searchIndex!.records = [
      // ag-1 became hidden in source, but is still public in projection
      {
        record: { id: 'ag-1', name: 'Canopy Predictor', description: 'Secret', status: 'active' },
        permissions: { isPublic: false, visibleTo: [] },
        updatedAt: 1700000005000,
      },
      // ag-2 is public in source, but missing from projection
      {
        record: { id: 'ag-2', name: 'Nebula Guard', description: 'Sentinel', status: 'active' },
        permissions: { isPublic: true },
        updatedAt: 1700000005000,
      },
      // ag-3 has restricted permissions that changed in source
      {
        record: { id: 'ag-3', name: 'Org Bot', description: 'Scoped', status: 'active' },
        permissions: { isPublic: false, visibleTo: ['user-1'], organizationId: 'org-a' },
        updatedAt: 1700000005000,
      },
    ];

    projection.searchIndex!.indexedRecords = [
      {
        id: 'ag-1',
        name: 'Canopy Predictor',
        description: 'Secret',
        status: 'active',
        visibility: 'public',
        indexed_at: 1700000000000,
      },
      {
        id: 'ag-3',
        name: 'Org Bot',
        description: 'Scoped',
        status: 'active',
        visibility: 'restricted',
        visibleTo: ['user-1', 'revoked-user-2'],
        organizationId: 'org-a',
        indexed_at: 1700000000000,
      },
      // ag-deleted is not in source at all
      {
        id: 'ag-deleted',
        name: 'Ghost Agent',
        description: 'Deleted',
        status: 'inactive',
        visibility: 'public',
        indexed_at: 1700000000000,
      },
    ];

    const report = runReconciliation(source, projection, { domains: ['search-index'] });
    const byId = new Map(report.findings.map((f) => [f.id, f]));

    expect(byId.get('drift:search-index:ag-1:hidden-exposed')?.rootCauseHint.code).toBe(
      'PERMISSION_REVOCATION_LAG',
    );
    expect(byId.get('drift:search-index:ag-1:hidden-exposed')?.plannedAction).toBe('delete');

    expect(byId.get('drift:search-index:ag-2:missing')?.rootCauseHint.code).toBe(
      'MISSED_DOMAIN_EVENT',
    );
    expect(byId.get('drift:search-index:ag-2:missing')?.plannedAction).toBe('upsert');

    expect(byId.get('drift:search-index:ag-3:permission-scope')?.rootCauseHint.code).toBe(
      'PERMISSION_REVOCATION_LAG',
    );

    expect(byId.get('drift:search-index:ag-deleted:orphaned')?.rootCauseHint.code).toBe(
      'UNFLUSHED_DELETION_TOMBSTONE',
    );
  });

  it('distinguishes bounded ring-buffer truncation from duplicate replay in telemetry counters', () => {
    const { source, projection } = buildHealthyFixture();
    source.telemetry!.maxBufferSize = 2;
    // Buffer has 2 events (at maxBufferSize capacity), but counters have 10 requests
    projection.telemetry!.idempotencyCounters!.idempotency_requests = 10;
    // Abuse buffer has 2 events, increase maxBufferSize check by testing under-count on abuse
    projection.telemetry!.abuseCounters!.totalEvaluations = 0;

    const report = runReconciliation(source, projection, { domains: ['telemetry-counters'] });
    const idemFinding = report.findings.find(
      (f) => f.id === 'drift:telemetry-counters:idempotency:mismatch',
    );
    const abuseFinding = report.findings.find(
      (f) => f.id === 'drift:telemetry-counters:abuse:mismatch',
    );

    expect(idemFinding?.rootCauseHint.code).toBe('BOUNDED_BUFFER_TRUNCATION');
    expect(abuseFinding?.rootCauseHint.code).toBe('PARTIAL_SIDE_EFFECT_WRITE');
  });

  it('enforces the dry-run-first workflow, rejects stale plans, repairs drift, and supports rollback', async () => {
    const { source, projection } = buildHealthyFixture();

    // Corrupt projection across all 4 domains
    projection.affiliate!.earningsLedger = [];
    projection.affiliate!.clickMetricsByWallet = {};
    projection.searchIndex!.indexedRecords = [];
    projection.telemetry!.idempotencyCounters!.idempotency_hits = 0;

    const snapshotBeforeDryRun = JSON.stringify(projection);
    const dryRunReport = runReconciliation(source, projection);

    // 1. Dry-run never mutates the projection object
    expect(JSON.stringify(projection)).toBe(snapshotBeforeDryRun);
    expect(dryRunReport.findings.length).toBeGreaterThanOrEqual(4);

    const store = createMemoryProjectionStore(projection);

    // 2. Calling applyReconciliationRepair without approvedPlan fails closed
    await expect(
      applyReconciliationRepair(source, store, { requireDryRunApproval: true }),
    ).rejects.toMatchObject({
      code: 'DRY_RUN_REQUIRED',
    });

    // 3. Mutating state between dry-run and apply invalidates the planDigest
    const mutatedSource = JSON.parse(JSON.stringify(source)) as ReconciliationSourceState;
    mutatedSource.affiliate!.referrals![0].commissionAmount = '999.00';

    await expect(
      applyReconciliationRepair(mutatedSource, store, {
        approvedPlan: dryRunReport.repairPlan,
      }),
    ).rejects.toBeInstanceOf(ReconciliationRepairError);

    // Confirm store was not modified by the rejected apply
    expect(JSON.stringify(store.getState())).toBe(snapshotBeforeDryRun);

    // 4. Applying with the valid dry-run plan repairs all drift and verifies clean post-state
    const applyReport = await applyReconciliationRepair(source, store, {
      approvedPlan: dryRunReport.repairPlan,
    });

    expect(applyReport.mode).toBe('apply');
    expect(applyReport.ok).toBe(true);
    expect(applyReport.status).toBe('repaired');
    expect(applyReport.postRepairVerification?.verifiedClean).toBe(true);
    expect(applyReport.postRepairVerification?.remainingDriftCount).toBe(0);
    expect(applyReport.rollbackSnapshot).toBeDefined();

    const repairedState = store.getState();
    expect(repairedState.affiliate?.earningsLedger).toEqual([
      { wallet: WALLET_ALICE, earnedXlm: 200 },
    ]);
    expect(repairedState.searchIndex?.indexedRecords).toHaveLength(1);
    expect(repairedState.telemetry?.idempotencyCounters?.idempotency_hits).toBe(1);

    // 5. Rolling back restores the exact pre-repair corrupted projection state
    await rollbackReconciliationRepair(store, applyReport.rollbackSnapshot as RollbackSnapshot);
    expect(JSON.stringify(store.getState())).toBe(snapshotBeforeDryRun);
  });

  it('supports two-phase reconcileAndRepair and CLI argument parsing', async () => {
    const { source, projection } = buildHealthyFixture();
    projection.searchIndex!.indexedRecords = [];

    const store = createMemoryProjectionStore(projection);
    const { dryRunReport, applyReport } = await reconcileAndRepair(source, store, {
      apply: true,
      domains: ['search-index'],
    });

    expect(dryRunReport.status).toBe('drift_detected');
    expect(applyReport?.status).toBe('repaired');
    expect(store.getState().searchIndex?.indexedRecords).toHaveLength(1);

    const parsed = parseReconcileArgs([
      '--apply',
      '--domain',
      'search-index',
      '--plan-digest',
      'abc1234',
      '--json',
    ]);
    expect(parsed.apply).toBe(true);
    expect(parsed.dryRun).toBe(false);
    expect(parsed.domains).toEqual(['search-index']);
    expect(parsed.planDigest).toBe('abc1234');
    expect(parsed.json).toBe(true);

    const exitCode = await runCli(['--dry-run', '--json']);
    expect(exitCode).toBe(0);
  });
});
