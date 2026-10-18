/**
 * Client-side zero-knowledge verification for agent execution attestations.
 *
 * ```ts
 * import { extractAttestation, verifyGroth16Proof } from "@/features/provenance/zk";
 *
 * const attestation = extractAttestation(record.details.payload);
 * if (attestation) {
 *   const result = await verifyGroth16Proof(attestation);
 *   result.status; // "verified" | "invalid" | "unverifiable"
 * }
 * ```
 */

export * from "./types";
export {
  BN254_FIELD_MODULUS,
  BN254_G2_B,
  BN254_G2_GENERATOR,
  BN254_G1_B,
  BN254_G1_GENERATOR,
  BN254_GROUP_ORDER,
  fp2Add,
  fp2Equals,
  fp2Inverse,
  fp2Mul,
  fp2Square,
  fp2Sub,
  isFieldElement,
  isG1Identity,
  isOnG1Curve,
  isOnG2Curve,
  mod,
  modInverse,
  modPow,
  readFieldElement,
  toFieldElement,
  type Fp2,
  type G1Point,
  type G2Point,
} from "./bn254";
export {
  attestationKey,
  failureCode,
  failureNotice,
  passedRatio,
  verifyAttestation,
  ZkVerificationCache,
} from "./attestation";
export {
  shortSignal,
  signalToHex,
  summarizeVerification,
  verifyGroth16Proof,
  verifyGroth16ProofLocally,
  type VerifyInput,
} from "./verifier";
