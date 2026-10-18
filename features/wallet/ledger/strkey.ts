/**
 * Minimal StrKey (Stellar address) codec for Ed25519 public keys.
 *
 * The Ledger adapter needs to turn the raw 32-byte Ed25519 public key returned by
 * the device into the `G...` address the rest of the app speaks, and it must do so
 * without pulling `@stellar/stellar-sdk` (and its Buffer/polyfill surface) into the
 * wallet chunk. The implementation below is the same base32 + CRC16-XModem scheme
 * used by Stellar Core, so addresses produced here are byte-identical to
 * `StrKey.encodeEd25519PublicKey`.
 */

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Version byte for an Ed25519 public key, i.e. `(6 << 3)`, which renders as `G`. */
export const ED25519_PUBLIC_KEY_VERSION = 6 << 3;

/** Length, in bytes, of a raw Ed25519 public key. */
export const ED25519_PUBLIC_KEY_LENGTH = 32;

/** CRC16-XModem checksum, as required by the StrKey specification. */
export function crc16xmodem(bytes: Uint8Array): number {
  let crc = 0x0000;
  for (let i = 0; i < bytes.length; i += 1) {
    crc ^= bytes[i] << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc & 0xffff;
}

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (let i = 0; i < bytes.length; i += 1) {
    value = (value << 8) | bytes[i];
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

export function base32Decode(input: string): Uint8Array {
  const normalized = input.replace(/=+$/, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const output: number[] = [];
  for (let i = 0; i < normalized.length; i += 1) {
    const index = BASE32_ALPHABET.indexOf(normalized[i]);
    if (index === -1) {
      throw new Error(`Invalid base32 character "${normalized[i]}"`);
    }
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(output);
}

/**
 * Encode a raw 32-byte Ed25519 public key as a `G...` Stellar address.
 */
export function encodeEd25519PublicKey(rawPublicKey: Uint8Array): string {
  if (rawPublicKey.length !== ED25519_PUBLIC_KEY_LENGTH) {
    throw new Error(
      `Expected a ${ED25519_PUBLIC_KEY_LENGTH}-byte Ed25519 public key, got ${rawPublicKey.length} bytes`,
    );
  }

  const payload = new Uint8Array(1 + rawPublicKey.length + 2);
  payload[0] = ED25519_PUBLIC_KEY_VERSION;
  payload.set(rawPublicKey, 1);
  const checksum = crc16xmodem(payload.subarray(0, 1 + rawPublicKey.length));
  payload[1 + rawPublicKey.length] = checksum & 0xff;
  payload[1 + rawPublicKey.length + 1] = (checksum >> 8) & 0xff;

  return base32Encode(payload);
}

/**
 * Decode a `G...` Stellar address back into its raw 32-byte Ed25519 public key.
 */
export function decodeEd25519PublicKey(address: string): Uint8Array {
  const decoded = base32Decode(address);
  if (decoded.length !== 1 + ED25519_PUBLIC_KEY_LENGTH + 2) {
    throw new Error(`Invalid Stellar address length (${address.length} characters)`);
  }
  if (decoded[0] !== ED25519_PUBLIC_KEY_VERSION) {
    throw new Error("Invalid Stellar address version byte");
  }

  const payload = decoded.subarray(0, decoded.length - 2);
  const expected = decoded[decoded.length - 2] | (decoded[decoded.length - 1] << 8);
  if (crc16xmodem(payload) !== expected) {
    throw new Error("Invalid Stellar address checksum");
  }

  return decoded.subarray(1, 1 + ED25519_PUBLIC_KEY_LENGTH);
}

export function isValidEd25519PublicKey(address: string): boolean {
  try {
    decodeEd25519PublicKey(address);
    return true;
  } catch {
    return false;
  }
}

/**
 * Signature hint used by `DecoratedSignature`: the last 4 bytes of the public key.
 */
export function signatureHintFor(rawPublicKey: Uint8Array): Uint8Array {
  if (rawPublicKey.length !== ED25519_PUBLIC_KEY_LENGTH) {
    throw new Error(
      `Expected a ${ED25519_PUBLIC_KEY_LENGTH}-byte Ed25519 public key, got ${rawPublicKey.length} bytes`,
    );
  }
  return rawPublicKey.slice(rawPublicKey.length - 4);
}
