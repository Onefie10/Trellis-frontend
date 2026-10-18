/**
 * Client-side Groth16 verification pipeline for agent execution attestations.
 *
 * The verifier runs in two stages:
 *
 * 1. **Local, synchronous hardening** (this module, no dependencies): the proof
 *    envelope, every field element range, the verification-key shape and the
 *    on-curve membership of all six points are checked with `BigInt` maths from
 *    `./bn254`. A malicious or corrupted payload is rejected here, before a
 *    single byte reaches the WASM pairing backend.
 * 2. **Pairing equation** (optional, async): `groth16.verify` from `snarkjs` is
 *    loaded lazily so it never lands in the initial bundle. When it cannot be
 *    loaded the result is reported as `unverifiable` — the UI must never show a
 *    green badge for a proof whose pairing equation was not actually evaluated.
 */

import {
  BN254_GROUP_ORDER,
  isFieldElement,
  isOnG1Curve,
  isOnG2Curve,
  mod,
  readFieldElement,
  type G1Point,
  type G2Point,
} from "./bn254";
import type {
  AgentExecutionAttestation,
  G1Json,
  G2Json,
  Groth16Proof,
  Groth16VerificationKey,
  PairingBackend,
  ZkCheck,
  ZkCheckId,
  ZkVerificationResult,
  ZkVerificationSummary,
  ZkVerifierOptions,
} from "./types";

/* -------------------------------------------------------------------------- */
/* Shape readers                                                              */
/* -------------------------------------------------------------------------- */

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTuple(value: unknown, length: number): value is unknown[] {
  return Array.isArray(value) && value.length === length;
}

/** Read a `[x, y, "1"]` G1 triple without throwing. */
function readG1(value: unknown, label: string, errors: string[]): G1Point | null {
  if (!isTuple(value, 3)) {
    errors.push(`${label} must be a 3-element G1 tuple`);
    return null;
  }
  const [x, y, z] = value as [unknown, unknown, unknown];
  const parsedX = readFieldElement(x);
  const parsedY = readFieldElement(y);
  if (parsedX === null || parsedY === null) {
    errors.push(`${label} has a coordinate outside the BN254 field`);
    return null;
  }
  if (z !== "1") {
    errors.push(`${label} must use the affine form with z = "1"`);
    return null;
  }
  return { x: parsedX, y: parsedY };
}

/** Read a `[[x0, x1], [y0, y1], "1"]` G2 triple without throwing. */
function readG2(value: unknown, label: string, errors: string[]): G2Point | null {
  if (!isTuple(value, 3)) {
    errors.push(`${label} must be a 3-element G2 tuple`);
    return null;
  }
  const [rawX, rawY, z] = value as [unknown, unknown, unknown];
  if (!isTuple(rawX, 2) || !isTuple(rawY, 2)) {
    errors.push(`${label} must use Fp² coordinates`);
    return null;
  }
  const cx0 = readFieldElement(rawX[0]);
  const cx1 = readFieldElement(rawX[1]);
  const cy0 = readFieldElement(rawY[0]);
  const cy1 = readFieldElement(rawY[1]);
  if (cx0 === null || cx1 === null || cy0 === null || cy1 === null) {
    errors.push(`${label} has a coordinate outside the BN254 field`);
    return null;
  }
  if (z !== "1") {
    errors.push(`${label} must use the affine form with z = "1"`);
    return null;
  }
  return { x: { c0: cx0, c1: cx1 }, y: { c0: cy0, c1: cy1 } };
}

/* -------------------------------------------------------------------------- */
/* Checks                                                                     */
/* -------------------------------------------------------------------------- */

function check(
  id: ZkCheckId,
  label: string,
  passed: boolean,
  detail: string,
): ZkCheck {
  return { id, label, passed, detail };
}

/** Stage 1a — the JSON envelope matches the Groth16 shape we expect. */
function checkEnvelope(
  proof: unknown,
  vkey: unknown,
  publicSignals: unknown,
): { checks: ZkCheck[]; errors: string[]; proof: Groth16Proof | null; vkey: Groth16VerificationKey | null; signals: string[] | null } {
  const errors: string[] = [];

  if (!isObject(proof)) {
    return {
      checks: [check("envelope", "Proof envelope", false, "proof is not an object")],
      errors: ["proof is not an object"],
      proof: null,
      vkey: null,
      signals: null,
    };
  }
  if (!isObject(vkey)) {
    return {
      checks: [check("envelope", "Proof envelope", false, "verification key is not an object")],
      errors: ["verification key is not an object"],
      proof: null,
      vkey: null,
      signals: null,
    };
  }

  const protocol = String(proof.protocol ?? "");
  const curve = String(proof.curve ?? "");
  if (protocol !== "groth16") errors.push(`unsupported proof protocol "${protocol}"`);
  if (curve !== "bn128") errors.push(`unsupported curve "${curve}"`);

  const keyProtocol = String(vkey.protocol ?? "");
  const keyCurve = String(vkey.curve ?? "");
  if (keyProtocol !== "groth16") errors.push(`unsupported verification-key protocol "${keyProtocol}"`);
  if (keyCurve !== "bn128") errors.push(`unsupported verification-key curve "${keyCurve}"`);

  const nPublicRaw = vkey.nPublic;
  const nPublic =
    typeof nPublicRaw === "number" && Number.isInteger(nPublicRaw) && nPublicRaw >= 0
      ? nPublicRaw
      : null;
  if (nPublic === null) errors.push("verification key is missing a non-negative integer nPublic");

  const ic = vkey.IC;
  if (!Array.isArray(ic)) {
    errors.push("verification key is missing the IC point list");
  } else if (nPublic !== null && ic.length !== nPublic + 1) {
    errors.push(`IC must hold nPublic + 1 = ${nPublic + 1} points, found ${ic.length}`);
  }

  let signals: string[] | null = null;
  if (!Array.isArray(publicSignals)) {
    errors.push("publicSignals must be an array");
  } else {
    signals = publicSignals.map((entry) => String(entry));
    if (nPublic !== null && publicSignals.length !== nPublic) {
      errors.push(
        `expected ${nPublic} public signal(s) for this circuit, found ${publicSignals.length}`,
      );
    }
  }

  const checks = [
    check(
      "envelope",
      "Proof envelope",
      errors.length === 0,
      errors.length === 0
        ? `groth16 / bn128 envelope with ${nPublic ?? "?"} public input(s)`
        : errors.join("; "),
    ),
  ];

  return {
    checks,
    errors,
    proof: protocol && curve ? (proof as unknown as Groth16Proof) : null,
    vkey: nPublic !== null ? (vkey as unknown as Groth16VerificationKey) : null,
    signals,
  };
}

/** Stage 1b — every serialised number is a scalar in `[0, r)`. */
function checkPublicSignals(signals: string[] | null): ZkCheck {
  if (!signals) {
    return check("public-signals", "Public signals", false, "public signals are missing");
  }
  const invalid = signals.filter((value) => {
    const parsed = readFieldElement(value);
    if (parsed === null) return true;
    return parsed >= BN254_GROUP_ORDER;
  });
  return check(
    "public-signals",
    "Public signals",
    invalid.length === 0,
    invalid.length === 0
      ? `${signals.length} signal(s) reduced into the BN254 scalar field`
      : `${invalid.length} signal(s) are not BN254 scalars: ${invalid.slice(0, 3).join(", ")}`,
  );
}

/** Stage 1c — coordinates are canonically reduced (`0 <= x < p`). */
function checkFieldRange(proof: Groth16Proof | null, vkey: Groth16VerificationKey | null): ZkCheck {
  const offenders: string[] = [];
  const probe = (value: unknown, label: string) => {
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") {
      offenders.push(label);
      return;
    }
    if (!isFieldElement(value)) offenders.push(label);
  };
  if (proof) {
    probe(proof.pi_a?.[0], "pi_a.x");
    probe(proof.pi_a?.[1], "pi_a.y");
    probe(proof.pi_c?.[0], "pi_c.x");
    probe(proof.pi_c?.[1], "pi_c.y");
    for (const [axis, pair] of [["x", proof.pi_b?.[0]], ["y", proof.pi_b?.[1]]] as const) {
      if (!Array.isArray(pair)) {
        offenders.push(`pi_b.${axis}`);
        continue;
      }
      probe(pair[0], `pi_b.${axis}.c0`);
      probe(pair[1], `pi_b.${axis}.c1`);
    }
  }
  if (vkey) {
    for (const name of ["vk_alpha_1"] as const) {
      const point = vkey[name] as G1Json | undefined;
      if (!Array.isArray(point)) {
        offenders.push(name);
        continue;
      }
      probe(point[0], `${name}.x`);
      probe(point[1], `${name}.y`);
    }
    for (const name of ["vk_beta_2", "vk_gamma_2", "vk_delta_2"] as const) {
      const point = vkey[name] as G2Json | undefined;
      if (!Array.isArray(point)) {
        offenders.push(name);
        continue;
      }
      const [x, y] = point as unknown as [[unknown, unknown], [unknown, unknown], unknown];
      for (const [axis, pair] of [["x", x], ["y", y]] as const) {
        if (!Array.isArray(pair)) {
          offenders.push(`${name}.${axis}`);
          continue;
        }
        probe(pair[0], `${name}.${axis}.c0`);
        probe(pair[1], `${name}.${axis}.c1`);
      }
    }
    if (Array.isArray(vkey.IC)) {
      vkey.IC.forEach((point, index) => {
        if (!Array.isArray(point)) {
          offenders.push(`IC[${index}]`);
          return;
        }
        probe(point[0], `IC[${index}].x`);
        probe(point[1], `IC[${index}].y`);
      });
    }
  }

  return check(
    "field-range",
    "Field range",
    offenders.length === 0,
    offenders.length === 0
      ? "every coordinate is canonically reduced modulo p"
      : `out-of-range or non-numeric values: ${offenders.slice(0, 4).join(", ")}`,
  );
}

/** Stage 1d — all six points lie on G1 / G2 respectively. */
function checkCurveMembership(
  proof: Groth16Proof | null,
  vkey: Groth16VerificationKey | null,
): ZkCheck {
  if (!proof || !vkey) {
    return check("curve-membership", "Curve membership", false, "points could not be parsed");
  }

  const errors: string[] = [];
  const g1 = (value: unknown, label: string) => {
    const point = readG1(value, label, errors);
    if (point && !isOnG1Curve(point)) errors.push(`${label} is not on the BN254 G1 curve`);
  };
  const g2 = (value: unknown, label: string) => {
    const point = readG2(value, label, errors);
    if (point && !isOnG2Curve(point)) errors.push(`${label} is not on the BN254 G2 curve`);
  };

  g1(proof.pi_a, "pi_a");
  g1(proof.pi_c, "pi_c");
  g2(proof.pi_b, "pi_b");
  g1(vkey.vk_alpha_1, "vk_alpha_1");
  g2(vkey.vk_beta_2, "vk_beta_2");
  g2(vkey.vk_gamma_2, "vk_gamma_2");
  g2(vkey.vk_delta_2, "vk_delta_2");
  if (Array.isArray(vkey.IC)) {
    vkey.IC.forEach((point, index) => g1(point, `IC[${index}]`));
  }

  return check(
    "curve-membership",
    "Curve membership",
    errors.length === 0,
    errors.length === 0
      ? "pi_a, pi_c, all IC points, vk_alpha_1 on G1; pi_b and the G2 key points on G2"
      : errors.slice(0, 3).join("; "),
  );
}

/** Stage 1e — the verification key as a whole is usable. */
function checkVerificationKey(vkey: Groth16VerificationKey | null): ZkCheck {
  if (!vkey) {
    return check("verification-key", "Verification key", false, "verification key could not be parsed");
  }
  const required = [
    "vk_alpha_1",
    "vk_beta_2",
    "vk_gamma_2",
    "vk_delta_2",
  ] as const;
  const missing = required.filter((name) => !Array.isArray(vkey[name]));
  if (missing.length > 0) {
    return check(
      "verification-key",
      "Verification key",
      false,
      `missing key material: ${missing.join(", ")}`,
    );
  }
  return check(
    "verification-key",
    "Verification key",
    true,
    `groth16 key for ${vkey.nPublic} public input(s) with ${Array.isArray(vkey.IC) ? vkey.IC.length : 0} IC point(s)`,
  );
}

/** Stage 2 — the actual pairing equation. */
async function loadDefaultBackend(): Promise<PairingBackend | null> {
  try {
    // Optional peer: only pulled in when a proof is actually verified, so the
    // WASM prover/verifier never inflates the initial bundle. The specifier is
    // held in a variable so bundlers and `tsc` treat it as a runtime-only,
    // unresolvable-at-build-time import.
    const specifier = "snarkjs";
    const snarkModule = (await import(/* webpackIgnore: true */ specifier)) as unknown as {
      groth16?: {
        verify: (
          vkey: unknown,
          signals: unknown,
          proof: unknown,
        ) => Promise<boolean>;
      };
    };
    if (!snarkModule?.groth16?.verify) return null;
    return {
      verify: (verificationKey, publicSignals, proof) =>
        snarkModule.groth16!.verify(verificationKey, publicSignals, proof),
    };
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

export interface VerifyInput {
  proof: unknown;
  verificationKey: unknown;
  publicSignals: unknown;
}

/**
 * Run every local (dependency-free) verification stage.
 *
 * Because it never awaits, this is safe to call during render to decide whether
 * a record is worth showing a "verify" affordance for.
 */
export function verifyGroth16ProofLocally(input: VerifyInput): ZkVerificationResult {
  const envelope = checkEnvelope(input.proof, input.verificationKey, input.publicSignals);

  const proxy = {
    protocol: String((input.proof as Groth16Proof | undefined)?.protocol ?? "unknown"),
    curve: String((input.proof as Groth16Proof | undefined)?.curve ?? "unknown"),
  };

  if (envelope.errors.length > 0 && !envelope.proof) {
    return {
      status: "invalid",
      checks: envelope.checks,
      message: envelope.errors.join("; "),
      protocol: proxy.protocol,
      curve: proxy.curve,
      publicSignals: Array.isArray(input.publicSignals)
        ? input.publicSignals.map((entry) => String(entry))
        : [],
      verifiedAt: new Date().toISOString(),
      pairingEvaluated: false,
    };
  }

  const checks: ZkCheck[] = [
    ...envelope.checks,
    checkPublicSignals(envelope.signals),
    checkFieldRange(envelope.proof, envelope.vkey),
    checkVerificationKey(envelope.vkey),
    checkCurveMembership(envelope.proof, envelope.vkey),
  ];

  const failed = checks.filter((entry) => !entry.passed);
  const pairingCheck = check(
    "pairing",
    "Pairing equation",
    false,
    "not evaluated — no pairing backend loaded",
  );

  if (failed.length > 0 || envelope.errors.length > 0) {
    const message = [...envelope.errors, ...failed.map((entry) => `${entry.label}: ${entry.detail}`)]
      .join("; ");
    return {
      status: "invalid",
      checks: [...checks, pairingCheck],
      message,
      protocol: proxy.protocol,
      curve: proxy.curve,
      publicSignals: envelope.signals ?? [],
      verifiedAt: new Date().toISOString(),
      pairingEvaluated: false,
    };
  }

  return {
    status: "unverifiable",
    checks: [...checks, pairingCheck],
    message:
      "Structure, field ranges and curve membership are valid; the pairing equation was not evaluated.",
    protocol: proxy.protocol,
    curve: proxy.curve,
    publicSignals: envelope.signals ?? [],
    verifiedAt: new Date().toISOString(),
    pairingEvaluated: false,
  };
}

/**
 * Full verification: local hardening followed by the Groth16 pairing equation.
 *
 * When `options.loadBackend` is omitted the `snarkjs` WASM backend is imported
 * on demand. If it is unavailable the result stays `unverifiable` — never
 * `verified`.
 */
export async function verifyGroth16Proof(
  input: VerifyInput,
  options: ZkVerifierOptions = {},
): Promise<ZkVerificationResult> {
  const local = verifyGroth16ProofLocally(input);
  const now = (options.now ?? (() => new Date()))().toISOString();

  if (local.status === "invalid") {
    return { ...local, verifiedAt: now };
  }

  const loadBackend = options.loadBackend ?? loadDefaultBackend;
  let backend: PairingBackend | null = null;
  try {
    backend = await loadBackend();
  } catch {
    backend = null;
  }

  if (!backend) {
    return { ...local, verifiedAt: now };
  }

  let ok = false;
  let detail = "";
  try {
    ok = await backend.verify(
      input.verificationKey as Groth16VerificationKey,
      (input.publicSignals as unknown[]).map((entry) => String(entry)),
      input.proof as Groth16Proof,
    );
    detail = ok
      ? "the Groth16 pairing equation holds for the supplied public signals"
      : "the Groth16 pairing equation does not hold";
  } catch (error) {
    return {
      ...local,
      status: "unverifiable",
      verifiedAt: now,
      message: `Pairing backend failed: ${error instanceof Error ? error.message : String(error)}`,
      checks: [
        ...local.checks.filter((entry) => entry.id !== "pairing"),
        check("pairing", "Pairing equation", false, "backend threw before producing a result"),
      ],
    };
  }

  const checks = [
    ...local.checks.filter((entry) => entry.id !== "pairing"),
    check("pairing", "Pairing equation", ok, detail),
  ];

  return {
    status: ok ? "verified" : "invalid",
    checks,
    message: ok
      ? "Proof verified: the agent's execution attestation is cryptographically valid."
      : "Cryptographic verification failed: the Groth16 pairing equation does not hold.",
    protocol: local.protocol,
    curve: local.curve,
    publicSignals: local.publicSignals,
    verifiedAt: now,
    pairingEvaluated: true,
  };
}

/** Reduce a result to the parts a badge needs. */
export function summarizeVerification(result: ZkVerificationResult): ZkVerificationSummary {
  const failed = result.checks.filter((entry) => !entry.passed);
  return { status: result.status, message: result.message, failed };
}

/* -------------------------------------------------------------------------- */
/* Attestation plumbing                                                       */
/* -------------------------------------------------------------------------- */

function looksLikeVerificationKey(value: unknown): value is Groth16VerificationKey {
  return (
    isObject(value) &&
    Array.isArray((value as Groth16VerificationKey).IC) &&
    Array.isArray((value as Groth16VerificationKey).vk_alpha_1)
  );
}

function looksLikeProof(value: unknown): value is Groth16Proof {
  return (
    isObject(value) &&
    Array.isArray((value as Groth16Proof).pi_a) &&
    Array.isArray((value as Groth16Proof).pi_b) &&
    Array.isArray((value as Groth16Proof).pi_c)
  );
}

/**
 * Pull a zero-knowledge attestation out of a provenance record payload.
 *
 * Returns `null` for ordinary payloads so the explorer can call this
 * unconditionally. Also tolerates the flat `{ proof, verificationKey, ... }`
 * shape as well as a `{ zk: { ... } }` wrapper.
 */
export function extractAttestation(payload: unknown): AgentExecutionAttestation | null {
  if (!isObject(payload)) return null;
  const source = isObject(payload.zk) ? (payload.zk as Record<string, unknown>) : payload;

  const proof = source.proof ?? source.proofJson;
  const vkey = source.verificationKey ?? source.vkey;
  if (!looksLikeProof(proof) || !looksLikeVerificationKey(vkey)) return null;

  const publicSignals = source.publicSignals ?? source.public_inputs ?? proof.publicSignals;
  if (!Array.isArray(publicSignals)) return null;

  return {
    version: typeof source.version === "string" ? source.version : undefined,
    circuitId:
      typeof source.circuitId === "string"
        ? source.circuitId
        : typeof source.circuit === "string"
          ? source.circuit
          : "unknown-circuit",
    agentId: typeof source.agentId === "string" ? source.agentId : "",
    commitment: typeof source.commitment === "string" ? source.commitment : undefined,
    publicSignals: publicSignals.map((entry) => String(entry)),
    proof,
    verificationKey: vkey,
  };
}

/** Fingerprint a public signal list for display without leaking long integers. */
export function shortSignal(value: string, head = 10, tail = 6): string {
  if (value.length <= head + tail + 3) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

/** Normalise a scalar for display as a 32-byte hex string. */
export function signalToHex(value: string): string {
  const parsed = readFieldElement(value);
  if (parsed === null) return "0x" + "?".repeat(8);
  return "0x" + mod(parsed).toString(16).padStart(64, "0");
}
