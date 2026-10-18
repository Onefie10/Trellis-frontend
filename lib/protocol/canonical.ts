/**
 * Canonical serialization shared by the protocol safety modules.
 *
 * Fingerprints must not depend on object key order, whitespace, or the
 * machine that produced them, so every fingerprint in `lib/protocol/` is taken
 * over this one stable encoding. Receipts additionally hash it with SHA-256
 * (via `lib/canonicalization.ts`); the preflight request id only needs a
 * stable short tag, for which FNV-1a is enough.
 */

/** Depth-first stable JSON: object keys sorted, `undefined` values dropped. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([k, v]) => [k, sortKeys(v)]));
  }
  return value;
}

/** Deterministic 64-bit-ish FNV-1a tag, hex-encoded (not cryptographic). */
export function shortFingerprint(value: unknown): string {
  const input = stableStringify(value);
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  // Two passes give 16 hex chars — enough to stay collision-free for the
  // request-tag use case while staying synchronous and dependency-free.
  let hash2 = 0x811c9dc5;
  for (let i = input.length - 1; i >= 0; i -= 1) {
    hash2 ^= input.charCodeAt(i);
    hash2 = Math.imul(hash2, 0x01000193) >>> 0;
  }
  return `${hash.toString(16).padStart(8, '0')}${hash2.toString(16).padStart(8, '0')}`;
}
