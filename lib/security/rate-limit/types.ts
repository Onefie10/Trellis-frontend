/**
 * Rate limiting primitives.
 *
 * The pieces are deliberately split so the bucket maths, the store and the
 * identity resolution can be unit tested without a running Next.js server:
 *
 *   token-bucket.ts  pure refill/consume maths (no clock, no I/O)
 *   store.ts         where bucket state lives (in-memory by default)
 *   identity.ts      who a request belongs to (token, else client IP)
 *   policies.ts      per-route budgets + env overrides
 *   limiter.ts       ties the above together and produces headers / 429 payloads
 */

/** Which budget a route belongs to. */
export type RateLimitScope =
  | "public"
  | "search"
  | "heavy"
  | "auth"
  | "mutation";

export interface RateLimitPolicy {
  /** Policy name reported in headers and logs. */
  name: string;
  /** Maximum tokens a bucket holds — also the maximum burst. */
  burst: number;
  /** Tokens replenished per second. Fractional values are allowed. */
  refillPerSecond: number;
  /** Tokens charged per matching request. */
  cost: number;
}

export interface TokenBucketState {
  /** Fractional token count, kept as a float so small refill rates work. */
  tokens: number;
  /** Epoch milliseconds of the last refill. */
  updatedAt: number;
}

export interface RateLimitStore {
  get(key: string): TokenBucketState | undefined;
  set(key: string, state: TokenBucketState): void;
  delete(key: string): void;
  /** Number of live buckets — used by tests and the metrics endpoint. */
  size(): number;
  reset(): void;
}

export interface RateLimitDecision {
  allowed: boolean;
  /** Bucket key (already hashed — never a raw token or IP). */
  key: string;
  /** How the key was derived. */
  identity: "token" | "ip" | "anonymous";
  scope: RateLimitScope;
  policy: string;
  /** Configured burst == `X-RateLimit-Limit`. */
  limit: number;
  /** Whole tokens left after this request, floored at 0. */
  remaining: number;
  /** Whole seconds until the bucket is full again. */
  resetSeconds: number;
  /** Epoch milliseconds when the bucket is expected to be full. */
  resetAt: number;
  /** Whole seconds a rejected client should wait (0 when allowed). */
  retryAfterSeconds: number;
}

export interface RateLimitRequestInput {
  method: string;
  /** Path only — query strings must be stripped by the caller. */
  pathname: string;
  headers: Headers | Record<string, string | string[] | undefined>;
}

export interface RateLimitEvaluation {
  allowed: boolean;
  decision: RateLimitDecision;
  /** Headers to attach to *every* response, allowed or not. */
  headers: Record<string, string>;
  /** Present only when the request was rejected. */
  body?: Record<string, unknown>;
  status: number;
}
