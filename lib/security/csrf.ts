import { NextRequest, NextResponse } from 'next/server';

export const CSRF_HEADER_NAME = 'X-CSRF-Token';
export const CSRF_COOKIE_NAME = 'csrf-token';
export const CSRF_TOKEN_BYTES = 32;
export const CSRF_MUTATION_METHODS = ['POST', 'PUT', 'DELETE', 'PATCH'] as const;

export type CsrfMutationMethod = (typeof CSRF_MUTATION_METHODS)[number];

export type CsrfFailureReason =
  | 'missing_cookie'
  | 'missing_header'
  | 'malformed_token'
  | 'token_mismatch';

export interface CsrfValidationResult {
  valid: boolean;
  reason?: CsrfFailureReason;
  message?: string;
}

export interface CsrfCookieOptions {
  cookieName?: string;
  headerName?: string;
  path?: string;
  sameSite?: 'Strict' | 'Lax' | 'None';
  secure?: boolean;
  maxAge?: number;
}

const HEX_TOKEN_REGEX = /^[0-9a-fA-F]{32,128}$/;

let fallbackClientToken: string | null = null;

/**
 * Generates a cryptographically secure random hex token for Anti-CSRF protection.
 */
export function generateCsrfToken(byteLength: number = CSRF_TOKEN_BYTES): string {
  if (!Number.isInteger(byteLength) || byteLength < 16 || byteLength > 64) {
    throw new RangeError('CSRF token byteLength must be an integer between 16 and 64');
  }

  const bytes = new Uint8Array(byteLength);
  if (typeof globalThis.crypto !== 'undefined' && typeof globalThis.crypto.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    throw new Error('Cryptographically secure random number generator is not available');
  }

  let hex = '';
  for (let i = 0; i < bytes.length; i += 1) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * Checks whether a candidate value is a well-formed hexadecimal CSRF token.
 */
export function isValidCsrfTokenFormat(token: unknown): token is string {
  return typeof token === 'string' && HEX_TOKEN_REGEX.test(token);
}

/**
 * Constant-time string comparison to prevent timing side-channel attacks on CSRF tokens.
 */
export function timingSafeEqualStrings(a: string, b: string): boolean {
  const maxLen = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < maxLen; i += 1) {
    const charA = i < a.length ? a.charCodeAt(i) : 0;
    const charB = i < b.length ? b.charCodeAt(i) : 0;
    diff |= charA ^ charB;
  }
  return diff === 0;
}

/**
 * Returns true if the HTTP method is a state-changing mutation method requiring CSRF verification.
 */
export function isCsrfProtectedMethod(method: string): boolean {
  return (CSRF_MUTATION_METHODS as readonly string[]).includes(method.toUpperCase());
}

/**
 * Parses a raw Cookie header or `document.cookie` string into a key-value map.
 */
export function parseCookies(cookieHeader: string | null | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!cookieHeader) return result;

  const pairs = cookieHeader.split(';');
  for (const pair of pairs) {
    const eqIndex = pair.indexOf('=');
    if (eqIndex === -1) continue;
    const rawKey = pair.slice(0, eqIndex).trim();
    const rawVal = pair.slice(eqIndex + 1).trim();
    if (!rawKey) continue;
    try {
      result[rawKey] = decodeURIComponent(rawVal);
    } catch {
      result[rawKey] = rawVal;
    }
  }
  return result;
}

/**
 * Serializes a double-submit CSRF cookie with secure defaults (`SameSite=Strict`, `Path=/`).
 */
export function serializeCsrfCookie(token: string, options: CsrfCookieOptions = {}): string {
  if (!isValidCsrfTokenFormat(token)) {
    throw new Error('Cannot serialize an invalid CSRF token');
  }

  const cookieName = options.cookieName ?? CSRF_COOKIE_NAME;
  const path = options.path ?? '/';
  const sameSite = options.sameSite ?? 'Strict';
  const isProd = typeof process !== 'undefined' && process.env?.NODE_ENV === 'production';
  const isHttpsWindow =
    typeof window !== 'undefined' && window.location?.protocol === 'https:';
  const secure = options.secure ?? (isProd || isHttpsWindow);

  const parts = [
    `${cookieName}=${encodeURIComponent(token)}`,
    `Path=${path}`,
    `SameSite=${sameSite}`,
  ];

  if (typeof options.maxAge === 'number' && Number.isFinite(options.maxAge)) {
    parts.push(`Max-Age=${Math.floor(options.maxAge)}`);
  }

  if (secure) {
    parts.push('Secure');
  }

  return parts.join('; ');
}

function readHeaderValue(
  headers: Headers | Record<string, string | string[] | undefined> | undefined,
  name: string,
): string | null {
  if (!headers) return null;
  if (typeof (headers as Headers).get === 'function') {
    const val = (headers as Headers).get(name);
    return val ? val.trim() : null;
  }

  const record = headers as Record<string, string | string[] | undefined>;
  const target = name.toLowerCase();
  for (const [k, v] of Object.entries(record)) {
    if (k.toLowerCase() === target) {
      if (Array.isArray(v)) return v[0]?.trim() ?? null;
      return typeof v === 'string' ? v.trim() : null;
    }
  }
  return null;
}

/**
 * Extracts the CSRF header token and double-submit cookie token from a request.
 */
export function extractCsrfTokens(
  req:
    | NextRequest
    | Request
    | {
        headers?: Headers | Record<string, string | string[] | undefined>;
        cookies?: { get?: (name: string) => { value: string } | string | undefined };
      },
  options: CsrfCookieOptions = {},
): { headerToken: string | null; cookieToken: string | null } {
  const cookieName = options.cookieName ?? CSRF_COOKIE_NAME;
  const headerName = options.headerName ?? CSRF_HEADER_NAME;

  const headerToken = readHeaderValue(req.headers, headerName);

  let cookieToken: string | null = null;
  const maybeCookies = (req as NextRequest).cookies;
  if (maybeCookies && typeof maybeCookies.get === 'function') {
    const entry = maybeCookies.get(cookieName) as { value?: string } | string | undefined;
    if (typeof entry === 'string') {
      cookieToken = entry.trim() || null;
    } else if (entry && typeof entry.value === 'string') {
      cookieToken = entry.value.trim() || null;
    }
  }

  if (!cookieToken) {
    const cookieHeader = readHeaderValue(req.headers, 'cookie');
    const parsed = parseCookies(cookieHeader);
    cookieToken = parsed[cookieName]?.trim() || null;
  }

  return { headerToken, cookieToken };
}

/**
 * Validates that the `X-CSRF-Token` header matches the double-submit cookie token.
 */
export function verifyCsrfToken(
  headerToken: string | null | undefined,
  cookieToken: string | null | undefined,
): CsrfValidationResult {
  if (!cookieToken) {
    return {
      valid: false,
      reason: 'missing_cookie',
      message: 'Forbidden: Missing CSRF double-submit cookie',
    };
  }

  if (!headerToken) {
    return {
      valid: false,
      reason: 'missing_header',
      message: 'Forbidden: Missing X-CSRF-Token header',
    };
  }

  if (!isValidCsrfTokenFormat(cookieToken) || !isValidCsrfTokenFormat(headerToken)) {
    return {
      valid: false,
      reason: 'malformed_token',
      message: 'Forbidden: Invalid CSRF token format',
    };
  }

  if (!timingSafeEqualStrings(headerToken, cookieToken)) {
    return {
      valid: false,
      reason: 'token_mismatch',
      message: 'Forbidden: CSRF token does not match double-submit cookie',
    };
  }

  return { valid: true };
}

/**
 * Validates a request against the Anti-CSRF double-submit cookie requirement.
 * Safe methods (GET, HEAD, OPTIONS) are allowed without requiring a token.
 */
export function validateCsrfRequest(
  req: NextRequest | Request,
  options: CsrfCookieOptions = {},
): CsrfValidationResult {
  if (!isCsrfProtectedMethod(req.method || 'GET')) {
    return { valid: true };
  }

  const { headerToken, cookieToken } = extractCsrfTokens(req, options);
  return verifyCsrfToken(headerToken, cookieToken);
}

/**
 * Creates a standardized HTTP 403 Forbidden response for rejected CSRF requests.
 */
export function createCsrfErrorResponse(
  result?: CsrfValidationResult,
  customMessage?: string,
): NextResponse {
  return NextResponse.json(
    {
      error: customMessage || result?.message || 'Forbidden: Invalid or missing CSRF token',
      code: result?.reason || 'csrf_validation_failed',
    },
    { status: 403 },
  );
}

/**
 * Anti-CSRF double-submit cookie middleware for App Router API endpoints.
 * Returns a 403 Forbidden `NextResponse` when verification fails, or `null` when valid.
 */
export function csrfMiddleware(
  req: NextRequest | Request,
  options: CsrfCookieOptions = {},
): NextResponse | null {
  const validation = validateCsrfRequest(req, options);
  if (!validation.valid) {
    return createCsrfErrorResponse(validation);
  }
  return null;
}

/**
 * Wraps an App Router route handler with Anti-CSRF double-submit cookie verification.
 */
export function withCsrfProtection<
  T extends (req: NextRequest, ...args: any[]) => Promise<Response> | Response,
>(handler: T, options: CsrfCookieOptions = {}): T {
  return (async (req: NextRequest, ...args: any[]) => {
    const rejection = csrfMiddleware(req, options);
    if (rejection) return rejection;
    return handler(req, ...args);
  }) as unknown as T;
}

/**
 * Attaches a newly generated or caller-supplied CSRF double-submit cookie to a `NextResponse`.
 */
export function attachCsrfCookie(
  response: NextResponse,
  token: string = generateCsrfToken(),
  options: CsrfCookieOptions = {},
): { response: NextResponse; token: string } {
  const cookieHeader = serializeCsrfCookie(token, options);
  response.headers.append('Set-Cookie', cookieHeader);
  response.headers.set(options.headerName ?? CSRF_HEADER_NAME, token);
  return { response, token };
}

/**
 * Reads the current CSRF token from `document.cookie` (browser) or the fallback store.
 */
export function getClientCsrfToken(cookieName: string = CSRF_COOKIE_NAME): string | null {
  if (typeof document !== 'undefined' && typeof document.cookie === 'string') {
    const cookies = parseCookies(document.cookie);
    const cookieVal = cookies[cookieName];
    if (cookieVal) return cookieVal;
  }
  return fallbackClientToken;
}

/**
 * Sets the double-submit CSRF cookie on the client and returns the token.
 */
export function setClientCsrfToken(
  token: string = generateCsrfToken(),
  options: CsrfCookieOptions = {},
): string {
  const serialized = serializeCsrfCookie(token, options);
  if (typeof document !== 'undefined') {
    document.cookie = serialized;
  }
  fallbackClientToken = token;
  return token;
}

/**
 * Ensures a valid cryptographically secure double-submit CSRF cookie exists on the client
 * and returns the token for inclusion in the `X-CSRF-Token` request header.
 */
export function ensureCsrfToken(options: CsrfCookieOptions = {}): string {
  const cookieName = options.cookieName ?? CSRF_COOKIE_NAME;
  const existing = getClientCsrfToken(cookieName);
  if (existing && isValidCsrfTokenFormat(existing)) {
    return existing;
  }
  return setClientCsrfToken(generateCsrfToken(), options);
}

/**
 * Clears the client-side CSRF token cookie and fallback state.
 */
export function clearClientCsrfToken(cookieName: string = CSRF_COOKIE_NAME): void {
  if (typeof document !== 'undefined') {
    document.cookie = `${cookieName}=; Path=/; Max-Age=0; SameSite=Strict`;
  }
  fallbackClientToken = null;
}
