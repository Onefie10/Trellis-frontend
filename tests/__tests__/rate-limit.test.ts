import {
  MemoryRateLimitStore,
  RateLimiter,
  assertValidPolicy,
  clientIp,
  consumeBucket,
  createBucket,
  describePolicies,
  hashIdentifier,
  isMutatingMethod,
  normaliseIp,
  normalisePathname,
  rateLimitHeaders,
  refillBucket,
  resolveIdentity,
  resolveRateLimitScope,
  retryAfterSeconds,
  secondsUntilFull,
  tooManyRequestsBody,
} from "../../lib/security/rate-limit";
import type {
  RateLimitPolicy,
  RateLimitScope,
} from "../../lib/security/rate-limit";

const PUBLIC_POLICY: RateLimitPolicy = {
  name: "public",
  burst: 3,
  refillPerSecond: 1,
  cost: 1,
};

const MUTATION_POLICY: RateLimitPolicy = {
  name: "mutation",
  burst: 4,
  refillPerSecond: 1,
  cost: 2,
};

const FRACTIONAL_POLICY: RateLimitPolicy = {
  name: "search",
  burst: 2,
  refillPerSecond: 0.5,
  cost: 1,
};

/** Clock we control so refill assertions never depend on wall time. */
function clock() {
  let now = 1_700_000_000_000;
  return {
    advance(ms: number) {
      now += ms;
    },
    now: () => now,
  };
}

function buildLimiter(overrides: {
  policies?: Partial<Record<RateLimitScope, RateLimitPolicy>>;
  enabled?: boolean;
  bypassLocalhost?: boolean;
} = {}) {
  const time = clock();
  const store = new MemoryRateLimitStore({ now: time.now, idleTtlMs: 60 * 60_000 });
  const limiter = new RateLimiter({
    store,
    now: time.now,
    localAddresses: ["127.0.0.1"],
    config: {
      enabled: overrides.enabled ?? true,
      trustProxyHops: 0,
      bypassLocalhost: overrides.bypassLocalhost ?? false,
      policies: {
        public: PUBLIC_POLICY,
        search: FRACTIONAL_POLICY,
        mutation: MUTATION_POLICY,
        heavy: { name: "heavy", burst: 2, refillPerSecond: 1, cost: 1 },
        auth: { name: "auth", burst: 2, refillPerSecond: 1, cost: 1 },
        ...overrides.policies,
      },
    },
  });
  return { limiter, time, store };
}

describe("Token bucket maths", () => {
  it("starts full and allows exactly `burst` single-cost requests", () => {
    const state = createBucket(PUBLIC_POLICY, 0);
    expect(state.tokens).toBe(3);

    const first = consumeBucket(state, PUBLIC_POLICY, 0);
    const second = consumeBucket(first.state, PUBLIC_POLICY, 0);
    const third = consumeBucket(second.state, PUBLIC_POLICY, 0);
    const fourth = consumeBucket(third.state, PUBLIC_POLICY, 0);

    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(true);
    expect(third.allowed).toBe(true);
    expect(fourth.allowed).toBe(false);
  });

  it("refills at the configured rate as time passes", () => {
    const drained = { tokens: 0, updatedAt: 0 };
    const half = refillBucket(drained, PUBLIC_POLICY, 500);
    expect(half.tokens).toBe(0.5);

    const full = refillBucket(drained, PUBLIC_POLICY, 1000);
    expect(full.tokens).toBe(1);
  });

  it("never refills above the burst ceiling", () => {
    const drained = { tokens: 0, updatedAt: 0 };
    const overflow = refillBucket(drained, PUBLIC_POLICY, 60_000);
    expect(overflow.tokens).toBe(3);
  });

  it("does not consume a token when the request is rejected", () => {
    const drained = { tokens: 0.4, updatedAt: 0 };
    const rejected = consumeBucket(drained, PUBLIC_POLICY, 0);
    expect(rejected.allowed).toBe(false);
    expect(rejected.state.tokens).toBe(0.4);
  });

  it("leaves the bucket untouched when the clock goes backwards", () => {
    const state = { tokens: 1.5, updatedAt: 5_000 };
    const stale = refillBucket(state, PUBLIC_POLICY, 1_000);
    expect(stale.tokens).toBe(1.5);
    expect(stale.updatedAt).toBe(5_000);
  });

  it("charges a multi-token cost in one request", () => {
    const first = consumeBucket(undefined, MUTATION_POLICY, 0);
    expect(first.allowed).toBe(true);
    expect(first.state.tokens).toBe(2);

    const second = consumeBucket(first.state, MUTATION_POLICY, 0);
    expect(second.allowed).toBe(true);
    expect(second.state.tokens).toBe(0);

    const third = consumeBucket(second.state, MUTATION_POLICY, 0);
    expect(third.allowed).toBe(false);
  });

  it("reports whole-second wait times that round up", () => {
    expect(retryAfterSeconds(0, PUBLIC_POLICY)).toBe(1);
    expect(retryAfterSeconds(0.5, PUBLIC_POLICY)).toBe(1);
    expect(retryAfterSeconds(0, FRACTIONAL_POLICY)).toBe(2);
    expect(retryAfterSeconds(0.5, FRACTIONAL_POLICY)).toBe(1);
    expect(secondsUntilFull(2, PUBLIC_POLICY)).toBe(1);
    expect(secondsUntilFull(3, PUBLIC_POLICY)).toBe(0);
  });

  it("rejects policies that could never allow a request", () => {
    expect(() =>
      assertValidPolicy({ name: "broken", burst: 1, refillPerSecond: 1, cost: 2 }),
    ).toThrow(/cost 2 above its burst 1/);
    expect(() =>
      assertValidPolicy({ name: "broken", burst: 1, refillPerSecond: 0, cost: 1 }),
    ).toThrow(/positive refillPerSecond/);
    expect(() =>
      assertValidPolicy({ name: "broken", burst: 0, refillPerSecond: 1, cost: 1 }),
    ).toThrow(/positive burst/);
    expect(() =>
      assertValidPolicy({ name: "ok", burst: 2, refillPerSecond: 1, cost: 2 }),
    ).not.toThrow();
  });
});

describe("Request identity", () => {
  it("reads the rightmost x-forwarded-for entry so a client cannot spoof it", () => {
    const headers = { "x-forwarded-for": "9.9.9.9, 203.0.113.5" };
    expect(clientIp(headers)).toEqual({ ip: "203.0.113.5", source: "x-forwarded-for" });
  });

  it("moves further left when trusted proxy hops are configured", () => {
    const headers = { "x-forwarded-for": "203.0.113.5, 10.0.0.7" };
    expect(clientIp(headers, { trustProxyHops: 1 }).ip).toBe("203.0.113.5");
  });

  it("falls back through x-real-ip, cf-connecting-ip and x-vercel-forwarded-for", () => {
    expect(clientIp({ "x-real-ip": "198.51.100.9" })).toEqual({
      ip: "198.51.100.9",
      source: "x-real-ip",
    });
    expect(clientIp({ "cf-connecting-ip": "198.51.100.10" })).toEqual({
      ip: "198.51.100.10",
      source: "cf-connecting-ip",
    });
    expect(clientIp({ "x-vercel-forwarded-for": "198.51.100.11" })).toEqual({
      ip: "198.51.100.11",
      source: "x-vercel-forwarded-for",
    });
  });

  it("strips transport ports and normalises IPv6 casing", () => {
    expect(normaliseIp("[::1]:3000")).toBe("::1");
    expect(normaliseIp("203.0.113.5:4432")).toBe("203.0.113.5");
    expect(normaliseIp("  2001:DB8::1  ")).toBe("2001:db8::1");
    expect(normaliseIp("not an address")).toBeNull();
    expect(normaliseIp("")).toBeNull();
    expect(normaliseIp(undefined)).toBeNull();
  });

  it("reads Headers objects as well as plain records", () => {
    const headers = new Headers();
    headers.set("x-forwarded-for", "203.0.113.5");
    expect(clientIp(headers).ip).toBe("203.0.113.5");
  });

  it("buckets a signed-in caller by token, not by IP", () => {
    const identity = resolveIdentity({
      authorization: "Bearer test-token-value",
      "x-forwarded-for": "203.0.113.5",
    });
    expect(identity.kind).toBe("token");
    expect(identity.ip).toBe("203.0.113.5");
    expect(identity.key.startsWith("token:")).toBe(true);
    expect(identity.key.includes("test-token-value")).toBe(false);
  });

  it("accepts x-api-key as an identity and ignores an empty bearer header", () => {
    expect(resolveIdentity({ "x-api-key": "key-123" }).kind).toBe("token");
    expect(resolveIdentity({ authorization: "Bearer   " }).kind).toBe("anonymous");
    expect(resolveIdentity({ authorization: "Basic abc" }).kind).toBe("anonymous");
  });

  it("never puts a raw IP or token in the bucket key", () => {
    const identity = resolveIdentity({ "x-forwarded-for": "203.0.113.5" });
    expect(identity.key).toBe("ip:" + hashIdentifier("203.0.113.5"));
    expect(identity.key.includes("203.0.113.5")).toBe(false);
  });

  it("uses one shared bucket when no identifier is available", () => {
    expect(resolveIdentity({})).toEqual({ key: "anonymous", kind: "anonymous", ip: null });
  });

  it("hashes deterministically and varies per input", () => {
    expect(hashIdentifier("a")).toBe(hashIdentifier("a"));
    expect(hashIdentifier("a") === hashIdentifier("b")).toBe(false);
    expect(hashIdentifier("a").length).toBe(8);
  });
});

describe("Route policy resolution", () => {
  it("maps heavy, auth and search endpoints to their own budgets", () => {
    expect(resolveRateLimitScope("/api/import", "POST")).toBe("heavy");
    expect(resolveRateLimitScope("/api/import/dry-run", "POST")).toBe("heavy");
    expect(resolveRateLimitScope("/api/security", "GET")).toBe("heavy");
    expect(resolveRateLimitScope("/api/analytics", "GET")).toBe("heavy");
    expect(resolveRateLimitScope("/api/tests", "POST")).toBe("heavy");
    expect(resolveRateLimitScope("/api/simulations/run/42", "POST")).toBe("heavy");
    expect(resolveRateLimitScope("/api/affiliates/payouts", "GET")).toBe("auth");
    expect(resolveRateLimitScope("/api/affiliates/validate", "POST")).toBe("auth");
    expect(resolveRateLimitScope("/api/search", "GET")).toBe("search");
  });

  it("promotes a mutation on an otherwise public route", () => {
    expect(resolveRateLimitScope("/api/waitlist", "POST")).toBe("mutation");
    expect(resolveRateLimitScope("/api/waitlist", "GET")).toBe("public");
    expect(resolveRateLimitScope("/api/bug-reports", "PATCH")).toBe("mutation");
    expect(isMutatingMethod("delete")).toBe(true);
    expect(isMutatingMethod("get")).toBe(false);
  });

  it("keeps a heavy route heavy even when it is a mutation", () => {
    expect(resolveRateLimitScope("/api/import", "POST")).toBe("heavy");
  });

  it("normalises case, query strings and trailing slashes", () => {
    expect(normalisePathname("/API/Import/?dryRun=true")).toBe("/api/import");
    expect(resolveRateLimitScope("/api/import/", "GET")).toBe("heavy");
    expect(resolveRateLimitScope("/api/importability", "GET")).toBe("public");
  });

  it("does not confuse a prefix with a longer sibling path", () => {
    expect(resolveRateLimitScope("/api/search-index", "GET")).toBe("public");
    expect(resolveRateLimitScope("/api/agents", "GET")).toBe("search");
    expect(resolveRateLimitScope("/api/agents/42/reviews", "GET")).toBe("search");
  });

  it("describes every scope", () => {
    const lines = describePolicies();
    expect(lines.length).toBe(5);
    expect(lines[0].startsWith("public:")).toBe(true);
    expect(lines.join(" ").includes("cost 2")).toBe(true);
  });
});

describe("RateLimiter enforcement", () => {
  it("allows up to the limit then rejects with 429 and Retry-After", () => {
    const { limiter } = buildLimiter();
    const request = {
      method: "GET",
      pathname: "/api/waitlist",
      headers: { "x-forwarded-for": "203.0.113.5" },
    };

    expect(limiter.evaluate(request).status).toBe(200);
    expect(limiter.evaluate(request).status).toBe(200);
    expect(limiter.evaluate(request).status).toBe(200);

    const denied = limiter.evaluate(request);
    expect(denied.allowed).toBe(false);
    expect(denied.status).toBe(429);
    expect(denied.headers["Retry-After"]).toBe("1");
    expect(denied.headers["X-RateLimit-Remaining"]).toBe("0");
    expect(denied.headers["X-RateLimit-Limit"]).toBe("3");
    expect(denied.body?.error).toBe("Too Many Requests");
    expect(denied.body?.policy).toBe("public");
  });

  it("advertises the budget on successful responses too", () => {
    const { limiter } = buildLimiter();
    const first = limiter.evaluate({
      method: "GET",
      pathname: "/api/waitlist",
      headers: { "x-forwarded-for": "203.0.113.5" },
    });
    expect(first.headers["X-RateLimit-Limit"]).toBe("3");
    expect(first.headers["X-RateLimit-Remaining"]).toBe("2");
    expect(first.headers["X-RateLimit-Policy"]).toBe("public");
    expect(first.headers["X-RateLimit-Reset"]).toBe("1");
    expect(first.headers["Retry-After"]).toBeUndefined();
  });

  it("recovers once the advertised window has passed", () => {
    const { limiter, time } = buildLimiter();
    const request = {
      method: "GET",
      pathname: "/api/waitlist",
      headers: { "x-forwarded-for": "203.0.113.5" },
    };

    for (let i = 0; i < 3; i += 1) limiter.evaluate(request);
    expect(limiter.evaluate(request).status).toBe(429);

    time.advance(1000);
    expect(limiter.evaluate(request).status).toBe(200);
  });

  it("waits for a full token when the refill rate is fractional", () => {
    const { limiter, time } = buildLimiter();
    const request = {
      method: "GET",
      pathname: "/api/search",
      headers: { "x-forwarded-for": "203.0.113.5" },
    };

    limiter.evaluate(request);
    limiter.evaluate(request);

    const denied = limiter.evaluate(request);
    expect(denied.status).toBe(429);
    expect(denied.headers["Retry-After"]).toBe("2");

    time.advance(1000);
    expect(limiter.evaluate(request).status).toBe(429);

    time.advance(1000);
    expect(limiter.evaluate(request).status).toBe(200);
  });

  it("counts remaining in request units for a multi-token policy", () => {
    const { limiter } = buildLimiter();
    const request = {
      method: "POST",
      pathname: "/api/waitlist",
      headers: { "x-forwarded-for": "203.0.113.5" },
    };

    const first = limiter.evaluate(request);
    expect(first.headers["X-RateLimit-Limit"]).toBe("2");
    expect(first.headers["X-RateLimit-Remaining"]).toBe("1");

    const second = limiter.evaluate(request);
    expect(second.status).toBe(200);
    expect(second.headers["X-RateLimit-Remaining"]).toBe("0");

    const third = limiter.evaluate(request);
    expect(third.status).toBe(429);
    expect(third.headers["Retry-After"]).toBe("2");
  });

  it("keeps separate budgets per identity", () => {
    const { limiter } = buildLimiter();
    const attacker = {
      method: "GET",
      pathname: "/api/waitlist",
      headers: { "x-forwarded-for": "203.0.113.5" },
    };
    const neighbour = {
      method: "GET",
      pathname: "/api/waitlist",
      headers: { "x-forwarded-for": "198.51.100.7" },
    };

    for (let i = 0; i < 3; i += 1) limiter.evaluate(attacker);
    expect(limiter.evaluate(attacker).status).toBe(429);
    expect(limiter.evaluate(neighbour).status).toBe(200);
  });

  it("keeps separate budgets per scope for the same client", () => {
    const { limiter } = buildLimiter();
    const common = { headers: { "x-forwarded-for": "203.0.113.5" } };

    for (let i = 0; i < 3; i += 1) {
      limiter.evaluate({ ...common, method: "GET", pathname: "/api/waitlist" });
    }
    expect(
      limiter.evaluate({ ...common, method: "GET", pathname: "/api/waitlist" }).status,
    ).toBe(429);
    expect(
      limiter.evaluate({ ...common, method: "GET", pathname: "/api/search" }).status,
    ).toBe(200);
  });

  it("charges the caller's token instead of the IP when authenticated", () => {
    const { limiter } = buildLimiter();
    const token = { authorization: "Bearer abc" };

    for (let i = 0; i < 3; i += 1) {
      limiter.evaluate({
        method: "GET",
        pathname: "/api/waitlist",
        headers: { ...token, "x-forwarded-for": "203.0.113.5" },
      });
    }
    expect(
      limiter.evaluate({
        method: "GET",
        pathname: "/api/waitlist",
        headers: { ...token, "x-forwarded-for": "203.0.113.5" },
      }).status,
    ).toBe(429);

    // Same IP, no token: a different bucket, so one user cannot exhaust another.
    expect(
      limiter.evaluate({
        method: "GET",
        pathname: "/api/waitlist",
        headers: { "x-forwarded-for": "203.0.113.5" },
      }).status,
    ).toBe(200);
  });

  it("does not charge CORS preflight requests", () => {
    const { limiter } = buildLimiter();
    const request = {
      method: "OPTIONS",
      pathname: "/api/waitlist",
      headers: { "x-forwarded-for": "203.0.113.5" },
    };
    for (let i = 0; i < 10; i += 1) {
      expect(limiter.evaluate(request).status).toBe(200);
    }
  });

  it("exempts localhost only when bypassLocalhost is on", () => {
    const bypassed = buildLimiter({ bypassLocalhost: true });
    const request = {
      method: "GET",
      pathname: "/api/waitlist",
      headers: { "x-forwarded-for": "127.0.0.1" },
    };
    for (let i = 0; i < 5; i += 1) {
      expect(bypassed.limiter.evaluate(request).status).toBe(200);
    }

    const enforced = buildLimiter({ bypassLocalhost: false });
    for (let i = 0; i < 3; i += 1) enforced.limiter.evaluate(request);
    expect(enforced.limiter.evaluate(request).status).toBe(429);
  });

  it("allows everything when disabled but still reports the budget", () => {
    const { limiter } = buildLimiter({ enabled: false });
    const request = {
      method: "GET",
      pathname: "/api/waitlist",
      headers: { "x-forwarded-for": "203.0.113.5" },
    };

    for (let i = 0; i < 10; i += 1) {
      const evaluation = limiter.evaluate(request);
      expect(evaluation.status).toBe(200);
      expect(evaluation.headers["X-RateLimit-Limit"]).toBe("3");
    }
  });

  it("shares budgets when two limiters are pointed at one store", () => {
    const time = clock();
    const shared = new MemoryRateLimitStore({ now: time.now });
    const config = {
      enabled: true,
      trustProxyHops: 0,
      bypassLocalhost: false,
      policies: {
        public: PUBLIC_POLICY,
        search: FRACTIONAL_POLICY,
        mutation: MUTATION_POLICY,
        heavy: PUBLIC_POLICY,
        auth: PUBLIC_POLICY,
      },
    };
    const a = new RateLimiter({ store: shared, now: time.now, config });
    const b = new RateLimiter({ store: shared, now: time.now, config });
    const request = {
      method: "GET",
      pathname: "/api/waitlist",
      headers: { "x-forwarded-for": "203.0.113.5" },
    };

    a.evaluate(request);
    a.evaluate(request);
    b.evaluate(request);
    expect(b.evaluate(request).status).toBe(429);
  });

  it("exposes policy lookup and a diagnostics snapshot", () => {
    const { limiter } = buildLimiter();
    const resolved = limiter.policyFor({ method: "GET", pathname: "/api/search" });
    expect(resolved.scope).toBe("search");
    expect(resolved.policy.burst).toBe(2);

    const snapshot = limiter.snapshot();
    expect(snapshot.enabled).toBe(true);
    expect(snapshot.buckets).toBe(0);
    expect(Object.keys(snapshot.policies).length).toBe(5);
  });
});

describe("Rate limit response helpers", () => {
  it("builds the standard headers", () => {
    const headers = rateLimitHeaders({
      allowed: true,
      key: "public:ip:abc",
      identity: "ip",
      scope: "public",
      policy: "public",
      limit: 60,
      remaining: 59,
      resetSeconds: 1,
      resetAt: 0,
      retryAfterSeconds: 0,
    });
    expect(headers).toEqual({
      "X-RateLimit-Limit": "60",
      "X-RateLimit-Remaining": "59",
      "X-RateLimit-Reset": "1",
      "X-RateLimit-Policy": "public",
    });
  });

  it("builds a 429 body a client can act on", () => {
    const body = tooManyRequestsBody({
      allowed: false,
      key: "search:ip:abc",
      identity: "ip",
      scope: "search",
      policy: "search",
      limit: 30,
      remaining: 0,
      resetSeconds: 30,
      resetAt: 0,
      retryAfterSeconds: 2,
    });
    expect(body.success).toBe(false);
    expect(body.error).toBe("Too Many Requests");
    expect(body.retryAfter).toBe(2);
    expect(String(body.message).includes("Retry in 2s")).toBe(true);
  });
});

describe("MemoryRateLimitStore", () => {
  it("expires buckets that have been idle past the TTL", () => {
    const time = clock();
    const store = new MemoryRateLimitStore({ now: time.now, idleTtlMs: 1000 });
    store.set("k", { tokens: 1, updatedAt: time.now() });
    expect(store.get("k")?.tokens).toBe(1);

    time.advance(2000);
    expect(store.get("k")).toBeUndefined();
    expect(store.size()).toBe(0);
  });

  it("caps the number of live buckets", () => {
    const store = new MemoryRateLimitStore({ maxKeys: 2 });
    store.set("a", { tokens: 1, updatedAt: 0 });
    store.set("b", { tokens: 1, updatedAt: 0 });
    store.set("c", { tokens: 1, updatedAt: 0 });

    expect(store.size()).toBe(2);
    expect(store.get("a")).toBeUndefined();
    expect(store.get("c")).toBeDefined();
  });

  it("supports delete and reset", () => {
    const store = new MemoryRateLimitStore();
    store.set("a", { tokens: 1, updatedAt: 0 });
    store.delete("a");
    expect(store.size()).toBe(0);

    store.set("b", { tokens: 1, updatedAt: 0 });
    store.reset();
    expect(store.size()).toBe(0);
  });
});
