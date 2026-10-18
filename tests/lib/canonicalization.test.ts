import { webcrypto } from 'crypto';
import {
  canonicalize,
  canonicalJSON,
  isCanonicallyEquivalent,
  normalizeWhitespace,
  normalizeNumber,
  normalizeLegacyRecord,
  isCanonicalizable,
  getCanonicalizeError,
  jcsCanonicalize,
  canonicalJSONJCS,
  canonicalJSONBytes,
  hashCanonicalPayload,
  domainSeparatedCanonicalJSONBytes,
  hashDomainSeparatedPayload,
  JCSUnsupportedTypeError,
} from '@/lib/canonicalization';

describe('Canonicalization', () => {
  describe('normalizeWhitespace', () => {
    it('trims leading and trailing whitespace', () => {
      expect(normalizeWhitespace('  hello  ')).toBe('hello');
    });

    it('collapses multiple spaces to single space', () => {
      expect(normalizeWhitespace('hello   world')).toBe('hello world');
    });

    it('handles tabs and newlines', () => {
      expect(normalizeWhitespace('hello\t\nworld')).toBe('hello world');
    });
  });

  describe('normalizeNumber', () => {
    it('formats numbers to specified decimal places', () => {
      expect(normalizeNumber(30.123456789, 8)).toBe('30.12345679');
    });

    it('preserves whole numbers', () => {
      expect(normalizeNumber(42, 8)).toBe('42');
    });

    it('rounds correctly', () => {
      expect(normalizeNumber(1.9999999, 8)).toBe('2');
    });

    it('throws on invalid numbers', () => {
      expect(() => normalizeNumber(NaN, 8)).toThrow();
      expect(() => normalizeNumber(Infinity, 8)).toThrow();
    });
  });

  describe('canonicalize', () => {
    it('sorts object keys alphabetically', () => {
      const input = { z: 1, a: 2, m: 3 };
      const result = canonicalize(input);
      expect(Object.keys(result as any)).toEqual(['a', 'm', 'z']);
    });

    it('normalizes whitespace in strings', () => {
      const input = { name: '  John   Doe  ' };
      const result = canonicalize(input);
      expect((result as any).name).toBe('John Doe');
    });

    it('normalizes numeric precision', () => {
      const input = { amount: 30.123456789 };
      const result = canonicalize(input);
      expect((result as any).amount).toBe('30.12345679');
    });

    it('preserves null and undefined', () => {
      const input = { a: null, b: undefined };
      const result = canonicalize(input);
      expect((result as any).a).toBe(null);
      expect((result as any).b).toBe(undefined);
    });

    it('handles nested objects recursively', () => {
      const input = {
        user: { name: '  John  ', age: 30.5 },
        items: [{ id: 3, name: '  Item  ' }],
      };
      const result = canonicalize(input);
      expect((result as any).user.name).toBe('John');
      expect((result as any).user.age).toBe('30.50000000');
      expect((result as any).items[0].name).toBe('Item');
    });

    it('handles arrays recursively', () => {
      const input = [{ z: '  hello  ', a: 1 }, { z: '  world  ', a: 2 }];
      const result = canonicalize(input);
      expect((result as any)[0]).toEqual({ a: '1', z: 'hello' });
      expect((result as any)[1]).toEqual({ a: '2', z: 'world' });
    });

    it('respects custom options', () => {
      const input = { Name: 'John' };
      const result = canonicalize(input, { lowerCase: true });
      expect((result as any).Name).toBe('john');
    });

    it('handles custom decimal places', () => {
      const input = { amount: 30.123456789 };
      const result = canonicalize(input, { decimalPlaces: 2 });
      expect((result as any).amount).toBe('30.12');
    });
  });

  describe('canonicalJSON', () => {
    it('produces JSON with sorted keys', () => {
      const input1 = { z: 1, a: 2 };
      const input2 = { a: 2, z: 1 };
      expect(canonicalJSON(input1)).toBe(canonicalJSON(input2));
    });

    it('produces consistent output for equivalent data', () => {
      const data1 = { amount: 10.1 };
      const data2 = { amount: 10.10000000 };
      expect(canonicalJSON(data1)).toBe(canonicalJSON(data2));
    });

    it('includes normalized whitespace', () => {
      const input = { message: '  hello  ' };
      const json = canonicalJSON(input);
      expect(json).toContain('"hello"');
    });
  });

  describe('isCanonicallyEquivalent', () => {
    it('returns true for equivalent inputs with different key ordering', () => {
      const a = { b: 1, a: 2 };
      const b = { a: 2, b: 1 };
      expect(isCanonicallyEquivalent(a, b)).toBe(true);
    });

    it('returns true for different whitespace but same values', () => {
      const a = { name: 'John' };
      const b = { name: '  John  ' };
      expect(isCanonicallyEquivalent(a, b)).toBe(true);
    });

    it('returns false for different values', () => {
      const a = { name: 'John' };
      const b = { name: 'Jane' };
      expect(isCanonicallyEquivalent(a, b)).toBe(false);
    });

    it('returns true for equivalent numeric precision', () => {
      const a = { amount: 10.1234567 };
      const b = { amount: 10.12345670 };
      expect(isCanonicallyEquivalent(a, b)).toBe(true);
    });

    it('returns true for nested structures', () => {
      const a = { user: { name: '  John  ', age: 30 } };
      const b = { user: { name: 'John', age: 30.0 } };
      expect(isCanonicallyEquivalent(a, b)).toBe(true);
    });

    it('returns false for different nested values', () => {
      const a = { user: { name: 'John', age: 30 } };
      const b = { user: { name: 'John', age: 31 } };
      expect(isCanonicallyEquivalent(a, b)).toBe(false);
    });
  });

  describe('normalizeLegacyRecord', () => {
    it('normalizes version 1.x records', () => {
      const legacy = { version: '1.0', name: '  John  ', amount: 30.5 };
      const normalized = normalizeLegacyRecord(legacy);
      expect(normalized).toBeDefined();
      expect(normalized?.name).toBe('John');
    });

    it('removes version field from normalized records', () => {
      const legacy = { version: '1.0', name: 'John' };
      const normalized = normalizeLegacyRecord(legacy);
      expect(normalized?.version).toBeUndefined();
    });

    it('handles records without version', () => {
      const legacy = { name: '  John  ' };
      const normalized = normalizeLegacyRecord(legacy);
      expect(normalized?.name).toBe('John');
    });

    it('returns null for invalid input', () => {
      expect(normalizeLegacyRecord(null as any)).toBeNull();
      expect(normalizeLegacyRecord(undefined as any)).toBeNull();
      expect(normalizeLegacyRecord('string' as any)).toBeNull();
    });

    it('applies canonicalization to result', () => {
      const legacy = { z: 1, a: 2, name: '  John  ' };
      const normalized = normalizeLegacyRecord(legacy);
      const keys = Object.keys(normalized || {});
      expect(keys).toEqual(['a', 'name', 'z']);
    });
  });

  describe('isCanonicalizable', () => {
    it('returns true for valid inputs', () => {
      expect(isCanonicalizable({ a: 1 })).toBe(true);
      expect(isCanonicalizable('string')).toBe(true);
      expect(isCanonicalizable(42)).toBe(true);
      expect(isCanonicalizable([1, 2, 3])).toBe(true);
    });

    it('handles circular references gracefully', () => {
      const circular: any = { a: 1 };
      circular.self = circular;
      // Should not throw, but return false due to JSON.stringify limitation
      expect(isCanonicalizable(circular)).toBe(false);
    });
  });

  describe('getCanonicalizeError', () => {
    it('returns null for valid input', () => {
      expect(getCanonicalizeError({ a: 1 })).toBeNull();
    });

    it('returns error for invalid input', () => {
      const circular: any = { a: 1 };
      circular.self = circular;
      const error = getCanonicalizeError(circular);
      expect(error).toBeInstanceOf(Error);
    });
  });

  describe('Signing and Hashing Use Case', () => {
    it('produces consistent hash for equivalent payloads', () => {
      const payload1 = { amount: '100', recipient: 'alice', nonce: 1 };
      const payload2 = { nonce: 1, amount: '100', recipient: 'alice' };

      const json1 = canonicalJSON(payload1);
      const json2 = canonicalJSON(payload2);

      expect(json1).toBe(json2);
      // Both would produce same hash
      expect(Buffer.from(json1).toString('base64')).toBe(
        Buffer.from(json2).toString('base64')
      );
    });

    it('detects payload tampering via different canonical form', () => {
      const original = { amount: 100, fee: 1 };
      const tampered = { amount: 100.00001, fee: 1 };

      expect(isCanonicallyEquivalent(original, tampered)).toBe(false);
      expect(canonicalJSON(original) !== canonicalJSON(tampered)).toBe(true);
    });

    it('handles decimal precision consistently for blockchain values', () => {
      const tx1 = { amount: 10.12345678 };
      const tx2 = { amount: 10.123456780 };

      expect(isCanonicallyEquivalent(tx1, tx2)).toBe(true);
      expect(canonicalJSON(tx1)).toBe(canonicalJSON(tx2));
    });
  });

  describe('Backward Compatibility', () => {
    it('maintains compatibility with old record formats', () => {
      const oldRecord = {
        version: '1.0',
        claim_id: 'abc123',
        recipient_addr: '  GXXX...  ',
        amount_xlm: '100.5',
      };

      const normalized = normalizeLegacyRecord(oldRecord);
      expect(normalized).toBeDefined();
      expect(typeof normalized).toBe('object');
    });
  });
});

describe('RFC 8785 JSON Canonicalization Scheme (JCS)', () => {
  // Reference vector from RFC 8785 (JSON Canonicalization Scheme).
  const RFC8785_INPUT = String.raw`{"numbers":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001],"string":"€$\u000f\nA'B\"\\\\\"/","literals":[null,true,false]}`;
  const RFC8785_EXPECTED = String.raw`{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\u000f\nA'B\"\\\\\"/"}`;
  // SHA-256 of the UTF-8 bytes of RFC8785_EXPECTED.
  const RFC8785_SHA256 = '2d5e01a318d0f0879ab568c4be289c8b1f64ef8921a53c6277d5e069978baacb';

  beforeAll(() => {
    // jsdom does not implement SubtleCrypto; fall back to Node's WebCrypto.
    const g = globalThis as any;
    if (!g.crypto || !g.crypto.subtle) {
      try {
        Object.defineProperty(globalThis, 'crypto', {
          value: webcrypto,
          configurable: true,
          writable: true,
        });
      } catch {
        g.crypto = webcrypto;
      }
    }
  });

  it('matches the RFC 8785 reference test vector', () => {
    const parsed = JSON.parse(RFC8785_INPUT);
    expect(jcsCanonicalize(parsed)).toBe(RFC8785_EXPECTED);
    expect(canonicalJSONJCS(parsed)).toBe(RFC8785_EXPECTED);
  });

  it('canonicalizes empty objects and arrays without whitespace', () => {
    expect(jcsCanonicalize({})).toBe('{}');
    expect(jcsCanonicalize([])).toBe('[]');
    expect(jcsCanonicalize({ b: {}, a: [] })).toBe('{"a":[],"b":{}}');
  });

  it('sorts object keys by UTF-16 code unit order', () => {
    expect(jcsCanonicalize({ b: 1, a: 2, A: 3 })).toBe('{"A":3,"a":2,"b":1}');
    expect(jcsCanonicalize({ '10': 1, '2': 2 })).toBe('{"10":1,"2":2}');
    expect(jcsCanonicalize({ z: { d: 1, c: [3, 2, 1] }, a: null })).toBe(
      '{"a":null,"z":{"c":[3,2,1],"d":1}}'
    );
    // Key order in the input must not survive into the output.
    expect(canonicalJSONJCS({ b: 1, a: 2 })).toBe(canonicalJSONJCS({ a: 2, b: 1 }));
  });

  it('formats numbers with ECMAScript Number::toString semantics', () => {
    expect(jcsCanonicalize(333333333.33333329)).toBe('333333333.3333333');
    expect(jcsCanonicalize(1e30)).toBe('1e+30');
    expect(jcsCanonicalize(4.5)).toBe('4.5');
    expect(jcsCanonicalize(2e-3)).toBe('0.002');
    expect(jcsCanonicalize(1e-27)).toBe('1e-27');
    expect(jcsCanonicalize(-0)).toBe('0');
    expect(jcsCanonicalize(100)).toBe('100');
  });

  it('escapes strings using only the RFC 8785 escape sequences', () => {
    expect(jcsCanonicalize('a"b\\c')).toBe('"a\\"b\\\\c"');
    expect(jcsCanonicalize('\b\t\n\f\r')).toBe('"\\b\\t\\n\\f\\r"');
    expect(jcsCanonicalize('\u000f')).toBe('"\\u000f"');
    expect(jcsCanonicalize('€')).toBe('"€"');
    expect(jcsCanonicalize('😀')).toBe('"😀"');
  });

  it('escapes lone surrogates so the output is well-formed', () => {
    expect(jcsCanonicalize('\ud800')).toBe('"\\ud800"');
    expect(jcsCanonicalize('a\udc00b')).toBe('"a\\udc00b"');
  });

  it('rejects values that have no JSON representation', () => {
    expect(() => jcsCanonicalize(undefined)).toThrow(JCSUnsupportedTypeError);
    expect(() => jcsCanonicalize(NaN)).toThrow(JCSUnsupportedTypeError);
    expect(() => jcsCanonicalize(Infinity)).toThrow(JCSUnsupportedTypeError);
    expect(() => jcsCanonicalize(-Infinity)).toThrow(JCSUnsupportedTypeError);
    expect(() => jcsCanonicalize({ a: undefined })).toThrow(JCSUnsupportedTypeError);
    expect(() => jcsCanonicalize(() => 1)).toThrow(JCSUnsupportedTypeError);

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => jcsCanonicalize(circular)).toThrow(JCSUnsupportedTypeError);
  });

  it('normalises unicode to NFC only when requested', () => {
    const decomposed = 'e\u0301';
    expect(jcsCanonicalize(decomposed)).toBe('"e\u0301"');
    expect(jcsCanonicalize(decomposed, { unicodeNormalization: 'NFC' })).toBe('"é"');
  });

  it('produces byte-identical UTF-8 output', () => {
    const parsed = JSON.parse(RFC8785_INPUT);
    expect(Array.from(canonicalJSONBytes(parsed))).toEqual(
      Array.from(new TextEncoder().encode(RFC8785_EXPECTED))
    );
    // '"€"' is two ASCII quotes plus the three UTF-8 bytes of U+20AC.
    expect(canonicalJSONBytes('€')).toEqual(new Uint8Array([0x22, 0xe2, 0x82, 0xac, 0x22]));
  });

  it('derives identical SHA-256 hashes regardless of key order', async () => {
    const first = await hashCanonicalPayload({ recipient: 'alice', amount: '100', nonce: 1 });
    const second = await hashCanonicalPayload({ nonce: 1, amount: '100', recipient: 'alice' });

    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hashes the canonical UTF-8 bytes of the RFC 8785 vector', async () => {
    const digest = await hashCanonicalPayload(JSON.parse(RFC8785_INPUT));
    expect(digest).toBe(RFC8785_SHA256);
  });

  it('separates signed payload bytes and hashes by versioned domain', async () => {
    const first = domainSeparatedCanonicalJSONBytes('trellis.payment.v1', { b: 2, a: 1 });
    const reordered = domainSeparatedCanonicalJSONBytes('trellis.payment.v1', { a: 1, b: 2 });
    const otherDomain = domainSeparatedCanonicalJSONBytes('trellis.session.v1', { a: 1, b: 2 });

    expect(first).toEqual(reordered);
    expect(first).not.toEqual(otherDomain);
    await expect(hashDomainSeparatedPayload('trellis.payment.v1', { a: 1, b: 2 }))
      .resolves.toMatch(/^[0-9a-f]{64}$/);
    const paymentHash = await hashDomainSeparatedPayload('trellis.payment.v1', { a: 1, b: 2 });
    const sessionHash = await hashDomainSeparatedPayload('trellis.session.v1', { a: 1, b: 2 });
    expect(paymentHash).not.toBe(sessionHash);
  });

  it('rejects ambiguous or unversioned payload domains', () => {
    expect(() => domainSeparatedCanonicalJSONBytes('', {})).toThrow(/domain/i);
    expect(() => domainSeparatedCanonicalJSONBytes('Trellis.Payment', {})).toThrow(/domain/i);
    expect(() => domainSeparatedCanonicalJSONBytes('trellis\0payment', {})).toThrow(/domain/i);
  });

  it('produces different hashes for different payloads', async () => {
    const first = await hashCanonicalPayload({ amount: 100, fee: 1 });
    const second = await hashCanonicalPayload({ amount: 100.00001, fee: 1 });
    expect(first).not.toBe(second);
  });
});
