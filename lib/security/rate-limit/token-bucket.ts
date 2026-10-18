/**
 * Token bucket maths.
 *
 * Pure functions only: the caller passes `now`, nothing here reads the clock or
 * touches the network, which is what makes the refill behaviour testable.
 *
 * Model (the classic RFC-friendly bucket):
 *   - a bucket holds `burst` tokens and starts full;
 *   - tokens refill continuously at `refillPerSecond`, capped at `burst`;
 *   - a request succeeds when the bucket holds at least `cost` tokens;
 *   - a failed request consumes nothing, so a client that keeps hammering a
 *     drained bucket is never pushed further into debt.
 */

import type { RateLimitPolicy, TokenBucketState } from "./types";

/** Rejects a policy that could never allow (or would divide by zero). */
export function assertValidPolicy(policy: RateLimitPolicy): void {
  if (!Number.isFinite(policy.burst) || policy.burst <= 0) {
    throw new Error(`rate limit policy "${policy.name}" needs a positive burst`);
  }
  if (!Number.isFinite(policy.refillPerSecond) || policy.refillPerSecond <= 0) {
    throw new Error(
      `rate limit policy "${policy.name}" needs a positive refillPerSecond`,
    );
  }
  if (!Number.isFinite(policy.cost) || policy.cost <= 0) {
    throw new Error(`rate limit policy "${policy.name}" needs a positive cost`);
  }
  if (policy.cost > policy.burst) {
    throw new Error(
      `rate limit policy "${policy.name}" has cost ${policy.cost} above its burst ${policy.burst} — no request could ever be allowed`,
    );
  }
}

/** A fresh, full bucket for `policy` at `now`. */
export function createBucket(policy: RateLimitPolicy, now: number): TokenBucketState {
  return { tokens: policy.burst, updatedAt: now };
}

/**
 * Adds the tokens earned since `state.updatedAt` and clamps at the burst.
 *
 * A backwards clock (or `now === updatedAt`) yields an unchanged bucket rather
 * than draining it.
 */
export function refillBucket(
  state: TokenBucketState,
  policy: RateLimitPolicy,
  now: number,
): TokenBucketState {
  const elapsedMs = now - state.updatedAt;
  if (elapsedMs <= 0) return { tokens: state.tokens, updatedAt: state.updatedAt };

  const refilled = state.tokens + (elapsedMs / 1000) * policy.refillPerSecond;
  return {
    tokens: Math.min(policy.burst, refilled),
    updatedAt: now,
  };
}

export interface BucketConsumeResult {
  allowed: boolean;
  state: TokenBucketState;
  /** Tokens left after the attempt (unchanged when rejected). */
  remaining: number;
}

/**
 * Attempts to charge `policy.cost` tokens.
 *
 * `state` may be `undefined` for a first-time caller, which starts a full bucket.
 */
export function consumeBucket(
  state: TokenBucketState | undefined,
  policy: RateLimitPolicy,
  now: number,
): BucketConsumeResult {
  const refilled = refillBucket(state ?? createBucket(policy, now), policy, now);

  if (refilled.tokens + 1e-9 < policy.cost) {
    return { allowed: false, state: refilled, remaining: refilled.tokens };
  }

  const remaining = Math.max(0, refilled.tokens - policy.cost);
  return { allowed: true, state: { tokens: remaining, updatedAt: now }, remaining };
}

/** Milliseconds until `tokens` reaches `target`; 0 when already there. */
export function millisecondsUntil(
  tokens: number,
  target: number,
  refillPerSecond: number,
): number {
  if (tokens >= target) return 0;
  if (refillPerSecond <= 0) return Number.POSITIVE_INFINITY;
  return ((target - tokens) / refillPerSecond) * 1000;
}

/** Whole seconds a client must wait before `cost` tokens are available again. */
export function retryAfterSeconds(
  tokens: number,
  policy: RateLimitPolicy,
): number {
  return Math.ceil(
    millisecondsUntil(tokens, policy.cost, policy.refillPerSecond) / 1000,
  );
}

/** Whole seconds until the bucket is full — `X-RateLimit-Reset`. */
export function secondsUntilFull(
  tokens: number,
  policy: RateLimitPolicy,
): number {
  return Math.ceil(
    millisecondsUntil(tokens, policy.burst, policy.refillPerSecond) / 1000,
  );
}
