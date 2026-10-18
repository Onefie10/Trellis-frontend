/**
 * Shared backend state for the affiliate API routes.
 *
 * This module is the single source of truth behind
 * /api/affiliates/* until a persistent database / indexer is wired in.
 * Keeping it in one place (instead of per-route mock literals) means:
 * - generated referral codes are persisted and resolvable for attribution,
 * - payout validation reads the same earnings ledger it reserves from,
 * - stats/program/validate all agree with each other.
 *
 * NOTE on storage: this is process-local in-memory state. It is consistent
 * across routes within one server instance, which is what the affiliate
 * endpoints need today. Swap the functions here for real DB calls later;
 * the route handlers and their response shapes must not change.
 *
 * SERVER-ONLY: import from route handlers (and tests), never from client
 * components — it uses node:crypto.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type {
  AffiliateProgram,
  AffiliateStats,
  EarningsHistory,
  PayoutRequest,
  ReferralRecord,
} from '@/features/affiliate-dashboard/types';
import {
  buildVanityReferralUrl,
  normalizeVanitySlug,
  validateVanitySlug,
  VanitySlugError,
  type VanitySlugRecord,
} from '@/lib/vanity-slug';
import {
  classifyReferrerSource,
  computeReferralClickMetrics,
  detectDeviceType,
  emptyReferralClickMetrics,
  toConversionStatus,
  type ConversionStatus,
  type ReferralClickMetrics,
  type ReferralEventKind,
  type ReferralLinkEvent,
} from '@/lib/referral-metrics';

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

export const STELLAR_ADDRESS_RE = /^G[A-Z2-7]{55}$/;

export function isValidStellarAddress(address: string): boolean {
  return STELLAR_ADDRESS_RE.test(address);
}

// ---------------------------------------------------------------------------
// Program configuration (#11)
// ---------------------------------------------------------------------------
// Single source of truth for the tier structure and commission rates shown
// in the UI. These rates MUST mirror what referral-contract actually pays;
// if the contract changes, change it here (and only here).
export const AFFILIATE_PROGRAM_CONFIG = {
  id: 'prog-001',
  name: 'Trellis Affiliate Program',
  status: 'active' as const,
  commissionStructure: {
    direct: 10,
    tier2: 5,
    tier3: 2,
  },
  minimumPayout: '100.00',
  payoutFrequency: 'weekly' as const,
  guidelines: [
    'No misleading marketing claims',
    'Respect user privacy and data',
    'Follow all applicable regulations',
    'Maintain professional communication',
    'Report accurate referral data',
  ],
} as const;

export const MINIMUM_PAYOUT_XLM = parseFloat(AFFILIATE_PROGRAM_CONFIG.minimumPayout);

// ---------------------------------------------------------------------------
// Eligibility criteria (#12)
// ---------------------------------------------------------------------------
// PRODUCT DECISION (documented here per the issue — this is the gate on who
// can join the affiliate programme and earn commissions):
//
// 1. valid-wallet      — well-formed Stellar address.
// 2. no-violation      — wallet has not been flagged for abuse.
// 3. not-enrolled      — wallet is not already in the programme.
// 4. no-self-referral  — the referrer code used at signup must not resolve
//                        to the applicant's own wallet.
// 5. minimum-age       — account must be at least MIN_ACCOUNT_AGE_DAYS old.
// 6. minimum-volume    — lifetime trading volume >= MIN_TRADING_VOLUME_XLM.
// 7. verified          — KYC / verification complete where required.
//
// Criteria 5–7 need account evidence (chain age, volume, KYC status) that
// this frontend server does not have yet. They are enforced FAIL-CLOSED:
// when the caller supplies no evidence, validation rejects with an
// `*_UNVERIFIED` reason code instead of approving everyone (the old
// behaviour). Callers that do have the data pass it as input and get full
// enforcement. Each rejection carries a machine-readable `reasonCode` the
// UI can render instead of failing opaquely.
export const MIN_ACCOUNT_AGE_DAYS = 30;
export const MIN_TRADING_VOLUME_XLM = 1000;

export type EligibilityReasonCode =
  | 'INVALID_ADDRESS'
  | 'FLAGGED_VIOLATION'
  | 'ALREADY_ENROLLED'
  | 'SELF_REFERRAL'
  | 'ACCOUNT_TOO_NEW'
  | 'ACCOUNT_AGE_UNVERIFIED'
  | 'INSUFFICIENT_VOLUME'
  | 'VOLUME_UNVERIFIED'
  | 'NOT_VERIFIED'
  | 'VERIFICATION_UNVERIFIED';

const ELIGIBILITY_MESSAGES: Record<EligibilityReasonCode, string> = {
  INVALID_ADDRESS: 'Wallet address is not a valid Stellar address.',
  FLAGGED_VIOLATION: 'This account has been flagged for a programme violation.',
  ALREADY_ENROLLED: 'This wallet is already enrolled in the affiliate programme.',
  SELF_REFERRAL: 'You cannot refer yourself. Use a different referrer code.',
  ACCOUNT_TOO_NEW: `Account must be at least ${MIN_ACCOUNT_AGE_DAYS} days old.`,
  ACCOUNT_AGE_UNVERIFIED: 'Account age could not be verified.',
  INSUFFICIENT_VOLUME: `Lifetime trading volume must be at least ${MIN_TRADING_VOLUME_XLM} XLM.`,
  VOLUME_UNVERIFIED: 'Trading volume could not be verified.',
  NOT_VERIFIED: 'Account verification (KYC) is required.',
  VERIFICATION_UNVERIFIED: 'Verification status could not be confirmed.',
};

export interface EligibilityInput {
  wallet: string;
  /** ISO timestamp of on-chain account creation, when known. */
  accountCreatedAt?: string;
  /** Lifetime trading volume in XLM, when known. */
  tradingVolumeXlm?: number;
  /** KYC / verification status, when known. */
  verified?: boolean;
  /** Referrer code the applicant signed up with, when present. */
  referrerCode?: string;
}

export interface EligibilityResult {
  eligible: boolean;
  reasonCode?: EligibilityReasonCode;
  /** Human-readable explanation for the UI. */
  reason?: string;
  requirements: {
    minimumAccountAge: string;
    minimumTradingVolume: string;
    verificationRequired: boolean;
  };
}

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------

interface AffiliateState {
  enrolledAt: Map<string, string>;
  violations: Set<string>;
  /** referral code -> owner wallet */
  codeOwner: Map<string, string>;
  /** wallet -> referral code */
  walletCode: Map<string, string>;
  /** referral code -> creation timestamp */
  codeCreatedAt: Map<string, string>;
  referrals: ReferralRecord[];
  payouts: PayoutRequest[];
  /** idempotency key -> payout id */
  idempotencyIndex: Map<string, IdempotencyEntry>;
  /** wallet -> lifetime credited commission earnings (XLM) */
  earned: Map<string, number>;
  /** normalized vanity slug -> alias record (issue #128) */
  vanitySlugs: Map<string, VanitySlugRecord>;
  /** referral link click/view ledger, the source of click metrics (issue #128) */
  linkEvents: ReferralLinkEvent[];
  /** test seam: force the payout submission path to fail */
  payoutBackendMode: 'ok' | 'fail';
}

function freshState(): AffiliateState {
  return {
    enrolledAt: new Map(),
    violations: new Set(),
    codeOwner: new Map(),
    walletCode: new Map(),
    codeCreatedAt: new Map(),
    referrals: [],
    payouts: [],
    idempotencyIndex: new Map(),
    earned: new Map(),
    vanitySlugs: new Map(),
    linkEvents: [],
    payoutBackendMode: 'ok',
  };
}

let state: AffiliateState = freshState();

/** Test/setup helper: wipe all affiliate state. */
export function __resetAffiliateStore(): void {
  state = freshState();
}

/** Test seam: make the backend payout submission path fail. */
export function __setPayoutBackendMode(mode: 'ok' | 'fail'): void {
  state.payoutBackendMode = mode;
}

// ---------------------------------------------------------------------------
// Eligibility (#12)
// ---------------------------------------------------------------------------

export function validateAffiliateEligibility(input: EligibilityInput): EligibilityResult {
  const requirements: EligibilityResult['requirements'] = {
    minimumAccountAge: `${MIN_ACCOUNT_AGE_DAYS} days`,
    minimumTradingVolume: `${MIN_TRADING_VOLUME_XLM} XLM`,
    verificationRequired: true,
  };

  const reject = (reasonCode: EligibilityReasonCode): EligibilityResult => ({
    eligible: false,
    reasonCode,
    reason: ELIGIBILITY_MESSAGES[reasonCode],
    requirements,
  });

  if (!isValidStellarAddress(input.wallet)) {
    return reject('INVALID_ADDRESS');
  }
  if (state.violations.has(input.wallet)) {
    return reject('FLAGGED_VIOLATION');
  }
  // Checked before enrollment: owning a code implies enrollment, so a
  // self-referral attempt would otherwise be mislabelled ALREADY_ENROLLED.
  if (input.referrerCode) {
    const owner = state.codeOwner.get(input.referrerCode);
    // Self-referral is impossible: a code owned by the applicant is rejected,
    // and unknown codes fail closed rather than being ignored.
    if (owner === undefined || owner === input.wallet) {
      return reject('SELF_REFERRAL');
    }
  }
  if (state.enrolledAt.has(input.wallet)) {
    return reject('ALREADY_ENROLLED');
  }
  if (input.accountCreatedAt === undefined) {
    return reject('ACCOUNT_AGE_UNVERIFIED');
  }
  const ageMs = Date.now() - new Date(input.accountCreatedAt).getTime();
  if (Number.isNaN(ageMs) || ageMs < MIN_ACCOUNT_AGE_DAYS * 86_400_000) {
    return reject('ACCOUNT_TOO_NEW');
  }
  if (input.tradingVolumeXlm === undefined) {
    return reject('VOLUME_UNVERIFIED');
  }
  if (input.tradingVolumeXlm < MIN_TRADING_VOLUME_XLM) {
    return reject('INSUFFICIENT_VOLUME');
  }
  if (input.verified === undefined) {
    return reject('VERIFICATION_UNVERIFIED');
  }
  if (!input.verified) {
    return reject('NOT_VERIFIED');
  }

  return { eligible: true, requirements };
}

export function enrollAffiliate(wallet: string): void {
  if (!state.enrolledAt.has(wallet)) {
    state.enrolledAt.set(wallet, new Date().toISOString());
  }
}

export function isEnrolled(wallet: string): boolean {
  return state.enrolledAt.has(wallet);
}

export function flagViolation(wallet: string): void {
  state.violations.add(wallet);
}

// ---------------------------------------------------------------------------
// Referral codes & records (#10)
// ---------------------------------------------------------------------------

const CODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const CODE_SUFFIX_LENGTH = 8;
const MAX_CODE_ATTEMPTS = 10;

function randomCode(): string {
  const bytes = randomBytes(CODE_SUFFIX_LENGTH);
  let suffix = '';
  for (let i = 0; i < CODE_SUFFIX_LENGTH; i++) {
    suffix += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return `ASTR${suffix}`;
}

/**
 * Return the wallet's existing code, or mint, persist and return a new one.
 * Generation is collision-resistant (crypto randomness over a ~1T space)
 * and uniqueness is verified against stored codes before returning.
 */
export function getOrCreateReferralCode(wallet: string): { code: string; createdAt: string } {
  const existing = state.walletCode.get(wallet);
  if (existing) {
    return { code: existing, createdAt: state.codeCreatedAt.get(existing) ?? new Date().toISOString() };
  }
  for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt++) {
    const code = randomCode();
    if (!state.codeOwner.has(code)) {
      state.codeOwner.set(code, wallet);
      state.walletCode.set(wallet, code);
      const createdAt = new Date().toISOString();
      state.codeCreatedAt.set(code, createdAt);
      enrollAffiliate(wallet);
      return { code, createdAt };
    }
  }
  throw new Error('Failed to generate a unique referral code');
}

/** Resolve a code to its owner wallet for attribution. Null = unknown code. */
export function resolveReferralCode(code: string): string | null {
  return state.codeOwner.get(code) ?? null;
}

export function listReferrals(wallet: string): ReferralRecord[] {
  return state.referrals.filter((r) => r.referralCode === state.walletCode.get(wallet));
}

export function recordReferral(
  affiliateWallet: string,
  referredWallet: string,
  opts: { referredUserName?: string; commissionRate?: number; commissionAmount?: string } = {},
): ReferralRecord {
  if (affiliateWallet === referredWallet) {
    throw new Error('Self-referral is not allowed');
  }
  const ownCode = state.walletCode.get(affiliateWallet);
  const record: ReferralRecord = {
    id: randomUUID(),
    referralCode: ownCode ?? getOrCreateReferralCode(affiliateWallet).code,
    referredUserAddress: referredWallet,
    referredUserName: opts.referredUserName,
    status: 'active',
    commissionRate: opts.commissionRate ?? AFFILIATE_PROGRAM_CONFIG.commissionStructure.direct,
    commissionAmount: opts.commissionAmount ?? '0.00',
    createdAt: new Date().toISOString(),
  };
  state.referrals.push(record);
  return record;
}

/** Mark a referral converted and credit the affiliate's earnings ledger. */
export function convertReferral(id: string): ReferralRecord | null {
  const record = state.referrals.find((r) => r.id === id);
  if (!record || record.status === 'converted') {
    return record ?? null;
  }
  record.status = 'converted';
  record.convertedAt = new Date().toISOString();
  const owner = state.codeOwner.get(record.referralCode);
  if (owner) {
    creditEarnings(owner, parseFloat(record.commissionAmount) || 0);
  }
  return record;
}

/** Credit commission earnings. Used by convertReferral; exposed for seeding. */
export function creditEarnings(wallet: string, amountXlm: number): void {
  state.earned.set(wallet, (state.earned.get(wallet) ?? 0) + amountXlm);
}

// ---------------------------------------------------------------------------
// Payouts (#9)
// ---------------------------------------------------------------------------
// Payout flow (product decision per the issue): the frontend REQUESTS a
// payout; the backend initiates the Stellar transfer. The browser never
// signs. A request only QUEUES settlement — success is never reported
// without the backend submission path accepting it.

export type PayoutFailureCode =
  | 'INVALID_AMOUNT'
  | 'BELOW_MINIMUM'
  | 'INSUFFICIENT_EARNINGS'
  | 'DUPLICATE_PAYOUT_IN_FLIGHT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'IDEMPOTENCY_KEY_EXPIRED'
  | 'PAYOUT_BACKEND_UNAVAILABLE';

/**
 * How long a payout's idempotency key may be replayed. After this window the
 * key is refused rather than silently paying again: a key is what makes a retry
 * safe, so an expired one has to be reported, not ignored.
 */
export const IDEMPOTENCY_KEY_TTL_MS = 24 * 60 * 60 * 1000;

/** What a used key remembers: the payout it produced and the request it bound to. */
interface IdempotencyEntry {
  payoutId: string;
  /** wallet|amount|destination of the original request. */
  fingerprint: string;
  createdAt: number;
}

export class PayoutError extends Error {
  readonly code: PayoutFailureCode;
  readonly httpStatus: number;
  constructor(code: PayoutFailureCode, message: string, httpStatus: number) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export function listPayouts(wallet: string): PayoutRequest[] {
  return state.payouts.filter((p) => p.walletAddress === wallet);
}

/** Earnings available for a new payout: earned minus completed and in-flight. */
export function getPendingEarnings(wallet: string): number {
  const earned = state.earned.get(wallet) ?? 0;
  const reserved = state.payouts
    .filter((p) => p.walletAddress === wallet && p.status !== 'failed')
    .reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0);
  return Math.max(0, earned - reserved);
}

/**
 * The seam where the backend payment path plugs in. Today it records the
 * intent to pay (status stays `pending` until a settler advances it);
 * it never claims funds moved. Returns false when the backend is
 * unavailable so the route surfaces a failure instead of fake success.
 */
function submitPayoutToNetwork(): boolean {
  return state.payoutBackendMode === 'ok';
}

export interface PayoutRequestInput {
  walletAddress: string;
  amount: string;
  destinationAddress: string;
  idempotencyKey?: string;
}

export function requestPayout(input: PayoutRequestInput): { payout: PayoutRequest; replayed: boolean } {
  const amountNum = parseFloat(input.amount);
  if (Number.isNaN(amountNum) || amountNum <= 0) {
    throw new PayoutError('INVALID_AMOUNT', 'Invalid amount', 400);
  }
  if (amountNum < MINIMUM_PAYOUT_XLM) {
    throw new PayoutError(
      'BELOW_MINIMUM',
      `Minimum payout is ${AFFILIATE_PROGRAM_CONFIG.minimumPayout} XLM`,
      400,
    );
  }

  const fingerprint = `${input.walletAddress}|${input.amount}|${input.destinationAddress}`;

  if (input.idempotencyKey) {
    const entry = state.idempotencyIndex.get(input.idempotencyKey);
    if (entry) {
      // A key only makes a retry safe while both halves still match: the same
      // request, inside its window. Anything else is reported, never paid.
      if (Date.now() - entry.createdAt > IDEMPOTENCY_KEY_TTL_MS) {
        throw new PayoutError(
          'IDEMPOTENCY_KEY_EXPIRED',
          'This idempotency key has expired; request the payout again with a new key',
          409,
        );
      }
      if (entry.fingerprint !== fingerprint) {
        throw new PayoutError(
          'IDEMPOTENCY_CONFLICT',
          'This idempotency key was already used for a different payout request',
          409,
        );
      }
      const existing = state.payouts.find((p) => p.id === entry.payoutId);
      if (existing) {
        return { payout: existing, replayed: true };
      }
    }
  }

  const duplicate = state.payouts.find(
    (p) =>
      p.walletAddress === input.walletAddress &&
      p.amount === input.amount &&
      (p.status === 'pending' || p.status === 'processing'),
  );
  if (duplicate) {
    throw new PayoutError(
      'DUPLICATE_PAYOUT_IN_FLIGHT',
      'A payout request for this amount is already in flight',
      409,
    );
  }

  if (amountNum > getPendingEarnings(input.walletAddress)) {
    throw new PayoutError(
      'INSUFFICIENT_EARNINGS',
      'Insufficient pending earnings for this payout',
      422,
    );
  }

  const payout: PayoutRequest = {
    id: randomUUID(),
    amount: input.amount,
    status: 'pending',
    requestedAt: new Date().toISOString(),
    walletAddress: input.walletAddress,
  };
  state.payouts.push(payout);
  if (input.idempotencyKey) {
    state.idempotencyIndex.set(input.idempotencyKey, {
      payoutId: payout.id,
      fingerprint,
      createdAt: Date.now(),
    });
  }

  if (!submitPayoutToNetwork()) {
    payout.status = 'failed';
    throw new PayoutError(
      'PAYOUT_BACKEND_UNAVAILABLE',
      'Payout could not be submitted. No funds were moved.',
      502,
    );
  }

  return { payout, replayed: false };
}

// ---------------------------------------------------------------------------
// Earnings history (#8)
// ---------------------------------------------------------------------------
// Aggregated from the same referral ledger the stats endpoint reads, so the
// chart can never disagree with the totals. Only converted referrals count
// (active referrals have not earned anything yet). Days with no conversions
// produce no rows — an empty array means "no earnings", not an error.

export function getEarningsHistory(wallet: string, days: number): EarningsHistory[] {
  const code = state.walletCode.get(wallet);
  if (!code) {
    return [];
  }
  const cutoff = Date.now() - days * 86_400_000;
  const byDay = new Map<string, number>();
  for (const referral of state.referrals) {
    if (referral.referralCode !== code || referral.status !== 'converted') {
      continue;
    }
    const timestamp = new Date(referral.convertedAt ?? referral.createdAt).getTime();
    if (Number.isNaN(timestamp) || timestamp < cutoff) {
      continue;
    }
    const day = new Date(timestamp).toISOString().split('T')[0];
    byDay.set(day, (byDay.get(day) ?? 0) + (parseFloat(referral.commissionAmount) || 0));
  }
  return [...byDay.entries()]
    .map(([date, amount]) => ({
      date,
      amount: Math.round(amount * 100) / 100,
      source: 'direct' as const,
    }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

// ---------------------------------------------------------------------------
// Stats & program (#11)
// ---------------------------------------------------------------------------

export function getStats(wallet: string): AffiliateStats {
  const referrals = state.referrals.filter(
    (r) => r.referralCode === state.walletCode.get(wallet),
  );
  const converted = referrals.filter((r) => r.status === 'converted');
  const active = referrals.filter((r) => r.status === 'active' || r.status === 'converted');
  const earned = state.earned.get(wallet) ?? 0;
  const pending = getPendingEarnings(wallet);
  const paid = state.payouts
    .filter((p) => p.walletAddress === wallet && p.status === 'completed')
    .reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0);

  return {
    totalReferrals: referrals.length,
    activeReferrals: active.length,
    totalEarnings: earned.toFixed(2),
    pendingEarnings: pending.toFixed(2),
    totalPayouts: paid.toFixed(2),
    conversionRate: referrals.length === 0 ? 0 : (converted.length / referrals.length) * 100,
  };
}

export function getProgram(wallet?: string): AffiliateProgram {
  return {
    ...AFFILIATE_PROGRAM_CONFIG,
    commissionStructure: { ...AFFILIATE_PROGRAM_CONFIG.commissionStructure },
    guidelines: [...AFFILIATE_PROGRAM_CONFIG.guidelines],
    joinedAt:
      (wallet && state.enrolledAt.get(wallet)) ?? new Date(Date.now() - 86_400_000 * 180).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Vanity referral aliases (#128)
// ---------------------------------------------------------------------------
// Clean trellis.market/r/<slug> aliases that resolve to a specific marketplace
// agent. Uniqueness is enforced across *all* wallets (case-insensitively via
// normalization), which is the collision guarantee the client pre-checks
// against but can never provide on its own.

export function registerVanitySlug(
  wallet: string,
  rawSlug: string,
  targetAgentId: string,
): VanitySlugRecord {
  // The owner is the wallet public key (or app user id) the alias belongs to.
  // Callers that need chain-level checks validate the address themselves; the
  // registry only requires a non-empty owner so attribution never goes missing.
  if (!wallet || wallet.trim() === '') {
    throw new VanitySlugError('INVALID_WALLET', 'An owner wallet or user id is required');
  }
  if (!targetAgentId || targetAgentId.trim() === '') {
    throw new VanitySlugError('AGENT_REQUIRED', 'A target marketplace agent is required');
  }

  const validation = validateVanitySlug(rawSlug, { taken: state.vanitySlugs.keys() });
  if (!validation.valid) {
    throw new VanitySlugError(
      validation.reason ?? 'INVALID_CHARACTERS',
      validation.error ?? 'Invalid vanity slug',
      validation.reason === 'COLLISION' ? 409 : 400,
    );
  }

  const record: VanitySlugRecord = {
    slug: validation.normalized,
    ownerWallet: wallet,
    targetAgentId: targetAgentId.trim(),
    createdAt: new Date().toISOString(),
  };
  state.vanitySlugs.set(record.slug, record);
  return record;
}

/** Resolve a slug (any casing) to its alias record. Null = not registered. */
export function resolveVanitySlug(rawSlug: string): VanitySlugRecord | null {
  return state.vanitySlugs.get(normalizeVanitySlug(rawSlug)) ?? null;
}

export function listVanitySlugs(wallet: string): VanitySlugRecord[] {
  return [...state.vanitySlugs.values()].filter((record) => record.ownerWallet === wallet);
}

/** The clean share URL for a registered alias. */
export function getVanitySlugUrl(record: VanitySlugRecord): string {
  return buildVanityReferralUrl(record.slug);
}

// ---------------------------------------------------------------------------
// Referral click analytics (#128)
// ---------------------------------------------------------------------------

export interface RecordClickInput {
  slug: string;
  referrer?: string;
  userAgent?: string;
  conversionStatus?: ConversionStatus | boolean;
  kind?: ReferralEventKind;
}

/**
 * Record a click (or link view) against a registered alias. The event borrows
 * the alias's agent for attribution; events for unknown slugs are refused so
 * metrics can never be attributed to something that was not created.
 */
export function recordReferralClickEvent(input: RecordClickInput): ReferralLinkEvent {
  const record = resolveVanitySlug(input.slug);
  if (!record) {
    throw new VanitySlugError('NOT_FOUND', `Unknown vanity slug "${input.slug}"`, 404);
  }

  const event: ReferralLinkEvent = {
    id: randomUUID(),
    kind: input.kind === 'view' ? 'view' : 'click',
    slug: record.slug,
    targetAgentId: record.targetAgentId,
    timestamp: new Date().toISOString(),
    referrerSource: classifyReferrerSource(input.referrer),
    deviceType: detectDeviceType(input.userAgent),
    conversionStatus: toConversionStatus(input.conversionStatus),
    referrer: input.referrer,
    userAgent: input.userAgent,
  };
  state.linkEvents.push(event);
  return event;
}

/** CTR / conversion metrics for every alias owned by a wallet. */
export function getReferralClickMetrics(
  wallet: string,
  days: number = 30,
): ReferralClickMetrics {
  const owned = new Set(listVanitySlugs(wallet).map((record) => record.slug));
  if (owned.size === 0) {
    return emptyReferralClickMetrics();
  }

  const cutoff = Date.now() - days * 86_400_000;
  const events = state.linkEvents.filter((event) => {
    if (!owned.has(event.slug)) return false;
    const timestamp = new Date(event.timestamp).getTime();
    return !Number.isNaN(timestamp) && timestamp >= cutoff;
  });

  return computeReferralClickMetrics(events);
}
