import { checkRateLimit, clearRateLimitStore, RateLimitConfig } from '../security/rate-limit';
import { NextRequest } from 'next/server';

describe('Rate Limiter', () => {
  beforeEach(() => {
    clearRateLimitStore();
  });

  const mockConfig: RateLimitConfig = {
    maxRequests: 2,
    windowMs: 60000,
    scope: 'test',
  };

  function createReq(headers: Record<string, string> = {}): NextRequest {
    const req = new NextRequest('http://localhost/api/test', {
      headers: new Headers(headers),
    });
    return req;
  }

  it('allows requests under the limit', () => {
    const req = createReq({ 'x-forwarded-for': '127.0.0.1' });
    const res = checkRateLimit(req, mockConfig);
    expect(res.success).toBe(true);
    expect(res.remaining).toBe(1);
    expect(res.blocked).toBe(false);
  });

  it('blocks requests over the limit', () => {
    const req = createReq({ 'x-forwarded-for': '127.0.0.1' });
    checkRateLimit(req, mockConfig);
    checkRateLimit(req, mockConfig);
    const res3 = checkRateLimit(req, mockConfig);
    expect(res3.success).toBe(false);
    expect(res3.remaining).toBe(0);
    expect(res3.blocked).toBe(true);
  });

  it('handles legitimate retries without penalizing rate limit', () => {
    const req = createReq({ 'x-forwarded-for': '127.0.0.1' });
    checkRateLimit(req, mockConfig, 'idempotency-key-1');
    checkRateLimit(req, mockConfig, 'idempotency-key-2');
    // Third request with identical key as the first should not be blocked
    const resRetry = checkRateLimit(req, mockConfig, 'idempotency-key-1');
    expect(resRetry.success).toBe(true);
    expect(resRetry.blocked).toBe(false);
    
    // But a new key should be blocked
    const res3 = checkRateLimit(req, mockConfig, 'idempotency-key-3');
    expect(res3.success).toBe(false);
  });

  it('allows privileged bypass', () => {
    const req = createReq({ 'x-bypass-rate-limit': 'privileged-token-123' });
    checkRateLimit(req, mockConfig);
    checkRateLimit(req, mockConfig);
    const res3 = checkRateLimit(req, mockConfig);
    expect(res3.success).toBe(true);
    expect(res3.blocked).toBe(false);
  });

  it('resets after window expires', async () => {
    const shortConfig = { ...mockConfig, windowMs: 10 };
    const req = createReq({ 'x-forwarded-for': '127.0.0.1' });
    checkRateLimit(req, shortConfig);
    checkRateLimit(req, shortConfig);
    expect(checkRateLimit(req, shortConfig).blocked).toBe(true);
    
    await new Promise((r) => setTimeout(r, 15));
    const resetRes = checkRateLimit(req, shortConfig);
    expect(resetRes.success).toBe(true);
    expect(resetRes.remaining).toBe(1);
  });
});
