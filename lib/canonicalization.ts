/**
 * Canonicalization and Input Normalization Utilities
 *
 * Ensures signed, hashed, or externally referenced payloads produce
 * consistent canonical representations across equivalent input.
 *
 * Implements normalization rules for:
 * - String ordering and whitespace
 * - Numeric precision and formatting
 * - Case sensitivity
 * - Legacy record compatibility
 */

export interface CanonicalizeOptions {
  /** Sort object keys alphabetically */
  sortKeys?: boolean;
  /** Normalize whitespace (trim and single spaces) */
  normalizeWhitespace?: boolean;
  /** Convert numeric strings to numbers */
  normalizeNumbers?: boolean;
  /** Lowercase string values */
  lowerCase?: boolean;
  /** Precision for decimal numbers */
  decimalPlaces?: number;
  /** Transform nested objects recursively */
  recursive?: boolean;
}

const DEFAULT_OPTIONS: CanonicalizeOptions = {
  sortKeys: true,
  normalizeWhitespace: true,
  normalizeNumbers: true,
  lowerCase: false,
  decimalPlaces: 8,
  recursive: true,
};

/**
 * Normalize whitespace in strings (trim and single internal spaces)
 */
export function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

/**
 * Normalize numeric precision for consistent comparison and hashing
 */
export function normalizeNumber(value: number, decimalPlaces: number = 8): string {
  // Handle edge cases
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid numeric value: ${value}`);
  }

  // Convert to fixed decimal places
  const normalized = Number(value.toFixed(decimalPlaces));

  // Return string representation to preserve precision
  return normalized.toString();
}

/**
 * Canonicalize a single value based on options
 */
function canonicalizeValue(
  value: unknown,
  options: CanonicalizeOptions = DEFAULT_OPTIONS
): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'string') {
    let result = value;
    if (options.normalizeWhitespace) {
      result = normalizeWhitespace(result);
    }
    if (options.lowerCase) {
      result = result.toLowerCase();
    }
    return result;
  }

  if (typeof value === 'number') {
    if (options.normalizeNumbers) {
      return normalizeNumber(value, options.decimalPlaces);
    }
    return value;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  if (Array.isArray(value)) {
    if (options.recursive) {
      return value.map(item => canonicalizeValue(item, options));
    }
    return value;
  }

  if (typeof value === 'object') {
    if (options.recursive) {
      return canonicalizeObject(value as Record<string, unknown>, options);
    }
    return value;
  }

  return value;
}

/**
 * Canonicalize an object with sorting, normalization, and recursion
 */
function canonicalizeObject(
  obj: Record<string, unknown>,
  options: CanonicalizeOptions = DEFAULT_OPTIONS
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  // Get keys and sort if requested
  const keys = Object.keys(obj);
  const sortedKeys = options.sortKeys ? keys.sort() : keys;

  for (const key of sortedKeys) {
    const value = obj[key];
    result[key] = canonicalizeValue(value, options);
  }

  return result;
}

/**
 * Canonicalize input for signing/hashing
 *
 * Produces consistent canonical form for equivalent logical data.
 * Safe for use with JSON.stringify before signing/hashing.
 *
 * @example
 * ```typescript
 * const data = { name: "John", age: 30.1234567 };
 * const canonical = canonicalize(data);
 * // { age: "30.12345670", name: "John" }
 *
 * const stringified = JSON.stringify(canonical);
 * // Produces consistent hash regardless of input key order
 * ```
 */
export function canonicalize(
  input: unknown,
  options: Partial<CanonicalizeOptions> = {}
): unknown {
  const mergedOptions = { ...DEFAULT_OPTIONS, ...options };

  if (Array.isArray(input)) {
    if (mergedOptions.recursive) {
      return input.map(item => canonicalizeValue(item, mergedOptions));
    }
    return input;
  }

  if (typeof input === 'object' && input !== null) {
    return canonicalizeObject(input as Record<string, unknown>, mergedOptions);
  }

  return canonicalizeValue(input, mergedOptions);
}

/**
 * Create a canonical JSON string suitable for signing/hashing
 *
 * @example
 * ```typescript
 * const signature = sign(canonicalJSON(data));
 * // Always produces same JSON string for equivalent data
 * ```
 */
export function canonicalJSON(input: unknown, options: Partial<CanonicalizeOptions> = {}): string {
  const canonical = canonicalize(input, options);
  return JSON.stringify(canonical);
}

/**
 * Verify that two inputs produce the same canonical form
 *
 * @returns true if inputs are canonically equivalent
 * @example
 * ```typescript
 * const a = { b: 1, a: 2 };
 * const b = { a: 2, b: 1 };
 * isCanonicallyEquivalent(a, b); // true
 * ```
 */
export function isCanonicallyEquivalent(
  input1: unknown,
  input2: unknown,
  options: Partial<CanonicalizeOptions> = {}
): boolean {
  try {
    return canonicalJSON(input1, options) === canonicalJSON(input2, options);
  } catch {
    return false;
  }
}

/**
 * Handle legacy record normalization for compatibility
 *
 * Transforms old record formats to current canonical form.
 * Supports gradual migration from non-canonical data.
 */
export interface LegacyRecord {
  version?: string | number;
  [key: string]: unknown;
}

/**
 * Normalize a legacy record to current schema
 *
 * Returns normalized record or null if format is unsupported.
 */
export function normalizeLegacyRecord(
  record: LegacyRecord,
  options: Partial<CanonicalizeOptions> = {}
): Record<string, unknown> | null {
  if (!record || typeof record !== 'object') {
    return null;
  }

  // Determine version and apply compatibility transforms
  const version = record.version || '1.0';

  let normalized = { ...record };

  // Version 1.x → 2.x compatibility transforms
  if (typeof version === 'string' && version.startsWith('1.')) {
    // Example legacy transforms:
    // - Remove deprecated fields
    // - Rename fields
    // - Convert data types
    const { version: _, ...withoutVersion } = normalized;
    normalized = withoutVersion;
  }

  // Apply canonicalization
  const canonical = canonicalize(normalized, options);

  return typeof canonical === 'object' && canonical !== null
    ? (canonical as Record<string, unknown>)
    : null;
}

/**
 * Validate that input can be canonicalized without errors
 */
export function isCanonicalizable(input: unknown): boolean {
  try {
    canonicalize(input);
    return true;
  } catch {
    return false;
  }
}

/**
 * Extract canonicalization errors from problematic input
 */
export function getCanonicalizeError(input: unknown): Error | null {
  try {
    canonicalize(input);
    return null;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

/* -------------------------------------------------------------------------- *
 * RFC 8785 JSON Canonicalization Scheme (JCS)
 *
 * The helpers above deliberately keep their historical, lenient behaviour
 * (trimming strings, rounding numbers to a fixed precision, ...). The
 * implementation below is the strict, standards-compliant counterpart that
 * cryptographic signing requires: identical data always produces identical
 * bytes, across every client architecture and browser runtime.
 *
 * Reference: https://www.rfc-editor.org/rfc/rfc8785
 * -------------------------------------------------------------------------- */

/** Options accepted by the RFC 8785 canonical encoders. */
export interface JCSCanonicalizeOptions {
  /**
   * When set to `"NFC"`, object keys and string values are Unicode-normalised
   * to Normalization Form C before serialization. RFC 8785 does not normalise
   * Unicode, so this defaults to `false`; enabling it makes payloads resilient
   * to canonically equivalent characters produced by different clients.
   */
  unicodeNormalization?: 'NFC' | false;
}

/**
 * Thrown when a value has no RFC 8785 representation, for example
 * `undefined`, functions, symbols, `NaN`, `Infinity` or circular structures.
 */
export class JCSUnsupportedTypeError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = 'JCSUnsupportedTypeError';
  }
}

function jcsNormalizeString(value: string, enabled: boolean): string {
  return enabled ? value.normalize('NFC') : value;
}

/**
 * Serialize a finite number using ECMAScript `Number::toString`, which is the
 * algorithm RFC 8785 section 3.2.2.3 mandates (no trailing zeros, lowercase
 * exponent, `-0` rendered as `0`).
 */
function jcsSerializeNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new JCSUnsupportedTypeError(
      `RFC 8785 JCS cannot serialize a non-finite number: ${String(value)}`
    );
  }
  return String(value);
}

/**
 * Serialize a JSON string per RFC 8785 section 3.2.2.2: only the shortest
 * required escape sequences, every other code point emitted as-is, and lone
 * surrogates escaped as `\uXXXX` so the output is always well-formed UTF-8.
 */
function jcsSerializeString(value: string): string {
  let result = '"';
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);

    if (code === 0x22) {
      result += '\\"';
      continue;
    }
    if (code === 0x5c) {
      result += '\\\\';
      continue;
    }
    if (code === 0x08) {
      result += '\\b';
      continue;
    }
    if (code === 0x09) {
      result += '\\t';
      continue;
    }
    if (code === 0x0a) {
      result += '\\n';
      continue;
    }
    if (code === 0x0c) {
      result += '\\f';
      continue;
    }
    if (code === 0x0d) {
      result += '\\r';
      continue;
    }
    if (code < 0x20) {
      result += `\\u${code.toString(16).padStart(4, '0')}`;
      continue;
    }
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        result += value[i] + value[i + 1];
        i += 1;
      } else {
        result += `\\u${code.toString(16).padStart(4, '0')}`;
      }
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      result += `\\u${code.toString(16).padStart(4, '0')}`;
      continue;
    }
    result += value[i];
  }
  return `${result}"`;
}

function jcsSerializeValue(
  value: unknown,
  normalizeUnicode: boolean,
  stack: Set<object>
): string {
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (typeof value === 'number') {
    return jcsSerializeNumber(value);
  }
  if (typeof value === 'string') {
    return jcsSerializeString(jcsNormalizeString(value, normalizeUnicode));
  }
  if (typeof value !== 'object') {
    throw new JCSUnsupportedTypeError(
      `RFC 8785 JCS cannot serialize a value of type "${typeof value}"`
    );
  }

  if (Array.isArray(value)) {
    if (stack.has(value)) {
      throw new JCSUnsupportedTypeError('RFC 8785 JCS cannot serialize circular structures');
    }
    stack.add(value);
    const items = value.map(item => jcsSerializeValue(item, normalizeUnicode, stack));
    stack.delete(value);
    return `[${items.join(',')}]`;
  }

  const record = value as Record<string, unknown>;
  if (stack.has(record)) {
    throw new JCSUnsupportedTypeError('RFC 8785 JCS cannot serialize circular structures');
  }
  stack.add(record);

  // RFC 8785 section 3.2.3: properties are sorted by their UTF-16 code units.
  // A comparator using `<` / `>` performs exactly that comparison.
  const members = Object.keys(record).map(key => ({
    key: jcsNormalizeString(key, normalizeUnicode),
    value: record[key],
  }));
  members.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const serialized: string[] = [];
  for (let i = 0; i < members.length; i += 1) {
    if (i > 0 && members[i].key === members[i - 1].key) {
      throw new JCSUnsupportedTypeError(
        `RFC 8785 JCS key collision after Unicode normalisation: "${members[i].key}"`
      );
    }
    serialized.push(
      `${jcsSerializeString(members[i].key)}:${jcsSerializeValue(
        members[i].value,
        normalizeUnicode,
        stack
      )}`
    );
  }

  stack.delete(record);
  return `{${serialized.join(',')}}`;
}

/**
 * RFC 8785 JSON Canonicalization Scheme encoder.
 *
 * Produces the canonical JSON text for any JSON-compatible value: object keys
 * sorted by UTF-16 code units, no insignificant whitespace, ECMAScript number
 * formatting and minimal string escaping. Identical logical data always maps
 * to a byte-identical string, so it is safe to hash or sign directly.
 *
 * Throws {@link JCSUnsupportedTypeError} for values JSON cannot represent.
 *
 * @example
 * ```typescript
 * jcsCanonicalize({ b: 1, a: [true, null] }); // '{"a":[true,null],"b":1}'
 * ```
 */
export function jcsCanonicalize(
  input: unknown,
  options: JCSCanonicalizeOptions = {}
): string {
  return jcsSerializeValue(input, options.unicodeNormalization === 'NFC', new Set<object>());
}

/**
 * Alias of {@link jcsCanonicalize} that mirrors the naming of
 * {@link canonicalJSON} for call sites that prefer the `canonicalJSON*` family.
 */
export function canonicalJSONJCS(
  input: unknown,
  options: JCSCanonicalizeOptions = {}
): string {
  return jcsCanonicalize(input, options);
}

/**
 * Encode a value to its RFC 8785 canonical UTF-8 bytes, ready to be hashed or
 * handed to a signing routine.
 */
export function canonicalJSONBytes(
  input: unknown,
  options: JCSCanonicalizeOptions = {}
): Uint8Array {
  return new TextEncoder().encode(jcsCanonicalize(input, options));
}

/**
 * Encode canonical payload bytes with an explicit protocol/domain prefix.
 *
 * Reusing the same JSON payload for two different signatures or replay
 * domains must not produce the same signed bytes. Include a versioned domain
 * such as `trellis.payment.v1` at the call site; the prefix is unambiguous and
 * the JSON body remains RFC 8785 canonical.
 */
export function domainSeparatedCanonicalJSONBytes(
  domain: string,
  input: unknown,
  options: JCSCanonicalizeOptions = {}
): Uint8Array {
  if (!/^[a-z0-9][a-z0-9._:/-]{0,127}$/.test(domain)) {
    throw new Error('Canonical payload domain must be a non-empty lowercase ASCII identifier (max 128 characters)');
  }

  const encoder = new TextEncoder();
  const prefix = encoder.encode(`trellis-signed-payload\0${domain}\0`);
  const body = canonicalJSONBytes(input, options);
  const result = new Uint8Array(prefix.length + body.length);
  result.set(prefix, 0);
  result.set(body, prefix.length);
  return result;
}

function getSubtleCrypto(): SubtleCrypto {
  const webcrypto = globalThis.crypto;
  if (webcrypto && webcrypto.subtle) {
    return webcrypto.subtle;
  }
  throw new Error(
    'hashCanonicalPayload requires WebCrypto SubtleCrypto, which is unavailable in this runtime'
  );
}

/**
 * Produce a deterministic payload hash for wallet signing.
 *
 * The payload is canonicalized with RFC 8785, UTF-8 encoded, then hashed with
 * SHA-256 via `crypto.subtle`. The returned value is a lowercase hexadecimal
 * digest.
 *
 * @example
 * ```typescript
 * const digest = await hashCanonicalPayload({ amount: '100', to: 'G...' });
 * ```
 */
export async function hashCanonicalPayload(
  payload: unknown,
  options: JCSCanonicalizeOptions = {}
): Promise<string> {
  const bytes = canonicalJSONBytes(payload, options);
  const digest = await getSubtleCrypto().digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

/** SHA-256 digest for a versioned, domain-separated canonical payload. */
export async function hashDomainSeparatedPayload(
  domain: string,
  payload: unknown,
  options: JCSCanonicalizeOptions = {}
): Promise<string> {
  const digest = await getSubtleCrypto().digest(
    'SHA-256',
    domainSeparatedCanonicalJSONBytes(domain, payload, options),
  );
  return Array.from(new Uint8Array(digest))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}
