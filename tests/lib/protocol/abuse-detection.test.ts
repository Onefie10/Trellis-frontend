import {
  evaluateAbuseRisk,
  DEFAULT_ABUSE_CONFIG,
  type AbuseEvaluationRequest,
  type StepUpChallenge,
} from '@/lib/protocol/abuse-detection';

describe('Risk-Scored Abuse Detection (lib/protocol/abuse-detection.ts)', () => {
  const baseRequest: AbuseEvaluationRequest = {
    operation: 'transfer_funds',
    environment: 'production',
    actorId: 'G_ACTOR_1',
    actor: { id: 'G_ACTOR_1', role: 'contributor' },
    payload: {
      amount: '1000000', // 0.1 XLM in stroops
      destination: 'G_DEST_1',
    },
    historySnapshot: {
      actorAgeDays: 30,
      operationCountLastHour: 1,
      failedAttemptsLast15Minutes: 0,
      isKnownBeneficiary: true,
    },
    clientContext: {
      isVpnOrTor: false,
      geoMismatch: false,
    },
  };

  it('allows normal low-risk operations with score 0 and no signals', () => {
    const result = evaluateAbuseRisk(baseRequest);
    expect(result.action).toBe('allow');
    expect(result.riskScore).toBe(0);
    expect(result.signals).toHaveLength(0);
    expect(result.stepUpChallenge).toBeUndefined();
    expect(result.telemetryEvent.eventType).toBe('abuse_evaluated');
  });

  it('surfaces explainable signals for high burst velocity', () => {
    const req: AbuseEvaluationRequest = {
      ...baseRequest,
      historySnapshot: {
        ...baseRequest.historySnapshot,
        operationCountLastHour: 15, // exceeds burst limit of 10
      },
    };
    const result = evaluateAbuseRisk(req);
    expect(result.riskScore).toBe(30);
    expect(result.action).toBe('allow'); // 30 is below stepUpThreshold (40)
    expect(result.signals.some((s) => s.code === 'HIGH_VELOCITY_BURST')).toBe(true);
    const signal = result.signals.find((s) => s.code === 'HIGH_VELOCITY_BURST');
    expect(signal?.message).toMatch(/high frequency/i);
    expect(signal?.remediation).toBeDefined();
  });

  it('triggers step-up challenge when risk crosses stepUpThreshold', () => {
    // 30 (velocity) + 15 (moderate failures) = 45 (> 40 threshold)
    const req: AbuseEvaluationRequest = {
      ...baseRequest,
      historySnapshot: {
        ...baseRequest.historySnapshot,
        operationCountLastHour: 12,
        failedAttemptsLast15Minutes: 3,
      },
    };
    const result = evaluateAbuseRisk(req);
    expect(result.riskScore).toBe(45);
    expect(result.action).toBe('step_up');
    expect(result.stepUpChallenge).toBeDefined();
    expect(result.stepUpChallenge?.required).toBe(true);
    expect(result.stepUpChallenge?.token).toBeDefined();
    expect(result.stepUpChallenge?.challengeType).toBe('mfa_totp');
    expect(result.telemetryEvent.eventType).toBe('step_up_requested');
  });

  it('clears step-up challenge and allows execution when valid stepUpProof is presented', () => {
    const req: AbuseEvaluationRequest = {
      ...baseRequest,
      historySnapshot: {
        ...baseRequest.historySnapshot,
        operationCountLastHour: 12,
        failedAttemptsLast15Minutes: 3,
      },
      stepUpProof: {
        token: 'stepup-valid-token',
        verified: true,
        challengeType: 'mfa_totp',
      },
    };
    const result = evaluateAbuseRisk(req);
    expect(result.riskScore).toBe(45);
    expect(result.action).toBe('allow'); // Step up verified!
  });

  it('quarantines for review when suspicious combined signals cross reviewThreshold', () => {
    // 30 (burst) + 35 (high failure rate) + 20 (VPN) = 85 (crosses 70 reviewThreshold)
    const req: AbuseEvaluationRequest = {
      ...baseRequest,
      historySnapshot: {
        ...baseRequest.historySnapshot,
        operationCountLastHour: 12,
        failedAttemptsLast15Minutes: 5,
      },
      clientContext: {
        isVpnOrTor: true,
      },
    };
    const result = evaluateAbuseRisk(req);
    expect(result.riskScore).toBe(85);
    expect(result.action).toBe('review');
    expect(result.telemetryEvent.eventType).toBe('review_quarantined');
    expect(result.signals.length).toBeGreaterThanOrEqual(3);
  });

  it('immediately blocks critical abuse scenarios (score >= 90)', () => {
    // 50 (critical burst) + 35 (high failure rate) + 20 (VPN) = 105 -> capped at 100
    const req: AbuseEvaluationRequest = {
      ...baseRequest,
      historySnapshot: {
        ...baseRequest.historySnapshot,
        operationCountLastHour: 25,
        failedAttemptsLast15Minutes: 6,
      },
      clientContext: {
        isVpnOrTor: true,
      },
    };
    const result = evaluateAbuseRisk(req);
    expect(result.riskScore).toBe(100);
    expect(result.action).toBe('block');
    expect(result.telemetryEvent.eventType).toBe('abuse_blocked');
    expect(result.signals.some((s) => s.code === 'BURST_VELOCITY_CRITICAL')).toBe(true);
  });

  it('flags unauthorized governance update attempts with critical signal', () => {
    const req: AbuseEvaluationRequest = {
      ...baseRequest,
      operation: 'update_governance',
      actor: { id: 'G_MEMBER', role: 'contributor' }, // Not admin
    };
    const result = evaluateAbuseRisk(req);
    expect(result.signals.some((s) => s.code === 'GOVERNANCE_PRIVILEGE_ELEVATION')).toBe(true);
    expect(result.riskScore).toBeGreaterThanOrEqual(60);
    expect(result.action).toBe('step_up');
  });

  it('flags unusually large transaction amounts', () => {
    const req: AbuseEvaluationRequest = {
      ...baseRequest,
      payload: {
        amount: '150000000000', // 15,000 XLM > 10,000 XLM threshold
      },
    };
    const result = evaluateAbuseRisk(req);
    expect(result.signals.some((s) => s.code === 'UNUSUAL_LARGE_VOLUME')).toBe(true);
    expect(result.riskScore).toBe(30);
  });

  it('produces deterministic evaluation IDs for identical inputs', () => {
    const timeFn = () => 1_700_000_000_000;
    const res1 = evaluateAbuseRisk(baseRequest, DEFAULT_ABUSE_CONFIG, timeFn);
    const res2 = evaluateAbuseRisk(baseRequest, DEFAULT_ABUSE_CONFIG, timeFn);
    expect(res1.evaluationId).toBe(res2.evaluationId);
    expect(res1.riskScore).toBe(res2.riskScore);
  });
});
