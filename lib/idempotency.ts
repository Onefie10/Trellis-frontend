/**
 * Idempotency for high-risk writes (issue #28).
 *
 * Retrying a write that already happened is how a user gets charged twice, a
 * reward claimed twice, or two payout requests queued for the same earnings.
 * A client cannot know whether its previous request reached the server, so the
 * only safe retry is one the server can recognise — which needs a key the
 * client sends and the outcome the client remembers.
 *
 * This module is the client half:
 *
 *   - a deterministic key derived from the operation and its payload, so two
 *     clicks on the same logical action produce the same key without any
 *     caller bookkeeping;
 *   - a persisted record of what that key produced, so a retry after a success
 *     returns the original result instead of sending a second request (this
 *     survives a page reload, which a promise cache does not);
 *   - explicit, typed failures for the two cases where replaying is wrong:
 *     the same key reused for a different payload, and a key whose window has
 *     expired.
 *
 * The semantics, in full — every branch is covered by a test:
 *
 *   no record                → run, persist the outcome
 *   succeeded, same payload  → return the stored result, do not run again
 *   failed, same payload     → run again (a failure is not a side effect)
 *   in progress, this tab    → share the first promise, do not run again
 *   in progress, older tab   → IdempotencyInProgressError while it is fresh,
 *                              retried once it goes stale (abandoned attempt)
 *   same key, other payload  → IdempotencyConflictError
 *   expired key              → IdempotencyKeyExpiredError
 *
 * Every branch also emits a telemetry event (see "Telemetry" below) so
 * maintainers can see how often duplicate submissions and key collisions
 * happen — the signature of a UI double-submit bug or a network retry storm.
 */

export type IdempotencyStatus = 'in_progress' | 'succeeded' | 'failed';

export interface IdempotencyRecord {
  key: string;
  /** Fingerprint of the request this key was first used for. */
  fingerprint: string;
  status: IdempotencyStatus;
  /** Stored result, only for `succeeded`. */
  result?: unknown;
  /** Stored reason, only for `failed`. */
  error?: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

export interface IdempotencyStore {
  get(key: string): IdempotencyRecord | null;
  set(key: string, record: IdempotencyRecord): void;
  remove(key: string): void;
}

export class IdempotencyError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'IdempotencyError';
    this.code = code;
    this.status = status;
  }
}

/** The key was already used for a different request. */
export class IdempotencyConflictError extends IdempotencyError {
  constructor(message = 'This idempotency key was already used for a different request') {
    super('IDEMPOTENCY_CONFLICT', message, 409);
    this.name = 'IdempotencyConflictError';
  }
}

/** The key's replay window has passed; a fresh key is required. */
export class IdempotencyKeyExpiredError extends IdempotencyError {
  constructor(message = 'This idempotency key has expired; start the operation again with a new key') {
    super('IDEMPOTENCY_KEY_EXPIRED', message, 400);
    this.name = 'IdempotencyKeyExpiredError';
  }
}

/** The same key is being processed right now. */
export class IdempotencyInProgressError extends IdempotencyError {
  constructor(message = 'A request with this idempotency key is already in progress') {
    super('IDEMPOTENCY_IN_PROGRESS', message, 409);
    this.name = 'IdempotencyInProgressError';
  }
}

export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
/** How long an `in_progress` record is trusted before it is treated as abandoned. */
export const DEFAULT_STALE_IN_PROGRESS_MS = 30 * 1000;

const STORAGE_PREFIX = 'trellis:idempotency:';
const ATTEMPT_PREFIX = 'attempt:';

export class MemoryIdempotencyStore implements IdempotencyStore {
  private readonly records = new Map<string, IdempotencyRecord>();

  get(key: string): IdempotencyRecord | null {
    const record = this.records.get(key);
    // Return a copy so a caller cannot mutate what a later retry will read.
    return record ? { ...record } : null;
  }

  set(key: string, record: IdempotencyRecord): void {
    this.records.set(key, { ...record });
  }

  remove(key: string): void {
    this.records.delete(key);
  }

  /** Test/support helper: how many records are being remembered. */
  size(): number {
    return this.records.size;
  }
}

/**
 * Persists outcomes in `localStorage` so they survive a reload — the case a
 * promise cache cannot cover. Falls back to the in-memory store when there is
 * no usable storage (SSR, private mode, storage disabled), where the module
 * still dedupes within the page.
 */
export class LocalStorageIdempotencyStore implements IdempotencyStore {
  private readonly fallback = new MemoryIdempotencyStore();
  private evictionInterval: number | null = null;

  constructor() {
    this.startEvictionWorker();
  }

  private startEvictionWorker() {
    if (typeof window === 'undefined') return;
    this.evictionInterval = window.setInterval(() => this.evictStale(), 60000) as unknown as number;
  }

  private evictStale() {
    const storage = this.storage;
    if (!storage) return;
    const now = Date.now();
    const toRemove: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key?.startsWith(STORAGE_PREFIX) || key?.startsWith(ATTEMPT_PREFIX)) {
        const raw = storage.getItem(key);
        if (raw) {
          try {
            const record = JSON.parse(raw) as IdempotencyRecord;
            if (record.expiresAt <= now) {
              toRemove.push(key);
            }
          } catch {
             toRemove.push(key);
          }
        }
      }
    }
    for (const key of toRemove) {
      storage.removeItem(key);
    }
  }

  private get storage(): Storage | null {
    try {
      if (typeof window === 'undefined' || !window.localStorage) return null;
      return window.localStorage;
    } catch {
      return null;
    }
  }

  get(key: string): IdempotencyRecord | null {
    const storage = this.storage;
    if (!storage) return this.fallback.get(key);
    const raw = storage.getItem(STORAGE_PREFIX + key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as IdempotencyRecord;
    } catch {
      // A record we cannot read is worse than no record: drop it so the next
      // attempt can proceed instead of failing forever on corrupt data.
      storage.removeItem(STORAGE_PREFIX + key);
      return null;
    }
  }

  set(key: string, record: IdempotencyRecord): void {
    const storage = this.storage;
    if (!storage) {
      this.fallback.set(key, record);
      return;
    }
    storage.setItem(STORAGE_PREFIX + key, JSON.stringify(record));
  }

  remove(key: string): void {
    const storage = this.storage;
    if (!storage) {
      this.fallback.remove(key);
      return;
    }
    storage.removeItem(STORAGE_PREFIX + key);
  }
}

let defaultStore: IdempotencyStore = new LocalStorageIdempotencyStore();

export function getIdempotencyStore(): IdempotencyStore {
  return defaultStore;
}

/** Test/support helper: swap the default store. */
export function setIdempotencyStore(store: IdempotencyStore): void {
  defaultStore = store;
}

/** Stable JSON: object keys sorted, so key order cannot change a fingerprint. */
export function canonicalise(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([k, v]) => [k, sortKeys(v)]));
  }
  return value;
}

/**
 * Fingerprint of a request: what the key is bound to. Two attempts with the
 * same key but a different amount, destination or operation are a conflict,
 * not a retry.
 */
export function fingerprintRequest(value: unknown): string {
  return fnv1a(canonicalise(value));
}

/**
 * Deterministic key for a logical operation. Two clicks on "confirm" produce
 * the same key without the caller storing anything; a genuinely new action
 * (different payload) produces a different one.
 */
export async function createIdempotencyKey(scope: string, payload: unknown): Promise<string> {
  const material = `${scope}:${canonicalise(payload)}`;
  const digest = await sha256Hex(material);
  return `${scope}:${digest}`;
}

/** `crypto.subtle` where available, FNV-1a otherwise (older browsers). */
async function sha256Hex(material: string): Promise<string> {
  const subtle = typeof globalThis !== 'undefined' ? globalThis.crypto?.subtle : undefined;
  if (subtle) {
    const bytes = new TextEncoder().encode(material);
    const hash = await subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(hash))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
  return fnv1a(material);
}

function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}


/* -------------------------------------------------------------------------- */
/* Telemetry                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * What happened to one `executeIdempotent` call:
 *
 *   miss       first attempt for the key — the operation ran
 *   hit        duplicate submission absorbed (stored result or shared promise)
 *   collision  key reuse the engine refused (other payload, or running elsewhere)
 *   retry      the operation ran again after a failed or abandoned attempt
 *   expired    the key's replay window had passed
 */
export type IdempotencyTelemetryKind = 'miss' | 'hit' | 'collision' | 'retry' | 'expired';

export type IdempotencyTelemetryReason =
  | 'first_attempt'
  | 'replayed'
  | 'in_flight'
  | 'fingerprint_mismatch'
  | 'in_progress'
  | 'lock_contention'
  | 'failed_retry'
  | 'stale_retry'
  | 'expired';

export interface IdempotencyTelemetryEvent {
  kind: IdempotencyTelemetryKind;
  reason: IdempotencyTelemetryReason;
  /** Operation scope (the key prefix), never the key or payload itself. */
  scope: string;
  /** Milliseconds since the epoch. */
  ts: number;
}

export interface IdempotencyTelemetryCounters {
  idempotency_requests: number;
  idempotency_hits: number;
  idempotency_collisions: number;
  idempotency_retries: number;
  idempotency_expired: number;
}

export type IdempotencyTelemetryListener = (event: IdempotencyTelemetryEvent) => void;

const COUNTER_FOR_KIND: Record<Exclude<IdempotencyTelemetryKind, 'miss'>, keyof IdempotencyTelemetryCounters> = {
  hit: 'idempotency_hits',
  collision: 'idempotency_collisions',
  retry: 'idempotency_retries',
  expired: 'idempotency_expired',
};

function emptyCounters(): IdempotencyTelemetryCounters {
  return {
    idempotency_requests: 0,
    idempotency_hits: 0,
    idempotency_collisions: 0,
    idempotency_retries: 0,
    idempotency_expired: 0,
  };
}

let telemetryCounters = emptyCounters();
const telemetryListeners = new Set<IdempotencyTelemetryListener>();

/** Keys look like `<scope>:<digest>`; only the low-cardinality scope is reported. */
export function scopeFromIdempotencyKey(key: string): string {
  const withoutAttempt = key.startsWith(ATTEMPT_PREFIX) ? key.slice(ATTEMPT_PREFIX.length) : key;
  const separator = withoutAttempt.lastIndexOf(':');
  return separator > 0 ? withoutAttempt.slice(0, separator) : 'unscoped';
}

function recordIdempotencyTelemetry(
  kind: IdempotencyTelemetryKind,
  reason: IdempotencyTelemetryReason,
  key: string,
  ts: number,
): void {
  telemetryCounters = { ...telemetryCounters, idempotency_requests: telemetryCounters.idempotency_requests + 1 };
  if (kind !== 'miss') {
    const counter = COUNTER_FOR_KIND[kind];
    telemetryCounters[counter] += 1;
  }
  const event: IdempotencyTelemetryEvent = { kind, reason, scope: scopeFromIdempotencyKey(key), ts };
  for (const listener of [...telemetryListeners]) {
    try {
      listener(event);
    } catch {
      // Telemetry must never break a write path.
    }
  }
}

/** Snapshot of the telemetry counters since load (or the last reset). */
export function getIdempotencyTelemetry(): IdempotencyTelemetryCounters {
  return { ...telemetryCounters };
}

/** Test/support helper: zero the counters. Listeners are kept. */
export function resetIdempotencyTelemetry(): void {
  telemetryCounters = emptyCounters();
}

/** Receives every telemetry event; returns an unsubscribe function. */
export function subscribeIdempotencyTelemetry(listener: IdempotencyTelemetryListener): () => void {
  telemetryListeners.add(listener);
  return () => {
    telemetryListeners.delete(listener);
  };
}

/** Share of requests that were duplicates (hits) or refused key reuse (collisions). */
export function duplicateRequestRate(counters: Pick<IdempotencyTelemetryCounters, 'idempotency_requests' | 'idempotency_hits' | 'idempotency_collisions'>): number {
  if (counters.idempotency_requests === 0) return 0;
  return (counters.idempotency_hits + counters.idempotency_collisions) / counters.idempotency_requests;
}

/** Above this duplicate rate the operations dashboard raises a warning. */
export const DUPLICATE_RATE_WARNING_THRESHOLD = 0.2;

export interface IdempotencyRateBucket {
  start: number;
  label: string;
  requests: number;
  hits: number;
  collisions: number;
  retries: number;
  /** (hits + collisions) / requests, 0 when the bucket is empty. */
  duplicateRate: number;
}

/**
 * Buckets telemetry events over `[now - windowMs, now)` for charting hit and
 * collision rates over time. Events outside the window are ignored.
 */
export function buildIdempotencyRateSeries(
  events: readonly IdempotencyTelemetryEvent[],
  options: { windowMs: number; bucketMs: number; now: number },
): IdempotencyRateBucket[] {
  const { windowMs, bucketMs, now } = options;
  if (bucketMs <= 0 || windowMs <= 0) return [];
  const bucketCount = Math.max(1, Math.ceil(windowMs / bucketMs));
  const start = now - bucketCount * bucketMs;
  const buckets: IdempotencyRateBucket[] = Array.from({ length: bucketCount }, (_, index) => {
    const bucketStart = start + index * bucketMs;
    const date = new Date(bucketStart);
    return {
      start: bucketStart,
      label: `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`,
      requests: 0,
      hits: 0,
      collisions: 0,
      retries: 0,
      duplicateRate: 0,
    };
  });

  for (const event of events) {
    if (event.ts < start || event.ts >= now) continue;
    const bucket = buckets[Math.floor((event.ts - start) / bucketMs)];
    bucket.requests += 1;
    if (event.kind === 'hit') bucket.hits += 1;
    if (event.kind === 'collision') bucket.collisions += 1;
    if (event.kind === 'retry') bucket.retries += 1;
  }

  for (const bucket of buckets) {
    bucket.duplicateRate = bucket.requests === 0 ? 0 : (bucket.hits + bucket.collisions) / bucket.requests;
  }
  return buckets;
}

export interface IdempotentRunOptions {
  key: string;
  fingerprint: string;
  /** How long a stored outcome may be replayed. */
  ttlMs?: number;
  /** How long an `in_progress` record is trusted before it counts as abandoned. */
  staleInProgressMs?: number;
  store?: IdempotencyStore;
  now?: () => number;
}

export interface IdempotentRunResult<T> {
  value: T;
  /** True when the value came from a stored outcome rather than a new request. */
  replayed: boolean;
}

/** In-flight operations in this tab, keyed by idempotency key. */
const inFlight = new Map<string, Promise<IdempotentRunResult<unknown>>>();

/**
 * Runs `operation` at most once per key (and per payload), returning the stored
 * outcome for repeats.
 */
export async function executeIdempotent<T>(
  options: IdempotentRunOptions,
  operation: () => Promise<T>,
): Promise<IdempotentRunResult<T>> {
  const {
    key,
    fingerprint,
    ttlMs = DEFAULT_TTL_MS,
    staleInProgressMs = DEFAULT_STALE_IN_PROGRESS_MS,
    store = getIdempotencyStore(),
    now = () => Date.now(),
  } = options;

  const existingInFlight = inFlight.get(key);
  if (existingInFlight) {
    // A second click while the first is still running shares its outcome.
    recordIdempotencyTelemetry('hit', 'in_flight', key, now());
    return (await existingInFlight) as IdempotentRunResult<T>;
  }

  const runLogic = async (): Promise<IdempotentRunResult<T>> => {
    const record = store.get(key);

    if (record) {
      if (record.expiresAt <= now()) {
        recordIdempotencyTelemetry('expired', 'expired', key, now());
        throw new IdempotencyKeyExpiredError();
      }
      if (record.fingerprint !== fingerprint) {
        recordIdempotencyTelemetry('collision', 'fingerprint_mismatch', key, now());
        throw new IdempotencyConflictError();
      }
      if (record.status === 'succeeded') {
        recordIdempotencyTelemetry('hit', 'replayed', key, now());
        return { value: record.result as T, replayed: true };
      }
      if (record.status === 'in_progress' && now() - record.updatedAt < staleInProgressMs) {
        // Another tab started this and has not finished; we cannot see its
        // promise, so refusing is the only way to avoid a second side effect.
        recordIdempotencyTelemetry('collision', 'in_progress', key, now());
        throw new IdempotencyInProgressError();
      }
      // `failed`, or an `in_progress` attempt that went stale: retry.
      recordIdempotencyTelemetry(
        'retry',
        record.status === 'failed' ? 'failed_retry' : 'stale_retry',
        key,
        now(),
      );
    } else {
      recordIdempotencyTelemetry('miss', 'first_attempt', key, now());
    }

    const startedAt = now();
    const pending: IdempotencyRecord = {
      key,
      fingerprint,
      status: 'in_progress',
      createdAt: record?.createdAt ?? startedAt,
      updatedAt: startedAt,
      expiresAt: record && record.expiresAt > startedAt ? record.expiresAt : startedAt + ttlMs,
    };

    store.set(key, pending);
    try {
      const value = await operation();
      store.set(key, {
        ...pending,
        status: 'succeeded',
        result: value,
        updatedAt: now(),
      });
      return { value, replayed: false };
    } catch (error) {
      store.set(key, {
        ...pending,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
        updatedAt: now(),
      });
      throw error;
    }
  };

  const executeWithLock = async (): Promise<IdempotentRunResult<T>> => {
    if (typeof navigator !== 'undefined' && navigator.locks) {
      const lockName = `${STORAGE_PREFIX}${key}`;
      let lockAcquired = false;
      const result = await navigator.locks.request(lockName, { ifAvailable: true }, async (lock) => {
        if (!lock) {
          return null;
        }
        lockAcquired = true;
        return runLogic();
      });
      
      if (!lockAcquired) {
        recordIdempotencyTelemetry('collision', 'lock_contention', key, now());
        throw new IdempotencyInProgressError();
      }
      return result as IdempotentRunResult<T>;
    }
    return runLogic();
  };

  const run = executeWithLock();
  inFlight.set(key, run as Promise<IdempotentRunResult<unknown>>);
  try {
    return await run;
  } finally {
    inFlight.delete(key);
  }
}

/** Test/support helper: drop the in-flight map between cases. */
export function __resetInFlight(): void {
  inFlight.clear();
}

/**
 * Attempt keys — for paths where the *same* request may legitimately be made
 * again later (paying out 100 XLM twice is not the same intent), but a retry of
 * one attempt must reuse its key.
 *
 * `beginAttempt` returns the key of an attempt that is still open, or mints and
 * remembers a new one; `finishAttempt` clears it once the request completed, so
 * the next identical request is a new intent rather than a replay.
 */

export const DEFAULT_ATTEMPT_TTL_MS = 10 * 60 * 1000;

interface AttemptRecord {
  key: string;
  startedAt: number;
  expiresAt: number;
}

interface AttemptStorage {
  get(key: string): IdempotencyRecord | null;
  set(key: string, record: IdempotencyRecord): void;
  remove(key: string): void;
}

function rememberAttempt(
  store: AttemptStorage,
  scope: string,
  attempt: AttemptRecord,
): void {
  // Reuses the record shape so one store backs both concerns.
  store.set(`${ATTEMPT_PREFIX}${scope}`, {
    key: `${ATTEMPT_PREFIX}${scope}`,
    fingerprint: attempt.key,
    status: 'in_progress',
    createdAt: attempt.startedAt,
    updatedAt: attempt.startedAt,
    expiresAt: attempt.expiresAt,
  });
}

function readAttempt(store: AttemptStorage, scope: string): AttemptRecord | null {
  const record = store.get(`${ATTEMPT_PREFIX}${scope}`);
  if (!record) return null;
  return {
    key: record.fingerprint,
    startedAt: record.createdAt,
    expiresAt: record.expiresAt,
  };
}

export interface BeginAttemptOptions {
  ttlMs?: number;
  store?: IdempotencyStore;
  now?: () => number;
}

/** Returns the open attempt's key for `scope`, or mints one. */
export async function beginIdempotentAttempt(
  scope: string,
  options: BeginAttemptOptions = {},
): Promise<string> {
  const {
    ttlMs = DEFAULT_ATTEMPT_TTL_MS,
    store = getIdempotencyStore(),
    now = () => Date.now(),
  } = options;

  const existing = readAttempt(store, scope);
  if (existing && existing.expiresAt > now()) return existing.key;

  // A new attempt gets a *unique* key: stability comes from the stored attempt,
  // not from the derivation, otherwise two attempts that start inside the same
  // millisecond would share a key and the second one would replay the first
  // instead of being the separate request it is.
  const key = await createIdempotencyKey(scope, { at: now(), nonce: randomAttemptNonce() });
  rememberAttempt(store, scope, {
    key,
    startedAt: now(),
    expiresAt: now() + ttlMs,
  });
  return key;
}

function randomAttemptNonce(): string {
  const cryptoRef = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined;
  if (cryptoRef && 'randomUUID' in cryptoRef) return cryptoRef.randomUUID();
  return `${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}

/** Closes the attempt so an identical later request is a new intent. */
export function finishIdempotentAttempt(
  scope: string,
  store: IdempotencyStore = getIdempotencyStore(),
): void {
  store.remove(`${ATTEMPT_PREFIX}${scope}`);
}
