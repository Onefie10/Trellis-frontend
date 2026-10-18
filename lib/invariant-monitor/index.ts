/**
 * Public surface of the Trellis invariant monitor.
 *
 * ```ts
 * import { runInvariantMonitor, renderTextReport } from '@/lib/invariant-monitor';
 *
 * const report = runInvariantMonitor(snapshot, { failOn: 'error' });
 * ```
 */

export type {
  InvariantDefinition,
  InvariantDomain,
  InvariantEvaluation,
  InvariantId,
  InvariantResult,
  InvariantStatus,
  InvariantViolation,
  MonitorDataset,
  MonitorOptions,
  MonitorRecord,
  MonitorReport,
  MonitorSummary,
  OffendingRecord,
  Severity,
} from './types';
export { INVARIANT_DOMAINS, SEVERITY_ORDER, isSeverityAtLeast, severityRank } from './types';

export { DATASET_COLLECTIONS, countEntities, emptyDataset, normalizeDataset } from './dataset';
export type { DatasetCollection } from './dataset';

export { ALL_INVARIANTS, DOMAIN_ID_PREFIX, findInvariant, invariantsByDomain } from './registry';
export { evaluateInvariant, failingResults, runInvariantMonitor } from './monitor';
export type { RunOptions } from './monitor';
export { renderJsonReport, renderTextReport } from './report';
export type { RenderOptions } from './report';
