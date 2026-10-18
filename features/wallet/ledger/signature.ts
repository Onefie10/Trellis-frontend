/**
 * Signature and public-key payload helpers for the Ledger integration.
 *
 * `@ledgerhq/hw-app-str` returns the raw 64-byte Ed25519 signature produced by the
 * device, but other builds (and older firmware) hand back DER-encoded or
 * hex/base64 encoded payloads. The parser below normalises all of those into the
 * 64-byte signature Stellar's `DecoratedSignature` expects, and derives the
 * 4-byte signature hint from the account's public key.
 */

import { LedgerError } from "./errors";
import {
  ED25519_PUBLIC_KEY_LENGTH,
  encodeEd25519PublicKey,
  signatureHintFor,
} from "./strkey";

/** A Ledger-derived Stellar account. */
export interface LedgerAccount {
  /** `G...` address derived from the device public key. */
  address: string;
  /** Alias of `address`, matching the naming used elsewhere in the app. */
  publicKey: string;
  /** Raw 32-byte Ed25519 public key returned by the device. */
  rawPublicKey: Uint8Array;
  /** BIP-32 path used to derive the key, e.g. `44'/148'/0'`. */
  derivationPath: string;
}

const SIGNATURE_LENGTH = 64;
const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function isHex(value: string): boolean {
  return value.length > 0 && value.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(value);
}

export function bytesToHex(bytes: Uint8Array): string {
  let output = "";
  for (let i = 0; i < bytes.length; i += 1) {
    output += bytes[i].toString(16).padStart(2, "0");
  }
  return output;
}

export function hexToBytes(hex: string): Uint8Array {
  const normalized = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (!isHex(normalized)) {
    throw new LedgerError(`"${hex}" is not a valid hex string`, { code: "invalid-signature" });
  }
  const bytes = new Uint8Array(normalized.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = parseInt(normalized.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function base64ToBytes(base64: string): Uint8Array {
  const normalized = base64.replace(/[^A-Za-z0-9+/]/g, "");
  const output: number[] = [];
  let bits = 0;
  let value = 0;
  for (let i = 0; i < normalized.length; i += 1) {
    const index = BASE64_ALPHABET.indexOf(normalized[i]);
    if (index === -1) {
      throw new LedgerError(`"${base64}" is not valid base64`, { code: "invalid-signature" });
    }
    value = (value << 6) | index;
    bits += 6;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(output);
}

/**
 * Coerce a device payload into bytes. Accepts `Uint8Array`, `ArrayBuffer`,
 * `number[]`, and hex/base64 strings.
 */
export function toUint8Array(
  value: unknown,
  label = "payload",
): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  if (Array.isArray(value)) {
    if (!value.every((entry) => Number.isInteger(entry) && entry >= 0 && entry <= 255)) {
      throw new LedgerError(`Expected ${label} to be a byte array`, { code: "invalid-data" });
    }
    return Uint8Array.from(value as number[]);
  }
  if (typeof value === "string") {
    const hexCandidate = value.startsWith("0x") ? value.slice(2) : value;
    if (value.startsWith("0x") || (isHex(hexCandidate) && [64, 128].includes(hexCandidate.length))) {
      return hexToBytes(value);
    }
    try {
      return base64ToBytes(value);
    } catch {
      throw new LedgerError(`Expected ${label} to be hex or base64 encoded`, {
        code: "invalid-data",
      });
    }
  }
  throw new LedgerError(`Unsupported ${label} payload type`, { code: "invalid-data" });
}

interface DerLength {
  length: number;
  offset: number;
}

function readDerLength(bytes: Uint8Array, offset: number): DerLength {
  const first = bytes[offset];
  if (first === undefined) {
    throw new LedgerError("Truncated DER signature", { code: "invalid-signature" });
  }
  if (first < 0x80) return { length: first, offset: offset + 1 };

  const byteCount = first & 0x7f;
  if (byteCount === 0 || byteCount > 2 || offset + 1 + byteCount > bytes.length) {
    throw new LedgerError("Unsupported DER signature length", { code: "invalid-signature" });
  }
  let length = 0;
  for (let i = 0; i < byteCount; i += 1) {
    length = (length << 8) | bytes[offset + 1 + i];
  }
  return { length, offset: offset + 1 + byteCount };
}

function readDerInteger(bytes: Uint8Array, offset: number): { value: Uint8Array; offset: number } {
  if (bytes[offset] !== 0x02) {
    throw new LedgerError("Malformed DER signature integer", { code: "invalid-signature" });
  }
  const { length, offset: valueOffset } = readDerLength(bytes, offset + 1);
  const end = valueOffset + length;
  if (length === 0 || end > bytes.length) {
    throw new LedgerError("Truncated DER signature integer", { code: "invalid-signature" });
  }

  let value = bytes.subarray(valueOffset, end);
  while (value.length > 1 && value[0] === 0x00) {
    value = value.subarray(1);
  }
  if (value.length > SIGNATURE_LENGTH / 2) {
    throw new LedgerError("DER signature integer is too large", { code: "invalid-signature" });
  }

  const padded = new Uint8Array(SIGNATURE_LENGTH / 2);
  padded.set(value, padded.length - value.length);
  return { value: padded, offset: end };
}

/**
 * Convert a DER `SEQUENCE { r INTEGER, s INTEGER }` signature into the raw 64-byte
 * `r || s` form used by Ed25519 on Stellar.
 */
export function derToRawSignature(der: Uint8Array): Uint8Array {
  if (der[0] !== 0x30) {
    throw new LedgerError("Not a DER encoded signature", { code: "invalid-signature" });
  }
  const { length, offset } = readDerLength(der, 1);
  const bodyEnd = offset + length;
  if (bodyEnd > der.length) {
    throw new LedgerError("Truncated DER signature sequence", { code: "invalid-signature" });
  }

  const r = readDerInteger(der, offset);
  const s = readDerInteger(der, r.offset);
  if (s.offset > bodyEnd) {
    throw new LedgerError("DER signature length mismatch", { code: "invalid-signature" });
  }

  const raw = new Uint8Array(SIGNATURE_LENGTH);
  raw.set(r.value, 0);
  raw.set(s.value, SIGNATURE_LENGTH / 2);
  return raw;
}

/**
 * Normalise whatever the Ledger app returned into a raw 64-byte Ed25519 signature.
 */
export function parseLedgerSignature(payload: unknown): Uint8Array {
  const resolved =
    payload && typeof payload === "object" && !(payload instanceof Uint8Array)
      ? (payload as Record<string, unknown>).signature ??
        (payload as Record<string, unknown>).signatureHex ??
        (payload as Record<string, unknown>).derSignature ??
        (payload as Record<string, unknown>).hex ??
        (payload as Record<string, unknown>).base64 ??
        payload
      : payload;

  const bytes = toUint8Array(resolved, "signature");

  if (bytes.length === SIGNATURE_LENGTH) return bytes;
  if (bytes.length > SIGNATURE_LENGTH && bytes[0] === 0x30) return derToRawSignature(bytes);

  throw new LedgerError(
    `Expected a ${SIGNATURE_LENGTH}-byte Ed25519 signature, got ${bytes.length} bytes`,
    { code: "invalid-signature" },
  );
}

/**
 * Build the account record (address + hint) for a raw device public key.
 */
export function accountFromPublicKey(
  rawPublicKey: unknown,
  derivationPath: string,
): LedgerAccount {
  const key = toUint8Array(rawPublicKey, "public key");
  if (key.length !== ED25519_PUBLIC_KEY_LENGTH) {
    throw new LedgerError(
      `Expected a ${ED25519_PUBLIC_KEY_LENGTH}-byte Ed25519 public key, got ${key.length} bytes`,
      { code: "invalid-response" },
    );
  }

  const address = encodeEd25519PublicKey(key);
  return {
    address,
    publicKey: address,
    rawPublicKey: key,
    derivationPath,
  };
}

/** The 4-byte hint stamped onto the `DecoratedSignature` for an account. */
export function signatureHintOf(source: LedgerAccount | Uint8Array): Uint8Array {
  const rawPublicKey = source instanceof Uint8Array ? source : source.rawPublicKey;
  return signatureHintFor(rawPublicKey);
}
