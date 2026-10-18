/**
 * Dead Letter Queue (DLQ) and retry policy for domain event consumers.
 *
 * When a subscriber handler throws (or rejects), the consumer retries with
 * exponential backoff. Once the attempts are exhausted the event envelope is
 * captured here so a maintainer can inspect and replay it from the operations
 * dashboard instead of losing it.
 */

export interface RetryPolicy {
  /** Retries after the first failed attempt. Default 3. */
  maxRetries: number;
  /** Delay before the first retry. Each later retry doubles it. Default 2000ms. */
  baseDelayMs: number;
}

/** 3 retries with 2s, 4s, 8s backoff. */
export const DEFAULT_RETRY_POLICY: RetryPolicy = { maxRetries: 3, baseDelayMs: 2000 };

/** Delay (ms) before retry number `retry` (1-based). */
export function computeBackoffMs(retry: number, policy: RetryPolicy = DEFAULT_RETRY_POLICY): number {
  return policy.baseDelayMs * 2 ** (retry - 1);
}

export interface DeadLetterEntry {
  readonly id: string;
  /** Subscriber key used to find the handler on replay. */
  readonly subscriber: string;
  readonly eventName: string;
  readonly version: string | null;
  /** The validated envelope that the handler failed to process. */
  readonly envelope: unknown;
  readonly error: string;
  /** Total handler invocations made before giving up. */
  readonly attempts: number;
  readonly failedAt: number;
}

export type DeadLetterInput = Omit<DeadLetterEntry, 'id' | 'failedAt'>;

export const DLQ_STORAGE_KEY = 'trellis-domain-event-dlq';
export const MAX_DLQ_ENTRIES = 200;

type Replayer = (envelope: unknown) => void | Promise<void>;
type Listener = (entries: readonly DeadLetterEntry[]) => void;

function getStorage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export class DeadLetterQueue {
  private entries: DeadLetterEntry[] = [];
  private readonly listeners = new Set<Listener>();
  private readonly replayers = new Map<string, Replayer>();
  private counter = 0;

  constructor(private readonly storageKey: string | null = DLQ_STORAGE_KEY) {
    this.load();
  }

  private load(): void {
    const storage = this.storageKey ? getStorage() : null;
    if (!storage || !this.storageKey) return;
    try {
      const parsed: unknown = JSON.parse(storage.getItem(this.storageKey) ?? '[]');
      if (Array.isArray(parsed)) {
        this.entries = parsed.filter((e) => e && typeof e.id === 'string').slice(-MAX_DLQ_ENTRIES);
      }
    } catch {
      this.entries = [];
    }
  }

  private commit(): void {
    const storage = this.storageKey ? getStorage() : null;
    if (storage && this.storageKey) {
      try {
        storage.setItem(this.storageKey, JSON.stringify(this.entries));
      } catch {
        // Quota or serialization failure: keep the in-memory copy.
      }
    }
    const snapshot = this.list();
    this.listeners.forEach((listener) => listener(snapshot));
  }

  /** Capture a failed event. Oldest entries are dropped past the cap. */
  capture(input: DeadLetterInput): DeadLetterEntry {
    this.counter += 1;
    const entry: DeadLetterEntry = {
      ...input,
      id: `dlq-${Date.now().toString(36)}-${this.counter}`,
      failedAt: Date.now(),
    };
    this.entries = [...this.entries, entry].slice(-MAX_DLQ_ENTRIES);
    this.commit();
    return entry;
  }

  list(): readonly DeadLetterEntry[] {
    return [...this.entries];
  }

  get(id: string): DeadLetterEntry | undefined {
    return this.entries.find((entry) => entry.id === id);
  }

  remove(id: string): boolean {
    const before = this.entries.length;
    this.entries = this.entries.filter((entry) => entry.id !== id);
    if (this.entries.length === before) return false;
    this.commit();
    return true;
  }

  clear(): void {
    this.entries = [];
    this.commit();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Register how to re-run a subscriber's handler. Returns an unregister fn. */
  registerReplayer(subscriber: string, replayer: Replayer): () => void {
    this.replayers.set(subscriber, replayer);
    return () => {
      if (this.replayers.get(subscriber) === replayer) this.replayers.delete(subscriber);
    };
  }

  /**
   * Re-trigger a dead-lettered event against its subscriber. The entry is
   * removed on success; if the handler fails again a fresh entry is captured
   * by the normal retry path, so the original is removed up front.
   */
  async replay(id: string): Promise<{ ok: boolean; reason?: string }> {
    const entry = this.get(id);
    if (!entry) return { ok: false, reason: 'Entry not found' };
    const replayer = this.replayers.get(entry.subscriber);
    if (!replayer) {
      return { ok: false, reason: `No active subscriber "${entry.subscriber}" to replay to` };
    }
    this.remove(id);
    try {
      await replayer(entry.envelope);
      return { ok: true };
    } catch (error) {
      this.capture({
        subscriber: entry.subscriber,
        eventName: entry.eventName,
        version: entry.version,
        envelope: entry.envelope,
        error: error instanceof Error ? error.message : String(error),
        attempts: entry.attempts + 1,
      });
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }
}

/** Shared queue used by consumers unless one is injected. */
export const deadLetterQueue = new DeadLetterQueue();
