/**
 * History Store — Issue #53
 *
 * Two concrete HistoryStore implementations:
 *
 *   MemoryHistoryStore           — tests and SSR paths
 *   LocalStorageHistoryStore     — browser sessions; survives page reload
 *
 * Storage layout (localStorage):
 *   trellis:history:entry:<id>          — individual HistoryEntry (JSON)
 *   trellis:history:chain:<type>:<id>   — ordered array of entry IDs for one record
 *   trellis:history:actor:<actor>       — array of entry IDs for one actor
 *
 * The chain index makes chain retrieval O(chain length) rather than O(all
 * entries); the actor index makes actor lookup O(actor entries).
 *
 * Hash computation:
 *   SHA-256 where available; FNV-1a fallback for environments without
 *   crypto.subtle.  Both paths are tested explicitly.
 */

import type {
  HistoryEntry,
  HistoryStore,
  CriticalRecordType,
  ChainVerificationResult,
  ChainViolation,
} from './types';
import { GENESIS_HASH } from './types';

// ─── Hash computation ─────────────────────────────────────────────────────────

/** Stable JSON serialisation — object keys sorted so field order doesn't matter. */
function stableJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, val]) => [k, sortKeys(val)]),
    );
  }
  return v;
}

/**
 * Build the canonical string that is fed into the hash function.
 * The order of fields is fixed here — changes would break existing chains.
 */
export function buildHashMaterial(entry: Omit<HistoryEntry, 'hash'>): string {
  return [
    entry.id,
    entry.recordType,
    entry.recordId,
    entry.actor,
    entry.reason,
    stableJson(entry.before),
    stableJson(entry.after),
    entry.occurredAt,
    entry.previousHash,
  ].join('|');
}

/** SHA-256 hex where available, FNV-1a hex otherwise. */
export async function computeHash(material: string): Promise<string> {
  const subtle =
    typeof globalThis !== 'undefined' ? globalThis.crypto?.subtle : undefined;
  if (subtle) {
    const bytes  = new TextEncoder().encode(material);
    const buffer = await subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(buffer))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }
  return fnv1a(material).padStart(64, '0');
}

function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash  = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16);
}

// ─── Verification ─────────────────────────────────────────────────────────────

/**
 * Walk a chain, recompute every hash, and verify the previousHash linkage.
 * Exported so the service and tests can use it directly.
 */
export async function verifyChain(
  entries: HistoryEntry[],
): Promise<ChainVerificationResult> {
  const violations: ChainViolation[] = [];
  let prevHash = GENESIS_HASH;

  for (let i = 0; i < entries.length; i++) {
    const entry    = entries[i];
    const material = buildHashMaterial(entry);
    const computed = await computeHash(material);

    // 1. Hash integrity
    if (computed !== entry.hash) {
      violations.push({
        kind:    'hash_mismatch',
        entryId: entry.id,
        detail:  `Stored hash ${entry.hash.slice(0, 12)}… ≠ computed ${computed.slice(0, 12)}…`,
      });
    }

    // 2. Chain linkage
    if (entry.previousHash !== prevHash) {
      violations.push({
        kind:    'chain_break',
        entryId: entry.id,
        detail:  `previousHash ${entry.previousHash.slice(0, 12)}… ≠ expected ${prevHash.slice(0, 12)}…`,
      });
    }

    // 3. Monotone timestamps (entries must be ordered oldest-first)
    if (i > 0) {
      const prevTime = new Date(entries[i - 1].occurredAt).getTime();
      const thisTime = new Date(entry.occurredAt).getTime();
      if (thisTime < prevTime) {
        violations.push({
          kind:    'out_of_order',
          entryId: entry.id,
          detail:  `occurredAt ${entry.occurredAt} is before previous entry ${entries[i - 1].occurredAt}`,
        });
      }
    }

    // Advance the expected hash (use the computed value so a mismatch in one
    // entry doesn't cascade false chain-break violations for all followers).
    prevHash = computed;
  }

  return {
    outcome:    violations.length === 0 ? 'valid' : 'invalid',
    checked:    entries.length,
    violations,
    verifiedAt: new Date().toISOString(),
  };
}

// ─── MemoryHistoryStore ───────────────────────────────────────────────────────

export class MemoryHistoryStore implements HistoryStore {
  /** All entries by entry ID. */
  private entries  = new Map<string, HistoryEntry>();
  /** Chain index: (type:id) → ordered entry IDs (oldest first). */
  private chains   = new Map<string, string[]>();
  /** Actor index: actor → entry IDs. */
  private actors   = new Map<string, string[]>();

  private chainKey(recordType: CriticalRecordType, recordId: string): string {
    return `${recordType}:${recordId}`;
  }

  append(entry: HistoryEntry): void {
    this.entries.set(entry.id, { ...entry });

    const ck  = this.chainKey(entry.recordType, entry.recordId);
    const ids = this.chains.get(ck) ?? [];
    ids.push(entry.id);
    this.chains.set(ck, ids);

    const actorIds = this.actors.get(entry.actor) ?? [];
    actorIds.push(entry.id);
    this.actors.set(entry.actor, actorIds);
  }

  getChain(recordType: CriticalRecordType, recordId: string): HistoryEntry[] {
    const ids = this.chains.get(this.chainKey(recordType, recordId)) ?? [];
    return ids.map(id => ({ ...this.entries.get(id)! })).filter(Boolean);
  }

  getLatest(recordType: CriticalRecordType, recordId: string): HistoryEntry | null {
    const chain = this.getChain(recordType, recordId);
    return chain.length > 0 ? chain[chain.length - 1] : null;
  }

  getByActor(actor: string): HistoryEntry[] {
    const ids = this.actors.get(actor) ?? [];
    return ids.map(id => ({ ...this.entries.get(id)! })).filter(Boolean);
  }

  listAll(): HistoryEntry[] {
    return Array.from(this.entries.values()).sort(
      (a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime(),
    );
  }

  clear(): void {
    this.entries.clear();
    this.chains.clear();
    this.actors.clear();
  }

  /** Test helper. */
  size(): number {
    return this.entries.size;
  }
}

// ─── LocalStorageHistoryStore ─────────────────────────────────────────────────

const ENTRY_PREFIX = 'trellis:history:entry:';
const CHAIN_PREFIX = 'trellis:history:chain:';
const ACTOR_PREFIX = 'trellis:history:actor:';

export class LocalStorageHistoryStore implements HistoryStore {
  private readonly fallback = new MemoryHistoryStore();

  private get storage(): Storage | null {
    try {
      if (typeof window === 'undefined' || !window.localStorage) return null;
      window.localStorage.setItem('__trellis_h_check__', '1');
      window.localStorage.removeItem('__trellis_h_check__');
      return window.localStorage;
    } catch {
      return null;
    }
  }

  private readJson<T>(key: string): T | null {
    const s = this.storage;
    if (!s) return null;
    const raw = s.getItem(key);
    if (!raw) return null;
    try { return JSON.parse(raw) as T; } catch { s.removeItem(key); return null; }
  }

  private writeJson(key: string, value: unknown): void {
    const s = this.storage;
    if (!s) return;
    try { s.setItem(key, JSON.stringify(value)); } catch { /* quota */ }
  }

  append(entry: HistoryEntry): void {
    const s = this.storage;
    if (!s) { this.fallback.append(entry); return; }

    this.writeJson(`${ENTRY_PREFIX}${entry.id}`, entry);

    const chainKey = `${CHAIN_PREFIX}${entry.recordType}:${entry.recordId}`;
    const ids: string[] = this.readJson<string[]>(chainKey) ?? [];
    ids.push(entry.id);
    this.writeJson(chainKey, ids);

    const actorKey = `${ACTOR_PREFIX}${entry.actor}`;
    const actorIds: string[] = this.readJson<string[]>(actorKey) ?? [];
    actorIds.push(entry.id);
    this.writeJson(actorKey, actorIds);
  }

  getChain(recordType: CriticalRecordType, recordId: string): HistoryEntry[] {
    const s = this.storage;
    if (!s) return this.fallback.getChain(recordType, recordId);

    const ids: string[] = this.readJson(`${CHAIN_PREFIX}${recordType}:${recordId}`) ?? [];
    return ids
      .map(id => this.readJson<HistoryEntry>(`${ENTRY_PREFIX}${id}`))
      .filter((e): e is HistoryEntry => e !== null);
  }

  getLatest(recordType: CriticalRecordType, recordId: string): HistoryEntry | null {
    const chain = this.getChain(recordType, recordId);
    return chain.length > 0 ? chain[chain.length - 1] : null;
  }

  getByActor(actor: string): HistoryEntry[] {
    const s = this.storage;
    if (!s) return this.fallback.getByActor(actor);

    const ids: string[] = this.readJson(`${ACTOR_PREFIX}${actor}`) ?? [];
    return ids
      .map(id => this.readJson<HistoryEntry>(`${ENTRY_PREFIX}${id}`))
      .filter((e): e is HistoryEntry => e !== null);
  }

  listAll(): HistoryEntry[] {
    const s = this.storage;
    if (!s) return this.fallback.listAll();

    const entries: HistoryEntry[] = [];
    for (let i = 0; i < s.length; i++) {
      const key = s.key(i);
      if (key?.startsWith(ENTRY_PREFIX)) {
        const e = this.readJson<HistoryEntry>(key);
        if (e) entries.push(e);
      }
    }
    return entries.sort(
      (a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime(),
    );
  }

  clear(): void {
    const s = this.storage;
    if (!s) { this.fallback.clear(); return; }

    const toRemove: string[] = [];
    for (let i = 0; i < s.length; i++) {
      const key = s.key(i);
      if (
        key?.startsWith(ENTRY_PREFIX) ||
        key?.startsWith(CHAIN_PREFIX) ||
        key?.startsWith(ACTOR_PREFIX)
      ) {
        toRemove.push(key);
      }
    }
    toRemove.forEach(k => s.removeItem(k));
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

let _defaultHistoryStore: HistoryStore = new LocalStorageHistoryStore();

export function getHistoryStore(): HistoryStore {
  return _defaultHistoryStore;
}

export function setHistoryStore(store: HistoryStore): void {
  _defaultHistoryStore = store;
}
