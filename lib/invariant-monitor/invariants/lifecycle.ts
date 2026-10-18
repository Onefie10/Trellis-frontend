/**
 * Lifecycle invariants — state machine legality and timestamp coherence.
 *
 * Drift in this family is usually silent: a status or a date changes without
 * anything failing, and weeks later the dashboard and the chain disagree. The
 * rules below are the legal transitions and the ordering constraints that
 * `PayoutRequest`, `ReferralRecord`, `TestExecution`, and friends rely on.
 */

import {
  display,
  offending,
  readId,
  readNumber,
  readString,
  readTimestamp,
  violation,
} from '../internal/helpers';
import type { InvariantDefinition, MonitorRecord } from '../types';

const NO_MUTATION =
  'Do not coerce the value in the snapshot. Identify the writer that produced it, fix that, then re-run the monitor.';

/** Statuses each entity is allowed to hold. */
const ALLOWED_STATUS: Readonly<Record<string, readonly string[]>> = {
  Agent: ['active', 'inactive', 'draft'],
  TestExecution: ['pending', 'running', 'completed', 'failed'],
  ProvenanceRecord: ['success', 'failure', 'pending'],
  PayoutRequest: ['pending', 'processing', 'completed', 'failed'],
  ReferralRecord: ['active', 'inactive', 'converted'],
  BugReport: ['submitted', 'under_review', 'in_progress', 'resolved', 'rejected'],
};

const ALLOWED_BUG_PRIORITY = ['low', 'medium', 'high', 'critical'];

const ALLOWED_PROVENANCE_ACTION = [
  'input_received',
  'provider_call',
  'on_chain_submission',
  'output_generated',
  'error_encountered',
];

/** Every status and enum field must hold a value the domain recognises. */
const statusEnumsRecognized: InvariantDefinition = {
  id: 'LIFE-001',
  domain: 'lifecycle',
  title: 'Status and priority enums hold recognized values',
  description:
    'Agent, execution, provenance, payout, referral, and bug report statuses fall within their allowed sets, as do bug report priorities and provenance actions.',
  rationale:
    'The UI renders statuses as labels and uses them to pick branches. An unrecognized value renders as a blank and typically falls through to a default branch, hiding the record from the operator who needs it.',
  severity: 'error',
  remediation: `Map the value back onto a legal state using the source of truth, then fix the writer. ${NO_MUTATION}`,
  evaluate(dataset) {
    const sources: ReadonlyArray<readonly [string, readonly MonitorRecord[]]> = [
      ['Agent', dataset.agents],
      ['TestExecution', dataset.testExecutions],
      ['ProvenanceRecord', dataset.provenanceRecords],
      ['PayoutRequest', dataset.payouts],
      ['ReferralRecord', dataset.referrals],
      ['BugReport', dataset.bugReports],
    ];

    const violations = [];
    let evaluated = 0;

    for (const [entityType, records] of sources) {
      const allowed = ALLOWED_STATUS[entityType];
      for (const [index, record] of records.entries()) {
        const id = readId(record, index);
        const status = readString(record, 'status');
        evaluated += 1;
        if (status === null) {
          violations.push(
            violation('error', `${entityType} ${id} has a missing status.`, [
              offending(entityType, id, 'status is missing', 'status'),
            ])
          );
          continue;
        }
        if (!allowed.includes(status)) {
          violations.push(
            violation(
              'error',
              `${entityType} ${id} has unrecognized status '${status}' (expected one of: ${allowed.join(', ')}).`,
              [offending(entityType, id, `status is '${status}'`, 'status')],
              { details: { allowed } }
            )
          );
        }
      }
    }

    for (const [index, record] of dataset.bugReports.entries()) {
      const id = readId(record, index);
      const priority = readString(record, 'priority');
      if (priority !== null && !ALLOWED_BUG_PRIORITY.includes(priority)) {
        violations.push(
          violation('error', `BugReport ${id} has unrecognized priority '${priority}'.`, [
            offending('BugReport', id, `priority is '${priority}'`, 'priority'),
          ])
        );
      }
    }

    for (const [index, record] of dataset.provenanceRecords.entries()) {
      const id = readId(record, index);
      const action = readString(record, 'action');
      if (action !== null && !ALLOWED_PROVENANCE_ACTION.includes(action)) {
        violations.push(
          violation('error', `Provenance record ${id} has unrecognized action '${action}'.`, [
            offending('ProvenanceRecord', id, `action is '${action}'`, 'action'),
          ])
        );
      }
    }

    return { evaluatedRecords: evaluated, violations };
  },
};

/** Timestamps must parse, or every ordering rule below is meaningless. */
const timestampsParseable: InvariantDefinition = {
  id: 'LIFE-002',
  domain: 'lifecycle',
  title: 'Timestamps are parseable ISO-8601 values',
  description:
    'Every timestamp the monitor reads parses to a valid instant, including execution start/end, record created/updated, referral conversion, and payout request/process times.',
  rationale:
    'An unparseable date sorts unpredictably in the UI and cannot be range-queried, so affected records silently vanish from reports covering that window.',
  severity: 'error',
  remediation: `Recover the timestamp from the event log; if it is unrecoverable, mark the record as needing manual review rather than guessing a date. ${NO_MUTATION}`,
  evaluate(dataset) {
    const timestampFields: ReadonlyArray<readonly [string, readonly MonitorRecord[], string, string]> = [
      ['startTime', dataset.testExecutions, 'TestExecution', 'startTime'],
      ['endTime', dataset.testExecutions, 'TestExecution', 'endTime'],
      ['timestamp', dataset.provenanceRecords, 'ProvenanceRecord', 'timestamp'],
      ['createdAt', dataset.referrals, 'ReferralRecord', 'createdAt'],
      ['convertedAt', dataset.referrals, 'ReferralRecord', 'convertedAt'],
      ['requestedAt', dataset.payouts, 'PayoutRequest', 'requestedAt'],
      ['processedAt', dataset.payouts, 'PayoutRequest', 'processedAt'],
      ['createdAt', dataset.bugReports, 'BugReport', 'createdAt'],
      ['updatedAt', dataset.bugReports, 'BugReport', 'updatedAt'],
    ];

    const violations = [];
    let evaluated = 0;

    for (const [field, records, entityType, label] of timestampFields) {
      for (const [index, record] of records.entries()) {
        if (record[field] === undefined || record[field] === null) continue;
        evaluated += 1;
        if (readTimestamp(record, field) !== null) continue;
        violations.push(
          violation('error', `${entityType} ${readId(record, index)} has an unparseable ${label}: ${display(record[field])}.`, [
            offending(entityType, readId(record, index), `${label} is ${display(record[field])}`, field),
          ])
        );
      }
    }

    return { evaluatedRecords: evaluated, violations };
  },
};

/** An execution cannot end before it starts. */
const executionIntervalOrdered: InvariantDefinition = {
  id: 'LIFE-003',
  domain: 'lifecycle',
  title: 'Execution intervals are correctly ordered',
  description: 'For executions with an `endTime`, the end does not precede the start.',
  rationale:
    'A negative duration corrupts every duration statistic and benchmark trend derived from it, and hides genuinely slow runs inside negative averages.',
  severity: 'error',
  remediation: 'Discard the derived duration and re-measure the run. Do not swap the two timestamps to make the numbers look plausible.',
  evaluate(dataset) {
    const violations = [];
    for (const [index, record] of dataset.testExecutions.entries()) {
      const start = readTimestamp(record, 'startTime');
      const end = readTimestamp(record, 'endTime');
      if (start === null || end === null) continue;
      if (end < start) {
        const id = readId(record, index);
        violations.push(
          violation('error', `Test execution ${id} ends before it starts.`, [
            offending('TestExecution', id, `endTime ${record.endTime as string} precedes startTime ${record.startTime as string}`, 'endTime'),
          ])
        );
      }
    }
    return { evaluatedRecords: dataset.testExecutions.length, violations };
  },
};

/** An update cannot predate the record it updates. */
const recordUpdatesMonotonic: InvariantDefinition = {
  id: 'LIFE-004',
  domain: 'lifecycle',
  title: 'Record updates never predate their creation',
  description: 'For records with both `createdAt` and `updatedAt`, the update is at or after creation.',
  rationale:
    'A backwards update timestamp makes change history and audit trails unreadable, and breaks incremental sync, which replays everything newer than a watermark.',
  severity: 'error',
  remediation: 'Re-derive updatedAt from the underlying event log, or accept the record as having no trustworthy history and flag it for review.',
  evaluate(dataset) {
    const sources: ReadonlyArray<readonly [readonly MonitorRecord[], string]> = [
      [dataset.bugReports, 'BugReport'],
      [dataset.testCases, 'TestCase'],
      [dataset.agents, 'Agent'],
    ];

    const violations = [];
    let evaluated = 0;

    for (const [records, entityType] of sources) {
      for (const [index, record] of records.entries()) {
        const created = readTimestamp(record, 'createdAt');
        const updated = readTimestamp(record, 'updatedAt');
        if (created === null || updated === null) continue;
        evaluated += 1;
        if (updated < created) {
          violations.push(
            violation('error', `${entityType} ${readId(record, index)} was updated before it was created.`, [
              offending(
                entityType,
                readId(record, index),
                `updatedAt ${record.updatedAt as string} precedes createdAt ${record.createdAt as string}`,
                'updatedAt'
              ),
            ])
          );
        }
      }
    }

    return { evaluatedRecords: evaluated, violations };
  },
};

/** Conversion is a transition, so it must happen after the referral exists. */
const referralConversionAfterCreation: InvariantDefinition = {
  id: 'LIFE-005',
  domain: 'lifecycle',
  title: 'Referral conversions happen after creation',
  description: 'For converted referrals, `convertedAt` is at or after `createdAt`.',
  rationale:
    'A conversion timestamp earlier than creation means the conversion was back-dated or the record was reassembled from mismatched sources, and the attributed commission date cannot be trusted.',
  severity: 'error',
  remediation: 'Establish the true conversion time from the referral click and sign-up events before paying any commission against this record.',
  evaluate(dataset) {
    const violations = [];
    for (const [index, record] of dataset.referrals.entries()) {
      const created = readTimestamp(record, 'createdAt');
      const converted = readTimestamp(record, 'convertedAt');
      if (created === null || converted === null) continue;
      if (converted < created) {
        violations.push(
          violation('error', `Referral ${readId(record, index)} converted before it was created.`, [
            offending(
              'ReferralRecord',
              readId(record, index),
              `convertedAt ${record.convertedAt as string} precedes createdAt ${record.createdAt as string}`,
              'convertedAt'
            ),
          ])
        );
      }
    }
    return { evaluatedRecords: dataset.referrals.length, violations };
  },
};

/**
 * Terminal payouts must be stamped, and stamped after they were requested.
 *
 * A `completed` payout with no `processedAt` cannot appear in any "paid this
 * period" report, so it silently disappears from the affiliate's history.
 */
const terminalPayoutsStamped: InvariantDefinition = {
  id: 'LIFE-006',
  domain: 'lifecycle',
  title: 'Settled payouts are timestamped after they were requested',
  description:
    'Payouts in a terminal state (`completed` or `failed`) carry a `processedAt` that is at or after `requestedAt`.',
  rationale:
    'Without a processing stamp, settlement cannot be placed in a payout period, so period-over-period affiliate statements disagree with the chain and cannot be reconciled.',
  severity: 'error',
  remediation: 'Recover processedAt from the settlement job run that produced the transaction hash before issuing affiliate statements.',
  evaluate(dataset) {
    const violations = [];
    for (const [index, record] of dataset.payouts.entries()) {
      const status = readString(record, 'status');
      if (status !== 'completed' && status !== 'failed') continue;
      const id = readId(record, index);
      const requested = readTimestamp(record, 'requestedAt');
      const processed = readTimestamp(record, 'processedAt');

      if (processed === null) {
        violations.push(
          violation('error', `Payout ${id} is ${status} but has no processedAt stamp.`, [
            offending('PayoutRequest', id, `status is ${status} with no processedAt`, 'processedAt'),
          ])
        );
        continue;
      }
      if (requested !== null && processed < requested) {
        violations.push(
          violation('error', `Payout ${id} was processed before it was requested.`, [
            offending(
              'PayoutRequest',
              id,
              `processedAt ${record.processedAt as string} precedes requestedAt ${record.requestedAt as string}`,
              'processedAt'
            ),
          ])
        );
      }
    }
    return { evaluatedRecords: dataset.payouts.length, violations };
  },
};

/** The `converted` state and `convertedAt` must agree with each other. */
const referralConversionStateCoherent: InvariantDefinition = {
  id: 'LIFE-007',
  domain: 'lifecycle',
  title: 'Referral conversion state and timestamp agree',
  description:
    'A referral in the `converted` state has a `convertedAt`, and a referral that is not `converted` does not.',
  rationale:
    'Conversion is what releases the commission. If the two disagree, commission is either released with no evidence of conversion or withheld despite one, and neither can be explained from the record.',
  severity: 'error',
  remediation:
    'Derive the authoritative conversion time from referral click metrics, then align the status and the timestamp in the same operation.',
  evaluate(dataset) {
    const violations = [];
    for (const [index, record] of dataset.referrals.entries()) {
      const id = readId(record, index);
      const status = readString(record, 'status');
      const convertedAt = readString(record, 'convertedAt');
      if (status === 'converted' && convertedAt === null) {
        violations.push(
          violation('error', `Referral ${id} is converted but records no conversion time.`, [
            offending('ReferralRecord', id, 'status is converted with no convertedAt', 'convertedAt'),
          ])
        );
        continue;
      }
      if (status !== 'converted' && convertedAt !== null) {
        violations.push(
          violation('error', `Referral ${id} is '${status}' yet carries a conversion time.`, [
            offending(
              'ReferralRecord',
              id,
              `status is '${status}' but convertedAt is set to ${convertedAt}`,
              'convertedAt'
            ),
          ])
        );
      }
    }
    return { evaluatedRecords: dataset.referrals.length, violations };
  },
};

/** Quality scores and resource metrics must stay in physical range. */
const executionMetricsInRange: InvariantDefinition = {
  id: 'LIFE-008',
  domain: 'lifecycle',
  title: 'Execution scores and resource metrics are in range',
  description:
    '`qualityScore` lies within [0, 100] and every recorded resource metric is finite and non-negative.',
  rationale:
    'A score above 100 or a negative byte count means the benchmark collector is misreporting, which silently distorts agent leaderboards and any cost model fed from these numbers.',
  severity: 'warning',
  remediation: 'Inspect the benchmark collector and clamp at the source. Leave the record in place; it is evidence of the collector bug.',
  evaluate(dataset) {
    const violations = [];
    for (const [index, record] of dataset.testExecutions.entries()) {
      const id = readId(record, index);
      const score = readNumber(record, 'qualityScore');
      if (score !== null && (score < 0 || score > 100)) {
        violations.push(
          violation('warning', `Test execution ${id} has a qualityScore of ${score}, outside [0, 100].`, [
            offending('TestExecution', id, `qualityScore is ${score}`, 'qualityScore'),
          ])
        );
      }

      const metrics = record.metrics;
      if (typeof metrics !== 'object' || metrics === null) continue;
      const bag = metrics as Record<string, unknown>;
      for (const field of ['cpuInstructions', 'ramBytes', 'ledgerReadBytes', 'ledgerWriteBytes', 'readCount', 'writeCount']) {
        const value = readNumber(bag, field);
        if (value === null) continue;
        if (value < 0) {
          violations.push(
            violation('warning', `Test execution ${id} records a negative ${field} of ${value}.`, [
              offending('TestExecution', id, `${field} is ${value}`, `metrics.${field}`),
            ])
          );
        }
      }
    }
    return { evaluatedRecords: dataset.testExecutions.length, violations };
  },
};

export const LIFECYCLE_INVARIANTS: readonly InvariantDefinition[] = Object.freeze([
  statusEnumsRecognized,
  timestampsParseable,
  executionIntervalOrdered,
  recordUpdatesMonotonic,
  referralConversionAfterCreation,
  terminalPayoutsStamped,
  referralConversionStateCoherent,
  executionMetricsInRange,
]);

/** Re-exported for documentation tooling that enumerates legal states. */
export { ALLOWED_STATUS, ALLOWED_BUG_PRIORITY, ALLOWED_PROVENANCE_ACTION };
