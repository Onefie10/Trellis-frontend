/**
 * Risk-Scored Abuse Detection for High-Impact Protocol Operations.
 *
 * Provides granular risk scoring, explainable signals, step-up challenges,
 * and review/quarantine thresholds without blocking legitimate low-risk operations.
 */

import type { ProtocolOperation, ProtocolEnvironment, ProtocolActor } from './operations.ts';
import { shortFingerprint } from './canonical.ts';

/**
 * Categorical severity for an individual risk signal.
 */
export type RiskSignalSeverity = 'info' | 'low' | 'medium' | 'high' | 'critical';

/**
 * An explainable risk signal contributing to the composite risk score.
 */
export interface RiskSignal {
  readonly code: string;
  readonly severity: RiskSignalSeverity;
  readonly weight: number;
  readonly message: string;
  readonly remediation?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * Step-up challenge requirements when an operation is flagged for elevated risk.
 */
export type StepUpChallengeType =
  | 'biometric_or_hardware_wallet'
  | 'mfa_totp'
  | 'email_pin'
  | 'hold_delay'
  | 'manual_review';

export interface StepUpChallenge {
  readonly required: boolean;
  readonly challengeType?: StepUpChallengeType;
  readonly reason?: string;
  readonly expiresAt?: number;
  readonly token?: string;
}

/**
 * Evaluation action verdict:
 * - 'allow': normal low-risk pass
 * - 'step_up': elevated risk; requires interactive confirmation / secondary authentication
 * - 'review': suspicious risk; quarantined for manual compliance/maintainer review
 * - 'block': critical abuse; immediate rejection
 */
export type RiskAction = 'allow' | 'step_up' | 'review' | 'block';

/**
 * Telemetry event for abuse detection observability.
 */
export interface AbuseTelemetryEvent {
  readonly eventType: 'abuse_evaluated' | 'step_up_requested' | 'review_quarantined' | 'abuse_blocked';
  readonly operation: ProtocolOperation;
  readonly environment: ProtocolEnvironment;
  readonly actorId: string;
  readonly riskScore: number;
  readonly action: RiskAction;
  readonly signals: readonly RiskSignal[];
  readonly timestamp: number;
}

/**
 * Input evaluation payload for the risk engine.
 */
export interface AbuseEvaluationRequest {
  readonly operation: ProtocolOperation;
  readonly environment: ProtocolEnvironment;
  readonly actorId: string;
  readonly actor?: ProtocolActor;
  readonly payload: Readonly<Record<string, unknown>>;
  /** Client or network context */
  readonly clientContext?: {
    readonly ip?: string;
    readonly userAgent?: string;
    readonly deviceId?: string;
    readonly isVpnOrTor?: boolean;
    readonly geoMismatch?: boolean;
  };
  /** Behavioral & historical telemetry snapshot */
  readonly historySnapshot?: {
    readonly actorAgeDays?: number;
    readonly operationCountLastHour?: number;
    readonly operationCountLast24Hours?: number;
    readonly failedAttemptsLast15Minutes?: number;
    readonly previousReviewCount?: number;
    readonly recentTransactionsVolumeStroops?: string;
    readonly isKnownBeneficiary?: boolean;
  };
  /** State snapshot (balances, sequence, etc.) */
  readonly stateSnapshot?: {
    readonly balances?: Readonly<Record<string, string>>;
    readonly currentAllowanceOk?: boolean;
    readonly isContractWhitelisted?: boolean;
  };
  /** Supplied step-up challenge proof if retrying with step-up verification */
  readonly stepUpProof?: {
    readonly token: string;
    readonly verified: boolean;
    readonly challengeType: StepUpChallengeType;
  };
}

/**
 * Result of the risk evaluation.
 */
export interface AbuseEvaluationResult {
  readonly evaluationId: string;
  readonly operation: ProtocolOperation;
  readonly environment: ProtocolEnvironment;
  readonly actorId: string;
  readonly riskScore: number; // 0 to 100
  readonly action: RiskAction;
  readonly signals: readonly RiskSignal[];
  readonly stepUpChallenge?: StepUpChallenge;
  readonly evaluatedAt: number;
  readonly telemetryEvent: AbuseTelemetryEvent;
}

/**
 * Threshold configuration for risk grading.
 */
export interface AbuseDetectionConfig {
  readonly stepUpThreshold: number; // default: 40
  readonly reviewThreshold: number; // default: 70
  readonly blockThreshold: number;  // default: 90
  readonly highVolumeThresholdStroops: bigint; // default: 10,000 XLM (100,000,000,000 stroops)
  readonly burstVelocityLimitPerHour: number;  // default: 10
}

export const DEFAULT_ABUSE_CONFIG: AbuseDetectionConfig = {
  stepUpThreshold: 40,
  reviewThreshold: 70,
  blockThreshold: 90,
  highVolumeThresholdStroops: BigInt('100000000000'), // 10,000 XLM
  burstVelocityLimitPerHour: 10,
};

/**
 * Pure signal evaluator rules.
 */
export type RiskSignalEvaluator = (
  req: AbuseEvaluationRequest,
  config: AbuseDetectionConfig,
) => RiskSignal | null;

/**
 * Standard signal evaluators.
 */
export const SIGNAL_EVALUATORS: readonly RiskSignalEvaluator[] = [
  // 1. High-frequency velocity anomaly
  (req, config) => {
    const hourly = req.historySnapshot?.operationCountLastHour ?? 0;
    if (hourly > config.burstVelocityLimitPerHour * 2) {
      return {
        code: 'BURST_VELOCITY_CRITICAL',
        severity: 'critical',
        weight: 50,
        message: `Rapid operation frequency (${hourly} ops/hr) indicates automated burst scripting.`,
        remediation: 'Wait for cooldown period before attempting further operations.',
        metadata: { hourly, limit: config.burstVelocityLimitPerHour },
      };
    }
    if (hourly > config.burstVelocityLimitPerHour) {
      return {
        code: 'HIGH_VELOCITY_BURST',
        severity: 'high',
        weight: 30,
        message: `High frequency of operations detected (${hourly} in the last hour).`,
        remediation: 'Space out high-impact operations to maintain account safety.',
        metadata: { hourly, limit: config.burstVelocityLimitPerHour },
      };
    }
    return null;
  },

  // 2. High repeated failure anomaly
  (req) => {
    const failures = req.historySnapshot?.failedAttemptsLast15Minutes ?? 0;
    if (failures >= 5) {
      return {
        code: 'HIGH_FAILURE_RATE',
        severity: 'high',
        weight: 35,
        message: `Multiple recent failed attempts (${failures} in 15 mins).`,
        remediation: 'Ensure transaction parameters and wallet signatures are valid.',
        metadata: { failures },
      };
    }
    if (failures >= 3) {
      return {
        code: 'MODERATE_FAILURE_RATE',
        severity: 'medium',
        weight: 15,
        message: 'Several recent failed attempts detected.',
        remediation: 'Verify destination and balances before retrying.',
        metadata: { failures },
      };
    }
    return null;
  },

  // 3. Brand new account performing high-impact operation
  (req) => {
    const ageDays = req.historySnapshot?.actorAgeDays;
    if (ageDays !== undefined && ageDays < 1) {
      return {
        code: 'FRESH_ACCOUNT_SURGE',
        severity: 'medium',
        weight: 25,
        message: 'Account was created less than 24 hours ago.',
        remediation: 'New accounts require verification for high-impact actions.',
        metadata: { ageDays },
      };
    }
    return null;
  },

  // 4. Unusual transfer or payout volume
  (req, config) => {
    const amountStr = req.payload.amount;
    if (typeof amountStr === 'string' && /^\d+$/.test(amountStr)) {
      const amount = BigInt(amountStr);
      if (amount >= config.highVolumeThresholdStroops) {
        return {
          code: 'UNUSUAL_LARGE_VOLUME',
          severity: 'high',
          weight: 30,
          message: 'Requested transaction amount is unusually large.',
          remediation: 'Large volume operations require hardware key confirmation or approval.',
          metadata: { amount: amountStr, threshold: config.highVolumeThresholdStroops.toString() },
        };
      }
    }
    return null;
  },

  // 5. Unknown destination / beneficiary
  (req) => {
    if (req.operation === 'transfer_funds' || req.operation === 'claim_payout') {
      if (req.historySnapshot?.isKnownBeneficiary === false) {
        return {
          code: 'FIRST_TIME_BENEFICIARY',
          severity: 'low',
          weight: 15,
          message: 'Destination address has never been interacted with previously.',
          remediation: 'Review and confirm the destination address carefully.',
        };
      }
    }
    return null;
  },

  // 6. Network/Anonymizer risk
  (req) => {
    if (req.clientContext?.isVpnOrTor) {
      return {
        code: 'ANONYMIZED_NETWORK_ROUTE',
        severity: 'medium',
        weight: 20,
        message: 'Operation initiated via Tor, known proxy, or anonymizing VPN.',
        remediation: 'Disable VPN or proxy when executing high-value operations.',
      };
    }
    return null;
  },

  // 7. Geographic / IP mismatch
  (req) => {
    if (req.clientContext?.geoMismatch) {
      return {
        code: 'ANOMALOUS_GEO_LOCATION',
        severity: 'low',
        weight: 10,
        message: 'Operation origin country differs from your normal access patterns.',
        remediation: 'Verify the session if you are currently traveling.',
      };
    }
    return null;
  },

  // 8. Governance / Admin privilege operations by non-admins
  (req) => {
    if (req.operation === 'update_governance') {
      if (req.actor?.role !== 'admin') {
        return {
          code: 'GOVERNANCE_PRIVILEGE_ELEVATION',
          severity: 'critical',
          weight: 60,
          message: 'High-privilege governance update attempted without administrator credentials.',
          remediation: 'Governance modifications must be executed by administrator role.',
        };
      }
    }
    return null;
  },
];

/**
 * Computes an explainable risk evaluation for any high-risk operation request.
 */
export function evaluateAbuseRisk(
  request: AbuseEvaluationRequest,
  config: AbuseDetectionConfig = DEFAULT_ABUSE_CONFIG,
  now: () => number = () => Date.now(),
): AbuseEvaluationResult {
  const at = now();
  const signals: RiskSignal[] = [];

  for (const evaluator of SIGNAL_EVALUATORS) {
    const signal = evaluator(request, config);
    if (signal) {
      signals.push(signal);
    }
  }

  // Composite score: cumulative weights capped at 100
  const rawScore = signals.reduce((sum, s) => sum + s.weight, 0);
  const riskScore = Math.max(0, Math.min(100, rawScore));

  // Determine initial action based on thresholds
  let action: RiskAction = 'allow';
  if (riskScore >= config.blockThreshold) {
    action = 'block';
  } else if (riskScore >= config.reviewThreshold) {
    action = 'review';
  } else if (riskScore >= config.stepUpThreshold) {
    action = 'step_up';
  }

  // Check if step-up proof was provided and valid
  let stepUpChallenge: StepUpChallenge | undefined;
  if (action === 'step_up') {
    const proof = request.stepUpProof;
    if (proof && proof.verified) {
      // Step-up verification succeeded: allow the operation through
      action = 'allow';
    } else {
      const challengeType: StepUpChallengeType =
        riskScore >= 60 ? 'biometric_or_hardware_wallet' : 'mfa_totp';
      const token = `stepup-${shortFingerprint([request.actorId, request.operation, at])}`;
      stepUpChallenge = {
        required: true,
        challengeType,
        reason: signals[0]?.message ?? 'Step-up authentication required for high-risk operation.',
        expiresAt: at + 5 * 60 * 1000, // 5 min TTL
        token,
      };
    }
  }

  const evaluationId = `risk-${shortFingerprint([
    request.actorId,
    request.operation,
    request.environment,
    request.payload,
    at,
  ])}`;

  const telemetryEventType =
    action === 'block'
      ? 'abuse_blocked'
      : action === 'review'
        ? 'review_quarantined'
        : action === 'step_up'
          ? 'step_up_requested'
          : 'abuse_evaluated';

  const telemetryEvent: AbuseTelemetryEvent = {
    eventType: telemetryEventType,
    operation: request.operation,
    environment: request.environment,
    actorId: request.actorId,
    riskScore,
    action,
    signals,
    timestamp: at,
  };

  emitAbuseTelemetry(telemetryEvent);

  return {
    evaluationId,
    operation: request.operation,
    environment: request.environment,
    actorId: request.actorId,
    riskScore,
    action,
    signals,
    stepUpChallenge,
    evaluatedAt: at,
    telemetryEvent,
  };
}

/**
 * In-memory abuse telemetry event subscribers.
 */
export type AbuseTelemetrySubscriber = (event: AbuseTelemetryEvent) => void;
const subscribers = new Set<AbuseTelemetrySubscriber>();

export function subscribeAbuseTelemetry(subscriber: AbuseTelemetrySubscriber): () => void {
  subscribers.add(subscriber);
  return () => {
    subscribers.delete(subscriber);
  };
}

export function emitAbuseTelemetry(event: AbuseTelemetryEvent): void {
  for (const subscriber of subscribers) {
    try {
      subscriber(event);
    } catch {
      // Ignore subscriber errors to prevent impacting critical path
    }
  }
}

/**
 * Thrown when an operation is blocked or quarantined for review.
 */
export class AbuseRiskError extends Error {
  readonly code: 'ABUSE_RISK_BLOCKED' | 'ABUSE_RISK_REVIEW_REQUIRED' | 'ABUSE_RISK_STEP_UP_REQUIRED';
  readonly result: AbuseEvaluationResult;

  constructor(result: AbuseEvaluationResult) {
    const firstSignal = result.signals[0];
    const message =
      result.action === 'block'
        ? `Operation blocked due to high abuse risk: ${firstSignal?.message ?? 'Critical risk detected.'}`
        : result.action === 'review'
          ? `Operation held for security review: ${firstSignal?.message ?? 'Suspicious activity detected.'}`
          : `Step-up authentication required: ${firstSignal?.message ?? 'Elevated risk.'}`;
    super(message);
    this.name = 'AbuseRiskError';
    this.result = result;
    this.code =
      result.action === 'block'
        ? 'ABUSE_RISK_BLOCKED'
        : result.action === 'review'
          ? 'ABUSE_RISK_REVIEW_REQUIRED'
          : 'ABUSE_RISK_STEP_UP_REQUIRED';
  }
}
