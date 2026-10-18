/**
 * Budgets per route class, and the env overrides for them.
 *
 * Defaults are expressed per minute because that is how limits are discussed,
 * and converted to `refillPerSecond` here so the bucket maths stays generic.
 *
 *   public    60/min   ordinary reads (a dashboard poll every second fits)
 *   search    30/min   query endpoints — the ones a scraper would hammer
 *   mutation  20/min   POST/PUT/PATCH/DELETE on public routes, cost 2 tokens
 *   heavy     10/min   compute-heavy handlers (imports, scans, test runs)
 *   auth       5/min   credential-ish endpoints, deliberately strict
 *
 * Env overrides (all optional):
 *   RATE_LIMIT_ENABLED              "false"/"0" turns the limiter off entirely
 *   RATE_LIMIT_TRUST_PROXY_HOPS     integer, default 0
 *   RATE_LIMIT_BYPASS_LOCALHOST     default true outside production
 *   RATE_LIMIT_<SCOPE>_BURST        e.g. RATE_LIMIT_PUBLIC_BURST=120
 *   RATE_LIMIT_<SCOPE>_REFILL_PER_SECOND
 */

import { assertValidPolicy } from "./token-bucket";
import type { RateLimitPolicy, RateLimitScope } from "./types";

export const RATE_LIMIT_SCOPES: RateLimitScope[] = [
  "public",
  "search",
  "mutation",
  "heavy",
  "auth",
];

export const DEFAULT_POLICIES: Record<RateLimitScope, RateLimitPolicy> = {
  public: { name: "public", burst: 60, refillPerSecond: 60 / 60, cost: 1 },
  search: { name: "search", burst: 30, refillPerSecond: 30 / 60, cost: 1 },
  mutation: { name: "mutation", burst: 20, refillPerSecond: 20 / 60, cost: 2 },
  heavy: { name: "heavy", burst: 10, refillPerSecond: 10 / 60, cost: 1 },
  auth: { name: "auth", burst: 5, refillPerSecond: 5 / 60, cost: 1 },
};

/**
 * Longest-prefix route table.
 *
 * Deliberately *not* a list of exact paths: `/api/simulations/run/42` must
 * inherit `/api/simulations/run`, and a new handler under a known prefix lands
 * in the right bucket without touching this file.
 */
export const ROUTE_SCOPES: Array<{ prefix: string; scope: RateLimitScope }> = [
  // Compute-heavy handlers.
  { prefix: "/api/import", scope: "heavy" },
  { prefix: "/api/security", scope: "heavy" },
  { prefix: "/api/analytics", scope: "heavy" },
  { prefix: "/api/tests", scope: "heavy" },
  { prefix: "/api/simulations/run", scope: "heavy" },
  // Credential / privileged endpoints.
  { prefix: "/api/affiliates/payouts", scope: "auth" },
  { prefix: "/api/affiliates/validate", scope: "auth" },
  { prefix: "/api/notifications/lifecycle", scope: "auth" },
  // Query endpoints.
  { prefix: "/api/search", scope: "search" },
  { prefix: "/api/agents", scope: "search" },
];

/** Methods that change state — charged the `mutation` cost. */
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function isMutatingMethod(method: string): boolean {
  return MUTATING_METHODS.has(method.toUpperCase());
}

/** Methods that are never charged (CORS preflight is not application traffic). */
export function isPreflight(method: string): boolean {
  return method.toUpperCase() === "OPTIONS";
}

/** Strips query/hash and normalises a pathname for the route table. */
export function normalisePathname(pathname: string): string {
  let path = (pathname || "/").split("?")[0].split("#")[0];
  if (!path.startsWith("/")) path = `/${path}`;
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  return path.toLowerCase();
}

/**
 * Scope for a pathname + method.
 *
 * A mutating request on an otherwise-public route is promoted to `mutation`;
 * a mutating request on a heavy/auth route keeps that route's scope, because
 * its budget is already the tighter one.
 */
export function resolveRateLimitScope(
  pathname: string,
  method = "GET",
): RateLimitScope {
  const path = normalisePathname(pathname);

  let matched = "";
  let scope: RateLimitScope = "public";
  for (const entry of ROUTE_SCOPES) {
    const prefix = entry.prefix.toLowerCase();
    const isMatch = path === prefix || path.startsWith(`${prefix}/`);
    if (isMatch && prefix.length > matched.length) {
      matched = prefix;
      scope = entry.scope;
    }
  }

  if (scope === "public" && isMutatingMethod(method)) return "mutation";
  return scope;
}

function readEnv(name: string): string | undefined {
  try {
    if (typeof process === "undefined" || !process.env) return undefined;
    const value = process.env[name];
    return value === undefined || value === "" ? undefined : value;
  } catch {
    return undefined;
  }
}

function readBoolean(name: string): boolean | undefined {
  const raw = readEnv(name)?.trim().toLowerCase();
  if (raw === undefined) return undefined;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return undefined;
}

function readNumber(name: string): number | undefined {
  const raw = readEnv(name);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export interface RateLimitConfig {
  enabled: boolean;
  /** Proxies you control in front of the app; see `identity.ts`. */
  trustProxyHops: number;
  /** Localhost is exempt by default outside production. */
  bypassLocalhost: boolean;
  policies: Record<RateLimitScope, RateLimitPolicy>;
}

/**
 * Reads the limiter config from the environment.
 *
 * An override only replaces the field it names, so
 * `RATE_LIMIT_SEARCH_BURST=10` keeps the default refill rate rather than
 * silently resetting it to the other scope's value.
 */
export function readRateLimitConfig(): RateLimitConfig {
  const enabled = readBoolean("RATE_LIMIT_ENABLED") ?? true;
  const trustProxyHops = readNumber("RATE_LIMIT_TRUST_PROXY_HOPS") ?? 0;

  const isProduction = readEnv("NODE_ENV") === "production";
  const bypassLocalhost = readBoolean("RATE_LIMIT_BYPASS_LOCALHOST") ?? !isProduction;

  const policies = {} as Record<RateLimitScope, RateLimitPolicy>;
  for (const scope of RATE_LIMIT_SCOPES) {
    const base = DEFAULT_POLICIES[scope];
    const upper = scope.toUpperCase();
    const policy: RateLimitPolicy = {
      name: base.name,
      burst: readNumber(`RATE_LIMIT_${upper}_BURST`) ?? base.burst,
      refillPerSecond:
        readNumber(`RATE_LIMIT_${upper}_REFILL_PER_SECOND`) ?? base.refillPerSecond,
      cost: readNumber(`RATE_LIMIT_${upper}_COST`) ?? base.cost,
    };
    assertValidPolicy(policy);
    policies[scope] = policy;
  }

  return { enabled, trustProxyHops, bypassLocalhost, policies };
}

/**
 * `readRateLimitConfig()` but never throws.
 *
 * The limiter is constructed while `middleware.ts` is being imported, so a typo
 * in one env var must not take down every route. An invalid override degrades
 * that config to the built-in defaults and is reported on the console.
 */
export function safeReadRateLimitConfig(): RateLimitConfig {
  try {
    return readRateLimitConfig();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (typeof console !== "undefined") {
      console.warn(
        `[rate-limit] falling back to default policies: ${message}`,
      );
    }
    return {
      enabled: true,
      trustProxyHops: 0,
      bypassLocalhost: false,
      policies: { ...DEFAULT_POLICIES },
    };
  }
}

/** Human-readable summary used by `GET /api/security` style diagnostics. */
export function describePolicies(
  policies: Record<RateLimitScope, RateLimitPolicy> = DEFAULT_POLICIES,
): string[] {
  return RATE_LIMIT_SCOPES.map((scope) => {
    const policy = policies[scope];
    const perMinute = Math.round(policy.refillPerSecond * 60);
    return `${scope}: ${policy.burst} burst, ${perMinute}/min, cost ${policy.cost}`;
  });
}
