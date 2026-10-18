/**
 * The limiter: identity + policy + store, turned into a decision and headers.
 *
 * `check()` is sync and side-effect free apart from the store write, which is
 * what lets middleware call it on every request without an await. Nothing here
 * imports `next/server`, so the whole decision path is unit testable — the
 * middleware file is a thin adapter over `evaluate()`.
 *
 * Counting is in *request units*, not raw tokens: a policy with `burst: 20` and
 * `cost: 2` advertises `X-RateLimit-Limit: 10` and `remaining` of "requests you
 * can still make", so the header can never claim headroom the next request
 * cannot use.
 */

import { resolveIdentity } from "./identity";
import {
  isPreflight,
  resolveRateLimitScope,
  safeReadRateLimitConfig,
  type RateLimitConfig,
} from "./policies";
import { memoryRateLimitStore } from "./store";
import {
  assertValidPolicy,
  consumeBucket,
  retryAfterSeconds,
  secondsUntilFull,
} from "./token-bucket";
import type {
  RateLimitDecision,
  RateLimitEvaluation,
  RateLimitPolicy,
  RateLimitRequestInput,
  RateLimitScope,
  RateLimitStore,
} from "./types";

const LOCAL_ADDRESSES = ["127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost"];

export interface RateLimiterOptions {
  store?: RateLimitStore;
  /** Injectable clock — every time-dependent assertion in the tests uses this. */
  now?: () => number;
  /** Addresses exempted when `bypassLocalhost` is on. */
  localAddresses?: string[];
  /** Override config instead of reading the environment. */
  config?: Partial<RateLimitConfig>;
}

export class RateLimiter {
  private readonly store: RateLimitStore;
  private readonly now: () => number;
  private readonly localAddresses: string[];
  private config: RateLimitConfig;

  constructor(options: RateLimiterOptions = {}) {
    this.store = options.store ?? memoryRateLimitStore;
    this.now = options.now ?? (() => Date.now());
    this.localAddresses = options.localAddresses ?? LOCAL_ADDRESSES;
    this.config = { ...safeReadRateLimitConfig(), ...options.config };

    for (const policy of Object.values(this.config.policies)) {
      assertValidPolicy(policy);
    }
  }

  getConfig(): RateLimitConfig {
    return {
      ...this.config,
      policies: { ...this.config.policies },
    };
  }

  /** Runtime reconfiguration, used by tests and by admin tooling. */
  configure(patch: Partial<RateLimitConfig>): this {
    this.config = { ...this.config, ...patch };
    return this;
  }

  /** Resolves the policy a request will be charged against. */
  policyFor(input: Pick<RateLimitRequestInput, "method" | "pathname">): {
    scope: RateLimitScope;
    policy: RateLimitPolicy;
  } {
    const scope = resolveRateLimitScope(input.pathname, input.method);
    return { scope, policy: this.config.policies[scope] };
  }

  /**
   * Charges the request and reports what happened.
   *
   * Exempt requests (limiter disabled, CORS preflight, localhost when bypassed)
   * return a full, untouched budget so the response headers still describe the
   * policy a client would hit in production.
   */
  check(input: RateLimitRequestInput): RateLimitDecision {
    const { scope, policy } = this.policyFor(input);
    const now = this.now();
    const limit = Math.floor(policy.burst / policy.cost);

    const identity = resolveIdentity(input.headers, {
      trustProxyHops: this.config.trustProxyHops,
    });
    const key = `${scope}:${identity.key}`;

    const exempt =
      !this.config.enabled ||
      isPreflight(input.method) ||
      (this.config.bypassLocalhost && this.isLocal(identity.ip));

    if (exempt) {
      return {
        allowed: true,
        key,
        identity: identity.kind,
        scope,
        policy: policy.name,
        limit,
        remaining: limit,
        resetSeconds: 0,
        resetAt: now,
        retryAfterSeconds: 0,
      };
    }

    const result = consumeBucket(this.store.get(key), policy, now);
    this.store.set(key, result.state);

    const resetSeconds = secondsUntilFull(result.state.tokens, policy);

    if (!result.allowed) {
      return {
        allowed: false,
        key,
        identity: identity.kind,
        scope,
        policy: policy.name,
        limit,
        remaining: 0,
        resetSeconds,
        resetAt: now + resetSeconds * 1000,
        retryAfterSeconds: Math.max(1, retryAfterSeconds(result.state.tokens, policy)),
      };
    }

    return {
      allowed: true,
      key,
      identity: identity.kind,
      scope,
      policy: policy.name,
      limit,
      remaining: Math.floor(result.state.tokens / policy.cost),
      resetSeconds,
      resetAt: now + resetSeconds * 1000,
      retryAfterSeconds: 0,
    };
  }

  /**
   * `check()` plus the HTTP shape to send back, which is all `middleware.ts`
   * needs. Success headers are attached to allowed responses too, so a client
   * can see its budget shrinking before it is refused.
   */
  evaluate(input: RateLimitRequestInput): RateLimitEvaluation {
    const decision = this.check(input);
    const headers = rateLimitHeaders(decision);

    if (decision.allowed) {
      return { allowed: true, decision, headers, status: 200 };
    }

    headers["Retry-After"] = String(decision.retryAfterSeconds);
    return {
      allowed: false,
      decision,
      headers,
      status: 429,
      body: tooManyRequestsBody(decision),
    };
  }

  /** Diagnostics for an ops endpoint or a coverage report. */
  snapshot(): {
    enabled: boolean;
    trustProxyHops: number;
    bypassLocalhost: boolean;
    buckets: number;
    policies: Record<RateLimitScope, RateLimitPolicy>;
  } {
    return {
      enabled: this.config.enabled,
      trustProxyHops: this.config.trustProxyHops,
      bypassLocalhost: this.config.bypassLocalhost,
      buckets: this.store.size(),
      policies: { ...this.config.policies },
    };
  }

  private isLocal(ip: string | null): boolean {
    if (!ip) return false;
    return this.localAddresses.includes(ip.toLowerCase());
  }
}

/**
 * Standard rate limit headers.
 *
 * `X-RateLimit-Reset` is seconds-until-full rather than an epoch timestamp:
 * every gateway in front of Next.js rewrites or drops a stray date, and a
 * relative number survives caching proxies.
 */
export function rateLimitHeaders(decision: RateLimitDecision): Record<string, string> {
  return {
    "X-RateLimit-Limit": String(decision.limit),
    "X-RateLimit-Remaining": String(decision.remaining),
    "X-RateLimit-Reset": String(decision.resetSeconds),
    "X-RateLimit-Policy": decision.policy,
  };
}

/** 429 payload. Mirrors the `{ success, error }` shape the other routes return. */
export function tooManyRequestsBody(decision: RateLimitDecision): Record<string, unknown> {
  return {
    success: false,
    error: "Too Many Requests",
    message: `Rate limit exceeded for the "${decision.policy}" policy. Retry in ${decision.retryAfterSeconds}s.`,
    policy: decision.policy,
    scope: decision.scope,
    limit: decision.limit,
    remaining: decision.remaining,
    retryAfter: decision.retryAfterSeconds,
  };
}

/**
 * Process-wide limiter used by `middleware.ts`.
 *
 * Config is read on construction; `resetRateLimiter()` exists so a test can
 * rebuild it against a fresh store and a different environment.
 */
export let defaultRateLimiter = new RateLimiter();

export function getRateLimiter(): RateLimiter {
  return defaultRateLimiter;
}

export function configureRateLimiter(patch: Partial<RateLimitConfig>): RateLimiter {
  defaultRateLimiter.configure(patch);
  return defaultRateLimiter;
}

export function resetRateLimiter(options: RateLimiterOptions = {}): RateLimiter {
  defaultRateLimiter = new RateLimiter(options);
  return defaultRateLimiter;
}
