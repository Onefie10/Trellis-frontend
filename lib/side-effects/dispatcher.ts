/**
 * Idempotent Side-Effect Dispatcher.
 *
 * Coordinates execution of client-side mutations (Stellar transactions,
 * API requests, telemetry events) with:
 *   - Keyed deduplication & payload conflict detection
 *   - Concurrent tab execution locking
 *   - Bounded jittered retry policies using the central policy engine
 *   - Dead-letter queue capture upon exhaustion or non-retryable errors
 *   - Clean replay recovery without duplicate user-visible actions
 *   - Real-time observable telemetry events and dashboard hooks
 */

import {
  IdempotencyConflictError,
  IdempotencyInProgressError,
  IdempotencyKeyExpiredError,
  getIdempotencyStore,
  type IdempotencyStore,
} from '@/lib/idempotency';
import {
  classifyError,
  computeBackoffDelay,
  resolvePolicy,
  type OperationClass,
} from '@/lib/retry';
import {
  sideEffectDeadLetterQueue,
  SideEffectDeadLetterQueue,
} from './dead-letter';
import type {
  DispatcherOptions,
  RetryAttemptRecord,
  SideEffectDescriptor,
  SideEffectExecutionResult,
  SideEffectTelemetryEvent,
  SideEffectTelemetryObserver,
} from './types';

const DEFAULT_STALE_LOCK_MS = 30 * 1000;
const DEFAULT_EXPIRY_MS = 24 * 60 * 60 * 1000;

function canonicalFingerprint(payload: unknown): string {
  try {
    if (payload === undefined) return 'undefined';
    if (payload === null) return 'null';
    if (typeof payload !== 'object') return String(payload);

    const sortObject = (obj: Record<string, unknown>): Record<string, unknown> => {
      const sorted: Record<string, unknown> = {};
      Object.keys(obj)
        .sort()
        .forEach((key) => {
          const val = obj[key];
          if (val && typeof val === 'object' && !Array.isArray(val)) {
            sorted[key] = sortObject(val as Record<string, unknown>);
          } else {
            sorted[key] = val;
          }
        });
      return sorted;
    };

    return JSON.stringify(sortObject(payload as Record<string, unknown>));
  } catch {
    return String(payload);
  }
}

export type SideEffectHandler<TPayload, TResult> = (
  payload: TPayload,
  context: {
    key: string;
    attempt: number;
    metadata?: Record<string, unknown>;
  },
) => Promise<TResult>;

export class SideEffectDispatcher {
  private readonly inFlightPromises = new Map<string, Promise<SideEffectExecutionResult<any>>>();
  private readonly registeredHandlers = new Map<string, SideEffectHandler<any, any>>();
  private readonly telemetryObservers = new Set<SideEffectTelemetryObserver>();

  constructor(
    private readonly store: IdempotencyStore = getIdempotencyStore(),
    private readonly dlq: SideEffectDeadLetterQueue = sideEffectDeadLetterQueue,
    private readonly options: DispatcherOptions = {},
  ) {
    if (options.onTelemetry) {
      this.telemetryObservers.add(options.onTelemetry);
    }
  }

  /**
   * Register a persistent handler for an action type so that dead-letter
   * replay can invoke it automatically.
   */
  registerHandler<TPayload, TResult>(
    action: string,
    handler: SideEffectHandler<TPayload, TResult>,
  ): () => void {
    this.registeredHandlers.set(action, handler);
    return () => {
      if (this.registeredHandlers.get(action) === handler) {
        this.registeredHandlers.delete(action);
      }
    };
  }

  /** Subscribe to telemetry lifecycle events. */
  onTelemetry(observer: SideEffectTelemetryObserver): () => void {
    this.telemetryObservers.add(observer);
    return () => {
      this.telemetryObservers.delete(observer);
    };
  }

  private emitTelemetry(event: SideEffectTelemetryEvent): void {
    this.telemetryObservers.forEach((obs) => {
      try {
        obs(event);
      } catch {
        // Observers must not interrupt execution
      }
    });
  }

  /**
   * Dispatch a keyed side-effect.
   *
   * 1. Checks idempotency store:
   *    - If already succeeded with same payload fingerprint, returns stored result (no duplicate run).
   *    - If same key with different payload, rejects with IdempotencyConflictError.
   *    - If record is expired, rejects with IdempotencyKeyExpiredError.
   *    - If in progress in this tab, awaits identical in-flight promise.
   *    - If in progress in other tab and fresh, throws IdempotencyInProgressError.
   * 2. Executes handler through bounded retry policy with exponential jittered backoff.
   * 3. On terminal failure: captures operation into DeadLetterQueue and persists 'failed' status.
   * 4. On success: persists 'succeeded' record with result and resolves clean DLQ if present.
   */
  async dispatch<TPayload, TResult>(
    descriptor: SideEffectDescriptor<TPayload>,
    handler?: SideEffectHandler<TPayload, TResult>,
  ): Promise<SideEffectExecutionResult<TResult>> {
    const actionHandler = handler ?? this.registeredHandlers.get(descriptor.action);
    if (!actionHandler) {
      throw new Error(`No handler registered for action "${descriptor.action}"`);
    }

    const { key, payload, action } = descriptor;
    const nowFn = this.options.now ?? (() => Date.now());
    const sleepFn = this.options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    const randomFn = this.options.random ?? Math.random;

    const fingerprint = canonicalFingerprint(payload);
    const now = nowFn();

    // 1. Check existing idempotency record
    const record = this.store.get(key);
    if (record) {
      if (record.expiresAt <= now) {
        throw new IdempotencyKeyExpiredError();
      }
      if (record.fingerprint !== fingerprint) {
        throw new IdempotencyConflictError();
      }
      if (record.status === 'succeeded') {
        this.emitTelemetry({ type: 'side_effect_cached_hit', key, action, cachedAt: record.updatedAt });
        return {
          ok: true,
          key,
          status: 'succeeded',
          result: record.result as TResult,
          isCached: true,
          attempts: 0,
        };
      }
      if (record.status === 'in_progress') {
        const inFlight = this.inFlightPromises.get(key);
        if (inFlight) {
          return inFlight as Promise<SideEffectExecutionResult<TResult>>;
        }
        const isFresh = now - record.updatedAt < DEFAULT_STALE_LOCK_MS;
        if (isFresh) {
          throw new IdempotencyInProgressError();
        }
        // Stale in_progress: lock abandoned by crashing tab, safe to recover and proceed
      }
    }

    // 2. Mark in progress
    const ttlMs = descriptor.ttlMs ?? DEFAULT_EXPIRY_MS;
    this.store.set(key, {
      key,
      fingerprint,
      status: 'in_progress',
      createdAt: record?.createdAt ?? now,
      updatedAt: now,
      expiresAt: now + ttlMs,
    });

    this.emitTelemetry({ type: 'side_effect_queued', key, action, metadata: descriptor.metadata });

    // 3. Coordinate in-flight promise deduplication
    const executionPromise = (async (): Promise<SideEffectExecutionResult<TResult>> => {
      const opClass: OperationClass = descriptor.operationClass ?? 'api_write';
      const policy = resolvePolicy(opClass, descriptor.retryPolicy);
      const attemptsRecord: RetryAttemptRecord[] = [];
      const startTime = nowFn();

      let attempt = 0;
      while (true) {
        attempt += 1;
        this.emitTelemetry({ type: 'side_effect_started', key, action, attempt });

        try {
          const result = await actionHandler(payload, {
            key,
            attempt,
            metadata: descriptor.metadata,
          });

          // Mark Succeeded
          const finishedAt = nowFn();
          this.store.set(key, {
            key,
            fingerprint,
            status: 'succeeded',
            result,
            createdAt: record?.createdAt ?? startTime,
            updatedAt: finishedAt,
            expiresAt: finishedAt + ttlMs,
          });

          // If was dead-lettered previously, mark resolved
          const dlqEntry = this.dlq.getByKey(key);
          if (dlqEntry) {
            this.dlq.resolve(dlqEntry.id, 'replayed');
            this.emitTelemetry({ type: 'side_effect_recovered', key, action, deadLetterId: dlqEntry.id });
          }

          this.emitTelemetry({
            type: 'side_effect_succeeded',
            key,
            action,
            attempts: attempt,
            durationMs: finishedAt - startTime,
          });

          return {
            ok: true,
            key,
            status: 'succeeded',
            result,
            isCached: false,
            attempts: attempt,
          };
        } catch (rawError: unknown) {
          const errorMsg = rawError instanceof Error ? rawError.message : String(rawError);
          const classification = classifyError(rawError);
          const hasBudget = attempt <= policy.maxRetries;
          const isRetryable = policy.retryable && classification.retryable && hasBudget;

          if (isRetryable) {
            const delayMs = computeBackoffDelay(attempt, policy, randomFn);
            attemptsRecord.push({
              attemptNumber: attempt,
              timestamp: nowFn(),
              error: errorMsg,
              classification,
              delayMs,
            });

            this.emitTelemetry({
              type: 'side_effect_retry',
              key,
              action,
              attempt,
              delayMs,
              error: errorMsg,
            });

            await sleepFn(delayMs);
            continue;
          }

          // Terminal failure: Non-retryable or retries exhausted
          const failedAt = nowFn();
          attemptsRecord.push({
            attemptNumber: attempt,
            timestamp: failedAt,
            error: errorMsg,
            classification,
            delayMs: 0,
          });

          // Update idempotency store
          this.store.set(key, {
            key,
            fingerprint,
            status: 'failed',
            error: errorMsg,
            createdAt: record?.createdAt ?? startTime,
            updatedAt: failedAt,
            expiresAt: failedAt + ttlMs,
          });

          // Enqueue to Dead Letter Queue
          const dlqItem = this.dlq.enqueue(descriptor, attemptsRecord, errorMsg);
          this.emitTelemetry({
            type: 'side_effect_dead_lettered',
            key,
            action,
            deadLetterId: dlqItem.id,
            error: errorMsg,
          });

          return {
            ok: false,
            key,
            status: 'dead_lettered',
            error: errorMsg,
            isCached: false,
            attempts: attempt,
            deadLetterId: dlqItem.id,
          };
        }
      }
    })();

    this.inFlightPromises.set(key, executionPromise);

    try {
      return await executionPromise;
    } finally {
      this.inFlightPromises.delete(key);
    }
  }

  /**
   * Replay a dead-lettered item by id.
   * Ensures the operation is dispatched safely using the original payload and key.
   */
  async replayDeadLetter<TResult = unknown>(
    deadLetterId: string,
  ): Promise<SideEffectExecutionResult<TResult>> {
    const entry = this.dlq.get(deadLetterId);
    if (!entry) {
      throw new Error(`Dead letter record "${deadLetterId}" not found`);
    }

    const handler = this.registeredHandlers.get(entry.action);
    if (!handler) {
      throw new Error(`No registered handler to replay action "${entry.action}"`);
    }

    // Reset the failure status in store so it can retry with the same key
    const existing = this.store.get(entry.key);
    if (existing && existing.status === 'failed') {
      this.store.remove(entry.key);
    }

    const descriptor: SideEffectDescriptor = {
      action: entry.action,
      key: entry.key,
      payload: entry.payload,
      operationClass: entry.operationClass,
      metadata: entry.metadata,
    };

    const res = await this.dispatch(descriptor, handler);
    if (res.ok) {
      this.dlq.resolve(deadLetterId, 'replayed');
    }
    return res as SideEffectExecutionResult<TResult>;
  }

  /**
   * Discard an item from the dead-letter queue.
   */
  discardDeadLetter(deadLetterId: string): boolean {
    return this.dlq.resolve(deadLetterId, 'discarded');
  }

  getDeadLetterQueue(): SideEffectDeadLetterQueue {
    return this.dlq;
  }
}

export const sideEffectDispatcher = new SideEffectDispatcher();
