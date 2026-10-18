/**
 * Bucket storage.
 *
 * `MemoryRateLimitStore` is the default because it needs no infrastructure and
 * is enough for a single Next.js server (or a dev machine). It is deliberately
 * behind the `RateLimitStore` interface, and `limiter.ts` accepts any store, so
 * a multi-instance deployment can swap in Redis without touching the limiter:
 *
 *   const limiter = new RateLimiter({ store: new RedisRateLimitStore(redis) });
 *
 * Two things matter for the in-memory flavour: it must not grow without bound
 * (a scraper with random IPs would otherwise leak one entry per request), and it
 * must not hand back state it has already expired.
 */

import type { RateLimitStore, TokenBucketState } from "./types";

export interface MemoryRateLimitStoreOptions {
  /** Hard ceiling on live buckets. Default 10_000. */
  maxKeys?: number;
  /** A bucket untouched for this long is dropped. Default 10 minutes. */
  idleTtlMs?: number;
  /** Injectable clock, for tests. */
  now?: () => number;
}

interface StoredBucket extends TokenBucketState {
  /** Last read/write, used for eviction ordering. */
  seenAt: number;
}

export class MemoryRateLimitStore implements RateLimitStore {
  private buckets = new Map<string, StoredBucket>();
  private readonly maxKeys: number;
  private readonly idleTtlMs: number;
  private readonly now: () => number;

  constructor(options: MemoryRateLimitStoreOptions = {}) {
    this.maxKeys = options.maxKeys ?? 10_000;
    this.idleTtlMs = options.idleTtlMs ?? 10 * 60_000;
    this.now = options.now ?? (() => Date.now());
  }

  get(key: string): TokenBucketState | undefined {
    const stored = this.buckets.get(key);
    if (!stored) return undefined;

    if (this.now() - stored.seenAt > this.idleTtlMs) {
      this.buckets.delete(key);
      return undefined;
    }

    stored.seenAt = this.now();
    return { tokens: stored.tokens, updatedAt: stored.updatedAt };
  }

  set(key: string, state: TokenBucketState): void {
    if (this.buckets.size >= this.maxKeys && !this.buckets.has(key)) {
      this.evict();
    }
    this.buckets.set(key, { ...state, seenAt: this.now() });
  }

  delete(key: string): void {
    this.buckets.delete(key);
  }

  size(): number {
    return this.buckets.size;
  }

  reset(): void {
    this.buckets.clear();
  }

  /** Drops expired buckets, then the oldest ones if still over the ceiling. */
  private evict(): void {
    const cutoff = this.now() - this.idleTtlMs;
    for (const [key, value] of this.buckets) {
      if (value.seenAt <= cutoff) this.buckets.delete(key);
    }
    if (this.buckets.size < this.maxKeys) return;

    // Map iterates in insertion order, so this drops the least recently created
    // buckets. That is close enough to LRU for abuse protection and never grows.
    const overflow = this.buckets.size - this.maxKeys + 1;
    let dropped = 0;
    for (const key of this.buckets.keys()) {
      this.buckets.delete(key);
      dropped += 1;
      if (dropped >= overflow) break;
    }
  }
}

/**
 * Shared store for the process-wide limiter.
 *
 * Exported so a route handler or a health check can read `size()` without
 * holding a reference to the limiter itself.
 */
export const memoryRateLimitStore = new MemoryRateLimitStore();
