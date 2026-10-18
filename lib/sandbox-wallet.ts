/**
 * Sandbox Mock Wallet Balance Generator
 *
 * Builds deterministic, validated mock wallet states so contributors can
 * exercise UI branches — empty wallet, low XLM, missing trustline, unauthorised
 * asset — without spending testnet XLM or holding any credentials.
 *
 * This module is pure: the same input always produces the same state. There is
 * no network access, no randomness and no clock dependency unless the caller
 * passes an explicit `now`.
 */

import type { StellarNetwork } from "./types";

/** Stellar stores balances as integer stroops (7 decimal places). */
export const STROOPS_PER_UNIT = 10_000_000n;

/** Base reserve, in stroops. One reserve unit is 0.5 XLM. */
export const BASE_RESERVE_STROOPS = 5_000_000n;

/** Asset codes are 1–12 alphanumeric characters on Stellar. */
export const MAX_ASSET_CODE_LENGTH = 12;

/** Strkey alphabet used by Stellar public keys. */
export const STRKEY_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export const ASSET_CODE_PATTERN = /^[A-Za-z0-9]{1,12}$/;
export const PUBLIC_KEY_PATTERN = /^G[A-Z2-7]{55}$/;

export type SandboxAssetType = "native" | "credit_alphanum4" | "credit_alphanum12";

export interface MockBalanceInput {
  /** `native`, `XLM`, `USDC`, `USDC:<issuer>` or `USDC-<issuer>`. */
  asset: string;
  /** Decimal string or number, up to 7 decimal places. */
  balance: string | number;
  /** Overrides / supplies the issuer when `asset` is a bare code. */
  issuer?: string;
  limit?: string | number;
  authorized?: boolean;
  sponsored?: boolean;
}

export interface NormalisedAsset {
  key: string;
  label: string;
  code: string;
  issuer?: string;
  type: SandboxAssetType;
  isNative: boolean;
}

export interface MockBalance extends NormalisedAsset {
  /** Normalised, always 7 decimal places. */
  balance: string;
  balanceStroops: bigint;
  limit?: string;
  authorized: boolean;
  sponsored: boolean;
  hasTrustline: boolean;
}

export interface MockWalletReserve {
  subentryCount: number;
  baseReserve: string;
  minimumReserve: string;
  spendable: string;
  belowMinimum: boolean;
}

export interface MockWalletState {
  id: string;
  label: string;
  publicKey: string;
  network: StellarNetwork;
  generatedAt: number;
  balances: MockBalance[];
  reserve: MockWalletReserve;
  warnings: string[];
}

export interface BuildMockWalletInput {
  label?: string;
  /** Explicit public key. Falls back to a key derived from `seed` / `label`. */
  publicKey?: string;
  seed?: string;
  network?: StellarNetwork;
  balances: MockBalanceInput[];
  /** Prepend a zero native balance when none was supplied. Default `true`. */
  ensureNative?: boolean;
  /** Extra subentries the account already owns (offers, data, signers…). */
  sponsoredSubentries?: number;
  /** Fixed timestamp for deterministic tests. */
  now?: number;
}

export class SandboxWalletError extends Error {
  readonly code: string;
  readonly field?: string;

  constructor(message: string, code: string, field?: string) {
    super(message);
    this.name = "SandboxWalletError";
    this.code = code;
    this.field = field;
  }
}

/* ------------------------------------------------------------------ *
 * Deterministic helpers
 * ------------------------------------------------------------------ */

/** 32-bit FNV-1a — small, dependency-free, and stable across platforms. */
export function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Seeded PRNG so a given seed always yields the same sequence. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Derives a syntactically valid (but deliberately fake) Stellar public key.
 *
 * The key satisfies `PUBLIC_KEY_PATTERN` so validation paths are exercised, but
 * it is not a real ed25519 key and can never sign anything.
 */
export function deriveMockPublicKey(seed: string): string {
  const random = seededRandom(fnv1a32(`sandbox-wallet:${seed}`));
  let body = "";
  for (let i = 0; i < 55; i += 1) {
    body += STRKEY_ALPHABET[Math.floor(random() * 32) % 32];
  }
  return `G${body}`;
}

export function isValidPublicKey(value: string): boolean {
  return PUBLIC_KEY_PATTERN.test(value);
}

export function isValidAssetCode(code: string): boolean {
  return ASSET_CODE_PATTERN.test(code);
}

/* ------------------------------------------------------------------ *
 * Balance <-> stroop conversion
 * ------------------------------------------------------------------ */

export function toStroops(value: string | number): bigint {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new SandboxWalletError(
        `Balance ${String(value)} is not a finite number`,
        "INVALID_BALANCE",
        "balance",
      );
    }
  }

  const raw = String(value).trim();
  if (raw.length === 0) {
    throw new SandboxWalletError("Balance is empty", "INVALID_BALANCE", "balance");
  }
  if (/e/i.test(raw)) {
    throw new SandboxWalletError(
      `Balance ${raw} uses exponent notation; pass a plain decimal string`,
      "INVALID_BALANCE",
      "balance",
    );
  }
  if (!/^-?\d+(\.\d+)?$/.test(raw)) {
    throw new SandboxWalletError(
      `Balance ${raw} is not a decimal number`,
      "INVALID_BALANCE",
      "balance",
    );
  }

  const negative = raw.startsWith("-");
  const unsigned = negative ? raw.slice(1) : raw;
  const [whole, fraction = ""] = unsigned.split(".");

  if (fraction.length > 7) {
    throw new SandboxWalletError(
      `Balance ${raw} has more than 7 decimal places`,
      "DECIMAL_PRECISION",
      "balance",
    );
  }

  const padded = (fraction + "0000000").slice(0, 7);
  const stroops = BigInt(whole || "0") * STROOPS_PER_UNIT + BigInt(padded);
  return negative ? -stroops : stroops;
}

/** Formats stroops back to the canonical 7-decimal Stellar representation. */
export function fromStroops(stroops: bigint): string {
  const negative = stroops < 0n;
  const absolute = negative ? -stroops : stroops;
  const whole = absolute / STROOPS_PER_UNIT;
  const fraction = absolute % STROOPS_PER_UNIT;
  return `${negative ? "-" : ""}${whole}.${fraction.toString().padStart(7, "0")}`;
}

/** Human-friendly form: trailing zeros removed (used by the UI preview). */
export function formatBalance(stroops: bigint): string {
  return trimBalance(fromStroops(stroops));
}

/** Trims a canonical 7-decimal balance down to its shortest exact form. */
export function trimBalance(value: string): string {
  if (!value.includes(".")) return value;
  const trimmed = value.replace(/0+$/, "").replace(/\.$/, "");
  return trimmed.length > 0 ? trimmed : "0";
}

/** Largest trustline limit Stellar accepts. */
export const MAX_TRUSTLINE_LIMIT = "922337203685.4775807";

/* ------------------------------------------------------------------ *
 * Asset normalisation
 * ------------------------------------------------------------------ */

const NATIVE_ALIASES = new Set(["native", "xlm", "lumens"]);

export function normaliseAssetSpec(spec: string, issuerOverride?: string): NormalisedAsset {
  const trimmed = String(spec ?? "").trim();
  if (trimmed.length === 0) {
    throw new SandboxWalletError("Asset is required", "EMPTY_ASSET", "asset");
  }

  if (NATIVE_ALIASES.has(trimmed.toLowerCase())) {
    return {
      key: "native",
      label: "XLM",
      code: "XLM",
      type: "native",
      isNative: true,
    };
  }

  // Accept both `CODE:ISSUER` (Stellar canonical) and `CODE-ISSUER`.
  const separator = trimmed.includes(":") ? ":" : trimmed.includes("-") ? "-" : null;
  const parts = separator ? trimmed.split(separator) : [trimmed];
  const code = parts[0].trim();
  const issuer = (issuerOverride ?? parts[1] ?? "").trim();

  if (!isValidAssetCode(code)) {
    throw new SandboxWalletError(
      `Asset code "${code}" must be 1–${MAX_ASSET_CODE_LENGTH} alphanumeric characters`,
      "INVALID_ASSET_CODE",
      "asset",
    );
  }

  if (issuer.length === 0) {
    throw new SandboxWalletError(
      `Asset ${code} needs an issuer (use "${code}:G…" or pass issuer separately)`,
      "MISSING_ISSUER",
      "issuer",
    );
  }

  if (!isValidPublicKey(issuer)) {
    throw new SandboxWalletError(
      `Issuer for ${code} is not a valid Stellar account id (expected G + 55 base32 chars)`,
      "INVALID_ISSUER",
      "issuer",
    );
  }

  const upperCode = code.toUpperCase();
  return {
    key: `${upperCode}:${issuer}`,
    label: upperCode,
    code: upperCode,
    issuer,
    type: upperCode.length <= 4 ? "credit_alphanum4" : "credit_alphanum12",
    isNative: false,
  };
}

/* ------------------------------------------------------------------ *
 * Wallet construction
 * ------------------------------------------------------------------ */

export function minimumReserveStroops(subentryCount: number): bigint {
  const safeCount = Number.isFinite(subentryCount) ? Math.max(0, Math.floor(subentryCount)) : 0;
  // Stellar base reserve is 0.5 XLM and the account itself costs 2 units.
  return BigInt(2 + safeCount) * BASE_RESERVE_STROOPS;
}

export function buildMockWallet(input: BuildMockWalletInput): MockWalletState {
  const balances = Array.isArray(input?.balances) ? input.balances : [];
  const ensureNative = input.ensureNative !== false;
  const network = input.network ?? "testnet";
  const warnings: string[] = [];

  const normalised: MockBalance[] = [];
  const seen = new Map<string, number>();

  for (const entry of balances) {
    if (!entry || entry.asset === undefined || entry.asset === null) {
      throw new SandboxWalletError("Every balance row needs an asset", "EMPTY_ASSET", "asset");
    }

    const asset = normaliseAssetSpec(String(entry.asset), entry.issuer);
    if (seen.has(asset.key)) {
      throw new SandboxWalletError(
        `Asset ${asset.label} appears more than once`,
        "DUPLICATE_ASSET",
        asset.key,
      );
    }
    seen.set(asset.key, normalised.length);

    if (entry.balance === undefined || entry.balance === null || String(entry.balance).trim() === "") {
      throw new SandboxWalletError(
        `Balance for ${asset.label} is required`,
        "INVALID_BALANCE",
        asset.key,
      );
    }

    const balanceStroops = toStroops(entry.balance);
    if (balanceStroops < 0n) {
      throw new SandboxWalletError(
        `Balance for ${asset.label} cannot be negative`,
        "NEGATIVE_BALANCE",
        asset.key,
      );
    }

    let limit: string | undefined;
    if (entry.limit !== undefined && entry.limit !== null && String(entry.limit).trim() !== "") {
      const limitStroops = toStroops(entry.limit);
      if (limitStroops <= 0n) {
        throw new SandboxWalletError(
          `Trustline limit for ${asset.label} must be greater than zero`,
          "INVALID_LIMIT",
          asset.key,
        );
      }
      limit = fromStroops(limitStroops);
    }

    if (!asset.isNative && balanceStroops > 0n && !limit) {
      limit = MAX_TRUSTLINE_LIMIT;
    }

    const authorized = entry.authorized !== false;
    if (!asset.isNative && !authorized) {
      warnings.push(
        `Trustline for ${asset.label} is not authorised — payments using it will fail with opNOT_AUTHORIZED.`,
      );
    }
    if (balanceStroops === 0n) {
      warnings.push(`Balance for ${asset.label} is zero — the empty-state branch will render.`);
    }

    normalised.push({
      ...asset,
      balance: fromStroops(balanceStroops),
      balanceStroops,
      limit,
      authorized,
      sponsored: entry.sponsored === true,
      hasTrustline: !asset.isNative,
    });
  }

  let result = normalised;
  const nativeIndex = result.findIndex((b) => b.isNative);
  if (nativeIndex === -1) {
    if (!ensureNative) {
      throw new SandboxWalletError(
        "A wallet needs a native XLM balance",
        "NO_NATIVE_BALANCE",
        "balance",
      );
    }
    warnings.push(
      "No native balance was supplied — a 0 XLM entry was added so the low-balance branch is reachable.",
    );
    result = [buildNativeBalance(0n), ...result];
  }

  if (input.sponsoredSubentries !== undefined && input.sponsoredSubentries !== 0) {
    warnings.push(
      `${input.sponsoredSubentries} extra subentr${input.sponsoredSubentries === 1 ? "y" : "ies"} counted towards the minimum reserve.`,
    );
  }

  const nonNativeCount = result.filter((b) => !b.isNative).length;
  const subentryCount = nonNativeCount + Math.max(0, Math.floor(input.sponsoredSubentries ?? 0));
  const minimumReserve = minimumReserveStroops(subentryCount);
  const nativeStroops = result.find((b) => b.isNative)?.balanceStroops ?? 0n;
  const spendable = nativeStroops > minimumReserve ? nativeStroops - minimumReserve : 0n;
  const belowMinimum = nativeStroops < minimumReserve;

  if (belowMinimum) {
    warnings.push(
      `Native balance is below the ${formatBalance(minimumReserve)} XLM minimum reserve — on-chain operations would fail with opINSUFFICIENT_BALANCE.`,
    );
  }

  const label = input.label?.trim() || "Sandbox wallet";
  const seed = input.seed?.trim() || label;
  const publicKey = input.publicKey?.trim() || deriveMockPublicKey(seed);

  if (!isValidPublicKey(publicKey)) {
    throw new SandboxWalletError(
      `Public key "${publicKey}" is not a valid Stellar account id`,
      "INVALID_PUBLIC_KEY",
      "publicKey",
    );
  }

  return {
    id: `sandbox-wallet-${fnv1a32(`${label}:${publicKey}:${subentryCount}`).toString(16)}`,
    label,
    publicKey,
    network,
    generatedAt: input.now ?? Date.now(),
    balances: result,
    reserve: {
      subentryCount,
      baseReserve: fromStroops(BASE_RESERVE_STROOPS),
      minimumReserve: fromStroops(minimumReserve),
      spendable: fromStroops(spendable),
      belowMinimum,
    },
    warnings,
  };
}

export function buildNativeBalance(stroops: bigint): MockBalance {
  return {
    key: "native",
    label: "XLM",
    code: "XLM",
    type: "native",
    isNative: true,
    balance: fromStroops(stroops),
    balanceStroops: stroops,
    authorized: true,
    sponsored: false,
    hasTrustline: false,
  };
}

/* ------------------------------------------------------------------ *
 * Queries + adapters into the rest of the app
 * ------------------------------------------------------------------ */

/**
 * Looks up a balance by asset spec.
 *
 * Tolerant by design: a bare code such as `USDC` is accepted (the issuer is not
 * needed to find the entry) so callers never have to re-supply it.
 */
export function findBalance(
  state: MockWalletState,
  asset: string,
): MockBalance | undefined {
  const raw = String(asset ?? "").trim();
  if (raw.length === 0) return undefined;

  try {
    const normalised = normaliseAssetSpec(raw).key;
    if (normalised === "native") return walletNativeBalance(state);
    return state.balances.find((b) => b.key === normalised);
  } catch {
    const code = raw.split(/[:\-]/)[0].trim().toUpperCase();
    return state.balances.find((b) => b.code.toUpperCase() === code);
  }
}

export function findBalanceByKey(
  state: MockWalletState,
  assetKey: string,
): MockBalance | undefined {
  return state.balances.find((b) => b.key === assetKey);
}

export function walletNativeBalance(state: MockWalletState): MockBalance {
  return state.balances.find((b) => b.isNative) ?? buildNativeBalance(0n);
}

/** Shapes the wallet for the wallet context / `WalletBalance` consumers. */
export function walletToBalances(
  state: MockWalletState,
): Array<{ asset: string; balance: string; assetCode?: string; assetIssuer?: string }> {
  return state.balances.map((b) => ({
    asset: b.key,
    balance: b.balance,
    assetCode: b.isNative ? undefined : b.code,
    assetIssuer: b.isNative ? undefined : b.issuer,
  }));
}

export function summariseWallet(state: MockWalletState): string {
  const native = walletNativeBalance(state);
  const assets = state.balances.filter((b) => !b.isNative).length;
  return `${state.label}: ${formatBalance(native.balanceStroops)} XLM native, ${assets} trustline${assets === 1 ? "" : "s"}, spendable ${trimBalance(state.reserve.spendable)} XLM`;
}

/* ------------------------------------------------------------------ *
 * Presets
 * ------------------------------------------------------------------ */

/** Valid-looking placeholder issuers. These are not real accounts. */
export const MOCK_ISSUERS = {
  usdc: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  eurc: "GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2",
  aqua: "GIXCNOA72PGIK5ZMD7YRUFIJMRPTXS5HRC3TXMPWS5HEMO6RCZ4RYJIP",
} as const;

export interface WalletPreset {
  id: string;
  label: string;
  description: string;
  input: Omit<BuildMockWalletInput, "now">;
}

export const WALLET_PRESETS: WalletPreset[] = [
  {
    id: "healthy",
    label: "Healthy wallet",
    description: "2 XLM native plus a funded USDC trustline — the happy path.",
    input: {
      label: "Healthy sandbox wallet",
      seed: "preset-healthy",
      balances: [
        { asset: "native", balance: "25" },
        { asset: "USDC", issuer: MOCK_ISSUERS.usdc, balance: "500" },
      ],
    },
  },
  {
    id: "low-xlm",
    label: "Low XLM / high reserve",
    description:
      "0.8 XLM native with three trustlines — below the 2.5 XLM minimum reserve, so operations fail with opINSUFFICIENT_BALANCE.",
    input: {
      label: "Low-balance sandbox wallet",
      seed: "preset-low-xlm",
      balances: [
        { asset: "native", balance: "0.8" },
        { asset: "USDC", issuer: MOCK_ISSUERS.usdc, balance: "120" },
        { asset: "EURC", issuer: MOCK_ISSUERS.eurc, balance: "75.5" },
        { asset: "AQUA", issuer: MOCK_ISSUERS.aqua, balance: "10000" },
      ],
    },
  },
  {
    id: "no-trustlines",
    label: "No trustlines",
    description: "Native-only wallet — the empty asset list branch.",
    input: {
      label: "Native-only sandbox wallet",
      seed: "preset-no-trustlines",
      balances: [{ asset: "native", balance: "50" }],
    },
  },
  {
    id: "unauthorised",
    label: "Unauthorised trustline",
    description:
      "A trustline that exists but is not authorised — renders the opNOT_AUTHORIZED failure path.",
    input: {
      label: "Unauthorised asset sandbox wallet",
      seed: "preset-unauthorised",
      balances: [
        { asset: "native", balance: "30" },
        { asset: "USDC", issuer: MOCK_ISSUERS.usdc, balance: "0", authorized: false },
      ],
    },
  },
  {
    id: "empty",
    label: "Empty wallet",
    description: "Zero XLM and no trustlines — the disconnected / brand-new account branch.",
    input: {
      label: "Empty sandbox wallet",
      seed: "preset-empty",
      balances: [{ asset: "native", balance: "0" }],
    },
  },
];

export function getWalletPreset(id: string): WalletPreset | undefined {
  return WALLET_PRESETS.find((p) => p.id === id);
}

export function buildWalletFromPreset(id: string, now?: number): MockWalletState {
  const preset = getWalletPreset(id);
  if (!preset) {
    throw new SandboxWalletError(`Unknown wallet preset "${id}"`, "UNKNOWN_PRESET", "id");
  }
  return buildMockWallet({ ...preset.input, now });
}

/**
 * Validates a draft without throwing — used by the generator UI so every row
 * can be annotated instead of only reporting the first failure.
 */
export function validateDraft(
  balances: MockBalanceInput[],
  options?: { ensureNative?: boolean; sponsoredSubentries?: number; now?: number },
): { ok: boolean; state?: MockWalletState; error?: SandboxWalletError } {
  try {
    const state = buildMockWallet({
      label: "Draft sandbox wallet",
      seed: "draft",
      balances,
      ensureNative: options?.ensureNative,
      sponsoredSubentries: options?.sponsoredSubentries,
      now: options?.now,
    });
    return { ok: true, state };
  } catch (error) {
    if (error instanceof SandboxWalletError) return { ok: false, error };
    throw error;
  }
}
