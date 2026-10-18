/**
 * Bounded dead-letter queue for operations that reached a terminal failure.
 *
 * Why this exists: `lib/partial-failures.ts` had a `manual_intervention` status
 * but no queue, no reason breakdown, and no attempt history. A maintainer
 * looking at a stalled transaction could see *that* it failed and not *why*,
 * how many times it was attempted, or what the underlying error was. Terminal
 * failures were therefore effectively invisible.
 *
 * Design notes:
 * - Bounded on purpose. The queue lives in module memory, so an unbounded
 *   version would leak for the lifetime of the server process. When capacity is
 *   reached the oldest *unresolved* record is evicted and counted, so the loss is
 *   observable rather than silent.
 * - Unresolved records are evicted before resolved ones. An operator who already
 *   triaged a record has less need for it than one with work outstanding.
 * - Storage is an interface so a durable backing store can be added later
 *   without changing the scheduler.
 */

import type { ErrorClassification } from './errors';
import type { OperationClass } from './policy';

/**
 * Why an operation stopped being retried.
 *
 * - `retries_exhausted`: still retryable, but the budget ran out. Most common.
 * - `non_retryable`: the failure was permanent, so it was dead-lettered on the
 *   first attempt rather than burning the budget.
 * - `abandoned`: recorded by callers that gave up for a reason outside the
 *   scheduler, e.g. a user navigating away mid-operation.
 */
export type DeadLetterReason = 'retries_exhausted' | 'non_retryable' | 'abandoned';

export type DeadLetterResolution = 'replayed' | 'discarded' | 'acknowledged';

export interface RetryAttempt {
  /** Zero-based attempt number. Attempt 0 is the initial try. */
  attempt: number;
  startedAt: string;
  durationMs: number;
  classification: ErrorClassification;
  /** Delay actually slept before the next attempt, absent on the last attempt. */
  waitedMs?: number;
}

export interface DeadLetterRecord {
  id: string;
  operationClass: OperationClass;
  operationId: string;
  reason: DeadLetterReason;
  classification: ErrorClassification;
  attempts: RetryAttempt[];
  attemptsCount: number;
  firstFailedAt: string;
  deadLetteredAt: string;
  resolvedAt?: string;
  resolution?: DeadLetterResolution;
  resolutionNotes?: string;
  /** Caller-supplied context, e.g. the affected resource or wallet address. */
  context: Record<string, unknown>;
}

export interface DeadLetterQuery {
  operationClass?: OperationClass;
  reason?: DeadLetterReason;
  operationId?: string;
  /** Defaults to unresolved only, which is what a maintainer triage view wants. */
  includeResolved?: boolean;
  limit?: number;
}

export interface DeadLetterStore {
  add(record: DeadLetterRecord): void;
  get(id: string): DeadLetterRecord | null;
  list(query?: DeadLetterQuery): DeadLetterRecord[];
  resolve(id: string, resolution: DeadLetterResolution, notes?: string): DeadLetterRecord | null;
  size(): number;
  /** Records evicted to stay within capacity. Non-zero means data was dropped. */
  droppedCount(): number;
  clear(): void;
}

const DEFAULT_MAX_RECORDS = 500;

function makeId(): string {
  const random =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2, 12);
  return `dlq_${Date.now().toString(36)}_${random}`;
}

/** In-memory implementation. Replace with a durable store for multi-instance deploys. */
export class InMemoryDeadLetterStore implements DeadLetterStore {
  private records = new Map<string, DeadLetterRecord>();
  private dropped = 0;

  constructor(private readonly maxRecords: number = DEFAULT_MAX_RECORDS) {
    if (maxRecords <= 0) {
      throw new RangeError('maxRecords must be positive');
    }
  }

  add(record: DeadLetterRecord): void {
    this.records.set(record.id, record);
    this.evictIfNeeded();
  }

  get(id: string): DeadLetterRecord | null {
    return this.records.get(id) ?? null;
  }

  list(query: DeadLetterQuery = {}): DeadLetterRecord[] {
    const includeResolved = query.includeResolved ?? false;

    const matches = Array.from(this.records.values()).filter((record) => {
      if (!includeResolved && record.resolution) return false;
      if (query.operationClass && record.operationClass !== query.operationClass) return false;
      if (query.reason && record.reason !== query.reason) return false;
      if (query.operationId && record.operationId !== query.operationId) return false;
      return true;
    });

    // Newest first: a triage view wants the most recent breakage at the top.
    matches.sort((a, b) => b.deadLetteredAt.localeCompare(a.deadLetteredAt));

    return query.limit === undefined ? matches : matches.slice(0, Math.max(0, query.limit));
  }

  resolve(
    id: string,
    resolution: DeadLetterResolution,
    notes?: string,
  ): DeadLetterRecord | null {
    const record = this.records.get(id);
    if (!record) return null;
    if (record.resolution) {
      throw new Error(`Dead-letter record ${id} is already resolved as ${record.resolution}`);
    }

    record.resolution = resolution;
    record.resolutionNotes = notes;
    record.resolvedAt = new Date().toISOString();
    return record;
  }

  size(): number {
    return this.records.size;
  }

  droppedCount(): number {
    return this.dropped;
  }

  clear(): void {
    this.records.clear();
    this.dropped = 0;
  }

  /**
   * Keeps the map at or below `maxRecords`, preferring to drop resolved records
   * and, among unresolved ones, the oldest.
   */
  private evictIfNeeded(): void {
    while (this.records.size > this.maxRecords) {
      let victimId: string | undefined;

      for (const [id, record] of this.records) {
        if (record.resolution) {
          victimId = id;
          break;
        }
      }

      if (!victimId) {
        for (const id of this.records.keys()) {
          victimId = id;
          break;
        }
      }

      if (!victimId) return;
      this.records.delete(victimId);
      this.dropped += 1;
    }
  }
}

/**
 * Maintainer-facing facade over a {@link DeadLetterStore}.
 *
 * Counts are exposed separately from the records so a dashboard can show
 * "12 dead-lettered, 3 triaged, 1 evicted since start" without loading payloads.
 */
export class DeadLetterQueue {
  constructor(
    private readonly store: DeadLetterStore = new InMemoryDeadLetterStore(),
  ) {}

  /**
   * Records a terminal failure. Returns the stored record so callers can attach
   * the id to the error they throw.
   */
  record(init: {
    operationClass: OperationClass;
    operationId: string;
    reason: DeadLetterReason;
    classification: ErrorClassification;
    attempts: RetryAttempt[];
    context?: Record<string, unknown>;
    now?: () => number;
  }): DeadLetterRecord {
    const now = init.now ?? Date.now;
    const timestamp = new Date(now()).toISOString();

    // A record with no attempts carries no diagnostic value and would look like a
    // silent drop to a maintainer, so synthesise an entry from the classification.
    const attempts: RetryAttempt[] =
      init.attempts.length > 0
        ? [...init.attempts]
        : [{ attempt: 0, startedAt: timestamp, durationMs: 0, classification: init.classification }];

    const record: DeadLetterRecord = {
      id: makeId(),
      operationClass: init.operationClass,
      operationId: init.operationId,
      reason: init.reason,
      classification: init.classification,
      attempts,
      // Derived from the final array so the count can never disagree with it.
      attemptsCount: attempts.length,
      firstFailedAt: attempts[0].startedAt,
      deadLetteredAt: timestamp,
      context: { ...(init.context ?? {}) },
    };

    this.store.add(record);
    return record;
  }

  get(id: string): DeadLetterRecord | null {
    return this.store.get(id);
  }

  list(query: DeadLetterQuery = {}): DeadLetterRecord[] {
    return this.store.list(query);
  }

  resolve(
    id: string,
    resolution: DeadLetterResolution,
    notes?: string,
  ): DeadLetterRecord | null {
    return this.store.resolve(id, resolution, notes);
  }

  /** Aggregate view for a dashboard. Cheap: no attempt payloads are loaded. */
  stats(): {
    total: number;
    unresolved: number;
    resolved: number;
    byReason: Record<DeadLetterReason, number>;
    byOperationClass: Partial<Record<OperationClass, number>>;
    dropped: number;
  } {
    const all = this.store.list({ includeResolved: true });
    const byReason: Record<DeadLetterReason, number> = {
      retries_exhausted: 0,
      non_retryable: 0,
      abandoned: 0,
    };
    const byOperationClass: Partial<Record<OperationClass, number>> = {};

    for (const record of all) {
      byReason[record.reason] += 1;
      byOperationClass[record.operationClass] =
        (byOperationClass[record.operationClass] ?? 0) + 1;
    }

    return {
      total: all.length,
      unresolved: all.filter((record) => !record.resolution).length,
      resolved: all.filter((record) => record.resolution).length,
      byReason,
      byOperationClass,
      dropped: this.store.droppedCount(),
    };
  }

  clear(): void {
    this.store.clear();
  }
}

/** Process-wide queue. Swap the store for a durable one before running multi-instance. */
export const deadLetterQueue = new DeadLetterQueue();
