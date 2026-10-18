/**
 * @jest-environment node
 */
import { NextRequest, NextResponse } from 'next/server';
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  attachCsrfCookie,
  clearClientCsrfToken,
  createCsrfErrorResponse,
  csrfMiddleware,
  ensureCsrfToken,
  extractCsrfTokens,
  generateCsrfToken,
  getClientCsrfToken,
  isCsrfProtectedMethod,
  isValidCsrfTokenFormat,
  parseCookies,
  serializeCsrfCookie,
  setClientCsrfToken,
  timingSafeEqualStrings,
  validateCsrfRequest,
  verifyCsrfToken,
  withCsrfProtection,
} from '../security/csrf';
import { apiCall, apiClient } from '../api';
import { ApiError } from '../retry';
import { POST as waitlistPOST, GET as waitlistGET } from '@/app/api/waitlist/route';
import { POST as referralsPOST } from '@/app/api/affiliates/referrals/route';

describe('Anti-CSRF Double-Submit Cookie Security', () => {
  beforeEach(() => {
    clearClientCsrfToken();
  });

  describe('Token generation and format validation', () => {
    it('generates a cryptographically secure 64-character hex token by default', () => {
      const token = generateCsrfToken();
      expect(token).toHaveLength(64);
      expect(isValidCsrfTokenFormat(token)).toBe(true);
    });

    it('generates unique tokens across consecutive invocations', () => {
      const tokens = new Set(Array.from({ length: 50 }, () => generateCsrfToken()));
      expect(tokens.size).toBe(50);
    });

    it('supports custom valid byte lengths between 16 and 64', () => {
      const token16 = generateCsrfToken(16);
      const token48 = generateCsrfToken(48);
      expect(token16).toHaveLength(32);
      expect(token48).toHaveLength(96);
      expect(isValidCsrfTokenFormat(token16)).toBe(true);
      expect(isValidCsrfTokenFormat(token48)).toBe(true);
    });

    it('rejects insecure or out-of-range token byte lengths', () => {
      expect(() => generateCsrfToken(8)).toThrow(RangeError);
      expect(() => generateCsrfToken(128)).toThrow(RangeError);
      expect(() => generateCsrfToken(24.5)).toThrow(RangeError);
    });

    it('validates token format strictly', () => {
      expect(isValidCsrfTokenFormat('short')).toBe(false);
      expect(isValidCsrfTokenFormat('z'.repeat(64))).toBe(false);
      expect(isValidCsrfTokenFormat('')).toBe(false);
      expect(isValidCsrfTokenFormat(null)).toBe(false);
      expect(isValidCsrfTokenFormat(undefined)).toBe(false);
    });

    it('compares tokens in constant time', () => {
      const tokenA = generateCsrfToken();
      const tokenB = generateCsrfToken();
      expect(timingSafeEqualStrings(tokenA, tokenA)).toBe(true);
      expect(timingSafeEqualStrings(tokenA, tokenB)).toBe(false);
      expect(timingSafeEqualStrings(tokenA, `${tokenA}00`)).toBe(false);
    });
  });

  describe('Cookie serialization and parsing', () => {
    it('serializes double-submit cookies with SameSite=Strict and Path=/', () => {
      const token = generateCsrfToken();
      const cookie = serializeCsrfCookie(token, { secure: true, maxAge: 3600 });
      expect(cookie).toContain(`${CSRF_COOKIE_NAME}=${token}`);
      expect(cookie).toContain('Path=/');
      expect(cookie).toContain('SameSite=Strict');
      expect(cookie).toContain('Max-Age=3600');
      expect(cookie).toContain('Secure');
    });

    it('refuses to serialize malformed CSRF tokens', () => {
      expect(() => serializeCsrfCookie('invalid-token')).toThrow(/invalid CSRF token/i);
    });

    it('parses cookie headers accurately', () => {
      const token = generateCsrfToken();
      const parsed = parseCookies(`theme=dark; ${CSRF_COOKIE_NAME}=${token}; locale=en`);
      expect(parsed).toEqual({
        theme: 'dark',
        [CSRF_COOKIE_NAME]: token,
        locale: 'en',
      });
    });

    it('attaches Set-Cookie and X-CSRF-Token headers to NextResponse', () => {
      const token = generateCsrfToken();
      const res = NextResponse.json({ ok: true });
      attachCsrfCookie(res, token, { secure: true });

      expect(res.headers.get(CSRF_HEADER_NAME)).toBe(token);
      expect(res.headers.get('set-cookie')).toContain(`${CSRF_COOKIE_NAME}=${token}`);
    });
  });

  describe('Double-submit verification and middleware', () => {
    it('identifies state-changing HTTP methods', () => {
      expect(isCsrfProtectedMethod('POST')).toBe(true);
      expect(isCsrfProtectedMethod('PUT')).toBe(true);
      expect(isCsrfProtectedMethod('DELETE')).toBe(true);
      expect(isCsrfProtectedMethod('PATCH')).toBe(true);
      expect(isCsrfProtectedMethod('GET')).toBe(false);
      expect(isCsrfProtectedMethod('HEAD')).toBe(false);
      expect(isCsrfProtectedMethod('OPTIONS')).toBe(false);
    });

    it('accepts matching header and cookie tokens', () => {
      const token = generateCsrfToken();
      const result = verifyCsrfToken(token, token);
      expect(result).toEqual({ valid: true });
    });

    it('rejects missing cookie, missing header, malformed token, and mismatched tokens', () => {
      const tokenA = generateCsrfToken();
      const tokenB = generateCsrfToken();

      expect(verifyCsrfToken(tokenA, null)).toMatchObject({
        valid: false,
        reason: 'missing_cookie',
      });
      expect(verifyCsrfToken(null, tokenA)).toMatchObject({
        valid: false,
        reason: 'missing_header',
      });
      expect(verifyCsrfToken('not-hex-token', 'not-hex-token')).toMatchObject({
        valid: false,
        reason: 'malformed_token',
      });
      expect(verifyCsrfToken(tokenA, tokenB)).toMatchObject({
        valid: false,
        reason: 'token_mismatch',
      });
    });

    it('extracts tokens from NextRequest headers and cookies', () => {
      const token = generateCsrfToken();
      const req = new NextRequest('http://localhost:3000/api/waitlist', {
        method: 'POST',
        headers: {
          [CSRF_HEADER_NAME]: token,
          cookie: `${CSRF_COOKIE_NAME}=${token}`,
        },
      });

      expect(extractCsrfTokens(req)).toEqual({
        headerToken: token,
        cookieToken: token,
      });
    });

    it('allows GET requests through csrfMiddleware without CSRF tokens', () => {
      const req = new NextRequest('http://localhost:3000/api/waitlist', {
        method: 'GET',
      });
      expect(validateCsrfRequest(req)).toEqual({ valid: true });
      expect(csrfMiddleware(req)).toBeNull();
    });

    it('rejects POST, PUT, DELETE requests missing valid CSRF tokens with 403 Forbidden', async () => {
      const token = generateCsrfToken();

      for (const method of ['POST', 'PUT', 'DELETE'] as const) {
        const missingAll = new NextRequest('http://localhost:3000/api/test', { method });
        const resMissingAll = csrfMiddleware(missingAll);
        expect(resMissingAll?.status).toBe(403);
        await expect(resMissingAll?.json()).resolves.toMatchObject({
          code: 'missing_cookie',
        });

        const missingHeader = new NextRequest('http://localhost:3000/api/test', {
          method,
          headers: { cookie: `${CSRF_COOKIE_NAME}=${token}` },
        });
        const resMissingHeader = csrfMiddleware(missingHeader);
        expect(resMissingHeader?.status).toBe(403);
        await expect(resMissingHeader?.json()).resolves.toMatchObject({
          code: 'missing_header',
        });

        const mismatched = new NextRequest('http://localhost:3000/api/test', {
          method,
          headers: {
            [CSRF_HEADER_NAME]: generateCsrfToken(),
            cookie: `${CSRF_COOKIE_NAME}=${token}`,
          },
        });
        const resMismatched = csrfMiddleware(mismatched);
        expect(resMismatched?.status).toBe(403);
        await expect(resMismatched?.json()).resolves.toMatchObject({
          code: 'token_mismatch',
        });
      }
    });

    it('protects wrapped route handlers via withCsrfProtection', async () => {
      const handler = withCsrfProtection(async () =>
        NextResponse.json({ mutated: true }, { status: 200 }),
      );
      const token = generateCsrfToken();

      const unauthorizedReq = new NextRequest('http://localhost:3000/api/mutate', {
        method: 'DELETE',
      });
      const rejected = await handler(unauthorizedReq);
      expect(rejected.status).toBe(403);

      const authorizedReq = new NextRequest('http://localhost:3000/api/mutate', {
        method: 'DELETE',
        headers: {
          [CSRF_HEADER_NAME]: token,
          cookie: `${CSRF_COOKIE_NAME}=${token}`,
        },
      });
      const accepted = await handler(authorizedReq);
      expect(accepted.status).toBe(200);
      await expect(accepted.json()).resolves.toEqual({ mutated: true });
    });

    it('creates a 403 Forbidden error response with createCsrfErrorResponse', async () => {
      const response = createCsrfErrorResponse(
        { valid: false, reason: 'token_mismatch', message: 'Token mismatch' },
      );
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({
        error: 'Token mismatch',
        code: 'token_mismatch',
      });
    });
  });

  describe('lib/api.ts mutation header enforcement', () => {
    let fetchMock: jest.Mock;

    beforeEach(() => {
      apiClient.clearCache();
      clearClientCsrfToken();
      fetchMock = jest.fn(async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ success: true }),
      }));
      global.fetch = fetchMock as unknown as typeof fetch;
    });

    it('automatically attaches X-CSRF-Token header on POST, PUT, and DELETE requests', async () => {
      const token = setClientCsrfToken();
      expect(getClientCsrfToken()).toBe(token);

      await apiClient.post('/api/waitlist', { email: 'user@example.com' });
      await apiClient.put('/api/resource/1', { name: 'updated' });
      await apiClient.delete('/api/resource/1');

      expect(fetchMock).toHaveBeenCalledTimes(3);
      for (const [, init] of fetchMock.mock.calls as [string, RequestInit][]) {
        const headers = init.headers as Record<string, string>;
        expect(headers[CSRF_HEADER_NAME]).toBe(token);
      }
    });

    it('does not attach X-CSRF-Token header to GET requests', async () => {
      ensureCsrfToken();
      await apiClient.get('/api/waitlist');

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const headers = init.headers as Record<string, string>;
      expect(headers[CSRF_HEADER_NAME]).toBeUndefined();
    });

    it('rejects mutation requests with HTTP 403 ApiError when X-CSRF-Token is missing or mismatched', async () => {
      setClientCsrfToken();

      await expect(
        apiCall('/api/waitlist', {
          method: 'POST',
          headers: { [CSRF_HEADER_NAME]: '' },
          body: JSON.stringify({ email: 'user@example.com' }),
        }),
      ).rejects.toThrow(ApiError);

      try {
        await apiCall('/api/waitlist', {
          method: 'PUT',
          headers: { [CSRF_HEADER_NAME]: generateCsrfToken() },
          body: JSON.stringify({ email: 'user@example.com' }),
        });
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError);
        expect((err as ApiError).status).toBe(403);
      }

      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('App Router API endpoint CSRF enforcement', () => {
    it('rejects POST /api/waitlist without valid CSRF token with 403 and accepts valid double-submit token', async () => {
      const forgedReq = new NextRequest('http://localhost:3000/api/waitlist', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'csrf@example.com' }),
      });
      const forgedRes = await waitlistPOST(forgedReq);
      expect(forgedRes.status).toBe(403);

      const token = generateCsrfToken();
      const validReq = new NextRequest('http://localhost:3000/api/waitlist', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [CSRF_HEADER_NAME]: token,
          cookie: `${CSRF_COOKIE_NAME}=${token}`,
        },
        body: JSON.stringify({ email: 'valid-csrf@example.com' }),
      });
      const validRes = await waitlistPOST(validReq);
      expect(validRes.status).toBe(201);

      const getRes = await waitlistGET(
        new NextRequest('http://localhost:3000/api/waitlist?email=valid-csrf@example.com'),
      );
      expect(getRes.status).toBe(200);
    });

    it('rejects POST /api/affiliates/referrals when CSRF header and cookie mismatch', async () => {
      const wallet = `G${'A'.repeat(55)}`;
      const mismatchReq = new NextRequest('http://localhost:3000/api/affiliates/referrals', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [CSRF_HEADER_NAME]: generateCsrfToken(),
          cookie: `${CSRF_COOKIE_NAME}=${generateCsrfToken()}`,
        },
        body: JSON.stringify({ walletAddress: wallet }),
      });
      const mismatchRes = await referralsPOST(mismatchReq);
      expect(mismatchRes.status).toBe(403);

      const token = generateCsrfToken();
      const validReq = new NextRequest('http://localhost:3000/api/affiliates/referrals', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [CSRF_HEADER_NAME]: token,
          cookie: `${CSRF_COOKIE_NAME}=${token}`,
        },
        body: JSON.stringify({ walletAddress: wallet }),
      });
      const validRes = await referralsPOST(validReq);
      expect(validRes.status).toBe(201);
    });
  });
});
