/**
 * Trellis Invariant Monitor — core type contracts.
 *
 * The monitor answers one question for every registered invariant: does it
 * hold, and if not, which records are to blame and what is the safe next step?
 *
 * Design note — snapshots are treated as *untrusted input*. Records are typed
 * as `MonitorRecord` (a loose map) rather than as domain entities, because a
 * corruption monitor must be able to accept data that no longer satisfies its
 * own types. Anything the monitor believes is well-formed is re-checked at
 * runtime by an invariant. See `dataset.ts` for the normalizer.
 */

export type Severity = 'critical' | 'error' | 'warning';

/** Ordered most-severe first. Index doubles as the rank used by `--fail-on`. */
export const SEVERITY_ORDER: readonly Severity[] = ['critical', 'error', 'warning'];

/** Higher rank == more severe. Used for threshold comparisons. */
export function severityRank(severity: Severity): number {
  return SEVERITY_ORDER.indexOf(severity);
}

export function isSeverityAtLeast(severity: Severity, threshold: Severity): boolean {
  return severityRank(severity) <= severityRank(threshold);
}

/**
 * The four invariant families called for by the monitoring brief.
 *
 * - `funds`         — value conservation, settlement proof, double-spend.
 * - `ownership`      — identity, referential ownership, wallet authenticity.
 * - `lifecycle`      — state machine legality and timestamp coherence.
 * - `authorization`  — who was allowed to do what, and whether it is auditable.
 */
export type InvariantDomain = 'funds' | 'ownership' | 'lifecycle' | 'authorization';

export const INVARIANT_DOMAINS: readonly InvariantDomain[] = [
  'funds',
  'ownership',
  'lifecycle',
  'authorization',
];

export type InvariantId = string;

/** Every invariant resolves to exactly one of these two states. */
export type InvariantStatus = 'pass' | 'fail';

/** An untrusted snapshot record. Field access is always runtime-checked. */
export interface MonitorRecord {
  readonly [key: string]: unknown;
}

/**
 * A single record implicated by a failed invariant.
 *
 * `entityType` + `entityId` are the stable handle a maintainer needs in order
 * to locate the offending row without re-running the monitor by hand.
 */
export interface OffendingRecord {
  entityType: string;
  entityId: string;
  field?: string;
  detail: string;
}

/**
 * One concrete failure inside an invariant.
 *
 * `remediation` is always populated — either the invariant-level default or a
 * per-violation refinement — so no failure can ever be reported without a next
 * step, which is an explicit acceptance criterion.
 */
export interface InvariantViolation {
  severity: Severity;
  message: string;
  remediation: string;
  records: OffendingRecord[];
  details?: Record<string, unknown>;
}

/** Raw output of an invariant's `evaluate` function. */
export interface InvariantEvaluation {
  /** How many records the invariant actually inspected. Surfaced so a
   * vacuous pass over an empty collection is distinguishable from real coverage. */
  evaluatedRecords: number;
  violations: InvariantViolation[];
}

/**
 * A registered invariant.
 *
 * The descriptive fields are data, not comments, so that the report, the
 * documentation, and the rule itself cannot drift apart: the same `rationale`
 * and `remediation` strings the author wrote are what the CLI prints.
 */
export interface InvariantDefinition {
  id: InvariantId;
  domain: InvariantDomain;
  title: string;
  description: string;
  /** Why breaking this rule harms Trellis. */
  rationale: string;
  /** Severity applied to any violation this invariant raises. */
  severity: Severity;
  /** Default safe next steps, used by any violation that omits its own. */
  remediation: string;
  evaluate(dataset: MonitorDataset): InvariantEvaluation;
}

/** An invariant after evaluation, with outcome and violations attached. */
export interface InvariantResult {
  id: InvariantId;
  domain: InvariantDomain;
  title: string;
  description: string;
  rationale: string;
  severity: Severity;
  remediation: string;
  status: InvariantStatus;
  evaluatedRecords: number;
  violations: InvariantViolation[];
}

export interface MonitorSummary {
  totalInvariants: number;
  passed: number;
  failed: number;
  /** Count of each severity across all raised violations. */
  violationsBySeverity: Record<Severity, number>;
  totalViolations: number;
  /** Records present per collection, including collections the monitor read. */
  entitiesScanned: Record<string, number>;
}

export interface MonitorReport {
  /** ISO-8601 time the report was produced. */
  timestamp: string;
  /** Human-readable provenance of the snapshot (path or label). */
  source: string;
  /** True when nothing at or above the failure threshold failed. */
  ok: boolean;
  /** Threshold that decided `ok`. */
  failOn: Severity;
  summary: MonitorSummary;
  /** One entry per registered invariant, always — pass and fail alike. */
  results: InvariantResult[];
}

export interface MonitorOptions {
  /**
   * Violations strictly more severe than this fail the run. Defaults to
   * `'error'`, so a lone `warning` reports but does not fail the command.
   */
  failOn?: Severity;
  /** Restrict evaluation to a single domain, or list several. */
  domains?: readonly InvariantDomain[];
  /** Restrict evaluation to these invariant IDs. */
  only?: readonly string[];
  /** Label recorded on the report when the caller does not supply one. */
  source?: string;
}

/**
 * Shape of a dataset the monitor understands.
 *
 * The first nine collections mirror `DomainDataset` in `lib/domain-invariants.ts`
 * so an existing disaster-recovery snapshot can be replayed through the monitor
 * unchanged. `authorizationEvents` is the one addition, because the policy
 * engine records decisions but nothing persisted them for later inspection.
 */
export interface MonitorDataset {
  agents: readonly MonitorRecord[];
  testCases: readonly MonitorRecord[];
  testExecutions: readonly MonitorRecord[];
  provenanceRecords: readonly MonitorRecord[];
  referralCodes: readonly MonitorRecord[];
  referrals: readonly MonitorRecord[];
  payouts: readonly MonitorRecord[];
  earningsLedger: readonly MonitorRecord[];
  bugReports: readonly MonitorRecord[];
  authorizationEvents: readonly MonitorRecord[];
}

/**
 * Documented shape for `authorizationEvents`.
 *
 * ```json
 * {
 *   "id": "authz-1",
 *   "actorId": "GAAZI...",
 *   "actorRole": "admin",
 *   "action": "impersonate_user",
 *   "resourceId": "user-42",
 *   "resourceOwner": "GBBD4...",
 *   "confirmed": true,
 *   "amountStroops": "1500000",
 *   "provenanceId": "prov-1",
 *   "at": "2026-01-01T00:00:00.000Z"
 * }
 * ```
 *
 * `action` and `actorRole` are checked against the policy engine's
 * `PolicyAction` / `ActorRole` unions rather than trusted from the snapshot.
 */
export const AUTHORIZATION_EVENT_FIELDS = [
  'id',
  'actorId',
  'actorRole',
  'action',
  'resourceId',
  'resourceOwner',
  'confirmed',
  'amountStroops',
  'provenanceId',
  'at',
] as const;
