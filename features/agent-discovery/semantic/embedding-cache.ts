/**
 * Embedding cache.
 *
 * Two layers, because they solve different problems:
 *
 *   - in-memory LRU: re-rendering the marketplace, changing a filter or repeating
 *     a query must not re-run the model;
 *   - optional persistent backend (`localStorage`): the model weights are cached
 *     by Transformers.js, but the *vectors* are not, so a page reload would
 *     otherwise re-embed the whole catalogue.
 *
 * Keys include the embedder id, so switching model never mixes two vector spaces.
 * Entries are versioned, so a change to the document builder invalidates them.
 */

import { quantiseVector } from "./cosine";

/** Bump when `buildAgentDocument()` changes shape — old vectors stop matching. */
export const CACHE_VERSION = 1;

export interface EmbeddingStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  /** Optional: only needed by `clear()` to drop namespaced keys. */
  length?: number;
  key?(index: number): string | null;
}

export interface EmbeddingCacheOptions {
  /** In-memory entries. Default 2000. */
  maxEntries?: number;
  /** `localStorage`-like store; omit for memory-only caching. */
  storage?: EmbeddingStorage;
  /** Namespace for the persistent keys. */
  namespace?: string;
}

export interface CachedVector {
  vector: Float32Array;
  dimension: number;
}

function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** Content hash used in logs, stats and storage keys. */
export function vectorKey(embedderId: string, text: string): string {
  return `${CACHE_VERSION}:${embedderId}:${fnv1a(text)}:${text.length}`;
}

export class EmbeddingCache {
  private readonly memory = new Map<string, Float32Array>();
  private readonly maxEntries: number;
  private readonly storage?: EmbeddingStorage;
  private readonly namespace: string;
  private hitCount = 0;
  private missCount = 0;

  constructor(options: EmbeddingCacheOptions = {}) {
    this.maxEntries = options.maxEntries ?? 2000;
    this.storage = options.storage;
    this.namespace = options.namespace ?? "trellis:embeddings";
  }

  get hits(): number {
    return this.hitCount;
  }

  get misses(): number {
    return this.missCount;
  }

  get size(): number {
    return this.memory.size;
  }

  get(key: string): Float32Array | undefined {
    const inMemory = this.memory.get(key);
    if (inMemory) {
      this.touch(key, inMemory);
      this.hitCount += 1;
      return inMemory;
    }

    const fromStorage = this.readStorage(key);
    if (fromStorage) {
      this.touch(key, fromStorage);
      this.hitCount += 1;
      return fromStorage;
    }

    this.missCount += 1;
    return undefined;
  }

  set(key: string, vector: Float32Array): void {
    this.touch(key, vector);
    this.writeStorage(key, vector);
  }

  has(key: string): boolean {
    return this.memory.has(key) || this.readStorage(key) !== undefined;
  }

  clear(): void {
    this.memory.clear();
    this.hitCount = 0;
    this.missCount = 0;

    const storage = this.storage;
    if (!storage || typeof storage.key !== "function") return;
    try {
      const prefix = `${this.namespace}:`;
      const doomed: string[] = [];
      const count = storage.length ?? 0;
      for (let i = 0; i < count; i += 1) {
        const key = storage.key(i);
        if (key && key.startsWith(prefix)) doomed.push(key);
      }
      for (const key of doomed) storage.removeItem(key);
    } catch {
      // A storage backend that throws (private mode quota, disabled cookies) must
      // not break a search — the in-memory layer is already cleared.
    }
  }

  /** Re-inserts an entry so it becomes the most recently used. */
  private touch(key: string, vector: Float32Array): void {
    this.memory.delete(key);
    this.memory.set(key, vector);

    while (this.memory.size > this.maxEntries) {
      const oldest = this.memory.keys().next();
      if (oldest.done) break;
      this.memory.delete(oldest.value);
    }
  }

  private storageKey(key: string): string {
    return `${this.namespace}:${key}`;
  }

  private readStorage(key: string): Float32Array | undefined {
    const storage = this.storage;
    if (!storage) return undefined;
    try {
      const raw = storage.getItem(this.storageKey(key));
      if (!raw) return undefined;
      const parsed = JSON.parse(raw) as { vector?: number[] };
      if (!Array.isArray(parsed.vector)) return undefined;
      return Float32Array.from(parsed.vector);
    } catch {
      return undefined;
    }
  }

  private writeStorage(key: string, vector: Float32Array): void {
    const storage = this.storage;
    if (!storage) return;
    try {
      storage.setItem(
        this.storageKey(key),
        JSON.stringify({ vector: quantiseVector(vector, 5) }),
      );
    } catch {
      // Quota exceeded — drop the persistent copy and keep the memory one.
      try {
        storage.removeItem(this.storageKey(key));
      } catch {
        /* ignore */
      }
    }
  }
}

/** `localStorage` when it is actually usable (it throws in some private modes). */
export function browserStorage(): EmbeddingStorage | undefined {
  try {
    if (typeof window === "undefined" || !window.localStorage) return undefined;
    const probe = `${"trellis:embeddings"}:probe`;
    window.localStorage.setItem(probe, "1");
    window.localStorage.removeItem(probe);
    return window.localStorage;
  } catch {
    return undefined;
  }
}
