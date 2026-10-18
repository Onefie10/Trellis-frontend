/**
 * History Service — Issue #53
 *
 * Call-site API for recording tamper-evident mutations and verifying chains.
 *
 * Usage:
 *
 *   // On any critical mutation:
 *   const entry = await historyService.record({
 *     recordType:    'agent',
 *     recordId:      agent.id,
 *     actor:         wallet.publicKey,
 *     reason:        'User updated agent capabilities via settings form',
 *     before:        existingAgent,
 *     after:         updatedAgent,
 *     correlationId: operationManager.getOperation(opId)?.correlationId,
 *   });
 *
 *   // Verify a record's chain has not been tampered with:
 *   const result = await historyService.verify('agent', agent.id);
 *   if (result.outcome === 'invalid') {
 *     alert(`Integrity violation: ${result.violations[0].detail}`);
 *   }
 */

import type {
  HistoryEntry,
  CriticalRecordType,
  ChainVerificationResult,
  HistoryServiceOptions,
  HistoryStore,
} from './types';
import { GENESIS_HASH } from './types';
import {
  buildHashMaterial,
  computeHash,
  verifyChain,
  getHistoryStore,
} from './history-store';

// ─── ID generation ────────────────────────────────────────────────────────────

function newEntryId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `he-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

// ─── Mutation request ─────────────────────────────────────────────────────────

export interface RecordMutationOptions {
  recordType: CriticalRecordType;
  recordId: string;
  /** Wallet public key or user ID of whoever triggered this mutation. */
  actor: string;
  /** Required — call-sites must justify every write. */
  reason: string;
  /** State before mutation; null for create events. */
  before: Record<string, unknown> | null;
  /** State after mutation. */
  after: Record<string, unknown>;
  correlationId?: string;
  /** Override timestamp (useful for deterministic tests). */
  occurredAt?: string;
}

// ─── Service ─────────────────────────────────────────────────────────────────

export class HistoryService {
  private readonly store: HistoryStore;

  constructor(opts: HistoryServiceOptions = {}) {
    this.store = opts.store ?? getHistoryStore();
  }

  /**
   * Record a mutation by building, hashing, and appending a new HistoryEntry.
   *
   * The previousHash is read from the latest entry in the chain, or
   * GENESIS_HASH if this is the first entry.  The returned entry includes the
   * computed hash so callers can log it for diagnostics.
   */
  async record(opts: RecordMutationOptions): Promise<HistoryEntry> {
    const latest      = this.store.getLatest(opts.recordType, opts.recordId);
    const previousHash = latest?.hash ?? GENESIS_HASH;

    const draft: Omit<HistoryEntry, 'hash'> = {
      id:           newEntryId(),
      recordType:   opts.recordType,
      recordId:     opts.recordId,
      actor:        opts.actor,
      reason:       opts.reason,
      before:       opts.before,
      after:        opts.after,
      occurredAt:   opts.occurredAt ?? new Date().toISOString(),
      previousHash,
      correlationId: opts.correlationId,
    };

    const hash: string = await computeHash(buildHashMaterial(draft));
    const entry: HistoryEntry = { ...draft, hash };

    this.store.append(entry);
    return entry;
  }

  /**
   * Verify the hash chain for a specific record.
   * Returns the full verification result including any violations found.
   */
  async verify(
    recordType: CriticalRecordType,
    recordId: string,
  ): Promise<ChainVerificationResult> {
    const chain = this.store.getChain(recordType, recordId);
    return verifyChain(chain);
  }

  /**
   * Verify all chains for a given record type.
   * Groups results by record ID so callers can surface per-record violations.
   */
  async verifyAll(
    recordType: CriticalRecordType,
  ): Promise<Record<string, ChainVerificationResult>> {
    const all     = this.store.listAll();
    const recordIds = [
      ...new Set(
        all
          .filter(e => e.recordType === recordType)
          .map(e => e.recordId),
      ),
    ];

    const results: Record<string, ChainVerificationResult> = {};
    for (const id of recordIds) {
      results[id] = await this.verify(recordType, id);
    }
    return results;
  }

  /**
   * Return the full change history for a record (oldest-first).
   * Useful for "view history" panels in the UI.
   */
  getHistory(
    recordType: CriticalRecordType,
    recordId: string,
  ): HistoryEntry[] {
    return this.store.getChain(recordType, recordId);
  }

  /**
   * Return all mutations performed by a specific actor.
   * Useful for maintainer audit queries.
   */
  getActorHistory(actor: string): HistoryEntry[] {
    return this.store.getByActor(actor);
  }

  /**
   * Return all history entries, newest-first, across all record types.
   */
  listAll(): HistoryEntry[] {
    return this.store.listAll();
  }
}

// ─── Default singleton ────────────────────────────────────────────────────────

let _defaultService: HistoryService | null = null;

export function getHistoryService(): HistoryService {
  if (!_defaultService) _defaultService = new HistoryService();
  return _defaultService;
}

export function setHistoryService(service: HistoryService): void {
  _defaultService = service;
}
