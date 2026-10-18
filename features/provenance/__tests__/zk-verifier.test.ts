import {
  BN254_FIELD_MODULUS,
  BN254_G1_GENERATOR,
  BN254_G2_GENERATOR,
  BN254_GROUP_ORDER,
  isOnG1Curve,
  isOnG2Curve,
  modInverse,
  modPow,
} from "../zk/bn254";
import type {
  Groth16Proof,
  Groth16VerificationKey,
  PairingBackend,
  ZkVerificationResult,
} from "../zk/types";
import {
  attestationKey,
  extractAttestation,
  failureCode,
  failureNotice,
  passedRatio,
  verifyAttestation,
  ZkVerificationCache,
} from "../zk/attestation";
import {
  shortSignal,
  signalToHex,
  verifyGroth16Proof,
  verifyGroth16ProofLocally,
} from "../zk/verifier";

/* ------------------------------- fixtures -------------------------------- */

/** The BN254 G1 generator, serialised the way snarkjs writes G1 points. */
const G1: [string, string, string] = [
  BN254_G1_GENERATOR[0].toString(),
  BN254_G1_GENERATOR[1].toString(),
  "1",
];

/** The EIP-197 BN254 G2 generator, serialised the way snarkjs writes G2 points. */
const G2: [[string, string], [string, string], string] = [
  [BN254_G2_GENERATOR.x.c0.toString(), BN254_G2_GENERATOR.x.c1.toString()],
  [BN254_G2_GENERATOR.y.c0.toString(), BN254_G2_GENERATOR.y.c1.toString()],
  "1",
];

function makeProof(overrides: Partial<Groth16Proof> = {}): Groth16Proof {
  return {
    protocol: "groth16",
    curve: "bn128",
    pi_a: [...G1] as [string, string, string],
    pi_b: G2.map((part) => (Array.isArray(part) ? [...part] : part)) as Groth16Proof["pi_b"],
    pi_c: [...G1] as [string, string, string],
    ...overrides,
  };
}

function makeVerificationKey(
  nPublic = 0,
  overrides: Partial<Groth16VerificationKey> = {},
): Groth16VerificationKey {
  return {
    protocol: "groth16",
    curve: "bn128",
    nPublic,
    vk_alpha_1: [...G1] as [string, string, string],
    vk_beta_2: G2.map((part) => (Array.isArray(part) ? [...part] : part)) as Groth16VerificationKey["vk_beta_2"],
    vk_gamma_2: G2.map((part) => (Array.isArray(part) ? [...part] : part)) as Groth16VerificationKey["vk_gamma_2"],
    vk_delta_2: G2.map((part) => (Array.isArray(part) ? [...part] : part)) as Groth16VerificationKey["vk_delta_2"],
    IC: Array.from({ length: nPublic + 1 }, () => [...G1] as [string, string, string]),
    ...overrides,
  };
}

const okBackend = (result: boolean): PairingBackend => ({
  verify: jest.fn().mockResolvedValue(result),
});

function expectInvalid(result: ZkVerificationResult, checkId: string) {
  expect(result.status).toBe("invalid");
  expect(result.pairingEvaluated).toBe(false);
  const failed = result.checks.filter((entry) => !entry.passed).map((entry) => entry.id);
  expect(failed).toContain(checkId);
}

/* --------------------------------- bn254 --------------------------------- */

describe("BN254 arithmetic", () => {
  it("accepts the standard generators as curve members", () => {
    expect(isOnG1Curve({ x: BN254_G1_GENERATOR[0], y: BN254_G1_GENERATOR[1] })).toBe(true);
    expect(isOnG2Curve(BN254_G2_GENERATOR)).toBe(true);
  });

  it("rejects points that are not on the curve", () => {
    expect(isOnG1Curve({ x: 1n, y: 3n })).toBe(false);
    expect(
      isOnG2Curve({ x: { c0: 1n, c1: 0n }, y: BN254_G2_GENERATOR.y }),
    ).toBe(false);
  });

  it("inverts field elements correctly", () => {
    const value = 12345678901234567890n;
    expect((value * modInverse(value)) % BN254_FIELD_MODULUS).toBe(1n);
  });

  it("exponentiates with Fermat's little theorem", () => {
    const base = 7n;
    const exponent = BN254_FIELD_MODULUS - 2n;
    expect((base * modPow(base, exponent)) % BN254_FIELD_MODULUS).toBe(1n);
  });

  it("orders the scalar field strictly below the base field", () => {
    expect(BN254_GROUP_ORDER < BN254_FIELD_MODULUS).toBe(true);
  });
});

/* ------------------------------ local stage ------------------------------ */

describe("verifyGroth16ProofLocally", () => {
  it("passes every local stage for a well-formed proof", () => {
    const result = verifyGroth16ProofLocally({
      proof: makeProof(),
      verificationKey: makeVerificationKey(2),
      publicSignals: ["1", "2"],
    });

    expect(result.checks.map((entry) => entry.id)).toEqual([
      "envelope",
      "public-signals",
      "field-range",
      "verification-key",
      "curve-membership",
      "pairing",
    ]);
    expect(result.checks.filter((entry) => entry.passed)).toHaveLength(5);
  });

  it("does not claim success when the pairing equation was not evaluated", () => {
    const result = verifyGroth16ProofLocally({
      proof: makeProof(),
      verificationKey: makeVerificationKey(0),
      publicSignals: [],
    });

    expect(result.status).toBe("unverifiable");
    expect(result.pairingEvaluated).toBe(false);
    expect(result.message).toMatch(/pairing equation was not evaluated/i);
  });

  it("accepts decimal and 0x-prefixed signals alike", () => {
    const result = verifyGroth16ProofLocally({
      proof: makeProof(),
      verificationKey: makeVerificationKey(2),
      publicSignals: ["0x2a", "42"],
    });
    expect(result.status).toBe("unverifiable");
  });

  it("rejects a proof point that is not on the G1 curve", () => {
    const result = verifyGroth16ProofLocally({
      proof: makeProof({ pi_a: ["1", "4", "1"] }),
      verificationKey: makeVerificationKey(0),
      publicSignals: [],
    });
    expectInvalid(result, "curve-membership");
  });

  it("rejects a pi_b point that is not on the G2 twist", () => {
    const result = verifyGroth16ProofLocally({
      proof: makeProof({
        pi_b: [
          ["1", "0"],
          ["1", "0"],
          "1",
        ],
      }),
      verificationKey: makeVerificationKey(0),
      publicSignals: [],
    });
    expectInvalid(result, "curve-membership");
  });

  it("rejects coordinates outside the BN254 field", () => {
    const result = verifyGroth16ProofLocally({
      proof: makeProof({ pi_c: [BN254_FIELD_MODULUS.toString(), "2", "1"] }),
      verificationKey: makeVerificationKey(0),
      publicSignals: [],
    });
    expectInvalid(result, "field-range");
  });

  it("rejects a non-affine z coordinate", () => {
    const result = verifyGroth16ProofLocally({
      proof: makeProof({ pi_a: ["1", "2", "0"] }),
      verificationKey: makeVerificationKey(0),
      publicSignals: [],
    });
    expectInvalid(result, "curve-membership");
  });

  it("rejects a non-groth16 protocol", () => {
    const result = verifyGroth16ProofLocally({
      proof: makeProof({ protocol: "plonk" }),
      verificationKey: makeVerificationKey(0),
      publicSignals: [],
    });
    expectInvalid(result, "envelope");
    expect(result.message).toMatch(/unsupported proof protocol/i);
  });

  it("rejects a non-bn128 curve", () => {
    const result = verifyGroth16ProofLocally({
      proof: makeProof({ curve: "bls12381" }),
      verificationKey: makeVerificationKey(0),
      publicSignals: [],
    });
    expect(result.status).toBe("invalid");
    expect(result.message).toMatch(/unsupported curve/i);
  });

  it("rejects a proof that is not an object", () => {
    const result = verifyGroth16ProofLocally({
      proof: null,
      verificationKey: makeVerificationKey(0),
      publicSignals: [],
    });
    expectInvalid(result, "envelope");
  });

  it("rejects an IC list that does not match nPublic", () => {
    const result = verifyGroth16ProofLocally({
      proof: makeProof(),
      verificationKey: makeVerificationKey(3, { IC: [[...G1] as [string, string, string]] }),
      publicSignals: ["1", "2", "3"],
    });
    expectInvalid(result, "envelope");
    expect(result.message).toMatch(/IC must hold nPublic \+ 1 = 4 points/);
  });

  it("rejects the wrong number of public signals", () => {
    const result = verifyGroth16ProofLocally({
      proof: makeProof(),
      verificationKey: makeVerificationKey(2),
      publicSignals: ["1"],
    });
    expectInvalid(result, "envelope");
    expect(result.message).toMatch(/expected 2 public signal\(s\)/);
  });

  it("rejects a signal that is not a scalar in the BN254 group order", () => {
    const result = verifyGroth16ProofLocally({
      proof: makeProof(),
      verificationKey: makeVerificationKey(1),
      publicSignals: [(BN254_GROUP_ORDER + 1n).toString()],
    });
    expectInvalid(result, "public-signals");
    expect(result.message).toMatch(/not BN254 scalars/);
  });

  it("rejects a non-numeric public signal", () => {
    const result = verifyGroth16ProofLocally({
      proof: makeProof(),
      verificationKey: makeVerificationKey(1),
      publicSignals: ["not-a-number"],
    });
    expectInvalid(result, "public-signals");
  });
});

/* ------------------------------ full stage ------------------------------- */

describe("verifyGroth16Proof", () => {
  const input = () => ({
    proof: makeProof(),
    verificationKey: makeVerificationKey(1),
    publicSignals: ["7"],
  });

  it("marks the proof verified when the injected pairing backend agrees", async () => {
    const backend = okBackend(true);
    const result = await verifyGroth16Proof(input(), { loadBackend: async () => backend });

    expect(backend.verify).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("verified");
    expect(result.pairingEvaluated).toBe(true);
    expect(result.checks.find((entry) => entry.id === "pairing")?.passed).toBe(true);
    expect(result.message).toMatch(/cryptographically valid/i);
  });

  it("marks the proof invalid when the pairing equation does not hold", async () => {
    const result = await verifyGroth16Proof(input(), { loadBackend: async () => okBackend(false) });

    expect(result.status).toBe("invalid");
    expect(result.pairingEvaluated).toBe(true);
    expect(result.checks.find((entry) => entry.id === "pairing")?.passed).toBe(false);
    expect(result.message).toMatch(/pairing equation does not hold/i);
  });

  it("stays unverifiable when no backend is available", async () => {
    const result = await verifyGroth16Proof(input(), { loadBackend: async () => null });
    expect(result.status).toBe("unverifiable");
    expect(result.pairingEvaluated).toBe(false);
  });

  it("stays unverifiable when the backend itself throws", async () => {
    const throwing: PairingBackend = {
      verify: jest.fn().mockRejectedValue(new Error("wasm aborted")),
    };
    const result = await verifyGroth16Proof(input(), { loadBackend: async () => throwing });

    expect(result.status).toBe("unverifiable");
    expect(result.message).toMatch(/wasm aborted/);
    expect(result.checks.find((entry) => entry.id === "pairing")?.passed).toBe(false);
  });

  it("never calls the pairing backend for a structurally invalid proof", async () => {
    const backend = okBackend(true);
    const result = await verifyGroth16Proof(
      { ...input(), proof: makeProof({ pi_a: ["1", "4", "1"] }) },
      { loadBackend: async () => backend },
    );

    expect(backend.verify).not.toHaveBeenCalled();
    expect(result.status).toBe("invalid");
  });

  it("records an injected clock in verifiedAt", async () => {
    const result = await verifyGroth16Proof(input(), {
      loadBackend: async () => okBackend(true),
      now: () => new Date("2026-01-02T03:04:05.000Z"),
    });
    expect(result.verifiedAt).toBe("2026-01-02T03:04:05.000Z");
  });
});

/* ------------------------------- helpers --------------------------------- */

describe("attestation helpers", () => {
  const attestation = {
    version: "1.0.0",
    circuitId: "agent-execution-v1",
    agentId: "agent-42",
    commitment: "0xdeadbeef",
    publicSignals: ["7"],
    proof: makeProof(),
    verificationKey: makeVerificationKey(1),
  };

  it("extracts a flat attestation payload", () => {
    expect(extractAttestation(attestation)?.circuitId).toBe("agent-execution-v1");
  });

  it("extracts an attestation nested under `zk`", () => {
    expect(extractAttestation({ zk: attestation })?.agentId).toBe("agent-42");
  });

  it("returns null for payloads that carry no attestation", () => {
    expect(extractAttestation({ input: "hello" })).toBeNull();
    expect(extractAttestation(null)).toBeNull();
    expect(extractAttestation("string")).toBeNull();
    expect(extractAttestation({ proof: makeProof() })).toBeNull();
  });

  it("builds a stable, collision-resistant cache key", () => {
    const key = attestationKey(attestation);
    expect(key).toBe(attestationKey({ ...attestation }));
    expect(key).not.toBe(attestationKey({ ...attestation, publicSignals: ["8"] }));
    expect(key).toContain("agent-execution-v1");
  });

  it("caches verification results and skips the backend on a repeat", async () => {
    const cache = new ZkVerificationCache(4);
    const backend = okBackend(true);
    const loadBackend = jest.fn().mockResolvedValue(backend);

    const first = await verifyAttestation(attestation, { cache, loadBackend });
    const second = await verifyAttestation(attestation, { cache, loadBackend });

    expect(first.status).toBe("verified");
    expect(second).toBe(first);
    expect(loadBackend).toHaveBeenCalledTimes(1);
    expect(cache.size).toBe(1);
  });

  it("evicts the oldest cache entry past its bound", () => {
    const cache = new ZkVerificationCache(2);
    const result = verifyGroth16ProofLocally({
      proof: makeProof(),
      verificationKey: makeVerificationKey(0),
      publicSignals: [],
    });
    cache.set("a", result);
    cache.set("b", result);
    cache.set("c", result);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.size).toBe(2);
  });

  it("describes a curve failure in plain language", () => {
    const result = verifyGroth16ProofLocally({
      proof: makeProof({ pi_a: ["1", "4", "1"] }),
      verificationKey: makeVerificationKey(0),
      publicSignals: [],
    });
    expect(failureNotice(result)).toMatch(/not on the BN254 curve/i);
    expect(failureCode(result)).toBe("ZK-INVALID:CURVE-MEMBERSHIP");
  });

  it("uses a distinct code for an unconfirmed proof", () => {
    const result = verifyGroth16ProofLocally({
      proof: makeProof(),
      verificationKey: makeVerificationKey(0),
      publicSignals: [],
    });
    expect(failureCode(result)).toBe("ZK-UNVERIFIED");
    expect(failureNotice(result)).toMatch(/not confirmed/i);
  });

  it("reports the share of checks that passed", () => {
    const invalid = verifyGroth16ProofLocally({
      proof: makeProof({ pi_a: ["1", "4", "1"] }),
      verificationKey: makeVerificationKey(0),
      publicSignals: [],
    });
    expect(passedRatio(invalid)).toBeLessThan(100);
    expect(passedRatio(invalid)).toBeGreaterThan(0);
  });

  it("truncates long signals for display", () => {
    const long = BN254_FIELD_MODULUS.toString();
    expect(shortSignal(long).length).toBeLessThan(long.length);
    expect(shortSignal("42")).toBe("42");
  });

  it("renders signals as zero-padded 32-byte hex", () => {
    expect(signalToHex("7")).toBe(`0x${"0".repeat(63)}7`);
    expect(signalToHex("not-a-number")).toMatch(/^0x\?+$/);
  });
});
