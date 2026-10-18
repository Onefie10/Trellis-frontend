/**
 * Types for client-side Groth16 (ZK-SNARK) execution-attestation verification.
 *
 * The shapes mirror the `snarkjs` v0.7 JSON artifacts so a proof exported by the
 * proving service can be dropped straight into the verifier without a mapping
 * layer, and so `groth16.verify(vkey, publicSignals, proof)` can consume the same
 * objects once the WASM backend is available.
 */

/** A G1 point as serialised by snarkjs: `[x, y, "1"]`. */
export type G1Json = [string, string, string];

/** A G2 point as serialised by snarkjs: `[[x0, x1], [y0, y1], "1"]`. */
export type G2Json = [[string, string], [string, string], string];

/** `snarkjs` Groth16 proof object. */
export interface Groth16Proof {
  protocol: "groth16" | string;
  curve: "bn128" | string;
  pi_a: G1Json;
  pi_b: G2Json;
  pi_c: G1Json;
}

/** `snarkjs` Groth16 verification key object. */
export interface Groth16VerificationKey {
  protocol: "groth16" | string;
  curve: "bn128" | string;
  /** Number of public inputs the circuit exposes. */
  nPublic: number;
  vk_alpha_1: G1Json;
  vk_beta_2: G2Json;
  vk_gamma_2: G2Json;
  vk_delta_2: G2Json;
  /** `nPublic + 1` linear-combination points. */
  IC: G1Json[];
}

/** Stable identifier for each verification stage, used by the UI and tests. */
export type ZkCheckId =
  | "envelope"
  | "curve"
  | "field-range"
  | "public-signals"
  | "verification-key"
  | "curve-membership"
  | "pairing";

export interface ZkCheck {
  id: ZkCheckId;
  /** Short human-readable label for the proof inspector. */
  label: string;
  passed: boolean;
  /** Explanation shown when a check fails (or extra context when it passes). */
  detail: string;
}

/**
 * `verified`     — every structural check and the pairing equation passed.
 * `invalid`      — a check failed; the attestation must not be trusted.
 * `unverifiable` — the payload looks well-formed but no pairing backend was
 *                  available (offline build, WASM blocked), so the proof could
 *                  not be cryptographically confirmed. Never render this as a
 *                  success.
 */
export type ZkVerificationStatus = "verified" | "invalid" | "unverifiable";

export interface ZkVerificationResult {
  status: ZkVerificationStatus;
  checks: ZkCheck[];
  /** Human-readable summary of the outcome. */
  message: string;
  protocol: string;
  curve: string;
  /** Public signals exactly as supplied (decimal strings). */
  publicSignals: string[];
  /** ISO-8601 timestamp of when the verification ran. */
  verifiedAt: string;
  /** `true` only when the pairing equation itself was evaluated and passed. */
  pairingEvaluated: boolean;
}

/** Minimal contract for the optional `snarkjs` pairing backend. */
export interface PairingBackend {
  /** `true` when `groth16.verify` resolved the proof successfully. */
  verify(
    verificationKey: Groth16VerificationKey,
    publicSignals: string[],
    proof: Groth16Proof,
  ): Promise<boolean>;
}

/** Zero-knowledge attestation attached to an agent execution record. */
export interface AgentExecutionAttestation {
  /** Schema version of the attestation envelope. */
  version?: string;
  /** Identifier of the circuit that produced the proof. */
  circuitId: string;
  /** Agent whose execution is being attested. */
  agentId: string;
  /** Commitment to the (private) execution inputs. */
  commitment?: string;
  /** Public inputs the verifier is allowed to see. */
  publicSignals: string[];
  proof: Groth16Proof;
  verificationKey: Groth16VerificationKey;
}

export interface ZkVerifierOptions {
  /**
   * Pairing backend factory. When omitted the verifier lazily imports `snarkjs`;
   * tests inject a deterministic stub so they never touch WASM.
   */
  loadBackend?: () => Promise<PairingBackend | null>;
  /** Clock injection so tests can assert on a stable `verifiedAt`. */
  now?: () => Date;
}

export interface ZkVerificationSummary {
  status: ZkVerificationStatus;
  message: string;
  failed: ZkCheck[];
}
