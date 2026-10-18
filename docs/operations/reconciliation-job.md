# Projection Reconciliation Job

Trellis maintains several cached or derived projections alongside its authoritative source-of-truth ledgers:
- **Affiliate Earnings & Wallet Stats (`affiliate-ledger`)**: Derived `earningsLedger` and cached `AffiliateStats` computed from authoritative `referralCodes`, `referrals`, and `payouts`.
- **Referral Click Analytics (`referral-click-metrics`)**: Cached `ReferralClickMetrics` (CTR, conversion rates, source/device breakdowns) derived from raw `ReferralLinkEvent` streams.
- **Permission-Aware Search Index (`search-index`)**: Cached `IndexedRecord` entries derived from authoritative agent records and `PermissionConstraint` ACLs.
- **Telemetry Counters (`telemetry-counters`)**: Cached monotonic counters (`IdempotencyTelemetryCounters`, `AbuseTelemetryCounters`) derived from bounded telemetry event streams.

The reconciliation job in `lib/reconciliation/` and `scripts/reconcile-projections.ts` compares source-of-truth state against these cached/derived projections, classifies every discrepancy with structured root-cause hints, and optionally repairs drift through a **dry-run-first workflow** with cryptographic digest verification and pre-repair rollback snapshots.

---

## Quick Start

```bash
# 1. Run a non-mutating dry-run against the bundled baseline
npx tsx scripts/reconcile-projections.ts --dry-run

# 2. Run a dry-run against a custom snapshot and emit JSON
npx tsx scripts/reconcile-projections.ts --file path/to/snapshot.json --dry-run --json

# 3. Apply repairs using a verified dry-run plan digest and archive a rollback snapshot
npx tsx scripts/reconcile-projections.ts \
  --file path/to/snapshot.json \
  --apply \
  --plan-digest <planDigestFromDryRun> \
  --report .trellis/reconciliation-report.json \
  --rollback-out .trellis/reconciliation-rollback.json
```

---

## Dry-Run-First Repair Workflow

1. **Dry-Run Phase (`runReconciliation`)**:
   - Deep-clones the input states so caller data is never mutated.
   - Evaluates all selected projection domains (`affiliate-ledger`, `referral-click-metrics`, `search-index`, `telemetry-counters`).
   - Emits a `DriftFinding` for each discrepancy, including expected vs. observed values, severity (`critical`, `error`, `warning`), and a structured `RootCauseHint`.
   - Computes a canonical SHA-256 `sourceFingerprint`, `projectionFingerprint`, and `planDigest` over the exact `(source, projection, operations)` tuple.

2. **Approval & Digest Verification (`applyReconciliationRepair`)**:
   - By default (`requireDryRunApproval: true`), `applyReconciliationRepair` **refuses** to mutate state unless an `approvedPlan` (or `planDigest`) from a prior dry-run is supplied (`DRY_RUN_REQUIRED`).
   - Before writing any change, the engine re-evaluates the current state and compares its `planDigest` against the approved digest. If either the source-of-truth state or the projection mutated since the dry-run, repair aborts with `PLAN_STALE_STATE_CHANGED` and zero writes occur.

3. **Pre-Repair Rollback Snapshot & Post-Repair Verification**:
   - Captures a deep-cloned `RollbackSnapshot` (`projectionBefore`) prior to applying repair operations.
   - Applies idempotent repair operations (`upsert`, `delete`, `recompute`).
   - Automatically runs a post-repair reconciliation pass (`postRepairVerification`) to confirm `remainingRepairableCount === 0`.

---

## Root-Cause Hint Taxonomy

| Code | Category | Meaning | Safe Operator Action |
| :--- | :--- | :--- | :--- |
| `MISSED_DOMAIN_EVENT` | `event-pipeline` | Authoritative mutation occurred without updating the downstream projection. | Apply recomputed projection entry; inspect domain event DLQ. |
| `PARTIAL_SIDE_EFFECT_WRITE` | `event-pipeline` | Multi-step operation committed source state but interrupted before projection write. | Apply recomputed value; check side-effect dispatcher DLQ. |
| `UNFLUSHED_DELETION_TOMBSTONE` | `cache-invalidation` | Projection retains an entry whose source record was deleted or never existed. | Delete orphaned projection entry via dry-run repair. |
| `DUPLICATE_EVENT_REPLAY` | `concurrency` | Derived aggregate exceeds authoritative sum due to non-idempotent event replay. | Recompute projection from authoritative ledger; verify idempotency keys. |
| `STALE_CACHE_HYDRATION` | `cache-invalidation` | Projection reflects an older version or watermark than authoritative state. | Refresh projection fields from current source record. |
| `PAYOUT_RESERVATION_MISMATCH` | `settlement` | Cached `pendingEarnings` or `totalPayouts` lags behind payout status transitions. | Recompute `AffiliateStats` from referrals and payouts ledgers. |
| `PAYOUT_EXCEEDS_SOURCE_EARNINGS` | `settlement` | Completed payouts exceed earnings derivable from converted referrals. | **Manual review required** (`repairable: false`); freeze balance and audit settlement history. |
| `PERMISSION_REVOCATION_LAG` | `permissions` | Search index exposes hidden records or stale permission scopes. | Immediately remove or rescope indexed entry via repair plan. |
| `BOUNDED_BUFFER_TRUNCATION` | `retention` | Monotonic counter exceeds retained event count because the ring buffer reached capacity. | Re-baseline counters to retained window or archive historical counters. |

---

## Operational Edge Cases & Failure Modes

- **Concurrent State Mutation Between Dry-Run and Apply (`PLAN_STALE_STATE_CHANGED`)**:
  If a new referral conversion, payout, or permission update lands after the operator runs `--dry-run` but before `--apply`, the `sourceFingerprint` or `projectionFingerprint` changes. The engine rejects the stale `planDigest` without writing. Re-run `--dry-run` to inspect the updated diff.
- **Unrepairable Financial Drift (`PAYOUT_EXCEEDS_SOURCE_EARNINGS`)**:
  When settled payouts exceed the sum of converted referral commissions, automatically lowering `earningsLedger` would hide an overpayment anomaly. The reconciler marks the finding `repairable: false` (`plannedAction: 'manual_review'`), repairs all other safe findings, and reports status `partially_repaired` so operators investigate the ledger discrepancy manually.
- **Bounded Telemetry Ring-Buffer Eviction (`BOUNDED_BUFFER_TRUNCATION`)**:
  In-memory telemetry buffers cap at `MAX_IDEMPOTENCY_EVENTS` / `MAX_ABUSE_EVENTS` (500 events) while cumulative counters continue incrementing. The reconciler checks `maxBufferSize` to distinguish expected ring-buffer eviction from `DUPLICATE_EVENT_REPLAY`.
- **Floating-Point Rounding in Rates and Currency Sums**:
  Currency totals are rounded to two decimal places and compared using a configurable `numericTolerance` (default `0.01`) to avoid false-positive drift alerts from IEEE-754 representation noise.

---

## Rollback and Recovery Steps

If an applied repair needs to be reverted:

1. **Programmatic Rollback**:
   Pass the `RollbackSnapshot` returned in `applyReport.rollbackSnapshot` (or saved via `--rollback-out`) to `rollbackReconciliationRepair(store, snapshot)`:
   ```ts
   import { rollbackReconciliationRepair } from '@/lib/reconciliation';

   await rollbackReconciliationRepair(projectionStore, applyReport.rollbackSnapshot);
   ```
2. **Verification After Rollback**:
   Re-run `runReconciliation(source, await projectionStore.readProjection())` and confirm that `repairPlan.projectionFingerprint` matches the pre-repair `projectionFingerprint` recorded in the original dry-run report.
3. **Partial Repair Recovery**:
   Because every `RepairOperation` (`upsert`, `delete`, `recompute`) is idempotent and overwrites with full authoritative values rather than relative deltas, interrupted runs can be safely resumed by generating a fresh dry-run plan and applying it.
