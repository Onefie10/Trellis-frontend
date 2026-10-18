/**
 * The read-only monitor runner.
 *
 * `runInvariantMonitor` is a pure function over the dataset: it never mutates
 * the records it inspects, never touches the filesystem, network, or clock
 * beyond stamping the report, and never "repairs" anything it finds. Loading
 * is the caller's job (see `scripts/monitor-invariants.ts`), which keeps the
 * evaluation logic trivially testable and safely re-runnable.
 */

import { countEntities, normalizeDataset } from './dataset';
import { ALL_INVARIANTS } from './registry';
import {
  isSeverityAtLeast,
  type InvariantDefinition,
  type InvariantResult,
  type MonitorDataset,
  type MonitorOptions,
  type MonitorReport,
  type MonitorSummary,
  type Severity,
} from './types';

/** Injected so tests get a deterministic report timestamp. */
export interface RunOptions extends MonitorOptions {
  now?: Date;
}

function selectInvariants(options: RunOptions): readonly InvariantDefinition[] {
  let selected = ALL_INVARIANTS;

  if (options.domains && options.domains.length > 0) {
    const domains = new Set(options.domains);
    selected = selected.filter((invariant) => domains.has(invariant.domain));
  }

  if (options.only && options.only.length > 0) {
    const only = new Set(options.only);
    selected = selected.filter((invariant) => only.has(invariant.id));
  }

  return selected;
}

/**
 * Evaluates a single definition, converting a thrown error into a reported
 * failure so one faulty rule cannot hide the state of every other rule.
 *
 * Exported so a candidate invariant can be evaluated before it is registered.
 */
export function evaluateInvariant(
  definition: InvariantDefinition,
  dataset: MonitorDataset
): InvariantResult {
  let evaluation;
  try {
    evaluation = definition.evaluate(dataset);
  } catch (error) {
    // A throwing invariant is itself a monitoring failure and must not abort
    // the run, otherwise one bad rule hides the state of every other rule.
    return {
      id: definition.id,
      domain: definition.domain,
      title: definition.title,
      description: definition.description,
      rationale: definition.rationale,
      severity: definition.severity,
      remediation: definition.remediation,
      status: 'fail',
      evaluatedRecords: 0,
      violations: [
        {
          severity: 'critical',
          message: `Invariant ${definition.id} could not be evaluated: ${
            error instanceof Error ? error.message : String(error)
          }.`,
          remediation:
            'Treat this as a tooling fault, not a data fault. Fix the invariant, then re-run the monitor before trusting the rest of the report.',
          records: [{ entityType: 'Invariant', entityId: definition.id, detail: 'evaluation threw' }],
        },
      ],
    };
  }

  const violations = evaluation.violations.map((entry) => ({
    ...entry,
    // Every failure must carry next steps; fall back to the invariant's own
    // guidance when a violation did not override it.
    remediation: entry.remediation.trim() === '' ? definition.remediation : entry.remediation,
  }));

  return {
    id: definition.id,
    domain: definition.domain,
    title: definition.title,
    description: definition.description,
    rationale: definition.rationale,
    severity: definition.severity,
    remediation: definition.remediation,
    status: violations.length > 0 ? 'fail' : 'pass',
    evaluatedRecords: evaluation.evaluatedRecords,
    violations,
  };
}

function summarize(results: readonly InvariantResult[], dataset: MonitorDataset): MonitorSummary {
  const violationsBySeverity: Record<Severity, number> = { critical: 0, error: 0, warning: 0 };
  let totalViolations = 0;

  for (const result of results) {
    for (const entry of result.violations) {
      violationsBySeverity[entry.severity] += 1;
      totalViolations += 1;
    }
  }

  return {
    totalInvariants: results.length,
    passed: results.filter((result) => result.status === 'pass').length,
    failed: results.filter((result) => result.status === 'fail').length,
    violationsBySeverity,
    totalViolations,
    entitiesScanned: countEntities(dataset),
  };
}

/**
 * Evaluates every selected invariant against a dataset and returns a report
 * that contains a result for each one — pass and fail alike.
 *
 * @param rawDataset Parsed snapshot, or an already-normalized dataset.
 * @param options    Failure threshold and selection filters.
 */
export function runInvariantMonitor(
  rawDataset: unknown,
  options: RunOptions = {}
): MonitorReport {
  // normalizeDataset is idempotent, so an already-normalized dataset passes
  // through unchanged and a raw snapshot is coerced in one place.
  const dataset = normalizeDataset(rawDataset);

  const failOn: Severity = options.failOn ?? 'error';
  const definitions = selectInvariants(options);
  const results = definitions.map((definition) => evaluateInvariant(definition, dataset));
  const summary = summarize(results, dataset);

  const ok = results.every(
    (result) => !result.violations.some((entry) => isSeverityAtLeast(entry.severity, failOn))
  );

  return {
    timestamp: (options.now ?? new Date()).toISOString(),
    source: options.source ?? 'in-memory dataset',
    ok,
    failOn,
    summary,
    results,
  };
}

/** Convenience wrapper for callers that only need the failure roll-up. */
export function failingResults(report: MonitorReport): InvariantResult[] {
  return report.results.filter((result) => result.status === 'fail');
}
