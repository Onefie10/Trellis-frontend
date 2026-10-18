/**
 * Funds invariants — value conservation and settlement proof.
 *
 * These are the checks a maintainer runs when money is unaccounted for. They
 * are deliberately conservative: nothing here moves, cancels, or rewrites a
 * payout. A failure is a signal to reconcile against the Stellar ledger, not
 * an instruction to edit the database.
 */

import { MINIMUM_PAYOUT_XLM } from '../../affiliate-store';
import {
  display,
  groupByField,
  offending,
  parseAmount,
  readId,
  readString,
  violation,
} from '../internal/helpers';
import type { InvariantDefinition } from '../types';

const NO_MUTATION =
  'Do not edit the snapshot to make this pass. Reconcile against the Stellar ledger, then re-run the monitor.';

/** Amounts must be finite and strictly positive; `"150.00oops"` is corruption. */
const payoutAmountWellformed: InvariantDefinition = {
  id: 'FUNDS-001',
  domain: 'funds',
  title: 'Payout amounts are well-formed and strictly positive',
  description:
    'Every payout carries an amount that parses as a complete finite number greater than zero.',
  rationale:
    'A zero, negative, or unparseable amount is either a corrupted export or an attempt to inflate a balance. Neither should ever reach settlement.',
  severity: 'critical',
  remediation: `Reconcile the payout against the originating request. ${NO_MUTATION}`,
  evaluate(dataset) {
    const violations = [];
    for (const [index, payout] of dataset.payouts.entries()) {
      const id = readId(payout, index);
      const raw = payout.amount;
      const amount = parseAmount(raw);
      if (amount === null) {
        violations.push(
          violation('critical', `Payout ${id} has an unparseable amount ${display(raw)}.`, [
            offending('PayoutRequest', id, `amount is ${display(raw)}, expected a finite number`, 'amount'),
          ])
        );
        continue;
      }
      if (amount <= 0) {
        violations.push(
          violation('critical', `Payout ${id} has a non-positive amount of ${amount}.`, [
            offending('PayoutRequest', id, `amount is ${amount}, expected greater than 0`, 'amount'),
          ])
        );
      }
    }
    return { evaluatedRecords: dataset.payouts.length, violations };
  },
};

/** A completed payout without a transaction hash is unproven settlement. */
const settlementReferencePresent: InvariantDefinition = {
  id: 'FUNDS-002',
  domain: 'funds',
  title: 'Completed payouts carry an on-chain settlement reference',
  description:
    'Every payout in the `completed` state has a non-empty `transactionHash` tying it to a Stellar transaction.',
  rationale:
    'Completion is the point at which Trellis asserts funds moved. Without a transaction hash that assertion is unverifiable, and the affiliate ledger can diverge from the chain indefinitely.',
  severity: 'critical',
  remediation:
    'Look the payout up on the Stellar explorer by amount and recipient. If funds did move, attach the real hash; if they did not, reopen the payout. Do not fabricate a hash.',
  evaluate(dataset) {
    const violations = [];
    for (const [index, payout] of dataset.payouts.entries()) {
      if (payout.status !== 'completed') continue;
      const id = readId(payout, index);
      const hash = readString(payout, 'transactionHash');
      if (hash === null) {
        violations.push(
          violation(
            'critical',
            `Payout ${id} is marked completed but has no transactionHash.`,
            [offending('PayoutRequest', id, 'status is completed with no settlement proof', 'transactionHash')]
          )
        );
      }
    }
    return { evaluatedRecords: dataset.payouts.length, violations };
  },
};

/** Cumulative completed payouts may never exceed credited earnings. */
const payoutsWithinEarnedBalance: InvariantDefinition = {
  id: 'FUNDS-003',
  domain: 'funds',
  title: 'Completed payouts never exceed credited earnings',
  description:
    'For each wallet, the sum of completed payout amounts is less than or equal to its `earningsLedger` entry.',
  rationale:
    'Paying out more than was ever earned means the ledger is corrupt, an affiliate was paid twice, or funds originated outside the programme. All three are fund-loss scenarios.',
  severity: 'critical',
  remediation: `Freeze the wallet's payout queue and escalate to finance before any further settlement. ${NO_MUTATION}`,
  evaluate(dataset) {
    const earned = new Map<string, number>();
    for (const [index, entry] of dataset.earningsLedger.entries()) {
      const wallet = readString(entry, 'wallet');
      const value = parseAmount(entry.earnedXlm);
      if (wallet === null || value === null) continue;
      earned.set(wallet, (earned.get(wallet) ?? 0) + value);
      void index;
    }

    const paid = new Map<string, { total: number; ids: string[] }>();
    for (const [index, payout] of dataset.payouts.entries()) {
      if (payout.status !== 'completed') continue;
      const wallet = readString(payout, 'walletAddress');
      const amount = parseAmount(payout.amount);
      if (wallet === null || amount === null) continue;
      const bucket = paid.get(wallet) ?? { total: 0, ids: [] };
      bucket.total += amount;
      bucket.ids.push(readId(payout, index));
      paid.set(wallet, bucket);
    }

    const violations = [];
    for (const [wallet, { total, ids }] of paid) {
      const credited = earned.get(wallet);
      if (credited === undefined) {
        violations.push(
          violation(
            'critical',
            `Wallet ${wallet} has ${ids.length} completed payout(s) totalling ${total} XLM but no earnings ledger entry.`,
            ids.map((id) =>
              offending('PayoutRequest', id, `wallet ${wallet} is absent from the earnings ledger`)
            ),
            {
              remediation:
                'Treat the wallet as unverified: do not release further payouts. Establish where the credited earnings went before reconciling the balance.',
              details: { wallet, totalPaid: total, payoutIds: ids },
            }
          )
        );
        continue;
      }
      if (total > credited) {
        violations.push(
          violation(
            'critical',
            `Wallet ${wallet} was paid ${total} XLM against ${credited} XLM of credited earnings.`,
            ids.map((id) =>
              offending('PayoutRequest', id, `contributes to an overpayment of ${total - credited} XLM`)
            ),
            { details: { wallet, totalPaid: total, totalEarned: credited, payoutIds: ids } }
          )
        );
      }
    }

    return { evaluatedRecords: paid.size, violations };
  },
};

/** Sub-threshold payouts are drift, not loss — reported as a warning. */
const payoutMeetsMinimumThreshold: InvariantDefinition = {
  id: 'FUNDS-004',
  domain: 'funds',
  title: 'Payouts meet the affiliate minimum threshold',
  description: `Every payout amount is at least the configured minimum of ${MINIMUM_PAYOUT_XLM} XLM.`,
  rationale:
    'Dust payouts cost more in fees and administrative effort than the amount moved, and a threshold breach usually signals a client bug rather than deliberate intent.',
  severity: 'warning',
  remediation:
    'Confirm the request was assembled with the correct units (XLM versus stroops). Leave the warning in place if the payout was intentional.',
  evaluate(dataset) {
    const violations = [];
    for (const [index, payout] of dataset.payouts.entries()) {
      const amount = parseAmount(payout.amount);
      if (amount === null || amount >= MINIMUM_PAYOUT_XLM) continue;
      const id = readId(payout, index);
      violations.push(
        violation(
          'warning',
          `Payout ${id} is ${amount} XLM, below the ${MINIMUM_PAYOUT_XLM} XLM minimum.`,
          [offending('PayoutRequest', id, `amount ${amount} < minimum ${MINIMUM_PAYOUT_XLM}`, 'amount')]
        )
      );
    }
    return { evaluatedRecords: dataset.payouts.length, violations };
  },
};

/** Earnings are an accrual; a negative accrual is always corrupt. */
const earningsLedgerNonNegative: InvariantDefinition = {
  id: 'FUNDS-005',
  domain: 'funds',
  title: 'Earnings ledger entries are finite and non-negative',
  description: 'Every `earningsLedger` entry has a finite, non-negative `earnedXlm`.',
  rationale:
    'A negative accrual is used to claw back funds already credited. That is a governance decision, not something a monitor snapshot should encode silently.',
  severity: 'error',
  remediation: `Trace the accrual source before changing anything. ${NO_MUTATION}`,
  evaluate(dataset) {
    const violations = [];
    for (const [index, entry] of dataset.earningsLedger.entries()) {
      // Earnings rows are keyed by wallet, not by an `id` column.
      const wallet = readString(entry, 'wallet');
      const id = wallet ?? `UNKNOWN[${index}]`;
      const value = parseAmount(entry.earnedXlm);
      if (value === null) {
        violations.push(
          violation('error', `Earnings entry for ${id} has an unparseable earnedXlm ${display(entry.earnedXlm)}.`, [
            offending('EarningsLedger', id, `earnedXlm is ${display(entry.earnedXlm)}`, 'earnedXlm'),
          ])
        );
        continue;
      }
      if (value < 0) {
        violations.push(
          violation('error', `Earnings entry for ${id} records a negative balance of ${value} XLM.`, [
            offending('EarningsLedger', id, `earnedXlm is ${value}`, 'earnedXlm'),
          ])
        );
      }
    }
    return { evaluatedRecords: dataset.earningsLedger.length, violations };
  },
};

/** The same transaction hash settling two payouts is a double-spend. */
const settlementNotReplayed: InvariantDefinition = {
  id: 'FUNDS-006',
  domain: 'funds',
  title: 'Settlement hashes are not replayed across payouts',
  description: 'No two completed payouts share the same `transactionHash`.',
  rationale:
    'One Stellar transaction can only move funds once. Reusing a hash across payout records means the same settlement was counted twice, inflating what was paid out.',
  severity: 'critical',
  remediation:
    'Identify which of the linked payouts is the genuine settlement and have the other reversed through the normal payout correction flow. Never delete a payout to resolve this.',
  evaluate(dataset) {
    const completed = dataset.payouts.filter(
      (payout) => payout.status === 'completed' && readString(payout, 'transactionHash') !== null
    );
    const byHash = groupByField(completed, 'transactionHash');
    const violations = [];
    for (const [hash, entries] of byHash) {
      if (entries.length < 2) continue;
      violations.push(
        violation(
          'critical',
          `Transaction hash ${hash} is claimed by ${entries.length} completed payouts.`,
          entries.map(({ record, index }) =>
            offending('PayoutRequest', readId(record, index), `reuses settlement hash ${hash}`, 'transactionHash')
          ),
          { details: { transactionHash: hash, payoutIds: entries.map(({ record, index }) => readId(record, index)) } }
        )
      );
    }
    return { evaluatedRecords: completed.length, violations };
  },
};

/** Commission terms are what the referral contract pays; they must be sane. */
const commissionTermsWellformed: InvariantDefinition = {
  id: 'FUNDS-007',
  domain: 'funds',
  title: 'Referral commission terms are within bounds',
  description:
    'Each referral has a `commissionRate` in [0, 100] and a `commissionAmount` that parses to a finite, non-negative number.',
  rationale:
    'The commission schedule mirrors what the referral contract pays. A rate above 100 or a negative amount means the UI and the contract disagree, so affiliates would be paid the wrong figure.',
  severity: 'error',
  remediation:
    'Compare against AFFILIATE_PROGRAM_CONFIG in lib/affiliate-store.ts. If the contract changed, update the config there rather than patching snapshots.',
  evaluate(dataset) {
    const violations = [];
    for (const [index, referral] of dataset.referrals.entries()) {
      const id = readId(referral, index);
      const rate = typeof referral.commissionRate === 'number' ? referral.commissionRate : Number(referral.commissionRate);
      if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
        violations.push(
          violation('error', `Referral ${id} has an out-of-range commissionRate of ${display(referral.commissionRate)}.`, [
            offending('ReferralRecord', id, `commissionRate is ${display(referral.commissionRate)}, expected 0-100`, 'commissionRate'),
          ])
        );
      }
      const amount = parseAmount(referral.commissionAmount);
      if (amount === null) {
        violations.push(
          violation('error', `Referral ${id} has an unparseable commissionAmount ${display(referral.commissionAmount)}.`, [
            offending('ReferralRecord', id, `commissionAmount is ${display(referral.commissionAmount)}`, 'commissionAmount'),
          ])
        );
      } else if (amount < 0) {
        violations.push(
          violation('error', `Referral ${id} accrues a negative commission of ${amount}.`, [
            offending('ReferralRecord', id, `commissionAmount is ${amount}`, 'commissionAmount'),
          ])
        );
      }
    }
    return { evaluatedRecords: dataset.referrals.length, violations };
  },
};

export const FUNDS_INVARIANTS: readonly InvariantDefinition[] = Object.freeze([
  payoutAmountWellformed,
  settlementReferencePresent,
  payoutsWithinEarnedBalance,
  payoutMeetsMinimumThreshold,
  earningsLedgerNonNegative,
  settlementNotReplayed,
  commissionTermsWellformed,
]);
