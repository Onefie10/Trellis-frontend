/**
 * Persistent Dead-Letter Queue for Side-Effects.
 *
 * Captures exhausted or non-retryable side-effect operations, persists them
 * across page refreshes and tab lifecycles, and provides safe inspection,
 * replay, and discard capabilities without duplicate user-visible side-effects.
 */

import type { DeadLetterSideEffect, RetryAttemptRecord, SideEffectDescriptor } from './types';

export const DLQ_STORAGE_KEY = 'trellis.side-effects.dlq.v1';
export const MAX_DLQ_ENTRIES = 250;

export interface SideEffectDLQStore {
  list(): readonly DeadLetterSideEffect[];
  get(id: string): DeadLetterSideEffect | undefined;
  getByKey(key: string): DeadLetterSideEffect | undefined;
  save(entry: DeadLetterSideEffect): void;
  remove(id: string): boolean;
  clear(): void;
  subscribe(listener: (entries: readonly DeadLetterSideEffect[]) => void): () => void;
}

function getSafeStorage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export class MemorySideEffectDLQStore implements SideEffectDLQStore {
  protected entries: DeadLetterSideEffect[] = [];
  protected listeners = new Set<(entries: readonly DeadLetterSideEffect[]) => void>();

  list(): readonly DeadLetterSideEffect[] {
    return [...this.entries];
  }

  get(id: string): DeadLetterSideEffect | undefined {
    return this.entries.find((entry) => entry.id === id);
  }

  getByKey(key: string): DeadLetterSideEffect | undefined {
    return this.entries.find((entry) => entry.key === key && !entry.resolvedAt);
  }

  save(entry: DeadLetterSideEffect): void {
    const existingIdx = this.entries.findIndex((e) => e.id === entry.id || e.key === entry.key);
    if (existingIdx >= 0) {
      this.entries[existingIdx] = entry;
    } else {
      this.entries.push(entry);
    }
    if (this.entries.length > MAX_DLQ_ENTRIES) {
      // Evict resolved first, then oldest
      const resolvedIdx = this.entries.findIndex((e) => !!e.resolvedAt);
      if (resolvedIdx >= 0) {
        this.entries.splice(resolvedIdx, 1);
      } else {
        this.entries.shift();
      }
    }
    this.notify();
  }

  remove(id: string): boolean {
    const prevLen = this.entries.length;
    this.entries = this.entries.filter((e) => e.id !== id);
    const removed = this.entries.length !== prevLen;
    if (removed) {
      this.notify();
    }
    return removed;
  }

  clear(): void {
    this.entries = [];
    this.notify();
  }

  subscribe(listener: (entries: readonly DeadLetterSideEffect[]) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  protected notify(): void {
    const snapshot = this.list();
    this.listeners.forEach((listener) => {
      try {
        listener(snapshot);
      } catch {
        // Listener error must not fail state management
      }
    });
  }
}

export class LocalStorageSideEffectDLQStore extends MemorySideEffectDLQStore {
  constructor(private readonly storageKey: string = DLQ_STORAGE_KEY) {
    super();
    this.load();
  }

  private load(): void {
    const storage = getSafeStorage();
    if (!storage) return;
    try {
      const raw = storage.getItem(this.storageKey);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          this.entries = parsed.slice(-MAX_DLQ_ENTRIES);
        }
      }
    } catch {
      // Malformed json fallback
      this.entries = [];
    }
  }

  private persist(): void {
    const storage = getSafeStorage();
    if (!storage) return;
    try {
      storage.setItem(this.storageKey, JSON.stringify(this.entries));
    } catch {
      // Storage quota or restriction - in-memory copy persists
    }
  }

  override save(entry: DeadLetterSideEffect): void {
    super.save(entry);
    this.persist();
  }

  override remove(id: string): boolean {
    const removed = super.remove(id);
    if (removed) {
      this.persist();
    }
    return removed;
  }

  override clear(): void {
    super.clear();
    this.persist();
  }
}

export class SideEffectDeadLetterQueue {
  private counter = 0;

  constructor(
    private readonly store: SideEffectDLQStore = typeof window !== 'undefined'
      ? new LocalStorageSideEffectDLQStore()
      : new MemorySideEffectDLQStore(),
    private readonly now: () => number = () => Date.now(),
  ) {}

  enqueue(
    descriptor: SideEffectDescriptor,
    attempts: readonly RetryAttemptRecord[],
    lastError: Error | string,
  ): DeadLetterSideEffect {
    this.counter += 1;
    const nowMs = this.now();
    const errorMessage = lastError instanceof Error ? lastError.message : String(lastError);

    const record: DeadLetterSideEffect = {
      id: `dlq-se-${nowMs.toString(36)}-${this.counter}`,
      key: descriptor.key,
      action: descriptor.action,
      payload: descriptor.payload,
      operationClass: descriptor.operationClass ?? 'api_write',
      attempts,
      totalAttempts: attempts.length,
      lastError: errorMessage,
      metadata: descriptor.metadata,
      createdAt: attempts[0]?.timestamp ?? nowMs,
      failedAt: nowMs,
    };

    this.store.save(record);
    return record;
  }

  list(): readonly DeadLetterSideEffect[] {
    return this.store.list();
  }

  get(id: string): DeadLetterSideEffect | undefined {
    return this.store.get(id);
  }

  getByKey(key: string): DeadLetterSideEffect | undefined {
    return this.store.getByKey(key);
  }

  resolve(id: string, resolution: 'replayed' | 'discarded'): boolean {
    const entry = this.store.get(id);
    if (!entry) return false;

    if (resolution === 'discarded') {
      return this.store.remove(id);
    }

    const updated: DeadLetterSideEffect = {
      ...entry,
      resolvedAt: this.now(),
      resolution: 'replayed',
    };
    this.store.save(updated);
    return true;
  }

  remove(id: string): boolean {
    return this.store.remove(id);
  }

  clear(): void {
    this.store.clear();
  }

  subscribe(listener: (entries: readonly DeadLetterSideEffect[]) => void): () => void {
    return this.store.subscribe(listener);
  }
}

export const sideEffectDeadLetterQueue = new SideEffectDeadLetterQueue();
