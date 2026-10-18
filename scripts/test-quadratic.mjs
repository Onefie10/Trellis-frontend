import assert from 'node:assert';

// 1. Quadratic voting weight calculation tests
function calculateQuadraticVotingWeight(stakedBalance, options = {}) {
  if (stakedBalance === null || stakedBalance === undefined) return 0;
  let numericBalance;
  if (typeof stakedBalance === 'bigint') {
    numericBalance = Number(stakedBalance);
  } else if (typeof stakedBalance === 'string') {
    const trimmed = stakedBalance.trim();
    if (trimmed === '') return 0;
    numericBalance = parseFloat(trimmed);
  } else {
    numericBalance = stakedBalance;
  }
  if (isNaN(numericBalance) || numericBalance <= 0 || !isFinite(numericBalance)) return 0;

  const rawWeight = Math.sqrt(numericBalance);
  const precision = options.precision !== undefined ? options.precision : 4;
  const roundMode = options.roundMode || 'round';

  if (precision === null) return rawWeight;
  const factor = Math.pow(10, precision);
  let rounded;
  switch (roundMode) {
    case 'floor':
      rounded = Math.floor(rawWeight * factor) / factor;
      break;
    case 'ceil':
      rounded = Math.ceil(rawWeight * factor) / factor;
      break;
    case 'round':
    default:
      rounded = Math.round((rawWeight + Number.EPSILON) * factor) / factor;
      break;
  }
  return rounded;
}

// Test square roots
assert.strictEqual(calculateQuadraticVotingWeight(0), 0);
assert.strictEqual(calculateQuadraticVotingWeight(1), 1);
assert.strictEqual(calculateQuadraticVotingWeight(4), 2);
assert.strictEqual(calculateQuadraticVotingWeight(9), 3);
assert.strictEqual(calculateQuadraticVotingWeight(16), 4);
assert.strictEqual(calculateQuadraticVotingWeight(25), 5);
assert.strictEqual(calculateQuadraticVotingWeight(100), 10);
assert.strictEqual(calculateQuadraticVotingWeight(10000), 100);
assert.strictEqual(calculateQuadraticVotingWeight(1000000), 1000);

// Test non-perfect squares & precision
assert.strictEqual(calculateQuadraticVotingWeight(2), 1.4142);
assert.strictEqual(calculateQuadraticVotingWeight(2, { precision: 2 }), 1.41);
assert.strictEqual(calculateQuadraticVotingWeight(2, { precision: 0 }), 1);
assert.strictEqual(calculateQuadraticVotingWeight(2, { precision: 3, roundMode: 'floor' }), 1.414);
assert.strictEqual(calculateQuadraticVotingWeight(2, { precision: 3, roundMode: 'ceil' }), 1.415);

// Test fractional balances & edge cases
assert.strictEqual(calculateQuadraticVotingWeight(0.25), 0.5);
assert.strictEqual(calculateQuadraticVotingWeight(0.04), 0.2);
assert.strictEqual(calculateQuadraticVotingWeight(0.01), 0.1);
assert.strictEqual(calculateQuadraticVotingWeight(0.0001), 0.01);
assert.strictEqual(calculateQuadraticVotingWeight(0.0000001), 0.0003);

// Test invalid/negative inputs
assert.strictEqual(calculateQuadraticVotingWeight(-10), 0);
assert.strictEqual(calculateQuadraticVotingWeight(NaN), 0);
assert.strictEqual(calculateQuadraticVotingWeight(Infinity), 0);
assert.strictEqual(calculateQuadraticVotingWeight(null), 0);
assert.strictEqual(calculateQuadraticVotingWeight(undefined), 0);
assert.strictEqual(calculateQuadraticVotingWeight(''), 0);
assert.strictEqual(calculateQuadraticVotingWeight('invalid'), 0);
assert.strictEqual(calculateQuadraticVotingWeight('100'), 10);
assert.strictEqual(calculateQuadraticVotingWeight(BigInt(100)), 10);

console.log('✓ All Quadratic Voting Calculator tests passed!');

// 2. Sybil Resistance tests
function evaluateSybilResistance(accountData, requirements = {}) {
  const reqs = {
    minAccountAgeDays: 30,
    minTransactionCount: 5,
    ...requirements,
  };
  const now = Date.now();
  let createdTimeMs = null;
  let createdAtStr = null;
  if (accountData.createdAt) {
    const parsed = new Date(accountData.createdAt);
    if (!isNaN(parsed.getTime())) {
      createdTimeMs = parsed.getTime();
      createdAtStr = parsed.toISOString();
    }
  }
  const accountAgeDays =
    createdTimeMs !== null
      ? Math.max(0, Math.floor((now - createdTimeMs) / (1000 * 60 * 60 * 24)))
      : 0;
  const transactionCount = Math.max(0, accountData.transactionCount || 0);
  const passedAccountAge =
    createdTimeMs !== null && accountAgeDays >= reqs.minAccountAgeDays;
  const passedTransactionCount = transactionCount >= reqs.minTransactionCount;
  return {
    isVerified: passedAccountAge && passedTransactionCount,
    accountAgeDays,
    transactionCount,
    passedAccountAge,
    passedTransactionCount,
  };
}

const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
const res1 = evaluateSybilResistance({ createdAt: tenDaysAgo, transactionCount: 20 });
assert.strictEqual(res1.isVerified, false);
assert.strictEqual(res1.passedAccountAge, false);
assert.strictEqual(res1.passedTransactionCount, true);

const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
const res2 = evaluateSybilResistance({ createdAt: sixtyDaysAgo, transactionCount: 2 });
assert.strictEqual(res2.isVerified, false);
assert.strictEqual(res2.passedAccountAge, true);
assert.strictEqual(res2.passedTransactionCount, false);

const verified = evaluateSybilResistance({ createdAt: sixtyDaysAgo, transactionCount: 15 });
assert.strictEqual(verified.isVerified, true);
assert.strictEqual(verified.passedAccountAge, true);
assert.strictEqual(verified.passedTransactionCount, true);

console.log('✓ All Sybil Resistance verification tests passed!');

// 3. Whale Mitigation Comparison test
const whaleLinear = 10000;
const communityCount = 100;
const communityTokenEach = 100;
const communityTotalTokens = communityCount * communityTokenEach; // 10,000

const whaleQuad = calculateQuadraticVotingWeight(whaleLinear); // 100
const communityQuad = communityCount * calculateQuadraticVotingWeight(communityTokenEach); // 100 * 10 = 1000

const linearApprovalRatio = communityTotalTokens / (communityTotalTokens + whaleLinear); // 50%
const quadApprovalRatio = communityQuad / (communityQuad + whaleQuad); // 1000 / 1100 = 90.9%

assert.strictEqual(linearApprovalRatio, 0.5);
assert.ok(quadApprovalRatio > 0.9);
console.log(`✓ Whale mitigation verified: Linear Approval = ${linearApprovalRatio * 100}%, Quadratic Approval = ${(quadApprovalRatio * 100).toFixed(1)}%!`);

// 4. Governance isProposalApproved test
function isProposalApproved(proposal, totalVotingPower, config) {
  if (config.useQuadraticVoting) {
    const quadApprovals =
      proposal.quadraticApprovals ??
      (proposal.approvals > 0 ? Math.sqrt(proposal.approvals) : 0);
    const quadRejections =
      proposal.quadraticRejections ??
      (proposal.rejections > 0 ? Math.sqrt(proposal.rejections) : 0);
    const quadAbstentions =
      proposal.quadraticAbstentions ??
      (proposal.abstentions > 0 ? Math.sqrt(proposal.abstentions) : 0);

    const participated = quadApprovals + quadRejections + quadAbstentions;
    const quadTotal =
      proposal.totalQuadraticVotingPowerAtCreation ??
      (totalVotingPower > 0 ? Math.sqrt(totalVotingPower) : 0);

    const quorumReached = participated >= quadTotal * config.minQuorumRatio;
    const approvalRatio = participated === 0 ? 0 : quadApprovals / participated;
    return quorumReached && approvalRatio >= config.requiredApprovalRatio;
  }

  const participated = proposal.approvals + proposal.rejections + proposal.abstentions;
  const quorumReached = participated >= totalVotingPower * config.minQuorumRatio;
  const approvalRatio =
    participated === 0 ? 0 : proposal.approvals / participated;
  return quorumReached && approvalRatio >= config.requiredApprovalRatio;
}

const sampleProposal = {
  approvals: 10000,
  rejections: 10000,
  abstentions: 0,
  totalVotingPowerAtCreation: 25000,
  quadraticApprovals: 1000,
  quadraticRejections: 100,
  quadraticAbstentions: 0,
  totalQuadraticVotingPowerAtCreation: 1200,
};

const linearConfig = { minQuorumRatio: 0.2, requiredApprovalRatio: 0.6, useQuadraticVoting: false };
const quadraticConfig = { minQuorumRatio: 0.2, requiredApprovalRatio: 0.6, useQuadraticVoting: true };

assert.strictEqual(isProposalApproved(sampleProposal, 25000, linearConfig), false);
assert.strictEqual(isProposalApproved(sampleProposal, 25000, quadraticConfig), true);
console.log('✓ Governance isProposalApproved quadratic vs linear test passed!');

