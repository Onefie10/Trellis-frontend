/**
 * Trellis Projection Reconciliation Job — Core Types
 *
 * Compares authoritative source-of-truth domain state against cached or derived
 * projections across affiliate ledgers, referral click analytics, search indexes,
 * and telemetry counter stores.
 *
 * Every detected drift item includes structured root-cause hints and can be
 * optionally repaired through a strict dry-run-first workflow with cryptographic
 * plan digest verification and pre-repair rollback snapshots.
 */

import type {
  AffiliateStats,
  PayoutRequest,
  ReferralRecord,
} from '@/features/affiliate-dashboard/types';
import type { IdempotencyTelemetryCounters, IdempotencyTelemetryEvent } from '@/lib/idempotency';
import type { AbuseTelemetryEvent } from '@/lib/protocol/abuse-detection';
import type { ReferralClickMetrics, ReferralLinkEvent } from '@/lib/referral-metrics';
import type {
  IndexableRecord,
  IndexedRecord,
  PermissionConstraint,
} from '@/lib/search-indexing';
import type { VanitySlugRecord } from '@/lib/vanity-slug';
import type { AbuseTelemetryCounters } from '@/store/apiMetricsStore';

export type ProjectionDomain =
  | 'affiliate-ledger'
  | 'referral-click-metrics'
  | 'search-index'
  | 'telemetry-counters';

export const PROJECTION_DOMAINS: readonly ProjectionDomain[] = [
  'affiliate-ledger',
  'referral-click-metrics',
  'search-index',
  'telemetry-counters',
];

export type DriftKind =
  | 'missing_projection'
  | 'orphaned_projection'
  | 'value_mismatch'
  | 'visibility_mismatch'
  | 'stale_watermark';

export type DriftSeverity = 'critical' | 'error' | 'warning';

export type RootCauseCode =
  | 'MISSED_DOMAIN_EVENT'
  | 'PARTIAL_SIDE_EFFECT_WRITE'
  | 'UNFLUSHED_DELETION_TOMBSTONE'
  | 'DUPLICATE_EVENT_REPLAY'
  | 'STALE_CACHE_HYDRATION'
  | 'PAYOUT_RESERVATION_MISMATCH'
  | 'PAYOUT_EXCEEDS_SOURCE_EARNINGS'
  | 'PERMISSION_REVOCATION_LAG'
  | 'BOUNDED_BUFFER_TRUNCATION';

export type RootCauseCategory =
  | 'event-pipeline'
  | 'cache-invalidation'
  | 'concurrency'
  | 'settlement'
  | 'permissions'
  | 'retention';

export interface RootCauseHint {
  code: RootCauseCode;
  category: RootCauseCategory;
  summary: string;
  likelyCauses: readonly string[];
  recommendedAction: string;
  confidence: 'high' | 'medium' | 'low';
}

export type RepairActionType = 'upsert' | 'delete' | 'recompute' | 'manual_review';

export interface DriftFinding {
  id: string;
  domain: ProjectionDomain;
  entityType: string;
  entityId: string;
  field?: string;
  kind: DriftKind;
  severity: DriftSeverity;
  expected: unknown;
  observed: unknown;
  message: string;
  rootCauseHint: RootCauseHint;
  repairable: boolean;
  plannedAction: RepairActionType;
}

export interface RepairOperation {
  findingId: string;
  domain: ProjectionDomain;
  entityType: string;
  entityId: string;
  field?: string;
  action: Exclude<RepairActionType, 'manual_review'>;
  before: unknown;
  after: unknown;
  rootCauseCode: RootCauseCode;
  reason: string;
}

export interface RepairPlan {
  planId: string;
  createdAt: string;
  sourceFingerprint: string;
  projectionFingerprint: string;
  planDigest: string;
  operations: readonly RepairOperation[];
  manualReviewFindings: readonly DriftFinding[];
}

export interface RollbackSnapshot {
  snapshotId: string;
  planId: string;
  planDigest: string;
  capturedAt: string;
  projectionBefore: ReconciliationProjectionState;
}

export interface ReferralCodeSourceRecord {
  code: string;
  ownerWallet: string;
  createdAt: string;
}

export interface EarningsLedgerEntry {
  wallet: string;
  earnedXlm: number;
}

export interface AuthoritativeSearchRecord {
  record: IndexableRecord;
  permissions: PermissionConstraint;
  deleted?: boolean;
  updatedAt?: number;
}

export interface ReconciliationSourceState {
  affiliate?: {
    referralCodes?: readonly ReferralCodeSourceRecord[];
    referrals?: readonly ReferralRecord[];
    payouts?: readonly PayoutRequest[];
    vanitySlugs?: readonly VanitySlugRecord[];
    linkEvents?: readonly ReferralLinkEvent[];
  };
  searchIndex?: {
    records?: readonly AuthoritativeSearchRecord[];
    searchableFields?: readonly string[];
  };
  telemetry?: {
    idempotencyEvents?: readonly IdempotencyTelemetryEvent[];
    abuseEvents?: readonly AbuseTelemetryEvent[];
    maxBufferSize?: number;
  };
}

export interface ReconciliationProjectionState {
  affiliate?: {
    earningsLedger?: EarningsLedgerEntry[];
    walletStats?: Record<string, AffiliateStats>;
    clickMetricsByWallet?: Record<string, ReferralClickMetrics>;
  };
  searchIndex?: {
    indexedRecords?: IndexedRecord[];
  };
  telemetry?: {
    idempotencyCounters?: IdempotencyTelemetryCounters;
    abuseCounters?: AbuseTelemetryCounters;
  };
}

export interface ProjectionStoreAdapter {
  readProjection(): Promise<ReconciliationProjectionState> | ReconciliationProjectionState;
  writeProjection(nextState: ReconciliationProjectionState): Promise<void> | void;
}

export interface ReconciliationSummary {
  domainsEvaluated: readonly ProjectionDomain[];
  recordsCompared: number;
  driftedCount: number;
  repairableCount: number;
  manualReviewCount: number;
  repairedCount: number;
  skippedCount: number;
  failedCount: number;
  bySeverity: Record<DriftSeverity, number>;
  byKind: Record<DriftKind, number>;
  byDomain: Record<ProjectionDomain, number>;
}

export interface PostRepairVerification {
  verifiedClean: boolean;
  remainingDriftCount: number;
  remainingRepairableCount: number;
  remainingFindings: readonly DriftFinding[];
}

export type ReconciliationJobStatus =
  | 'clean'
  | 'drift_detected'
  | 'repaired'
  | 'partially_repaired'
  | 'failed';

export interface ReconciliationReport {
  jobId: string;
  timestamp: string;
  mode: 'dry-run' | 'apply';
  ok: boolean;
  status: ReconciliationJobStatus;
  summary: ReconciliationSummary;
  findings: readonly DriftFinding[];
  repairPlan: RepairPlan;
  rollbackSnapshot?: RollbackSnapshot;
  postRepairVerification?: PostRepairVerification;
  errors: readonly string[];
}

export interface RunReconciliationOptions {
  /** Select specific projection domains to evaluate; defaults to all registered domains. */
  domains?: readonly ProjectionDomain[];
  /** Optional deterministic timestamp (ISO-8601) for reproducible test runs. */
  nowIso?: string;
  /** Optional job identifier override. */
  jobId?: string;
  /** Numeric tolerance for floating-point rate comparisons (default: 0.01). */
  numericTolerance?: number;
}

export interface ApplyReconciliationRepairOptions extends RunReconciliationOptions {
  /**
   * Dry-run-first guard: requires a `RepairPlan` or `planDigest` produced by a
   * prior `runReconciliation` dry-run against the exact same source and projection state.
   */
  approvedPlan?: RepairPlan | string;
  /**
   * When true (default), refuses to apply repairs without `approvedPlan` matching
   * the current state's `planDigest`. Set to false only when using the two-phase
   * `reconcileAndRepair` helper that runs the dry-run phase internally first.
   */
  requireDryRunApproval?: boolean;
  /** Restrict repair execution to specific finding IDs. */
  onlyFindingIds?: readonly string[];
}
