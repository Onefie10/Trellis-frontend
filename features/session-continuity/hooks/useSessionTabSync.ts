import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  SessionSyncEventName,
  SessionSyncMessage,
  SessionSyncPayload,
  SessionTabSync,
} from '../tab-sync';

export type SessionTabSyncStatus = 'idle' | 'syncing' | 'degraded';

export interface SessionTabSyncOptions {
  /** Maximum number of retries for a failed publish. */
  maxRetries?: number;
  /** Base delay in ms for exponential backoff. */
  retryBaseDelayMs?: number;
  /** Maximum delay in ms between retries. */
  retryMaxDelayMs?: number;
  /** Window in ms during which identical payloads are coalesced. */
  dedupeWindowMs?: number;
}

export interface SessionTabSyncResult {
  lastMessage: SessionSyncMessage | null;
  status: SessionTabSyncStatus;
  pendingCount: number;
  publish: <TName extends SessionSyncEventName>(
    event: TName,
    payload: SessionSyncPayload<TName>,
  ) => Promise<void>;
  flush: () => Promise<void>;
}

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_BASE_DELAY = 50;
const DEFAULT_RETRY_MAX_DELAY = 2000;
const DEFAULT_DEDUP_WINDOW = 250;

interface PendingPublish {
  id: string;
  event: SessionSyncEventName;
  payload: SessionSyncPayload<SessionSyncEventName>;
  attempts: number;
  resolvers: Array<{
    resolve: () => void;
    reject: (error: unknown) => void;
  }>;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function dedupKey(event: SessionSyncEventName, payload: unknown): string {
  return `${event}::${safeStringify(payload)}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function useSessionTabSync(
  options: SessionTabSyncOptions = {},
): SessionTabSyncResult {
  const {
    maxRetries = DEFAULT_MAX_RETRIES,
    retryBaseDelayMs = DEFAULT_RETRY_BASE_DELAY,
    retryMaxDelayMs = DEFAULT_RETRY_MAX_DELAY,
    dedupeWindowMs = DEFAULT_DEDUP_WINDOW,
  } = options;

  const sync = useMemo(() => new SessionTabSync(), []);
  const [lastMessage, setLastMessage] = useState<SessionSyncMessage | null>(null);
  const [status, setStatus] = useState<SessionTabSyncStatus>('idle');
  const [pendingCount, setPendingCount] = useState(0);

  const pendingRef = useRef<Map<string, PendingPublish>>(new Map());
  const inflightRef = useRef<boolean>(false);
  const mountedRef = useRef<boolean>(true);
  const lastPublishedRef = useRef<Map<string, number>>(new Map());
  const sequenceRef = useRef(0);

  const updatePendingCount = useCallback(() => {
    if (!mountedRef.current) return;
    setPendingCount(pendingRef.current.size);
  }, []);

  const resolvePending = useCallback(
    (id: string, error?: unknown) => {
      const entry = pendingRef.current.get(id);
      if (!entry) return;
      pendingRef.current.delete(id);
      for (const r of entry.resolvers) {
        if (error) r.reject(error);
        else r.resolve();
      }
      updatePendingCount();
    },
    [updatePendingCount],
  );

  const flush = useCallback(async (): Promise<void> => {
    if (inflightRef.current) return;
    inflightRef.current = true;
    if (mountedRef.current) setStatus('syncing');

    try {
      // Snapshot the queue so new publishes arriving during flush are not
      // silently dropped; they are picked up by the next flush cycle.
      const entries = Array.from(pendingRef.current.values());
      for (const entry of entries) {
        let lastError: unknown = null;
        while (entry.attempts <= maxRetries) {
          try {
            await Promise.resolve(
              sync.publish(entry.event, entry.payload as never),
            );
            lastError = null;
            break;
          } catch (err) {
            lastError = err;
            entry.attempts += 1;
            if (entry.attempts > maxRetries) break;
            const backoff = Math.min(
              retryMaxDelayMs,
              retryBaseDelayMs * 2 ** (entry.attempts - 1),
            );
            await delay(backoff);
          }
        }
        if (lastError) {
          resolvePending(entry.id, lastError);
        } else {
          resolvePending(entry.id);
        }
      }
    } finally {
      inflightRef.current = false;
      if (mountedRef.current) {
        setStatus(pendingRef.current.size === 0 ? 'idle' : 'syncing');
      }
    }
  }, [maxRetries, retryBaseDelayMs, retryMaxDelayMs, resolvePending, sync]);

  const publish = useCallback(
    <TName extends SessionSyncEventName>(
      event: TName,
      payload: SessionSyncPayload<TName>,
    ): Promise<void> => {
      const now = Date.now();
      const key = dedupKey(event, payload);
      const last = lastPublishedRef.current.get(key);
      if (last !== undefined && now - last <= dedupeWindowMs) {
        // Dedupe duplicate submissions within the coalescing window.
        return Promise.resolve();
      }
      lastPublishedRef.current.set(key, now);

      // Coalesce if an identical payload is already queued.
      for (const entry of pendingRef.current.values()) {
        if (dedupKey(entry.event, entry.payload) === key) {
          return new Promise<void>((resolve, reject) => {
            entry.resolvers.push({ resolve, reject });
          });
        }
      }

      sequenceRef.current += 1;
      const id = `${event}-${sequenceRef.current}`;
      const promise = new Promise<void>((resolve, reject) => {
        pendingRef.current.set(id, {
          id,
          event,
          payload: payload as SessionSyncPayload<SessionSyncEventName>,
          attempts: 0,
          resolvers: [{ resolve, reject }],
        });
      });
      updatePendingCount();
      // Kick off a flush asynchronously to allow batching of concurrent publishes.
      void Promise.resolve().then(() => flush());
      return promise;
    },
    [dedupeWindowMs, flush, updatePendingCount],
  );

  useEffect(() => {
    mountedRef.current = true;
    const unsubscribe = sync.subscribe((updated) => {
      if (!mountedRef.current) return;
      setLastMessage(updated);
    });
    return () => {
      mountedRef.current = false;
      unsubscribe();
      // Reject any in-flight promises so callers do not hang forever.
      for (const entry of pendingRef.current.values()) {
        for (const r of entry.resolvers) {
          r.reject(new Error('Session tab messaging channel closed'));
        }
      }
      pendingRef.current.clear();
      sync.close();
    };
  }, [sync]);

  return { lastMessage, status, pendingCount, publish, flush };
}
