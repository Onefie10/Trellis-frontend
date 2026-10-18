/**
 * Dataset normalization for the invariant monitor.
 *
 * A snapshot may come from a restored backup, a fixture, or a half-written
 * export. Normalizing here means every invariant can assume it is looking at
 * an array, and that a malformed collection degrades to "no records" instead
 * of crashing a run that is meant to diagnose exactly that kind of damage.
 *
 * The report always states how many records each collection contributed, so a
 * collection that failed to load is visible as `0` rather than silently
 * missing from the summary.
 */

import type { MonitorDataset, MonitorRecord } from './types';

export const DATASET_COLLECTIONS = [
  'agents',
  'testCases',
  'testExecutions',
  'provenanceRecords',
  'referralCodes',
  'referrals',
  'payouts',
  'earningsLedger',
  'bugReports',
  'authorizationEvents',
] as const;

export type DatasetCollection = (typeof DATASET_COLLECTIONS)[number];

function toRecords(value: unknown): MonitorRecord[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is MonitorRecord => typeof entry === 'object' && entry !== null && !Array.isArray(entry)
  );
}

/**
 * Coerces arbitrary parsed JSON into a complete `MonitorDataset`.
 *
 * Non-array collections become empty; array members that are not objects are
 * dropped, because an invariant cannot meaningfully reason about `null`.
 */
export function normalizeDataset(raw: unknown): MonitorDataset {
  const source = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;

  return {
    agents: toRecords(source.agents),
    testCases: toRecords(source.testCases),
    testExecutions: toRecords(source.testExecutions),
    provenanceRecords: toRecords(source.provenanceRecords),
    referralCodes: toRecords(source.referralCodes),
    referrals: toRecords(source.referrals),
    payouts: toRecords(source.payouts),
    earningsLedger: toRecords(source.earningsLedger),
    bugReports: toRecords(source.bugReports),
    authorizationEvents: toRecords(source.authorizationEvents),
  };
}

/** Per-collection record counts, in a stable order suitable for reporting. */
export function countEntities(dataset: MonitorDataset): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const collection of DATASET_COLLECTIONS) {
    counts[collection] = dataset[collection].length;
  }
  return counts;
}

/** An empty dataset — every invariant passes vacuously, zero records scanned. */
export function emptyDataset(): MonitorDataset {
  return normalizeDataset({});
}
