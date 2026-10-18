'use client';

import { useCallback, useEffect, useState } from 'react';
import PWAManager, { type OfflineSubmission } from '@/lib/pwa-utils';
import { subscribeDomainEvent, type DomainEventFallbackContext } from '@/lib/domain-events';
import { usePWA } from '@/hooks/usePWA';

const SYNCED_MESSAGE_TIMEOUT_MS = 6000;

/**
 * An event we could not read is never allowed to corrupt the banner's state.
 * Log it and let the next authoritative refresh (or the next valid event) put
 * the UI right, rather than rendering a half-parsed payload.
 */
function reportUnreadableEvent(context: DomainEventFallbackContext): void {
  console.warn(
    `[OfflineBanner] Ignored unreadable domain event "${context.name}" ` +
      `(${context.reason}, version ${context.receivedVersion ?? 'absent'}): ${context.issues.join('; ')}`,
  );
}

/**
 * Informs the user when the app is running from cached data and when mutations
 * made offline (bug reports, feedback, ...) are queued for delivery.
 *
 * Reads the queue size from `PWAManager` and reacts to the `offline-queue-change`
 * / `offline-queue-synced` events so the count stays in sync with the service
 * worker driven replays.
 */
export default function OfflineBanner() {
  const { isOnline, updateAvailable, skipWaiting } = usePWA();
  const [pending, setPending] = useState(0);
  const [conflicts, setConflicts] = useState<OfflineSubmission[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [synced, setSynced] = useState(0);
  const [updating, setUpdating] = useState(false);

  const handleReload = useCallback(async () => {
    setUpdating(true);
    try {
      await skipWaiting();
    } finally {
      setUpdating(false);
    }
  }, [skipWaiting]);

  const refreshPending = useCallback(async () => {
    try {
      const manager = PWAManager.getInstance();
      const [count, conflicted] = await Promise.all([
        manager.getPendingSubmissionCount(),
        manager.getConflictedSubmissions(),
      ]);
      setPending(count);
      setConflicts(conflicted);
    } catch {
      setPending(0);
      setConflicts([]);
    }
  }, []);

  useEffect(() => {
    const manager = PWAManager.getInstance();
    manager.setupBackgroundSync();
    void refreshPending();

    const handleQueueChange = (pending: number) => {
      setPending(pending);
    };

    const handleSynced = (result: { synced: string[] }) => {
      setSyncing(false);
      setSynced(result.synced.length);
      void refreshPending();
    };

    // The payload is validated against the registered schema before these run,
    // so neither handler needs a defensive shape check.
    const unsubscribeQueueChange = subscribeDomainEvent(
      'offline-queue-change',
      (payload) => handleQueueChange(payload.pending),
      { fallback: reportUnreadableEvent },
    );
    const unsubscribeSynced = subscribeDomainEvent(
      'offline-queue-synced',
      (payload) => handleSynced(payload),
      { fallback: reportUnreadableEvent },
    );

    return () => {
      unsubscribeQueueChange();
      unsubscribeSynced();
    };
  }, [refreshPending]);

  // Clear the "synced" confirmation after a moment so it does not linger.
  useEffect(() => {
    if (synced === 0) {
      return;
    }

    const timeout = setTimeout(() => setSynced(0), SYNCED_MESSAGE_TIMEOUT_MS);

    return () => clearTimeout(timeout);
  }, [synced]);

  const syncNow = useCallback(async () => {
    setSyncing(true);

    try {
      await PWAManager.getInstance().flushOfflineSubmissions();
    } finally {
      setSyncing(false);
      void refreshPending();
    }
  }, [refreshPending]);

  const showSyncedMessage = isOnline && pending === 0 && synced > 0;
  const waitingToSync = Math.max(0, pending - conflicts.length);

  if (isOnline && pending === 0 && conflicts.length === 0 && !showSyncedMessage && !updateAvailable) {
    return null;
  }

  return (
    <div
      data-testid="offline-banner"
      role="status"
      aria-live="polite"
      className="fixed bottom-4 left-4 right-4 z-50 mx-auto flex max-w-xl items-center gap-3 rounded-xl border border-trellis-vine/40 bg-trellis-deep/95 px-4 py-3 text-sm text-white shadow-lg backdrop-blur md:left-1/2 md:right-auto md:-translate-x-1/2"
    >
      <span
        aria-hidden="true"
        className={`h-2.5 w-2.5 shrink-0 rounded-full ${
          updateAvailable
            ? 'bg-trellis-leaf animate-pulse'
            : isOnline
            ? 'bg-trellis-leaf'
            : 'bg-trellis-amber'
        }`}
      />

      <div className="flex-1">
        {updateAvailable ? (
          <p>New version available! Reload to update</p>
        ) : (
          <>
            {!isOnline && (
              <p>
                <span className="font-medium">You&apos;re offline.</span> Showing cached content.
              </p>
            )}

            {waitingToSync > 0 && (
              <p className={isOnline ? undefined : 'mt-0.5 text-xs text-white/70'}>
                {waitingToSync} offline {waitingToSync === 1 ? 'change' : 'changes'} waiting to sync
                {isOnline ? '' : ' — will send automatically when you reconnect'}.
              </p>
            )}

            {conflicts.map((conflict) => (
              <div key={conflict.id} className="mt-2 rounded-lg border border-trellis-amber/40 p-2 text-xs">
                <p className="font-medium">{conflict.label} needs review</p>
                <p className="mt-1 text-white/70">{conflict.lastError || 'The server state changed before this operation could be sent.'}</p>
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    onClick={async () => { await PWAManager.getInstance().retryConflictedSubmission(conflict.id); await refreshPending(); }}
                    className="rounded border border-trellis-leaf/50 px-2 py-1 text-trellis-leaf"
                  >Retry after reviewing current state</button>
                  <button
                    type="button"
                    onClick={async () => { await PWAManager.getInstance().discardConflictedSubmission(conflict.id); await refreshPending(); }}
                    className="rounded border border-white/30 px-2 py-1 text-white/80"
                  >Discard</button>
                </div>
              </div>
            ))}

            {showSyncedMessage && (
              <p>
                {synced} offline {synced === 1 ? 'change' : 'changes'} synced.
              </p>
            )}
          </>
        )}
      </div>

      {updateAvailable && (
        <button
          type="button"
          onClick={handleReload}
          disabled={updating}
          aria-label="Reload to update"
          className="shrink-0 rounded-lg border border-trellis-leaf/50 px-3 py-1 text-xs font-medium text-trellis-leaf transition hover:bg-trellis-leaf/10 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {updating ? 'Reloading…' : 'Reload'}
        </button>
      )}

      {isOnline && !updateAvailable && waitingToSync > 0 && (
        <button
          type="button"
          onClick={syncNow}
          disabled={syncing}
          className="shrink-0 rounded-lg border border-trellis-leaf/50 px-3 py-1 text-xs font-medium text-trellis-leaf transition hover:bg-trellis-leaf/10 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {syncing ? 'Syncing…' : 'Sync now'}
        </button>
      )}

      {showSyncedMessage && !updateAvailable && (
        <button
          type="button"
          onClick={() => setSynced(0)}
          aria-label="Dismiss offline sync notification"
          className="shrink-0 rounded-lg px-2 py-1 text-xs text-white/60 transition hover:text-white"
        >
          ✕
        </button>
      )}
    </div>
  );
}
