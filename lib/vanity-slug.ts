/**
 * Vanity referral slug rules for Trellis.
 *
 * One canonical implementation shared by the referral-sharing client service
 * and the affiliate API store, so a slug the browser accepts can never be
 * rejected by the server and vice versa.
 *
 * A vanity link has the shape https://trellis.market/r/<slug> and resolves to
 * the marketplace agent its owner registered it for.
 */

export const VANITY_SLUG_BASE_URL = 'https://trellis.market';
export const VANITY_SLUG_PATH_PREFIX = '/r/';

export const VANITY_SLUG_MIN_LENGTH = 3;
export const VANITY_SLUG_MAX_LENGTH = 32;

/**
 * Canonical slug shape: lowercase alphanumerics separated by single hyphens,
 * starting and ending alphanumeric (no leading/trailing/double hyphens).
 */
export const VANITY_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Characters a user may type. Normalization folds spaces/underscores to
 * hyphens and lowercases; anything outside this set is rejected rather than
 * silently dropped.
 */
const VANITY_SLUG_INPUT_PATTERN = /^[A-Za-z0-9 _-]+$/;

/** Slugs that would shadow a real route or impersonate the platform. */
export const RESERVED_VANITY_SLUGS: ReadonlySet<string> = new Set([
  'about',
  'account',
  'accounts',
  'admin',
  'administrator',
  'affiliate',
  'affiliates',
  'agent',
  'agents',
  'api',
  'app',
  'assets',
  'auth',
  'contact',
  'dashboard',
  'docs',
  'help',
  'login',
  'logout',
  'market',
  'me',
  'new',
  'null',
  'privacy',
  'profile',
  'r',
  'ref',
  'referral',
  'referrals',
  'register',
  'rewards',
  'root',
  'settings',
  'signup',
  'static',
  'support',
  'system',
  'terms',
  'trellis',
  'undefined',
  'user',
  'users',
  'wallet',
  'wallets',
  'www',
]);

export type VanitySlugRejectionReason =
  | 'EMPTY'
  | 'TOO_SHORT'
  | 'TOO_LONG'
  | 'INVALID_CHARACTERS'
  | 'RESERVED'
  | 'COLLISION';

export type VanitySlugFailureReason =
  | VanitySlugRejectionReason
  | 'INVALID_WALLET'
  | 'AGENT_REQUIRED'
  | 'NOT_FOUND'
  | 'REGISTRATION_FAILED';

export interface VanitySlugValidation {
  valid: boolean;
  /** Canonical form after normalization ('' when the input is unusable). */
  normalized: string;
  reason?: VanitySlugRejectionReason;
  error?: string;
}

export interface VanitySlugValidationOptions {
  /** Slugs already in use (any casing); a normalized match is a COLLISION. */
  taken?: Iterable<string>;
}

export interface VanitySlugRecord {
  slug: string;
  ownerWallet: string;
  targetAgentId: string;
  createdAt: string;
}

export class VanitySlugError extends Error {
  readonly reason: VanitySlugFailureReason;
  readonly httpStatus: number;

  constructor(reason: VanitySlugFailureReason, message: string, httpStatus = 400) {
    super(message);
    this.name = 'VanitySlugError';
    this.reason = reason;
    this.httpStatus = httpStatus;
  }
}

/** Canonicalize a candidate: trim, lowercase, spaces/underscores -> hyphen. */
export function normalizeVanitySlug(raw: string): string {
  if (typeof raw !== 'string') return '';
  return raw
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * First existing slug that collides with the candidate, compared in
 * normalized (case-insensitive) form. Returns null when there is no clash.
 */
export function findVanitySlugCollision(
  raw: string,
  taken: Iterable<string>,
): string | null {
  const normalized = normalizeVanitySlug(raw);
  if (!normalized) return null;
  for (const candidate of taken) {
    if (typeof candidate === 'string' && normalizeVanitySlug(candidate) === normalized) {
      return candidate;
    }
  }
  return null;
}

/**
 * Validate a candidate vanity slug: allowed charset, length, reserved words
 * and (optionally) collisions against slugs already in use.
 */
export function validateVanitySlug(
  raw: string,
  options: VanitySlugValidationOptions = {},
): VanitySlugValidation {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return { valid: false, normalized: '', reason: 'EMPTY', error: 'Enter a vanity slug.' };
  }

  const trimmed = raw.trim();
  if (!VANITY_SLUG_INPUT_PATTERN.test(trimmed)) {
    return {
      valid: false,
      normalized: normalizeVanitySlug(trimmed),
      reason: 'INVALID_CHARACTERS',
      error: 'Use only letters, numbers, spaces, hyphens and underscores.',
    };
  }

  const normalized = normalizeVanitySlug(trimmed);
  if (normalized.length === 0) {
    return { valid: false, normalized, reason: 'EMPTY', error: 'Enter a vanity slug.' };
  }
  if (normalized.length < VANITY_SLUG_MIN_LENGTH) {
    return {
      valid: false,
      normalized,
      reason: 'TOO_SHORT',
      error: `Use at least ${VANITY_SLUG_MIN_LENGTH} characters.`,
    };
  }
  if (normalized.length > VANITY_SLUG_MAX_LENGTH) {
    return {
      valid: false,
      normalized,
      reason: 'TOO_LONG',
      error: `Use at most ${VANITY_SLUG_MAX_LENGTH} characters.`,
    };
  }
  if (!VANITY_SLUG_PATTERN.test(normalized)) {
    return {
      valid: false,
      normalized,
      reason: 'INVALID_CHARACTERS',
      error: 'A slug cannot start or end with a hyphen or contain two in a row.',
    };
  }
  if (RESERVED_VANITY_SLUGS.has(normalized)) {
    return {
      valid: false,
      normalized,
      reason: 'RESERVED',
      error: `"${normalized}" is reserved and cannot be used.`,
    };
  }
  if (findVanitySlugCollision(normalized, options.taken ?? [])) {
    return {
      valid: false,
      normalized,
      reason: 'COLLISION',
      error: `"${normalized}" is already taken.`,
    };
  }
  return { valid: true, normalized };
}

export interface VanityUrlOptions {
  baseUrl?: string;
}

/**
 * Build the clean share URL for a slug: `<base>/r/<slug>` (default base
 * https://trellis.market). Throws when the slug is not canonical, so we never
 * mint an ugly or broken link.
 */
export function buildVanityReferralUrl(
  slug: string,
  options: VanityUrlOptions = {},
): string {
  const normalized = normalizeVanitySlug(slug);
  if (!normalized || !VANITY_SLUG_PATTERN.test(normalized)) {
    throw new VanitySlugError(
      'INVALID_CHARACTERS',
      `Cannot build a vanity URL from "${slug}"`,
    );
  }
  const base = (options.baseUrl ?? VANITY_SLUG_BASE_URL).replace(/\/+$/, '');
  return `${base}${VANITY_SLUG_PATH_PREFIX}${normalized}`;
}
