/**
 * Ownership invariants — identity, attribution, and referential integrity.
 *
 * Trellis has no single `User` entity: a person appears as an agent author, a
 * referral code owner, a referred address, a provenance user, and a bug report
 * reporter. These invariants check that those representations agree about who
 * owns what, which is the failure mode that silently misdirects commissions.
 */

import {
  collectStrings,
  display,
  groupByField,
  isStellarAddress,
  offending,
  readId,
  readString,
  violation,
} from '../internal/helpers';
import type { InvariantDefinition, MonitorRecord } from '../types';

const NO_MUTATION =
  'Do not rewrite identifiers in the snapshot to clear this. Fix the upstream writer, then re-run the monitor.';

/** Every collection must have a unique, non-empty primary key. */
const entityIdentifiersUnique: InvariantDefinition = {
  id: 'OWN-001',
  domain: 'ownership',
  title: 'Entity identifiers are present and unique',
  description:
    'Agents, test cases, executions, provenance records, referrals, payouts, bug reports, and authorization events each have a non-empty, unique `id`.',
  rationale:
    'Identifiers are the join key for every other invariant and for the restoration pipeline. A duplicate or blank id makes attribution ambiguous and causes one record to silently mask another.',
  severity: 'critical',
  remediation: `Re-index the affected collection from the authoritative source. ${NO_MUTATION}`,
  evaluate(dataset) {
    const collections: ReadonlyArray<readonly [string, readonly MonitorRecord[]]> = [
      ['Agent', dataset.agents],
      ['TestCase', dataset.testCases],
      ['TestExecution', dataset.testExecutions],
      ['ProvenanceRecord', dataset.provenanceRecords],
      ['ReferralRecord', dataset.referrals],
      ['PayoutRequest', dataset.payouts],
      ['BugReport', dataset.bugReports],
      ['AuthorizationEvent', dataset.authorizationEvents],
    ];

    const violations = [];
    let evaluated = 0;

    for (const [entityType, records] of collections) {
      evaluated += records.length;
      const seen = new Set<string>();
      for (const [index, record] of records.entries()) {
        const id = readId(record, index);
        if (id.startsWith('UNKNOWN[')) {
          violations.push(
            violation('critical', `${entityType} at position ${index} has a missing or empty id.`, [
              offending(entityType, id, `record at index ${index} has no usable id`, 'id'),
            ])
          );
          continue;
        }
        if (seen.has(id)) {
          violations.push(
            violation('critical', `${entityType} id '${id}' is used by more than one record.`, [
              offending(entityType, id, `duplicate identifier at index ${index}`, 'id'),
            ])
          );
          continue;
        }
        seen.add(id);
      }
    }

    return { evaluatedRecords: evaluated, violations };
  },
};

/** Referral codes are the public handle for attribution; collisions mispay. */
const referralCodesUnique: InvariantDefinition = {
  id: 'OWN-002',
  domain: 'ownership',
  title: 'Referral codes are present and unique',
  description: 'Every entry in `referralCodes` has a non-empty `code` that is globally unique.',
  rationale:
    'A duplicate or blank code makes it impossible to determine who referred whom, so commissions are attributed to an arbitrary owner.',
  severity: 'critical',
  remediation: 'Ask the registry owner which wallet legitimately holds the code, then void the other claim through the affiliate registry API.',
  evaluate(dataset) {
    const violations = [];
    const seen = new Set<string>();
    for (const [index, entry] of dataset.referralCodes.entries()) {
      const code = readString(entry, 'code');
      const owner = readString(entry, 'ownerWallet');
      if (code === null) {
        violations.push(
          violation('critical', `Referral code at position ${index} has a missing or empty code.`, [
            offending('ReferralCode', owner ?? `UNKNOWN[${index}]`, `record at index ${index} has no code`, 'code'),
          ])
        );
        continue;
      }
      if (seen.has(code)) {
        violations.push(
          violation('critical', `Referral code '${code}' is registered more than once.`, [
            offending('ReferralCode', code, `duplicate code at index ${index}`, 'code'),
          ])
        );
        continue;
      }
      seen.add(code);
    }
    return { evaluatedRecords: dataset.referralCodes.length, violations };
  },
};

/** A referral must point at a code that actually exists. */
const referralCodeResolves: InvariantDefinition = {
  id: 'OWN-003',
  domain: 'ownership',
  title: 'Referrals resolve to a registered referral code',
  description: 'Every `referrals[].referralCode` matches an entry in `referralCodes`.',
  rationale:
    'An unresolvable code means commission for that referral cannot be attributed to anyone. The money still moved, so the ledger drifts by exactly that amount.',
  severity: 'error',
  remediation:
    'Check whether the code was deleted or renamed. If the referral is genuine, restore the code; otherwise void the referral so the commission is not paid.',
  evaluate(dataset) {
    // An empty registry means the snapshot simply did not include codes; that
    // is an incomplete snapshot, not a dangling reference.
    if (dataset.referralCodes.length === 0) {
      return { evaluatedRecords: dataset.referrals.length, violations: [] };
    }
    const known = new Set(collectStrings(dataset.referralCodes, 'code'));
    const violations = [];
    for (const [index, referral] of dataset.referrals.entries()) {
      const code = readString(referral, 'referralCode');
      if (code === null) {
        violations.push(
          violation('error', `Referral ${readId(referral, index)} has a missing referralCode.`, [
            offending('ReferralRecord', readId(referral, index), 'referralCode is missing', 'referralCode'),
          ])
        );
        continue;
      }
      if (!known.has(code)) {
        violations.push(
          violation('error', `Referral ${readId(referral, index)} references unregistered code '${code}'.`, [
            offending('ReferralRecord', readId(referral, index), `unregistered code '${code}'`, 'referralCode'),
          ])
        );
      }
    }
    return { evaluatedRecords: dataset.referrals.length, violations };
  },
};

/** Referring yourself is the classic commission-avoidance vector. */
const noSelfReferral: InvariantDefinition = {
  id: 'OWN-004',
  domain: 'ownership',
  title: 'No wallet refers itself',
  description:
    'The owner of a referral code never appears as the referred address on a referral using that code.',
  rationale:
    'A self-referral pays commission from the platform to the same wallet that generated the referral, extracting funds without bringing in a new participant.',
  severity: 'critical',
  remediation:
    'Disqualify the referral from commission eligibility and reverse any commission already accrued to that wallet.',
  evaluate(dataset) {
    if (dataset.referralCodes.length === 0) {
      return { evaluatedRecords: dataset.referrals.length, violations: [] };
    }
    const ownerByCode = new Map(
      dataset.referralCodes
        .map((entry) => [readString(entry, 'code'), readString(entry, 'ownerWallet')] as const)
        .filter((pair): pair is readonly [string, string] => pair[0] !== null && pair[1] !== null)
    );

    const violations = [];
    for (const [index, referral] of dataset.referrals.entries()) {
      const code = readString(referral, 'referralCode');
      const referred = readString(referral, 'referredUserAddress');
      if (code === null || referred === null) continue;
      const owner = ownerByCode.get(code);
      if (owner !== undefined && owner === referred) {
        violations.push(
          violation(
            'critical',
            `Referral ${readId(referral, index)} lets ${owner} refer themselves.`,
            [
              offending(
                'ReferralRecord',
                readId(referral, index),
                `code '${code}' is owned by the referred wallet`
              ),
            ],
            { details: { wallet: owner, referralCode: code } }
          )
        );
      }
    }
    return { evaluatedRecords: dataset.referrals.length, violations };
  },
};

/**
 * Every wallet address in the snapshot must be a real Stellar account.
 *
 * The disaster-recovery validator only checked payout addresses even though
 * its comment claimed broader coverage; this check covers all four places a
 * wallet can appear.
 */
const walletAddressesWellFormed: InvariantDefinition = {
  id: 'OWN-005',
  domain: 'ownership',
  title: 'Wallet addresses are well-formed Stellar public keys',
  description:
    'Payout recipients, referred addresses, referral code owners, and bug report reporters all match the Stellar account format `G` + 55 base32 characters.',
  rationale:
    'A malformed address cannot have received funds. If it appears on a settled record, either the record is corrupt or the transfer silently failed while being marked successful.',
  severity: 'critical',
  remediation:
    'Re-derive the address from the originating wallet signature. If no valid address can be recovered, treat the settlement as unverified and do not retry the transfer to the bad address.',
  evaluate(dataset) {
    const sources: ReadonlyArray<[string, readonly MonitorRecord[], string, string]> = [
      ['walletAddress', dataset.payouts, 'PayoutRequest', 'PayoutRequest.walletAddress'],
      ['referredUserAddress', dataset.referrals, 'ReferralRecord', 'ReferralRecord.referredUserAddress'],
      ['ownerWallet', dataset.referralCodes, 'ReferralCode', 'ReferralCode.ownerWallet'],
      ['reporterAddress', dataset.bugReports, 'BugReport', 'BugReport.reporterAddress'],
    ];

    const violations = [];
    let evaluated = 0;

    for (const [field, records, entityType, label] of sources) {
      for (const [index, record] of records.entries()) {
        const value = record[field];
        if (value === undefined) continue;
        evaluated += 1;
        if (isStellarAddress(value)) continue;
        violations.push(
          violation('critical', `${label} is not a valid Stellar address: ${display(value)}.`, [
            offending(entityType, readId(record, index), `${field} is ${display(value)}`, field),
          ])
        );
      }
    }

    return { evaluatedRecords: evaluated, violations };
  },
};

/** Provenance must point at an agent that exists. */
const provenanceAgentResolves: InvariantDefinition = {
  id: 'OWN-006',
  domain: 'ownership',
  title: 'Provenance records resolve to a known agent',
  description: 'Every `provenanceRecords[].agentId` matches an entry in `agents`.',
  rationale:
    'Provenance is the audit trail that explains which agent acted. If the agent cannot be resolved, the action cannot be attributed to a publisher, so the audit trail is worthless for disputes.',
  severity: 'error',
  remediation:
    'Confirm whether the agent was deleted or whether the export dropped it. A restored agent record is safer than discarding its provenance.',
  evaluate(dataset) {
    if (dataset.agents.length === 0) {
      return { evaluatedRecords: dataset.provenanceRecords.length, violations: [] };
    }
    const known = new Set(collectStrings(dataset.agents, 'id'));
    const violations = [];
    for (const [index, record] of dataset.provenanceRecords.entries()) {
      const agentId = readString(record, 'agentId');
      if (agentId === null) {
        violations.push(
          violation('error', `Provenance record ${readId(record, index)} has no agentId.`, [
            offending('ProvenanceRecord', readId(record, index), 'agentId is missing', 'agentId'),
          ])
        );
        continue;
      }
      if (!known.has(agentId)) {
        violations.push(
          violation('error', `Provenance record ${readId(record, index)} references unknown agent '${agentId}'.`, [
            offending('ProvenanceRecord', readId(record, index), `unresolved agentId '${agentId}'`, 'agentId'),
          ])
        );
      }
    }
    return { evaluatedRecords: dataset.provenanceRecords.length, violations };
  },
};

/** Executions must point at a test case that exists. */
const executionCaseResolves: InvariantDefinition = {
  id: 'OWN-007',
  domain: 'ownership',
  title: 'Test executions resolve to a known test case',
  description: 'Every `testExecutions[].testCaseId` matches an entry in `testCases`.',
  rationale:
    'An execution with no test case is a result nobody can reproduce or trust, because the inputs and expected output are gone.',
  severity: 'error',
  remediation: 'Restore the test case from version control. If it was intentionally removed, drop the execution too.',
  evaluate(dataset) {
    const known = new Set(collectStrings(dataset.testCases, 'id'));
    const violations = [];
    for (const [index, execution] of dataset.testExecutions.entries()) {
      const testCaseId = readString(execution, 'testCaseId');
      const id = readId(execution, index);
      if (testCaseId === null) {
        violations.push(
          violation('error', `Test execution ${id} has no testCaseId.`, [
            offending('TestExecution', id, 'testCaseId is missing', 'testCaseId'),
          ])
        );
        continue;
      }
      if (!known.has(testCaseId)) {
        violations.push(
          violation('error', `Test execution ${id} references unknown test case '${testCaseId}'.`, [
            offending('TestExecution', id, `unresolved testCaseId '${testCaseId}'`, 'testCaseId'),
          ])
        );
      }
    }
    return { evaluatedRecords: dataset.testExecutions.length, violations };
  },
};

/** A duplicated code owned by two different wallets splits attribution. */
const referralCodeHasSingleOwner: InvariantDefinition = {
  id: 'OWN-008',
  domain: 'ownership',
  title: 'A referral code resolves to exactly one owner',
  description: 'No referral code is registered against more than one distinct `ownerWallet`.',
  rationale:
    'Two owners for one code is a merge accident. Every referral using that code is attributed to an arbitrary one of them, so commission routing is nondeterministic.',
  severity: 'critical',
  remediation:
    'Determine which wallet registered first and void the later claim. Do not attempt to split past commissions between the two owners.',
  evaluate(dataset) {
    const violations = [];
    for (const [code, entries] of groupByField(dataset.referralCodes, 'code')) {
      const owners = new Set<string>();
      for (const { record } of entries) {
        const owner = readString(record, 'ownerWallet');
        if (owner !== null) owners.add(owner);
      }
      if (owners.size < 2) continue;
      violations.push(
        violation(
          'critical',
          `Referral code '${code}' is claimed by ${owners.size} distinct wallets.`,
          [...owners].map((owner) =>
            offending('ReferralCode', code, `claimed by ${owner}`, 'ownerWallet')
          ),
          { details: { referralCode: code, owners: [...owners] } }
        )
      );
    }
    return { evaluatedRecords: dataset.referralCodes.length, violations };
  },
};

export const OWNERSHIP_INVARIANTS: readonly InvariantDefinition[] = Object.freeze([
  entityIdentifiersUnique,
  referralCodesUnique,
  referralCodeResolves,
  noSelfReferral,
  walletAddressesWellFormed,
  provenanceAgentResolves,
  executionCaseResolves,
  referralCodeHasSingleOwner,
]);
