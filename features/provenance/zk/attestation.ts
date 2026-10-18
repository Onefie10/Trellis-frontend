/**
 * Zero-knowledge attestation helpers.
 *
 * These sit between the provenance data model and the verifier: they decide
 * whether a record carries a ZK attestation, cache verification results per
 * proof so the explorer does not re-verify the same payload on every render, and
 * build the human-readable failure notices required by the acceptance criteria.
 */

import type {
  AgentExecutionAttestation,
  ZkVerificationResult,
  ZkVerifierOptions,
} from "./types";
import { extractAttestation, summarizeVerification, verifyGroth16Proof } from "./verifier";

export { extractAttestation };

/** Stable cache key for an attestation: circuit + proof points + signals. */
export function attestationKey(attestation: AgentExecutionAttestation): string {
  return [
    attestation.circuitId,
    attestation.proof.pi_a.join(","),
    attestation.proof.pi_b.flat().join(","),
    attestation.proof.pi_c.join(","),
    attestation.publicSignals.join(","),
  ].join("|");
}

/** In-memory verification cache, bounded so a long session cannot leak. */
export class ZkVerificationCache {
  private readonly entries = new Map<string, ZkVerificationResult>();

  constructor(private readonly maxEntries = 100) {}

  get(key: string): ZkVerificationResult | undefined {
    return this.entries.get(key);
  }

  set(key: string, value: ZkVerificationResult): void {
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    this.entries.set(key, value);
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}

/**
 * Verify an attestation, reusing a cached result when the exact same proof has
 * already been checked.
 */
export async function verifyAttestation(
  attestation: AgentExecutionAttestation,
  options: ZkVerifierOptions & { cache?: ZkVerificationCache } = {},
): Promise<ZkVerificationResult> {
  const key = attestationKey(attestation);
  const cached = options.cache?.get(key);
  if (cached) return cached;

  const result = await verifyGroth16Proof(
    {
      proof: attestation.proof,
      verificationKey: attestation.verificationKey,
      publicSignals: attestation.publicSignals,
    },
    options,
  );

  options.cache?.set(key, result);
  return result;
}

/** Copy shown when a proof fails verification, keyed by the first failed stage. */
export function failureNotice(result: ZkVerificationResult): string {
  const summary = summarizeVerification(result);
  if (summary.status === "verified") {
    return "Execution attestation verified.";
  }
  if (summary.status === "unverifiable") {
    return `Attestation not confirmed: ${result.message}`;
  }
  const first = summary.failed[0];
  if (!first) return "Cryptographic verification failed.";
  switch (first.id) {
    case "envelope":
      return `Malformed attestation: ${first.detail}.`;
    case "public-signals":
      return `Public inputs rejected: ${first.detail}.`;
    case "field-range":
      return `Proof contains values outside the BN254 field: ${first.detail}.`;
    case "verification-key":
      return `Verification key rejected: ${first.detail}.`;
    case "curve-membership":
      return `Proof points are not on the BN254 curve: ${first.detail}.`;
    case "pairing":
      return "Cryptographic verification failed: the pairing equation does not hold for these public inputs.";
    default:
      return "Cryptographic verification failed.";
  }
}

/** Short label for the failure badge. */
export function failureCode(result: ZkVerificationResult): string {
  if (result.status === "verified") return "ZK-VERIFIED";
  if (result.status === "unverifiable") return "ZK-UNVERIFIED";
  const failed = result.checks.filter((entry) => !entry.passed);
  const id = failed[0]?.id ?? "unknown";
  return `ZK-INVALID:${id.toUpperCase()}`;
}

/** Percentage of verification stages that passed — drives the inspector gauge. */
export function passedRatio(result: ZkVerificationResult): number {
  if (result.checks.length === 0) return 0;
  const passed = result.checks.filter((entry) => entry.passed).length;
  return Math.round((passed / result.checks.length) * 100);
}
