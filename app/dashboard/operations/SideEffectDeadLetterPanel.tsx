'use client';

import { useState } from 'react';
import { useSideEffectDLQ } from '@/lib/side-effects/useSideEffect';

/**
 * Operations dashboard panel to inspect, monitor, replay, and discard
 * dead-lettered side-effect mutations (wallet transactions, API writes, and sync jobs).
 */
export function SideEffectDeadLetterPanel() {
  const { entries, isReplaying, replay, discard, clear } = useSideEffectDLQ();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const handleReplay = async (id: string, actionName: string) => {
    try {
      const result = await replay(id);
      if (result.ok) {
        setFeedback(`Action "${actionName}" replayed successfully.`);
      } else {
        setFeedback(`Replay failed: ${result.error ?? 'Unknown error'}`);
      }
    } catch (err: unknown) {
      setFeedback(`Replay error: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleDiscard = (id: string, actionName: string) => {
    discard(id);
    setFeedback(`Discarded failed action "${actionName}".`);
  };

  const unresolvedEntries = entries.filter((e) => !e.resolvedAt);

  return (
    <section
      aria-labelledby="side-effect-dlq-heading"
      className="mt-10"
      data-testid="side-effect-dlq"
    >
      <div className="flex items-center justify-between">
        <div>
          <h2 id="side-effect-dlq-heading" className="text-2xl font-bold">
            Side-Effect Dead-Letter Queue
          </h2>
          <p className="mt-1 text-sm text-gray-400">
            High-risk client mutations and wallet writes that exhausted retry limits or hit terminal errors.
          </p>
        </div>
        {unresolvedEntries.length > 0 && (
          <button
            type="button"
            className="rounded border border-red-500/50 bg-red-950/20 px-3 py-1.5 text-xs font-medium text-red-300 hover:bg-red-900/40 focus:outline-none focus:ring-2 focus:ring-red-400"
            onClick={clear}
          >
            Clear all DLQ
          </button>
        )}
      </div>

      {feedback && (
        <div
          role="status"
          aria-live="polite"
          className="mt-3 rounded border border-trellis-leaf/40 bg-trellis-leaf/10 p-2.5 text-xs text-trellis-leaf"
        >
          {feedback}
        </div>
      )}

      {unresolvedEntries.length === 0 ? (
        <div className="mt-4 rounded-lg border border-trellis-vine/20 bg-trellis-vine/5 p-6 text-center text-sm text-gray-400">
          No dead-lettered side effects. System mutations are healthy.
        </div>
      ) : (
        <ul className="mt-4 space-y-3" role="list">
          {unresolvedEntries.map((entry) => (
            <li
              key={entry.id}
              className="rounded-lg border border-trellis-vine/30 bg-trellis-vine/10 p-4 transition-all"
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-white">{entry.action}</span>
                    <span className="rounded bg-black/40 px-2 py-0.5 text-[11px] font-mono text-gray-400">
                      key: {entry.key.slice(0, 16)}...
                    </span>
                    <span className="rounded bg-red-900/30 px-2 py-0.5 text-[11px] font-mono text-red-300">
                      {entry.operationClass}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-gray-400">
                    Failed {new Date(entry.failedAt).toLocaleString()} · {entry.totalAttempts} attempt(s)
                    {entry.metadata?.walletAddress && (
                      <span> · Wallet: {String(entry.metadata.walletAddress).slice(0, 10)}...</span>
                    )}
                  </p>
                  <p className="mt-1 text-xs text-red-300 font-mono">
                    {entry.lastError}
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className="rounded border border-trellis-vine/60 px-2.5 py-1 text-xs text-gray-200 hover:bg-trellis-vine/20 focus:outline-none focus:ring-2 focus:ring-trellis-leaf"
                    aria-expanded={expandedId === entry.id}
                    onClick={() => setExpandedId(expandedId === entry.id ? null : entry.id)}
                  >
                    {expandedId === entry.id ? 'Hide payload' : 'Inspect'}
                  </button>
                  <button
                    type="button"
                    disabled={isReplaying}
                    className="rounded bg-trellis-leaf px-3 py-1 text-xs font-semibold text-black hover:opacity-90 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-trellis-leaf"
                    onClick={() => void handleReplay(entry.id, entry.action)}
                    aria-label={`Replay ${entry.action}`}
                  >
                    {isReplaying ? 'Replaying...' : 'Replay'}
                  </button>
                  <button
                    type="button"
                    className="rounded border border-red-500/60 px-2.5 py-1 text-xs text-red-200 hover:bg-red-950/30 focus:outline-none focus:ring-2 focus:ring-red-400"
                    onClick={() => handleDiscard(entry.id, entry.action)}
                    aria-label={`Discard ${entry.action}`}
                  >
                    Discard
                  </button>
                </div>
              </div>

              {expandedId === entry.id && (
                <div className="mt-3 space-y-2 border-t border-trellis-vine/20 pt-3">
                  <div>
                    <span className="text-[11px] font-semibold text-gray-400">Request Payload:</span>
                    <pre className="mt-1 max-h-48 overflow-auto rounded bg-black/60 p-2.5 text-[11px] font-mono text-gray-300">
                      {JSON.stringify(entry.payload, null, 2)}
                    </pre>
                  </div>
                  {entry.attempts.length > 0 && (
                    <div>
                      <span className="text-[11px] font-semibold text-gray-400">Attempt History:</span>
                      <ul className="mt-1 space-y-1 text-[11px] font-mono text-gray-400">
                        {entry.attempts.map((att, idx) => (
                          <li key={idx} className="flex justify-between border-b border-white/5 py-0.5">
                            <span>Attempt #{att.attemptNumber} (delay: {att.delayMs}ms)</span>
                            <span className="text-red-300">{att.error}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
