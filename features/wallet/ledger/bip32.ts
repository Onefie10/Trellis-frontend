/**
 * BIP-32 derivation path helpers for the Stellar Ledger app.
 *
 * Stellar accounts live under the SLIP-0044 coin type 148 and the Ledger Stellar
 * app only accepts fully hardened paths, e.g. `m/44'/148'/0'`. Paths are
 * serialised for the wire the same way the official `bip32-path` helper does:
 * one length byte followed by each index as a big-endian uint32 with the
 * hardened bit (`0x80000000`) set.
 */

/** Default account path used when the user does not pick an account index. */
export const STELLAR_DERIVATION_PATH = "44'/148'/0'";

/** Stellar's SLIP-0044 coin type. */
export const STELLAR_COIN_TYPE = 148;

const HARDENED_OFFSET = 0x80000000;
const MAX_INDEX = 0x7fffffff;

export interface Bip32PathSegment {
  index: number;
  hardened: boolean;
}

/**
 * Parse a derivation path into its segments. Accepts an optional `m/` prefix and
 * `'`, `h` or `H` as hardened markers.
 */
export function parseBip32Path(path: string): Bip32PathSegment[] {
  if (typeof path !== "string" || path.trim().length === 0) {
    throw new Error("Derivation path must be a non-empty string");
  }

  const body = path.trim().replace(/^m\/?/i, "");
  if (body.length === 0) {
    throw new Error("Derivation path must contain at least one index");
  }

  return body.split("/").map((rawSegment) => {
    const segment = rawSegment.trim();
    const hardened = /['hH]$/.test(segment);
    const indexText = hardened ? segment.slice(0, -1) : segment;
    if (!/^\d+$/.test(indexText)) {
      throw new Error(`Invalid derivation path segment "${rawSegment}"`);
    }

    const index = Number(indexText);
    if (index > MAX_INDEX) {
      throw new Error(`Derivation path index out of range: "${rawSegment}"`);
    }

    return { index, hardened };
  });
}

/** Render the canonical `44'/148'/0'` form of a parsed path. */
export function formatBip32Path(segments: Bip32PathSegment[]): string {
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new Error("Derivation path must contain at least one index");
  }

  return segments
    .map((segment) => `${segment.index}${segment.hardened ? "'" : ""}`)
    .join("/");
}

export function isValidBip32Path(path: string): boolean {
  try {
    parseBip32Path(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Build the account path for a given index, e.g. `deriveAccountPath(2)` -> `44'/148'/2'`.
 */
export function deriveAccountPath(index = 0): string {
  if (!Number.isInteger(index) || index < 0 || index > MAX_INDEX) {
    throw new Error(`Account index must be an integer between 0 and ${MAX_INDEX}`);
  }
  return `${44}'/${STELLAR_COIN_TYPE}'/${index}'`;
}

/**
 * Validate that a path is a Stellar account path (`m/44'/148'/index'`).
 */
export function assertStellarBip32Path(path: string, fallback = STELLAR_DERIVATION_PATH): string {
  const candidate = path && path.trim().length > 0 ? path.trim() : fallback;
  const segments = parseBip32Path(candidate);

  if (segments.length !== 3) {
    throw new Error(`Stellar derivation paths need exactly 3 segments: got "${candidate}"`);
  }
  if (segments[0].index !== 44 || !segments[0].hardened) {
    throw new Error(`Stellar derivation paths must start with 44': got "${candidate}"`);
  }
  if (segments[1].index !== STELLAR_COIN_TYPE || !segments[1].hardened) {
    throw new Error(`Stellar derivation paths must use coin type 148': got "${candidate}"`);
  }
  if (!segments[2].hardened) {
    throw new Error(`Stellar account segments must be hardened: got "${candidate}"`);
  }

  return formatBip32Path(segments);
}

/**
 * Serialise a path for the Ledger Stellar app APDU payload.
 *
 * The device only performs hardened derivation, so un-hardened segments are
 * hardened on the wire (matching the official `bip32-path` serialisation that
 * `@ledgerhq/hw-app-str` relies on).
 */
export function pathToBytes(path: string, options: { harden?: boolean } = {}): Uint8Array {
  const { harden = true } = options;
  const segments = parseBip32Path(path);
  const buffer = new Uint8Array(1 + segments.length * 4);
  buffer[0] = segments.length;

  segments.forEach((segment, position) => {
    const hardened = harden || segment.hardened;
    const value = hardened ? segment.index + HARDENED_OFFSET : segment.index;
    const offset = 1 + position * 4;
    buffer[offset] = (value >>> 24) & 0xff;
    buffer[offset + 1] = (value >>> 16) & 0xff;
    buffer[offset + 2] = (value >>> 8) & 0xff;
    buffer[offset + 3] = value & 0xff;
  });

  return buffer;
}
