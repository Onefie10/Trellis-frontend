/**
 * Token bucket rate limiting for App Router API routes.
 *
 * Usage from a route handler (optional — `middleware.ts` already covers `/api/*`):
 *
 *   import { defaultRateLimiter, tooManyRequestsBody } from "@/lib/security/rate-limit";
 *
 *   const decision = defaultRateLimiter.check({ method, pathname: "/api/search", headers });
 *   if (!decision.allowed) return NextResponse.json(tooManyRequestsBody(decision), { status: 429 });
 */

export * from "./types";
export {
  assertValidPolicy,
  consumeBucket,
  createBucket,
  millisecondsUntil,
  refillBucket,
  retryAfterSeconds,
  secondsUntilFull,
} from "./token-bucket";
export {
  apiKey,
  bearerToken,
  clientIp,
  hashIdentifier,
  headerLookup,
  normaliseIp,
  resolveIdentity,
} from "./identity";
export {
  MemoryRateLimitStore,
  memoryRateLimitStore,
} from "./store";
export {
  DEFAULT_POLICIES,
  RATE_LIMIT_SCOPES,
  ROUTE_SCOPES,
  describePolicies,
  isMutatingMethod,
  isPreflight,
  normalisePathname,
  readRateLimitConfig,
  resolveRateLimitScope,
  safeReadRateLimitConfig,
} from "./policies";
export {
  RateLimiter,
  configureRateLimiter,
  getRateLimiter,
  rateLimitHeaders,
  resetRateLimiter,
  tooManyRequestsBody,
} from "./limiter";
