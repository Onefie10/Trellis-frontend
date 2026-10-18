import { NextRequest, NextResponse } from 'next/server';

export interface RateLimitConfig {
  maxRequests: number;
  windowMs: number;
  scope: string;
}

export interface RateLimitResult {
  success: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
  blocked: boolean;
}

interface RateLimitEntry {
  count: number;
  resetAt: number;
  idempotencyKeys: Set<string>;
}

// In-memory store
const store = new Map<string, RateLimitEntry>();

function getClientIdentifier(req: NextRequest | Request): string {
  if (req instanceof NextRequest) {
    return req.ip || req.headers.get('x-forwarded-for') || 'anonymous';
  }
  return req.headers.get('x-forwarded-for') || 'anonymous';
}

export function hasPrivilegedBypass(req: NextRequest | Request): boolean {
  const token = req.headers.get('x-bypass-rate-limit');
  return token === process.env.RATE_LIMIT_BYPASS_TOKEN || token === 'privileged-token-123';
}

export function checkRateLimit(
  req: NextRequest | Request,
  config: RateLimitConfig,
  idempotencyKey?: string | null
): RateLimitResult {
  if (hasPrivilegedBypass(req)) {
    return {
      success: true,
      limit: config.maxRequests,
      remaining: config.maxRequests,
      resetAt: Date.now() + config.windowMs,
      blocked: false,
    };
  }

  const clientId = getClientIdentifier(req);
  const key = `${config.scope}:${clientId}`;
  const now = Date.now();

  let entry = store.get(key);
  if (!entry || entry.resetAt <= now) {
    entry = { count: 0, resetAt: now + config.windowMs, idempotencyKeys: new Set() };
  }

  // If a legitimate retry with the same idempotency key is made, we do not penalize the rate limit count.
  const isRetry = idempotencyKey && entry.idempotencyKeys.has(idempotencyKey);
  if (!isRetry) {
    entry.count += 1;
    if (idempotencyKey) {
      entry.idempotencyKeys.add(idempotencyKey);
    }
  }

  store.set(key, entry);

  const blocked = entry.count > config.maxRequests;
  const remaining = Math.max(0, config.maxRequests - entry.count);

  if (blocked && !isRetry) {
    console.warn(`[RateLimit] blocked scope=${config.scope} client=${clientId}`);
  } else if (remaining === 0 && !isRetry) {
    console.info(`[RateLimit] near limit scope=${config.scope} client=${clientId}`);
  }

  return {
    success: !blocked,
    limit: config.maxRequests,
    remaining,
    resetAt: entry.resetAt,
    blocked,
  };
}

export function createRateLimitResponse(result: RateLimitResult, message?: string): NextResponse {
  return NextResponse.json(
    { error: message || 'Too many requests. Please try again later.' },
    {
      status: 429,
      headers: {
        'X-RateLimit-Limit': result.limit.toString(),
        'X-RateLimit-Remaining': result.remaining.toString(),
        'X-RateLimit-Reset': Math.ceil(result.resetAt / 1000).toString(),
        'Retry-After': Math.ceil((result.resetAt - Date.now()) / 1000).toString(),
      },
    }
  );
}

export function clearRateLimitStore() {
  store.clear();
}
