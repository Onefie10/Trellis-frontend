/**
 * Retry policy and backoff calculation for Trellis operations.
 *
 * Why this exists: retry behaviour was previously ad-hoc per call site. The RPC
 * client used exponential-plus-jitter capped at 8s, `lib/partial-failures.ts`
 * used jitter-free exponential, `lib/ipfs.ts` used linear growth, and the
 * websocket transport claimed exponential in a comment but multiplied linearly.
 * This module is the single definition of *how long to wait* and *how many
 * times*, so those paths can converge without changing their call sites first.
 *
 * Scope: policy lookup and delay maths. Execution lives in `./scheduler`, and
 * terminal records live in `./dead-letter`.
 */

/**
 * Classes of operation that can fail part-way through.
 *
 * The first six match `lib/partial-failures.ts` `OperationType` exactly so the
 * two vocabularies cannot drift. `http_request` and `rpc` cover the network
 * clients that were previously hard-coding their own backoff.
 */
export type OperationClass =
  | 'transaction'
  | 'sync'
  | 'webhook'
  | 'import'
  | 'export'
  | 'background_job'
  | 'http_request'
  | 'rpc';

/**
 * Jitter strategy applied on top of the exponential term.
 *
 * `full` is the default because synchronised clients are how a recovering
 * backend gets knocked over again: without jitter, every caller that failed
 * during an outage retries at the same instant. `none` exists for deterministic
 * tests and for call sites that already jitter upstream.
 */
export type JitterStrategy = 'none' | 'full';

export interface RetryPolicy {
  /** Attempts after the initial one. `0` means a single attempt, no retries. */
  maxRetries: number;
  /** Delay before the first retry, before any growth is applied. */
  initialDelayMs: number;
  /** Ceiling applied after exponential growth, before jitter. */
  maxDelayMs: number;
  /** Exponential growth factor per attempt. */
  backoffMultiplier: number;
  jitter: JitterStrategy;
}

export interface OperationPolicy extends RetryPolicy {
  /**
   * Whether operations in this class are eligible for retry at all.
   *
   * This is the "retryable operation class" half of the policy. A class marked
   * `false` dead-letters on first failure without consuming the budget, which
   * keeps genuinely non-retryable work from being re-executed.
   */
  retryable: boolean;
}

/**
 * Per-class defaults.
 *
 * Rationale for the non-uniform budgets:
 * - `transaction` is the most dangerous to duplicate, so it retries the least
 *   and starts slowest. Callers must be idempotent; `lib/idempotency.ts` is the
 *   guard. Funds movement is deliberately not retried automatically.
 * - `webhook` retries aggressively because a dropped delivery is a lost event
 *   and the sender will not necessarily replay it.
 * - `import`/`export` are long and resumable, so they start slow and back off
 *   far to avoid re-running expensive work against a struggling backend.
 * - `rpc` mirrors the existing Soroban client's 8s ceiling so behaviour does not
 *   change for callers migrating onto this module.
 */
export const DEFAULT_OPERATION_POLICIES: Readonly<Record<OperationClass, OperationPolicy>> = {
  transaction: {
    retryable: true,
    maxRetries: 3,
    initialDelayMs: 5_000,
    maxDelayMs: 120_000,
    backoffMultiplier: 2,
    jitter: 'full',
  },
  sync: {
    retryable: true,
    maxRetries: 3,
    initialDelayMs: 60_000,
    maxDelayMs: 24 * 60 * 60 * 1000,
    backoffMultiplier: 2,
    jitter: 'full',
  },
  webhook: {
    retryable: true,
    maxRetries: 5,
    initialDelayMs: 2_000,
    maxDelayMs: 300_000,
    backoffMultiplier: 2,
    jitter: 'full',
  },
  import: {
    retryable: true,
    maxRetries: 3,
    initialDelayMs: 60_000,
    maxDelayMs: 24 * 60 * 60 * 1000,
    backoffMultiplier: 2,
    jitter: 'full',
  },
  export: {
    retryable: true,
    maxRetries: 3,
    initialDelayMs: 60_000,
    maxDelayMs: 24 * 60 * 60 * 1000,
    backoffMultiplier: 2,
    jitter: 'full',
  },
  background_job: {
    retryable: true,
    maxRetries: 5,
    initialDelayMs: 30_000,
    maxDelayMs: 6 * 60 * 60 * 1000,
    backoffMultiplier: 2,
    jitter: 'full',
  },
  http_request: {
    retryable: true,
    maxRetries: 3,
    initialDelayMs: 1_000,
    maxDelayMs: 30_000,
    backoffMultiplier: 2,
    jitter: 'full',
  },
  rpc: {
    retryable: true,
    maxRetries: 3,
    initialDelayMs: 500,
    maxDelayMs: 8_000,
    backoffMultiplier: 2,
    jitter: 'full',
  },
};

/** Every operation class, for validation and documentation surfaces. */
export const OPERATION_CLASSES = Object.keys(
  DEFAULT_OPERATION_POLICIES,
) as OperationClass[];

export function isOperationClass(value: unknown): value is OperationClass {
  return typeof value === 'string' && value in DEFAULT_OPERATION_POLICIES;
}

/**
 * Resolves the effective policy for a class, merged with per-call overrides.
 *
 * Overrides are applied after the class default so a caller can widen or narrow
 * a single operation without mutating shared state. The result is frozen so a
 * caller cannot mutate the defaults through the returned object.
 */
export function resolvePolicy(
  operationClass: OperationClass,
  overrides?: Partial<RetryPolicy> & { retryable?: boolean },
): Readonly<OperationPolicy> {
  const base = DEFAULT_OPERATION_POLICIES[operationClass];
  const merged: OperationPolicy = { ...base, ...(overrides ?? {}) };

  if (merged.maxRetries < 0 || !Number.isFinite(merged.maxRetries)) {
    throw new RangeError('maxRetries must be a non-negative finite number');
  }
  if (merged.initialDelayMs < 0 || !Number.isFinite(merged.initialDelayMs)) {
    throw new RangeError('initialDelayMs must be a non-negative finite number');
  }
  if (merged.maxDelayMs < merged.initialDelayMs) {
    throw new RangeError('maxDelayMs must be greater than or equal to initialDelayMs');
  }
  if (merged.backoffMultiplier < 1 || !Number.isFinite(merged.backoffMultiplier)) {
    throw new RangeError('backoffMultiplier must be at least 1');
  }

  return Object.freeze(merged);
}

/**
 * Delay before the next attempt.
 *
 * @param attempt Zero-based index of the retry about to be scheduled, so the
 *   first retry is `0`. Using zero-based keeps the maths identical to
 *   `lib/soroban/client.ts`, which passes the zero-based attempt through.
 * @param random Injectable in `[0, 1)`. Tests pass a fixed value to make the
 *   schedule deterministic; production passes `Math.random`.
 *
 * The exponential term is capped *before* jitter is applied, so `maxDelayMs` is
 * a true upper bound. Applying jitter after the cap would let a `full` strategy
 * exceed the documented ceiling.
 */
export function computeBackoffDelay(
  attempt: number,
  policy: Pick<RetryPolicy, 'initialDelayMs' | 'maxDelayMs' | 'backoffMultiplier' | 'jitter'>,
  random: () => number = Math.random,
): number {
  const safeAttempt = Math.max(0, Math.floor(attempt));
  const exponential = Math.min(
    policy.initialDelayMs * Math.pow(policy.backoffMultiplier, safeAttempt),
    policy.maxDelayMs,
  );

  if (policy.jitter === 'none' || exponential === 0) {
    return Math.round(exponential);
  }

  // Full jitter: uniform in [0, exponential]. Prevents synchronised retries
  // without ever exceeding the capped ceiling.
  return Math.round(random() * exponential);
}

/**
 * Full schedule of retry delays for a policy, ignoring jitter randomness.
 * Intended for operator-facing documentation and assertions, not for sleeping.
 */
export function plannedBackoffSchedule(policy: RetryPolicy): number[] {
  const delays: number[] = [];
  for (let attempt = 0; attempt < policy.maxRetries; attempt += 1) {
    delays.push(
      computeBackoffDelay(attempt, { ...policy, jitter: 'none' }),
    );
  }
  return delays;
}
