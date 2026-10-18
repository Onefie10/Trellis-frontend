import { NextResponse, type NextRequest } from "next/server";
import { getRateLimiter } from "@/lib/security/rate-limit";

/**
 * Token bucket rate limiting for every `/api/*` route.
 *
 * The decision itself lives in `lib/security/rate-limit` (pure, unit tested);
 * this file only adapts a `NextRequest` to it and a decision back to a response.
 *
 * Notes for whoever deploys this:
 *   - The default store is in-process. On a single server that is exact; behind
 *     several instances each one keeps its own buckets, so the effective limit is
 *     `policy × instances`. Point `RateLimiter` at a shared store (Redis) via
 *     `configureRateLimiter` for a distributed limit.
 *   - Identity is the bearer/`x-api-key` token when present, otherwise the client
 *     IP read from the right of `x-forwarded-for` (see `identity.ts`). Set
 *     `RATE_LIMIT_TRUST_PROXY_HOPS` when you run an extra trusted proxy.
 *   - `RATE_LIMIT_ENABLED=false` disables enforcement but still returns the
 *     `X-RateLimit-*` headers, so a rollout can measure headroom first.
 */

export const config = {
  matcher: ["/api/:path*"],
};

export function middleware(request: NextRequest) {
  const evaluation = getRateLimiter().evaluate({
    method: request.method,
    pathname: request.nextUrl.pathname,
    headers: request.headers,
  });

  if (!evaluation.allowed) {
    return NextResponse.json(evaluation.body ?? {}, {
      status: evaluation.status,
      headers: evaluation.headers,
    });
  }

  const response = NextResponse.next();
  for (const [name, value] of Object.entries(evaluation.headers)) {
    response.headers.set(name, value);
  }
  return response;
}
