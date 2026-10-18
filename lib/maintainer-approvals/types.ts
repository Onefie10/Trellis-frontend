/**
 * Maintainer Action Approval Flow & Signed Intent Receipts
 *
 * Types and schemas for high-impact actions requiring explicit maintainer intent,
 * cryptographically verifiable signed receipts, offline queueing, and post-execution review.
 */

/**
 * High-impact operations requiring explicit maintainer intent approval.
 */
export const HIGH_IMPACT_MAINTAINER_ACTIONS = [
  'emergency_pause',
  'emergency_resume',
  'run_retention_cleanup',
  'escalate_role',
  'treasury_disbursement',
  'rotate_signing_keys',
  'bulk_data_import',
] as const;

export type HighImpactMaintainerAction = (typeof HIGH_IMPACT_MAINTAINER_ACTIONS)[number];

export function isHighImpactMaintainerAction(action: string): action is HighImpactMaintainerAction {
  return (HIGH_IMPACT_MAINTAINER_ACTIONS as readonly string[]).includes(action as HighImpactMaintainerAction);
}

/**
 * Status lifecycle of an action approval intent and its execution.
 */
export type IntentApprovalStatus =
  | 'draft'               // Formulated intent, pending signature/approval
  | 'approved'            // Explicitly signed and approved by maintainer
  | 'rejected'            // Explicitly rejected by reviewer/maintainer
  | 'queued_offline'      // Approved while offline; stored locally awaiting sync
  | 'executing'           // Currently executing against contract / network
  | 'completed'           // Successfully executed
  | 'failed'              // Execution failed; failure reason and receipt captured
  | 'rolled_back';        // Rolled back or compensated

/**
 * Severity / Impact tier of the maintainer action.
 */
export type ActionImpactLevel = 'tier_1_standard' | 'tier_2_sensitive' | 'tier_3_critical';

/**
 * Maintainer Intent Payload prior to signature.
 */
export interface MaintainerIntentPayload {
  readonly action: HighImpactMaintainerAction;
  readonly environment: 'development' | 'staging' | 'production';
  readonly targetResource: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly justification: string;
  readonly nonce: string;
  readonly timestamp: number;
  readonly expiresAt: number;
}

/**
 * Maintainer Actor details.
 */
export interface MaintainerActor {
  readonly id: string;
  readonly publicKey: string; // Hex-encoded or base64/stellar public key format
  readonly role: 'maintainer' | 'admin';
  readonly walletType?: 'freighter' | 'albedo' | 'ledger' | 'ed25519_software';
}

/**
 * Signed Intent Receipt proving explicit maintainer approval.
 */
export interface SignedIntentReceipt {
  readonly receiptId: string;
  readonly intentFingerprint: string;
  readonly canonicalIntentJson: string;
  readonly action: HighImpactMaintainerAction;
  readonly environment: 'development' | 'staging' | 'production';
  readonly impactLevel: ActionImpactLevel;
  readonly maintainer: MaintainerActor;
  readonly signature: string;
  readonly signedAt: number;
  readonly status: IntentApprovalStatus;
  readonly externalTxRef?: string;
  readonly executionResult?: Readonly<Record<string, unknown>>;
  readonly failureReason?: string;
  readonly telemetryEventId?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly completedAt?: number;
}

/**
 * Audit log entry for post-execution or post-failure review.
 */
export interface MaintainerAuditReceiptLog {
  readonly logId: string;
  readonly receiptId: string;
  readonly action: HighImpactMaintainerAction;
  readonly status: IntentApprovalStatus;
  readonly actor: MaintainerActor;
  readonly timestamp: number;
  readonly details: Readonly<Record<string, unknown>>;
  readonly error?: string;
}

/**
 * Pure validation for maintainer intent payload.
 */
export function validateMaintainerIntent(payload: unknown): asserts payload is MaintainerIntentPayload {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Intent payload must be an object');
  }
  const p = payload as Record<string, unknown>;

  if (typeof p.action !== 'string' || !isHighImpactMaintainerAction(p.action)) {
    throw new Error(`Invalid action: ${p.action}`);
  }

  if (p.environment !== 'development' && p.environment !== 'staging' && p.environment !== 'production') {
    throw new Error(`Invalid environment: ${p.environment}`);
  }

  if (typeof p.targetResource !== 'string' || p.targetResource.trim().length === 0) {
    throw new Error('Target resource must not be empty');
  }

  if (!p.parameters || typeof p.parameters !== 'object') {
    throw new Error('Parameters must be an object');
  }

  if (typeof p.justification !== 'string' || p.justification.trim().length < 10) {
    throw new Error('Justification must be at least 10 characters');
  }

  if (typeof p.nonce !== 'string' || p.nonce.length < 8) {
    throw new Error('Nonce must be at least 8 characters');
  }

  if (typeof p.timestamp !== 'number' || p.timestamp <= 0) {
    throw new Error('Timestamp must be a positive number');
  }

  if (typeof p.expiresAt !== 'number' || p.expiresAt <= 0) {
    throw new Error('ExpiresAt must be a positive number');
  }
}
