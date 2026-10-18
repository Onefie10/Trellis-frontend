/**
 * Proposal execution audit timeline.
 *
 * Turns a proposal's on-chain execution history (creation, votes, queueing,
 * execution) into render-ready timeline steps, and parses the transaction
 * records Soroban RPC and Horizon return so every step can show its ledger,
 * fee and contract events next to a block explorer link.
 */

import { scValToNative, xdr } from '@stellar/stellar-sdk';
import type {
  ContractEventLog,
  Proposal,
  ProposalExecutionRecord,
  ProposalLifecycleStep,
} from '@/lib/governance/types';
import type { StellarNetwork } from '@/lib/types';
import {
  STELLAR_NETWORKS,
  isValidLedgerSequence,
  isValidTransactionHash,
} from '@/lib/stellar-constants';

/** Normalised transaction status across Soroban RPC and Horizon. */
export type TransactionStatus = 'success' | 'failed' | 'pending' | 'not_found' | 'unknown';

/** How a step is drawn: finished on-chain, rejected, in flight, or still ahead. */
export type TimelineStepState = 'confirmed' | 'failed' | 'pending' | 'upcoming';

export interface ExecutionTimelineStep {
  id: string;
  step: ProposalLifecycleStep;
  label: string;
  state: TimelineStepState;
  txStatus: TransactionStatus;
  timestamp?: string;
  txHash?: string;
  ledger?: number;
  feeChargedStroops?: string;
  actor?: string;
  events: ContractEventLog[];
}

export const LIFECYCLE_LABELS: Record<ProposalLifecycleStep, string> = {
  created: 'Proposal created',
  vote_cast: 'Vote cast',
  voting_closed: 'Voting closed',
  queued: 'Queued in timelock',
  executed: 'Executed',
  failed: 'Execution failed',
  expired: 'Expired',
};

const STROOPS_PER_XLM = BigInt(10_000_000);

/**
 * Maps the status vocabulary of every source we read into one set:
 *
 *   Soroban RPC getTransaction   SUCCESS | FAILED | NOT_FOUND
 *   Soroban RPC sendTransaction  PENDING | DUPLICATE | TRY_AGAIN_LATER | ERROR
 *   Horizon transaction record   { successful: boolean }
 */
export function parseTransactionStatus(raw: unknown): TransactionStatus {
  if (raw && typeof raw === 'object') {
    const record = raw as { successful?: unknown; status?: unknown };
    if (typeof record.successful === 'boolean') return record.successful ? 'success' : 'failed';
    if (record.status !== undefined) return parseTransactionStatus(record.status);
    return 'unknown';
  }
  if (typeof raw === 'boolean') return raw ? 'success' : 'failed';
  if (typeof raw !== 'string') return 'unknown';

  switch (raw.trim().toUpperCase()) {
    case 'SUCCESS':
    case 'SUCCESSFUL':
    case 'CONFIRMED':
      return 'success';
    case 'FAILED':
    case 'ERROR':
      return 'failed';
    case 'PENDING':
    case 'DUPLICATE':
    case 'TRY_AGAIN_LATER':
    case 'SUBMITTED':
      return 'pending';
    case 'NOT_FOUND':
      return 'not_found';
    default:
      return 'unknown';
  }
}

/** Formats a stroop amount as XLM with the full 7-decimal precision. */
export function formatStroopsAsXlm(stroops: string | number | bigint | undefined): string | null {
  if (stroops === undefined || stroops === null || stroops === '') return null;
  let value: bigint;
  try {
    value = BigInt(typeof stroops === 'number' ? Math.trunc(stroops) : stroops);
  } catch {
    return null;
  }
  const negative = value < BigInt(0);
  const abs = negative ? -value : value;
  const whole = abs / STROOPS_PER_XLM;
  const fraction = (abs % STROOPS_PER_XLM).toString().padStart(7, '0');
  return `${negative ? '-' : ''}${whole.toString()}.${fraction} XLM`;
}

/** Decodes a base64 ScVal to text, or returns the input unchanged. */
function decodeScValText(value: unknown): string {
  if (typeof value !== 'string') return value === undefined ? '' : safeStringify(value);
  try {
    const native = scValToNative(xdr.ScVal.fromXDR(value, 'base64'));
    return typeof native === 'string' ? native : safeStringify(native);
  } catch {
    return value;
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? v.toString() : v));
  } catch {
    return String(value);
  }
}

/**
 * Normalises contract events from Soroban RPC `getEvents` (XDR `topic` array and
 * `value`) or from already-decoded records (`topics`, `value`).
 */
export function parseContractEvents(raw: unknown): ContractEventLog[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry): ContractEventLog[] => {
    if (!entry || typeof entry !== 'object') return [];
    const event = entry as {
      type?: unknown;
      contractId?: unknown;
      topic?: unknown;
      topics?: unknown;
      value?: unknown;
    };
    const rawTopics = Array.isArray(event.topics) ? event.topics : Array.isArray(event.topic) ? event.topic : [];
    const type =
      event.type === 'system' || event.type === 'diagnostic' ? event.type : 'contract';
    return [
      {
        type,
        contractId: typeof event.contractId === 'string' ? event.contractId : undefined,
        topics: rawTopics.map(decodeScValText),
        value: decodeScValText(event.value),
      },
    ];
  });
}

/** Extracts the audit fields from a Horizon `/transactions/:hash` record. */
export function parseHorizonTransaction(record: unknown): Partial<ProposalExecutionRecord> & {
  txStatus: TransactionStatus;
} {
  if (!record || typeof record !== 'object') return { txStatus: 'unknown' };
  const tx = record as {
    hash?: unknown;
    ledger?: unknown;
    fee_charged?: unknown;
    created_at?: unknown;
    successful?: unknown;
    source_account?: unknown;
  };
  const ledger = typeof tx.ledger === 'string' ? Number(tx.ledger) : tx.ledger;
  const txStatus = parseTransactionStatus(tx);
  return {
    txHash: isValidTransactionHash(tx.hash) ? tx.hash.toLowerCase() : undefined,
    ledger: isValidLedgerSequence(ledger) ? ledger : undefined,
    feeChargedStroops:
      typeof tx.fee_charged === 'string' || typeof tx.fee_charged === 'number'
        ? String(tx.fee_charged)
        : undefined,
    timestamp: typeof tx.created_at === 'string' ? tx.created_at : undefined,
    actor: typeof tx.source_account === 'string' ? tx.source_account : undefined,
    status: txStatus === 'unknown' ? undefined : txStatus.toUpperCase(),
    txStatus,
  };
}

/**
 * Looks up a transaction on the network's Horizon instance so a step can be
 * verified against the ledger. A 404 means the network has no such record.
 */
export async function fetchTransactionRecord(
  network: StellarNetwork,
  hash: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ReturnType<typeof parseHorizonTransaction>> {
  if (!isValidTransactionHash(hash)) return { txStatus: 'unknown' };
  const base = STELLAR_NETWORKS[network].horizonUrl.replace(/\/+$/, '');
  const response = await fetchImpl(`${base}/transactions/${hash.toLowerCase()}`);
  if (response.status === 404) return { txHash: hash.toLowerCase(), txStatus: 'not_found' };
  if (!response.ok) throw new Error(`Horizon returned ${response.status} for transaction ${hash}`);
  return parseHorizonTransaction(await response.json());
}

function stateFor(step: ProposalLifecycleStep, txStatus: TransactionStatus, hasTx: boolean): TimelineStepState {
  if (txStatus === 'failed') return 'failed';
  if (txStatus === 'success') return step === 'failed' ? 'failed' : 'confirmed';
  if (txStatus === 'pending' || txStatus === 'not_found') return 'pending';
  // No status reported: a recorded transaction is assumed to have landed, a
  // step without one (e.g. voting window closing) is a time-based transition.
  if (!hasTx) return step === 'failed' || step === 'expired' ? 'failed' : 'confirmed';
  return 'pending';
}

/** Steps still ahead for a proposal in `status`, in lifecycle order. */
function upcomingSteps(status: Proposal['status']): ProposalLifecycleStep[] {
  switch (status) {
    case 'pending':
    case 'active':
      return ['voting_closed', 'queued', 'executed'];
    case 'queued':
      return ['executed'];
    default:
      return [];
  }
}

/**
 * Builds the ordered audit timeline for `proposal`: every recorded lifecycle
 * transaction (oldest first) followed by the steps the proposal has yet to reach.
 */
export function buildProposalExecutionTimeline(proposal: Proposal): ExecutionTimelineStep[] {
  const history = [...(proposal.executionHistory ?? [])];
  if (!history.some((record) => record.step === 'created')) {
    history.push({ step: 'created', timestamp: proposal.createdAt, actor: proposal.creator });
  }

  const recorded = history
    .map((record, index) => ({ record, index }))
    .sort((a, b) => {
      const delta = Date.parse(a.record.timestamp) - Date.parse(b.record.timestamp);
      return Number.isNaN(delta) || delta === 0 ? a.index - b.index : delta;
    })
    .map(({ record }, index): ExecutionTimelineStep => {
      const txHash = isValidTransactionHash(record.txHash) ? record.txHash.toLowerCase() : undefined;
      const txStatus = parseTransactionStatus(record.status);
      return {
        id: `${record.step}-${txHash ?? index}`,
        step: record.step,
        label: LIFECYCLE_LABELS[record.step],
        state: stateFor(record.step, txStatus, Boolean(txHash)),
        txStatus,
        timestamp: record.timestamp,
        txHash,
        ledger: isValidLedgerSequence(record.ledger) ? record.ledger : undefined,
        feeChargedStroops: record.feeChargedStroops,
        actor: record.actor,
        events: record.events ?? [],
      };
    });

  const seen = new Set(recorded.map((step) => step.step));
  const upcoming = upcomingSteps(proposal.status)
    .filter((step) => !seen.has(step))
    .map(
      (step): ExecutionTimelineStep => ({
        id: `${step}-upcoming`,
        step,
        label: LIFECYCLE_LABELS[step],
        state: 'upcoming',
        txStatus: 'unknown',
        timestamp: step === 'voting_closed' ? proposal.endTime : undefined,
        events: [],
      }),
    );

  return [...recorded, ...upcoming];
}

/** Sum of fees charged across every recorded step, in stroops. */
export function totalFeesStroops(steps: readonly ExecutionTimelineStep[]): string {
  return steps
    .reduce((sum, step) => {
      try {
        return step.feeChargedStroops ? sum + BigInt(step.feeChargedStroops) : sum;
      } catch {
        return sum;
      }
    }, BigInt(0))
    .toString();
}
