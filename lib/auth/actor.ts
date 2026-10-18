import { z } from 'zod';
import { isRole, type Role } from '@/lib/permissions';

/**
 * Actor identity for `@/lib/permissions` enforcement.
 *
 * This repository has no session layer: routes that needed a role read one from
 * a query string, a header, or the request body. That is not authorization, it is
 * a self-asserted claim, so this module refuses to trust anything the client can
 * edit. An actor is established only from an HMAC-signed token.
 *
 * Fail-closed is the whole point. Every failure path returns `null` or throws
 * rather than defaulting to a role, because a default here would silently
 * re-grant whatever the caller's forged claim asked for.
 */

/** Name of the env var holding the HMAC secret. Documented in the PR. */
export const ACTOR_TOKEN_SECRET_ENV = 'PERMISSION_TOKEN_SECRET';

/** Token lifetime when `issueActorToken` is called without an explicit `exp`. */
const DEFAULT_TTL_MS = 15 * 60 * 1000;

export interface Actor {
  /** Stable principal id, e.g. a Stellar address or user id. */
  id: string;
  role: Role;
  /** Expiry, ms since epoch. */
  expiresAt: number;
}

const ActorPayloadSchema = z.object({
  sub: z.string().min(1),
  role: z.enum(['guest', 'viewer', 'contributor', 'maintainer', 'admin']),
  exp: z.number().int().positive(),
});

const textEncoder = new TextEncoder();

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function resolveSecret(): string | null {
  // Read through `process.env` at call time, not at module scope, so a test or
  // a serverless warm start can set it after import.
  const secret = process.env[ACTOR_TOKEN_SECRET_ENV];
  return secret && secret.length >= 32 ? secret : null;
}

async function hmac(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    textEncoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, textEncoder.encode(message));
  return new Uint8Array(signature);
}

/**
 * Constant-time comparison.
 *
 * Web Crypto has no `timingSafeEqual`, and a short-circuiting `===` on a
 * signature leaks the expected bytes one at a time.
 */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * Signs an actor token.
 *
 * Server-side only. Never call this from a route handler, or a client could mint
 * its own admin token.
 */
export async function issueActorToken(
  actor: { id: string; role: Role },
  options: { ttlMs?: number; now?: number } = {},
): Promise<string> {
  const secret = resolveSecret();
  if (!secret) {
    throw new Error(
      `${ACTOR_TOKEN_SECRET_ENV} is unset or shorter than 32 characters; cannot issue an actor token`,
    );
  }
  const now = options.now ?? Date.now();
  const payload = ActorPayloadSchema.parse({
    sub: actor.id,
    role: actor.role,
    exp: now + (options.ttlMs ?? DEFAULT_TTL_MS),
  });
  const encoded = base64UrlEncode(textEncoder.encode(JSON.stringify(payload)));
  const signature = base64UrlEncode(await hmac(secret, encoded));
  return `${encoded}.${signature}`;
}

export type ActorResolutionFailure =
  | 'missing_credentials'
  | 'malformed_token'
  | 'invalid_signature'
  | 'expired_token'
  | 'unknown_actor'
  | 'server_misconfigured';

export type ActorResolution =
  | { ok: true; actor: Actor }
  | { ok: false; failure: ActorResolutionFailure; message: string };

/**
 * Verifies a bearer token and resolves the actor.
 *
 * `server_misconfigured` is reported separately from the client failures so an
 * unset secret is never mistaken for a bad token during incident response.
 */
export async function verifyActorToken(
  token: string | null,
  options: { now?: number } = {},
): Promise<ActorResolution> {
  if (!token) {
    return { ok: false, failure: 'missing_credentials', message: 'No bearer token supplied' };
  }
  const secret = resolveSecret();
  if (!secret) {
    return {
      ok: false,
      failure: 'server_misconfigured',
      message: `${ACTOR_TOKEN_SECRET_ENV} is unset or shorter than 32 characters`,
    };
  }

  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return { ok: false, failure: 'malformed_token', message: 'Token must be "<payload>.<signature>"' };
  }
  const [encoded, signature] = parts as [string, string];

  const expected = await hmac(secret, encoded);
  let provided: Uint8Array;
  try {
    provided = base64UrlDecode(signature);
  } catch {
    return { ok: false, failure: 'malformed_token', message: 'Signature is not valid base64url' };
  }
  if (!timingSafeEqual(expected, provided)) {
    return { ok: false, failure: 'invalid_signature', message: 'Token signature does not match' };
  }

  // Signature is checked before the payload is trusted, so an attacker cannot
  // learn anything from parse errors on an unsigned token.
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(encoded)));
  } catch {
    return { ok: false, failure: 'malformed_token', message: 'Token payload is not valid JSON' };
  }
  const parsed = ActorPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return { ok: false, failure: 'malformed_token', message: 'Token payload failed validation' };
  }

  const now = options.now ?? Date.now();
  if (parsed.data.exp <= now) {
    return { ok: false, failure: 'expired_token', message: 'Token has expired' };
  }
  if (!isRole(parsed.data.role)) {
    return { ok: false, failure: 'unknown_actor', message: 'Token carries an unknown role' };
  }

  return {
    ok: true,
    actor: { id: parsed.data.sub, role: parsed.data.role, expiresAt: parsed.data.exp },
  };
}

/** Minimal request shape, so this works with `Request` and `NextRequest`. */
export interface HeaderCarrier {
  headers: { get(name: string): string | null };
}

/**
 * Resolves the calling actor from an `Authorization: Bearer` header.
 *
 * Nothing else is consulted. In particular there is no `x-role` fallback: a
 * client-set role header is exactly the bypass this module exists to remove.
 */
export async function resolveActor(
  request: HeaderCarrier,
  options: { now?: number } = {},
): Promise<ActorResolution> {
  const header = request.headers.get('authorization');
  if (!header) {
    return { ok: false, failure: 'missing_credentials', message: 'Authorization header is absent' };
  }
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) {
    return { ok: false, failure: 'missing_credentials', message: 'Authorization header must use the Bearer scheme' };
  }
  return verifyActorToken(match[1], options);
}
