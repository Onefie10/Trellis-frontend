/**
 * Bounded retry execution with terminal failure tracking.
 *
 * Why this exists: call sites previously implemented retry loops by hand, which
 * made three things easy to get wrong and impossible to audit — unbounded
 * attempts, backoff that ignored whether the error was worth retrying, and
 * failures that vanished once the budget ran out. This scheduler owns all three:
 * it bounds attempts, consults {@link classifyError} before every retry, and
 * routes every terminal outcome into the {@link DeadLetterQueue}.
 *
 * Determinism: `sleep` and `random` are injected rather than reaching for
 * `setTimeout`/`Math.random` directly. Tests therefore run instantly and
 * assert exact delay sequences instead of racing real timers.
 *
 * Scope: executing one operation. Cross-tab and cross-process coordination is
 * `lib/idempotency.ts`'s job, and checkpointed multi-step work is
 * `lib/recovery/operation-manager.ts`'s. This module will not deduplicate a
 * retry that runs in two tabs at once.
 */

import { classifyError, NonRetryableError, RetryExhaustedError } from './errors';
import type { ErrorClassification } from './errors';
import {
  computeBackoffDelay,
  isOperationClass,
  resolvePolicy,
  type OperationClass,
  type RetryPolicy,
} from './policy';
import {
  deadLetterQueue as defaultDeadLetterQueue,
  type DeadLetterQueue,
  type RetryAttempt,
} from './dead-letter';

/** Lifecycle of a single {@link execute} call, for callers that surface progress. */
export type RetryState =
  | 'idle'
  | 'running'
  | 'waiting'
  | 'succeeded'
  | 'dead_lettered';

export interface RetryObserver {
  /** Fired after every failed attempt, before the backoff wait. */
  onAttempt?: (attempt: RetryAttempt, state: RetryState) => void;
  /** Fired when the operation reaches a terminal failure. */
  onDeadLetter?: (deadLetterId: string, classification: ErrorClassification) => void;
  onStateChange?: (state: RetryState) => void;
}

export interface ExecuteOptions extends RetryObserver {
  operationClass: OperationClass;
  /** Stable identifier for the operation, used to correlate dead-letter records. */
  operationId: string;
  /** Per-call policy overrides merged over the class defaults. */
  policy?: Partial<RetryPolicy> & { retryable?: boolean };
  /** Extra context stored on the dead-letter record, e.g. `{ wallet: 'G...' }`. */
  context?: Record<string, unknown>;
  /** Injectable timer. Defaults to a real `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable jitter source in `[0, 1)`. Defaults to `Math.random`. */
  random?: () => number;
  /** Injectable clock. Defaults to `Date.now`. */
  now?: () => number;
  /** Queue for terminal records. Defaults to the process-wide queue. */
  deadLetterQueue?: DeadLetterQueue;
  /**
   * When false, a terminal failure is recorded and then rethrown unchanged
   * instead of being wrapped in `RetryExhaustedError`. Useful for call sites that
   * must not have their error type changed.
   */
  wrapExhaustedError?: boolean;
}

export interface ExecuteResult<T> {
  value: T;
  attempts: number;
  /** Milliseconds spent sleeping between attempts. Zero when the first try worked. */
  waitedMs: number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    if (ms <= 0) {
      resolve();
      return;
    }
    setTimeout(resolve, ms);
  });

export class RetryScheduler {
  constructor(private readonly queue: DeadLetterQueue = defaultDeadLetterQueue) {}

  /**
   * Runs `operation` until it succeeds, is proven permanent, or exhausts its
   * budget.
   *
   * Retry decisions are made per attempt against the *actual* error, not the
   * operation class alone. A class marked `retryable: false` never retries; a
   * class marked retryable still stops immediately if the failure classifies as
   * permanent, which is what keeps 4xx responses from being replayed.
   */
  async execute<T>(
    operation: (attempt: number) => Promise<T>,
    options: ExecuteOptions,
  ): Promise<T> {
    if (!isOperationClass(options.operationClass)) {
      throw new RangeError(
        `Unknown operation class: ${String(options.operationClass)}`,
      );
    }

    const policy = resolvePolicy(options.operationClass, options.policy);
    const sleep = options.sleep ?? defaultSleep;
    const random = options.random ?? Math.random;
    const now = options.now ?? Date.now;
    const queue = options.deadLetterQueue ?? this.queue;
    const wrapExhausted = options.wrapExhaustedError ?? true;

    const attempts: RetryAttempt[] = [];
    let waitedMs = 0;
    let state: RetryState = 'running';
    options.onStateChange?.(state);

    // `maxRetries` counts retries, so the ceiling is one more than that.
    const maxAttempts = policy.retryable ? policy.maxRetries + 1 : 1;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const startedAtMs = now();
      const startedAt = new Date(startedAtMs).toISOString();

      try {
        const value = await operation(attempt);
        state = 'succeeded';
        options.onStateChange?.(state);
        return value;
      } catch (error) {
        const classification = classifyError(error);
        const isLastAttempt = attempt === maxAttempts - 1;
        const budgetLeft = attempt < policy.maxRetries;

        // A permanent failure and an exhausted budget are both terminal, but they
        // are dead-lettered for different reasons so a maintainer can tell a bug
        // from an outage.
        const terminalReason = !policy.retryable || !classification.retryable
          ? 'non_retryable'
          : 'retries_exhausted';

        // Decide the wait *before* recording the attempt so the recorded
        // `waitedMs` matches what actually happened.
        const shouldRetry = policy.retryable && classification.retryable && budgetLeft;
        const waitedThisAttempt = shouldRetry
          ? computeBackoffDelay(attempt, policy, random)
          : 0;

        const attemptRecord: RetryAttempt = {
          attempt,
          startedAt,
          durationMs: Math.max(0, now() - startedAtMs),
          classification,
        };
        if (shouldRetry) {
          attemptRecord.waitedMs = waitedThisAttempt;
        }
        attempts.push(attemptRecord);
        options.onAttempt?.(attemptRecord, shouldRetry ? 'waiting' : 'dead_lettered');

        if (!shouldRetry) {
          const record = queue.record({
            operationClass: options.operationClass,
            operationId: options.operationId,
            reason: terminalReason,
            classification,
            attempts,
            context: options.context,
            now,
          });

          state = 'dead_lettered';
          options.onStateChange?.(state);
          options.onDeadLetter?.(record.id, classification);

          if (!wrapExhausted) {
            throw error;
          }
          throw new RetryExhaustedError({
            attempts: attempts.length,
            operationClass: options.operationClass,
            operationId: options.operationId,
            deadLetterId: record.id,
            cause: error,
          });
        }

        waitedMs += waitedThisAttempt;
        state = 'waiting';
        options.onStateChange?.(state);
        await sleep(waitedThisAttempt);
        state = 'running';
        options.onStateChange?.(state);
      }
    }

    // Unreachable: the loop always returns or throws. Kept so the function is
    // provably total rather than relying on control-flow analysis of the loop.
    throw new RetryExhaustedError({
      attempts: attempts.length,
      operationClass: options.operationClass,
      operationId: options.operationId,
    });
  }

  /**
   * Non-throwing variant for callers that want the failure as data.
   *
   * Returns the dead-letter id on failure so a UI can link the user to the
   * maintainer triage view.
   */
  async attempt<T>(
    operation: (attempt: number) => Promise<T>,
    options: ExecuteOptions,
  ): Promise<
    | { ok: true; result: ExecuteResult<T> }
    | { ok: false; error: unknown; deadLetterId?: string; attempts: number }
  > {
    const startedAt = (options.now ?? Date.now)();
    let attempts = 0;

    try {
      const value = await this.execute(operation, {
        ...options,
        onAttempt: (attempt) => {
          attempts = attempt.attempt + 1;
          options.onAttempt?.(attempt, 'waiting');
        },
      });
      return {
        ok: true,
        result: {
          value,
          attempts: Math.max(attempts, 1),
          waitedMs: (options.now ?? Date.now)() - startedAt,
        },
      };
    } catch (error) {
      const deadLetterId =
        error instanceof RetryExhaustedError ? error.deadLetterId : undefined;
      return {
        ok: false,
        error,
        deadLetterId,
        attempts: Math.max(attempts, 1),
      };
    }
  }
}

/** Convenience wrapper for one-off calls that do not need a dedicated scheduler. */
export async function executeWithRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: ExecuteOptions,
): Promise<T> {
  return new RetryScheduler().execute(operation, options);
}

export { NonRetryableError, RetryExhaustedError };
