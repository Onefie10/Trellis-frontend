'use client';

import { useEffect, useState } from 'react';

import { deadLetterQueue, type DeadLetterEntry } from '@/lib/domain-events';

/** Operations dashboard panel to inspect and manually replay failed domain events. */
export function DeadLetterPanel() {
  const [entries, setEntries] = useState<readonly DeadLetterEntry[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    setEntries(deadLetterQueue.list());
    return deadLetterQueue.subscribe(setEntries);
  }, []);

  const handleReplay = async (id: string) => {
    const result = await deadLetterQueue.replay(id);
    setMessage(result.ok ? 'Event replayed successfully.' : `Replay failed: ${result.reason}`);
  };

  return (
    <section aria-labelledby="dlq-heading" className="mt-10" data-testid="domain-event-dlq">
      <div className="flex items-center justify-between">
        <h2 id="dlq-heading" className="text-2xl font-bold">Failed domain events</h2>
        {entries.length > 0 && (
          <button
            type="button"
            className="rounded border border-red-400/60 px-2 py-1 text-xs text-red-200 focus:outline-none focus:ring-2 focus:ring-red-300"
            onClick={() => deadLetterQueue.clear()}
          >
            Clear all
          </button>
        )}
      </div>
      <p className="mt-1 text-sm text-gray-400">
        Events whose handler still failed after exponential-backoff retries.
      </p>
      {message && <p role="status" className="mt-2 text-sm text-trellis-leaf">{message}</p>}

      {entries.length === 0 ? (
        <p className="mt-4 text-sm text-gray-400">No failed events.</p>
      ) : (
        <ul className="mt-4 space-y-3">
          {entries.map((entry) => (
            <li key={entry.id} className="rounded-lg border border-trellis-vine/30 bg-trellis-vine/10 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="font-semibold">
                    {entry.eventName} <span className="text-xs text-gray-400">v{entry.version ?? '?'}</span>
                  </p>
                  <p className="text-xs text-gray-400">
                    {entry.subscriber} · {entry.attempts} attempts · {new Date(entry.failedAt).toLocaleString()}
                  </p>
                  <p className="mt-1 text-xs text-red-300">{entry.error}</p>
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    className="rounded border border-trellis-vine/60 px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-trellis-leaf"
                    aria-expanded={expanded === entry.id}
                    onClick={() => setExpanded(expanded === entry.id ? null : entry.id)}
                  >
                    {expanded === entry.id ? 'Hide payload' : 'Inspect'}
                  </button>
                  <button
                    type="button"
                    className="rounded bg-trellis-leaf px-2 py-1 text-xs font-semibold text-black focus:outline-none focus:ring-2 focus:ring-trellis-leaf"
                    onClick={() => void handleReplay(entry.id)}
                    aria-label={`Replay ${entry.eventName}`}
                  >
                    Replay
                  </button>
                  <button
                    type="button"
                    className="rounded border border-red-400/60 px-2 py-1 text-xs text-red-200 focus:outline-none focus:ring-2 focus:ring-red-300"
                    onClick={() => deadLetterQueue.remove(entry.id)}
                    aria-label={`Discard ${entry.eventName}`}
                  >
                    Discard
                  </button>
                </div>
              </div>
              {expanded === entry.id && (
                <pre className="mt-3 max-h-64 overflow-auto rounded bg-black/40 p-3 text-xs">
                  {JSON.stringify(entry.envelope, null, 2)}
                </pre>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
