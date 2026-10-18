'use client';

import React, { useMemo, useState } from 'react';
import type { Proposal } from '@/lib/governance/types';
import type { StellarNetwork } from '@/lib/types';
import {
  getExplorerLedgerUrl,
  getTransactionExplorerLinks,
} from '@/lib/stellar-constants';
import {
  buildProposalExecutionTimeline,
  fetchTransactionRecord,
  formatStroopsAsXlm,
  totalFeesStroops,
  type ExecutionTimelineStep,
  type TimelineStepState,
  type TransactionStatus,
} from '../utils/executionTimeline';

interface ProposalExecutionTimelineProps {
  proposal: Proposal;
  network: StellarNetwork;
  /** Injected for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

type Verification =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'done'; txStatus: TransactionStatus; ledger?: number; feeChargedStroops?: string };

const STATE_STYLES: Record<TimelineStepState, { dot: string; badge: string; text: string }> = {
  confirmed: { dot: 'bg-emerald-400 border-emerald-300', badge: 'bg-emerald-500/20 text-emerald-300', text: 'Confirmed' },
  failed: { dot: 'bg-red-400 border-red-300', badge: 'bg-red-500/20 text-red-300', text: 'Failed' },
  pending: { dot: 'bg-amber-400 border-amber-300', badge: 'bg-amber-500/20 text-amber-300', text: 'Pending' },
  upcoming: { dot: 'bg-transparent border-gray-500', badge: 'bg-gray-500/20 text-gray-400', text: 'Upcoming' },
};

function shortHash(hash: string): string {
  return `${hash.slice(0, 8)}…${hash.slice(-8)}`;
}

export function ProposalExecutionTimeline({
  proposal,
  network,
  fetchImpl,
}: ProposalExecutionTimelineProps) {
  const steps = useMemo(() => buildProposalExecutionTimeline(proposal), [proposal]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [verification, setVerification] = useState<Record<string, Verification>>({});

  const recordedCount = steps.filter((step) => step.state !== 'upcoming').length;
  const totalFees = formatStroopsAsXlm(totalFeesStroops(steps));

  const verify = async (step: ExecutionTimelineStep) => {
    if (!step.txHash) return;
    setVerification((current) => ({ ...current, [step.id]: { state: 'loading' } }));
    try {
      const record = await fetchTransactionRecord(network, step.txHash, fetchImpl ?? fetch);
      setVerification((current) => ({
        ...current,
        [step.id]: {
          state: 'done',
          txStatus: record.txStatus,
          ledger: record.ledger,
          feeChargedStroops: record.feeChargedStroops,
        },
      }));
    } catch (error) {
      setVerification((current) => ({
        ...current,
        [step.id]: { state: 'error', message: error instanceof Error ? error.message : 'Lookup failed' },
      }));
    }
  };

  return (
    <section aria-labelledby={`timeline-heading-${proposal.id}`} data-testid="proposal-execution-timeline">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h3 id={`timeline-heading-${proposal.id}`} className="text-lg font-bold text-white">
            On-chain execution audit
          </h3>
          <p className="text-xs text-gray-400">
            {recordedCount} recorded step{recordedCount === 1 ? '' : 's'} on {network}. Each transaction links to
            its block explorer record.
          </p>
        </div>
        {totalFees && (
          <p className="text-xs text-gray-400">
            Total fees: <span className="font-mono text-gray-200">{totalFees}</span>
          </p>
        )}
      </div>

      <ol className="relative ml-2 border-l border-white/10">
        {steps.map((step) => {
          const style = STATE_STYLES[step.state];
          const links = step.txHash ? getTransactionExplorerLinks(network, step.txHash) : [];
          const ledgerUrl = step.ledger ? getExplorerLedgerUrl(network, step.ledger) : null;
          const fee = formatStroopsAsXlm(step.feeChargedStroops);
          const check = verification[step.id];
          const isOpen = Boolean(expanded[step.id]);

          return (
            <li key={step.id} className="mb-5 ml-5" data-testid={`timeline-step-${step.step}`}>
              <span
                aria-hidden="true"
                className={`absolute -left-[7px] mt-1.5 h-3.5 w-3.5 rounded-full border-2 ${style.dot}`}
              />
              <div className="rounded-lg border border-white/10 bg-white/5 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-white">{step.label}</span>
                    <span className={`rounded px-2 py-0.5 text-[10px] font-semibold uppercase ${style.badge}`}>
                      {style.text}
                    </span>
                  </div>
                  {step.timestamp && (
                    <time dateTime={step.timestamp} className="text-xs text-gray-400">
                      {new Date(step.timestamp).toLocaleString()}
                    </time>
                  )}
                </div>

                {step.state !== 'upcoming' && (
                  <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1 text-xs sm:grid-cols-3">
                    <div>
                      <dt className="text-gray-500">Transaction</dt>
                      <dd className="font-mono text-gray-200">{step.txHash ? shortHash(step.txHash) : '—'}</dd>
                    </div>
                    <div>
                      <dt className="text-gray-500">Ledger</dt>
                      <dd className="font-mono text-gray-200">
                        {ledgerUrl ? (
                          <a href={ledgerUrl} target="_blank" rel="noopener noreferrer" className="underline hover:text-white">
                            #{step.ledger}
                          </a>
                        ) : (
                          '—'
                        )}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-gray-500">Fee charged</dt>
                      <dd className="font-mono text-gray-200">{fee ?? '—'}</dd>
                    </div>
                    {step.actor && (
                      <div className="sm:col-span-3">
                        <dt className="text-gray-500">Signer</dt>
                        <dd className="break-all font-mono text-gray-300">{step.actor}</dd>
                      </div>
                    )}
                  </dl>
                )}

                {(links.length > 0 || step.events.length > 0) && (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {links.map((link) => (
                      <a
                        key={link.explorer}
                        href={link.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="rounded border border-trellis-vine/40 px-2 py-0.5 text-[11px] text-trellis-leaf hover:bg-trellis-vine/20"
                      >
                        View on {link.label} ↗
                      </a>
                    ))}
                    {step.txHash && (
                      <button
                        type="button"
                        onClick={() => verify(step)}
                        disabled={check?.state === 'loading'}
                        className="rounded border border-white/20 px-2 py-0.5 text-[11px] text-gray-300 hover:bg-white/10 disabled:opacity-50"
                      >
                        {check?.state === 'loading' ? 'Verifying…' : 'Verify on ledger'}
                      </button>
                    )}
                    {step.events.length > 0 && (
                      <button
                        type="button"
                        aria-expanded={isOpen}
                        onClick={() => setExpanded((current) => ({ ...current, [step.id]: !isOpen }))}
                        className="rounded border border-white/20 px-2 py-0.5 text-[11px] text-gray-300 hover:bg-white/10"
                      >
                        {isOpen ? 'Hide' : 'Show'} contract events ({step.events.length})
                      </button>
                    )}
                  </div>
                )}

                {check && check.state !== 'loading' && (
                  <p role="status" className="mt-2 text-[11px] text-gray-400">
                    {check.state === 'error'
                      ? `Verification failed: ${check.message}`
                      : check.txStatus === 'not_found'
                      ? 'Not found on this network yet.'
                      : `Ledger reports ${check.txStatus}${check.ledger ? ` in ledger #${check.ledger}` : ''}${
                          check.feeChargedStroops ? `, fee ${formatStroopsAsXlm(check.feeChargedStroops)}` : ''
                        }.`}
                  </p>
                )}

                {isOpen && (
                  <ul className="mt-2 space-y-1 rounded bg-black/40 p-2 font-mono text-[11px] text-gray-300">
                    {step.events.map((event, index) => (
                      <li key={index} className="break-all">
                        <span className="text-purple-300">[{event.type}]</span>{' '}
                        <span className="text-amber-300">{event.topics.join(' · ')}</span>
                        {event.value && <span> → {event.value}</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
