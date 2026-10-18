import { evaluateAbuseRisk, DEFAULT_ABUSE_CONFIG } from '../lib/protocol/abuse-detection.ts';

let passed = 0;
let failed = 0;

function assert(description, condition, details = '') {
  if (condition) {
    passed++;
    console.log(`  ✔ PASS: ${description}`);
  } else {
    failed++;
    console.error(`  ✖ FAIL: ${description}${details ? ` -> ${details}` : ''}`);
  }
}

console.log('--- Testing Risk-Scored Abuse Detection ---');

const base = {
  operation: 'transfer_funds',
  environment: 'production',
  actorId: 'G_ACTOR_1',
  actor: { id: 'G_ACTOR_1', role: 'contributor' },
  payload: { amount: '1000000', destination: 'G_DEST_1' },
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

// 1. Normal low risk
const lowRisk = evaluateAbuseRisk(base);
assert('Normal low-risk operation has action=allow', lowRisk.action === 'allow');
assert('Normal low-risk operation has score=0', lowRisk.riskScore === 0);
assert('Normal low-risk operation has no step-up challenge', lowRisk.stepUpChallenge === undefined);

// 2. High velocity
const highVel = evaluateAbuseRisk({
  ...base,
  historySnapshot: { ...base.historySnapshot, operationCountLastHour: 15 },
});
assert('High burst velocity signals HIGH_VELOCITY_BURST', highVel.signals.some(s => s.code === 'HIGH_VELOCITY_BURST'));
assert('High burst velocity has weight 30', highVel.riskScore === 30);

// 3. Step up challenge (velocity 30 + moderate failures 15 = 45 >= 40)
const stepUp = evaluateAbuseRisk({
  ...base,
  historySnapshot: {
    ...base.historySnapshot,
    operationCountLastHour: 12,
    failedAttemptsLast15Minutes: 3,
  },
});
assert('Action is step_up when riskScore crosses 40', stepUp.action === 'step_up');
assert('Step up challenge is generated', stepUp.stepUpChallenge !== undefined && stepUp.stepUpChallenge.required === true);
assert('Step up challenge has token and type', typeof stepUp.stepUpChallenge.token === 'string' && stepUp.stepUpChallenge.challengeType === 'mfa_totp');

// 4. Step up bypass with valid proof
const stepUpVerified = evaluateAbuseRisk({
  ...base,
  historySnapshot: {
    ...base.historySnapshot,
    operationCountLastHour: 12,
    failedAttemptsLast15Minutes: 3,
  },
  stepUpProof: {
    token: 'stepup-xyz',
    verified: true,
    challengeType: 'mfa_totp',
  },
});
assert('Step-up verified proof allows operation to proceed', stepUpVerified.action === 'allow');

// 5. Review quarantine (30 + 35 + 20 = 85 >= 70)
const review = evaluateAbuseRisk({
  ...base,
  historySnapshot: {
    ...base.historySnapshot,
    operationCountLastHour: 12,
    failedAttemptsLast15Minutes: 5,
  },
  clientContext: { isVpnOrTor: true },
});
assert('Action is review when riskScore crosses 70', review.action === 'review');
assert('Telemetry event indicates review_quarantined', review.telemetryEvent.eventType === 'review_quarantined');

// 6. Critical block (50 + 35 + 20 = 100 >= 90)
const blocked = evaluateAbuseRisk({
  ...base,
  historySnapshot: {
    ...base.historySnapshot,
    operationCountLastHour: 25,
    failedAttemptsLast15Minutes: 6,
  },
  clientContext: { isVpnOrTor: true },
});
assert('Action is block when riskScore crosses 90', blocked.action === 'block');
assert('Telemetry event indicates abuse_blocked', blocked.telemetryEvent.eventType === 'abuse_blocked');

// 7. Large volume anomaly
const largeVol = evaluateAbuseRisk({
  ...base,
  payload: { amount: '200000000000' }, // 20,000 XLM
});
assert('Large transaction volume flags UNUSUAL_LARGE_VOLUME', largeVol.signals.some(s => s.code === 'UNUSUAL_LARGE_VOLUME'));

// 8. Governance privilege elevation
const gov = evaluateAbuseRisk({
  ...base,
  operation: 'update_governance',
  actor: { id: 'G_MEMBER', role: 'contributor' },
});
assert('Non-admin governance update flags GOVERNANCE_PRIVILEGE_ELEVATION', gov.signals.some(s => s.code === 'GOVERNANCE_PRIVILEGE_ELEVATION'));
assert('Governance privilege elevation carries high risk score', gov.riskScore >= 60);

// 9. Determinism test
const t0 = () => 1_700_000_000_000;
const det1 = evaluateAbuseRisk(base, DEFAULT_ABUSE_CONFIG, t0);
const det2 = evaluateAbuseRisk(base, DEFAULT_ABUSE_CONFIG, t0);
assert('Evaluation IDs are deterministic across calls', det1.evaluationId === det2.evaluationId);

console.log(`\nTotal: ${passed + failed} | Passed: ${passed} | Failed: ${failed}`);
if (failed > 0) {
  process.exit(1);
}
