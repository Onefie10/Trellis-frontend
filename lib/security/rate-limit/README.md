# Rate limiting

Token bucket rate limiting for the App Router API routes, enforced from
`middleware.ts` for every `/api/*` request.

```
middleware.ts                 thin adapter: NextRequest -> evaluate() -> NextResponse
lib/security/rate-limit/
  token-bucket.ts             pure refill/consume maths (caller passes `now`)
  store.ts                    where bucket state lives (in-memory by default)
  identity.ts                 who the request belongs to (token, else client IP)
  policies.ts                 route -> budget table + env overrides
  limiter.ts                  decision + headers + 429 payload
```

## Defaults

| scope | burst | sustained | cost | applied to |
| --- | --- | --- | --- | --- |
| `public` | 60 | 60/min | 1 | every other `/api/*` read |
| `search` | 30 | 30/min | 1 | `/api/search`, `/api/agents` |
| `mutation` | 20 | 20/min | 2 | non-GET on an otherwise public route |
| `heavy` | 10 | 10/min | 1 | `/api/import`, `/api/security`, `/api/analytics`, `/api/tests`, `/api/simulations/run` |
| `auth` | 5 | 5/min | 1 | `/api/affiliates/payouts`, `/api/affiliates/validate`, `/api/notifications/lifecycle` |

`X-RateLimit-Limit` and `-Remaining` are in **request units**: a `mutation` policy
with `burst: 20, cost: 2` advertises a limit of 10, so the header can never
promise headroom the next request cannot use.

Success responses carry `X-RateLimit-Limit`, `X-RateLimit-Remaining`,
`X-RateLimit-Reset` (seconds until full) and `X-RateLimit-Policy`. A rejected
request is a `429` with those headers plus `Retry-After`:

```json
{
  "success": false,
  "error": "Too Many Requests",
  "message": "Rate limit exceeded for the \"public\" policy. Retry in 3s.",
  "policy": "public",
  "scope": "public",
  "limit": 60,
  "remaining": 0,
  "retryAfter": 3
}
```

## Configuration

See the `RATE_LIMIT_*` entries in `.env.example`. `readRateLimitConfig()` parses
them; an invalid value degrades to the built-in defaults (with a console warning)
rather than throwing while `middleware.ts` is being imported.

## Identity

A `Bearer` token or `x-api-key` wins over the IP, so two users behind one NAT do
not share a budget and a token cannot dodge its limit by rotating IPs. Without a
token the client IP is read from the **right** of `x-forwarded-for` (the value the
trusted edge appended); raise `RATE_LIMIT_TRUST_PROXY_HOPS` for each extra proxy
you run. A request with no usable identifier lands in one shared `anonymous`
bucket instead of skipping the limit.

Keys are `scope:kind:hash` — the token or IP itself is hashed and never stored,
logged or echoed in a header.

## Multiple instances

The default store is in-process, which is exact for a single server and, behind
`n` instances, yields an effective limit of `policy × n`. For a shared limit,
implement `RateLimitStore` against Redis and hand it to the limiter:

```ts
import { configureRateLimiter } from "@/lib/security/rate-limit";

configureRateLimiter({ store: new RedisRateLimitStore(redis) });
```

## Using it inside a handler

Middleware already covers `/api/*`; a handler that wants its own bucket can call
the limiter directly:

```ts
import { getRateLimiter, tooManyRequestsBody } from "@/lib/security/rate-limit";

const decision = getRateLimiter().check({
  method: request.method,
  pathname: new URL(request.url).pathname,
  headers: request.headers,
});

if (!decision.allowed) {
  return NextResponse.json(tooManyRequestsBody(decision), {
    status: 429,
    headers: { "Retry-After": String(decision.retryAfterSeconds) },
  });
}
```
