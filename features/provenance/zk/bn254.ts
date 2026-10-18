/**
 * BN254 (a.k.a. `alt_bn128` / `bn128`) field and curve arithmetic.
 *
 * Everything here is pure `BigInt` maths with no native or WASM dependency, so
 * it runs identically in the browser, in Node, and in Jest. The verifier uses it
 * to reject malformed or off-curve proof points *before* handing anything to the
 * WASM pairing backend, which is the cheapest possible defence against a
 * malicious proof payload.
 *
 * The two constants below are the standard BN254 parameters used by Groth16
 * (`snarkjs` `curve: "bn128"`) and by Ethereum's `ecAdd` / `ecMul` /
 * `ecPairing` precompiles.
 */

/** Base field modulus `p` — coordinates must be strictly smaller than this. */
export const BN254_FIELD_MODULUS = BigInt(
  "21888242871839275222246405745257275088696311157297823662689037894645226208583",
);

/** Scalar field / group order `r` — public signals and exponents live here. */
export const BN254_GROUP_ORDER = BigInt(
  "21888242871839275222246405745257275088548364400416034343698204186575808495617",
);

/** Curve coefficient `b` for G1: `y² = x³ + 3`. */
export const BN254_G1_B = 3n;

/** G1 generator, handy for fixtures and sanity checks. */
export const BN254_G1_GENERATOR: readonly [bigint, bigint] = [1n, 2n];

/** An element of `Fp²`, represented as `c0 + c1·u` with `u² = -1`. */
export interface Fp2 {
  readonly c0: bigint;
  readonly c1: bigint;
}

/** Reduce `a` into `[0, m)`. */
export function mod(a: bigint, m: bigint = BN254_FIELD_MODULUS): bigint {
  const r = a % m;
  return r < 0n ? r + m : r;
}

/** Square-and-multiply modular exponentiation. */
export function modPow(base: bigint, exponent: bigint, m: bigint = BN254_FIELD_MODULUS): bigint {
  if (m <= 0n) throw new Error("modPow: modulus must be positive");
  if (exponent < 0n) throw new Error("modPow: negative exponents are not supported");
  let result = 1n;
  let b = mod(base, m);
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return result;
}

/** Modular inverse via the extended Euclidean algorithm. Throws for non-units. */
export function modInverse(a: bigint, m: bigint = BN254_FIELD_MODULUS): bigint {
  let [old_r, r] = [mod(a, m), m];
  let [old_s, s] = [1n, 0n];
  while (r !== 0n) {
    const q = old_r / r;
    [old_r, r] = [r, old_r - q * r];
    [old_s, s] = [s, old_s - q * s];
  }
  if (old_r !== 1n) throw new Error("modInverse: element is not invertible");
  return mod(old_s, m);
}

/** A decimal or `0x`-prefixed field element in the accepted input shape. */
export type FieldElementInput = string | number | bigint;

/** `true` when `value` parses to an integer in `[0, p)`. */
export function isFieldElement(value: unknown): boolean {
  return readFieldElement(value) !== null;
}

/**
 * Parse a field element, returning `null` instead of throwing so callers can
 * accumulate user-facing diagnostics rather than abort on the first bad value.
 */
export function readFieldElement(value: unknown): bigint | null {
  if (typeof value === "bigint") {
    return value >= 0n && value < BN254_FIELD_MODULUS ? value : null;
  }
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0) return null;
    const asBigInt = BigInt(value);
    return asBigInt < BN254_FIELD_MODULUS ? asBigInt : null;
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (!/^(0x[0-9a-fA-F]+|[0-9]+)$/.test(trimmed)) return null;
  try {
    const parsed = BigInt(trimmed);
    return parsed >= 0n && parsed < BN254_FIELD_MODULUS ? parsed : null;
  } catch {
    return null;
  }
}

/** Like {@link readFieldElement} but throws with a helpful message. */
export function toFieldElement(value: unknown, label = "value"): bigint {
  const parsed = readFieldElement(value);
  if (parsed === null) {
    throw new Error(`${label} is not a BN254 field element`);
  }
  return parsed;
}

/* -------------------------------------------------------------------------- */
/* Fp² arithmetic                                                             */
/* -------------------------------------------------------------------------- */

export const FP2_ZERO: Fp2 = { c0: 0n, c1: 0n };
export const FP2_ONE: Fp2 = { c0: 1n, c1: 0n };

export function fp2(c0: bigint, c1: bigint): Fp2 {
  return { c0: mod(c0), c1: mod(c1) };
}

export function fp2Add(a: Fp2, b: Fp2): Fp2 {
  return fp2(a.c0 + b.c0, a.c1 + b.c1);
}

export function fp2Sub(a: Fp2, b: Fp2): Fp2 {
  return fp2(a.c0 - b.c0, a.c1 - b.c1);
}

/** `(a0 + a1·u)(b0 + b1·u) = (a0b0 − a1b1) + (a0b1 + a1b0)·u`. */
export function fp2Mul(a: Fp2, b: Fp2): Fp2 {
  return fp2(
    a.c0 * b.c0 - a.c1 * b.c1,
    a.c0 * b.c1 + a.c1 * b.c0,
  );
}

export function fp2Square(a: Fp2): Fp2 {
  return fp2Mul(a, a);
}

export function fp2Neg(a: Fp2): Fp2 {
  return fp2(-a.c0, -a.c1);
}

export function fp2IsZero(a: Fp2): boolean {
  return mod(a.c0) === 0n && mod(a.c1) === 0n;
}

export function fp2Equals(a: Fp2, b: Fp2): boolean {
  return mod(a.c0) === mod(b.c0) && mod(a.c1) === mod(b.c1);
}

/** `1 / (c0 + c1·u) = (c0 − c1·u) / (c0² + c1²)`. Throws for zero. */
export function fp2Inverse(a: Fp2): Fp2 {
  const norm = mod(a.c0 * a.c0 + a.c1 * a.c1);
  if (norm === 0n) throw new Error("fp2Inverse: element is not invertible");
  const invNorm = modInverse(norm);
  return fp2(a.c0 * invNorm, -a.c1 * invNorm);
}

/* -------------------------------------------------------------------------- */
/* Curve membership                                                           */
/* -------------------------------------------------------------------------- */

/**
 * `b` coefficient of the G2 twist: `b₂ = 3 / (9 + u)`.
 *
 * On the BN254 twist the curve equation is `y² = x³ + b₂` with `b₂` in `Fp²`,
 * not the familiar `3` used on G1.
 */
export const BN254_G2_B: Fp2 = (() => {
  const ninePlusU: Fp2 = { c0: 9n, c1: 1n };
  const scaled = fp2Mul({ c0: 3n, c1: 0n }, fp2Inverse(ninePlusU));
  return fp2(scaled.c0, scaled.c1);
})();

/** Affine point over `Fp`. */
export interface G1Point {
  readonly x: bigint;
  readonly y: bigint;
}

/** Affine point over `Fp²`. */
export interface G2Point {
  readonly x: Fp2;
  readonly y: Fp2;
}

/** G2 generator as published in EIP-197. */
export const BN254_G2_GENERATOR: G2Point = {
  x: {
    c0: BigInt(
      "10857046999023057135944570762232829481370756359578518086990519993285655852781",
    ),
    c1: BigInt(
      "11559732032986387107991004021392285783925812861821192530917403151452391805634",
    ),
  },
  y: {
    c0: BigInt(
      "8495653923123431417604973247489272438418190587263600148770280649306958101930",
    ),
    c1: BigInt(
      "4082367875863433681332203403145435568316851327593401208105741076214120093531",
    ),
  },
};

/** Check `y² = x³ + 3` in `Fp` (the G1 equation). */
export function isOnG1Curve(point: G1Point): boolean {
  const { x, y } = point;
  if (x < 0n || x >= BN254_FIELD_MODULUS) return false;
  if (y < 0n || y >= BN254_FIELD_MODULUS) return false;
  return mod(y * y) === mod(x * x * x + BN254_G1_B);
}

/** Check `y² = x³ + b₂` in `Fp²` (the G2 twist equation). */
export function isOnG2Curve(point: G2Point): boolean {
  const lhs = fp2Square(point.y);
  const rhs = fp2Add(fp2Mul(fp2Square(point.x), point.x), BN254_G2_B);
  return fp2Equals(lhs, rhs);
}

/** `true` for the conventional affine identity `(0, 1)` used by snarkjs G1 points. */
export function isG1Identity(point: G1Point): boolean {
  return mod(point.x) === 0n && mod(point.y) === 1n;
}
