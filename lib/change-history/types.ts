/**
 * Tamper-Evident Change History — Issue #53
 *
 * Critical domain records (ownership, balance, permissions, access) need a
 * verifiable audit trail.  Mutable timestamps alone are insufficient because
 * a bad actor — or a bad deploy — can silently overwrite them.
 *
 * Design: hash chain
 *   Every history entry stores the SHA-256 hash of the previous entry (or a
 *   genesis sentinel for the first entry).  Verification walks the chain and
 *   recomputes each hash; a mismatch at any position indicates tampering,
 *   deletion, or reordering.
 *
 *   hash(entryN) = sha256(
 *     entryN.id
 *     + entryN.recordType
 *     + entryN.recordId
 *     + entryN.actor
 *     + entryN.reason
 *     + JSON.stringify(sorted(entryN.before))
 *     + JSON.stringify(sorted(entryN.after))
 *     + entryN.occurredAt
 *     + entryN.previousHash
 *   )
 *
 * The chain is per-(recordType, recordId) pair — each domain record gets its
 * own independent hash chain.  This avoids cross-record ordering disputes while
 * still protecting each record's individual history.
 */

// ─── Domain record types protected by this module ────────────────────────────

/**
 * Record types whose mutations must produce history entries.
 *
 * Add a new literal here whenever a record type joins the protected set.
 */
export type CriticalRecordType =
  | 'agent'        // ownership, status, capabilities
  | 'wallet'       // publicKey, network, linked wallets
  | 'delegation'   // permissions, status (granted/revoked)
  | 'stake'        // stakedAmount, effectiveStake
  | 'provenance'   // immutable audit trail entries themselves
  | 'test_case'    // contract/function/args defining a test
  | 'import_batch' // import pipeline results (idempotency & rollback data)
  | 'migration';   // migration run records

// ─── Entry ───────────────────────────────────────────────────────────────────

/** A single mutation event in the hash chain for one record. */
export interface HistoryEntry {
  /** Stable globally unique identifier for this entry. */
  id: string;
  /** The type of domain record that was mutated. */
  recordType: CriticalRecordType;
  /** The ID of the specific record instance. */
  recordId: string;
  /** Public key or user ID of the entity that triggered the mutation. */
  actor: string;
  /** Human-readable reason for the change (required — forces call-sites to justify writes). */
  reason: string;
  /** Full record state immediately before the mutation (omit for create events). */
  before: Record<string, unknown> | null;
  /** Full record state immediately after the mutation. */
  after: Record<string, unknown>;
  /** ISO-8601 timestamp. */
  occurredAt: string;
  /** SHA-256 hex of the previous entry in this record's chain. */
  previousHash: string;
  /** SHA-256 hex of this entry (computed by the writer, verified by the checker). */
  hash: string;
  /** Correlation ID linking this entry to the operation that produced it. */
  correlationId?: string;
}

// ─── Genesis sentinel ─────────────────────────────────────────────────────────

/**
 * The previousHash value used for the first entry in a chain.
 * A fixed string distinguishes "this is the start of history" from "the
 * previousHash field was accidentally left blank".
 */
export const GENESIS_HASH = '0000000000000000000000000000000000000000000000000000000000000000';

// ─── Verification ────────────────────────────────────────────────────────────

export type VerificationOutcome = 'valid' | 'invalid';

export interface ChainVerificationResult {
  outcome: VerificationOutcome;
  /** Total number of entries examined. */
  checked: number;
  /** Entries that failed hash or ordering checks. */
  violations: ChainViolation[];
  verifiedAt: string;
}

export type ViolationKind =
  | 'hash_mismatch'      // Recomputed hash ≠ stored hash
  | 'chain_break'        // Entry's previousHash ≠ previous entry's hash
  | 'out_of_order'       // occurredAt timestamps are not monotonically increasing
  | 'missing_entry';     // A gap in the expected sequence

export interface ChainViolation {
  kind: ViolationKind;
  entryId: string;
  detail: string;
}

// ─── Store interface ──────────────────────────────────────────────────────────

export interface HistoryStore {
  /** Append an entry to the chain for (recordType, recordId). */
  append(entry: HistoryEntry): void;
  /** Return all entries for a record, ordered oldest-first. */
  getChain(recordType: CriticalRecordType, recordId: string): HistoryEntry[];
  /** Return the most recent entry for a record (for chaining new entries). */
  getLatest(recordType: CriticalRecordType, recordId: string): HistoryEntry | null;
  /** Return all entries written by a specific actor. */
  getByActor(actor: string): HistoryEntry[];
  /** Return all entries across all record types, ordered by occurredAt desc. */
  listAll(): HistoryEntry[];
  /** Erase all stored history (test/reset only). */
  clear(): void;
}

// ─── Service options ──────────────────────────────────────────────────────────

export interface HistoryServiceOptions {
  store?: HistoryStore;
}
