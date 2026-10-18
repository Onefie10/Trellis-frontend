import {
  calculateQuadraticVotingWeight,
  calculateVotingPower,
  compareLinearVsQuadraticVotes,
} from '@/features/governance/utils/quadraticVoting';
import {
  evaluateSybilResistance,
  DEFAULT_SYBIL_REQUIREMENTS,
} from '@/features/governance/utils/sybilResistance';
import { isProposalApproved } from '@/lib/governance/stellar-governance';
import type { GovernanceConfig, Proposal } from '@/lib/governance/types';

describe('Quadratic Voting Weight Calculator', () => {
  describe('Square root voting calculations', () => {
    it('calculates exact square root for perfect squares', () => {
      expect(calculateQuadraticVotingWeight(0)).toBe(0);
      expect(calculateQuadraticVotingWeight(1)).toBe(1);
      expect(calculateQuadraticVotingWeight(4)).toBe(2);
      expect(calculateQuadraticVotingWeight(9)).toBe(3);
      expect(calculateQuadraticVotingWeight(16)).toBe(4);
      expect(calculateQuadraticVotingWeight(25)).toBe(5);
      expect(calculateQuadraticVotingWeight(100)).toBe(10);
      expect(calculateQuadraticVotingWeight(10000)).toBe(100);
      expect(calculateQuadraticVotingWeight(1000000)).toBe(1000);
    });

    it('calculates accurate values for non-perfect squares with default 4 decimal precision', () => {
      expect(calculateQuadraticVotingWeight(2)).toBe(1.4142);
      expect(calculateQuadraticVotingWeight(3)).toBe(1.7321);
      expect(calculateQuadraticVotingWeight(5)).toBe(2.2361);
      expect(calculateQuadraticVotingWeight(10)).toBe(3.1623);
      expect(calculateQuadraticVotingWeight(50)).toBe(7.0711);
    });

    it('handles fractional balances and decimal tokens correctly', () => {
      expect(calculateQuadraticVotingWeight(0.25)).toBe(0.5);
      expect(calculateQuadraticVotingWeight(0.04)).toBe(0.2);
      expect(calculateQuadraticVotingWeight(0.01)).toBe(0.1);
      expect(calculateQuadraticVotingWeight(0.0001)).toBe(0.01);
      // Smallest Stellar stroop (0.0000001 XLM / token)
      expect(calculateQuadraticVotingWeight(0.0000001)).toBe(0.0003);
    });

    it('parses valid numeric string inputs', () => {
      expect(calculateQuadraticVotingWeight('100')).toBe(10);
      expect(calculateQuadraticVotingWeight('  10000  ')).toBe(100);
      expect(calculateQuadraticVotingWeight('0.25')).toBe(0.5);
    });

    it('supports BigInt balances', () => {
      expect(calculateQuadraticVotingWeight(BigInt(100))).toBe(10);
      expect(calculateQuadraticVotingWeight(BigInt(10000))).toBe(100);
    });
  });

  describe('Rounding edge cases and precision options', () => {
    it('supports custom decimal precision', () => {
      expect(calculateQuadraticVotingWeight(2, { precision: 2 })).toBe(1.41);
      expect(calculateQuadraticVotingWeight(2, { precision: 0 })).toBe(1);
      expect(calculateQuadraticVotingWeight(2, { precision: 6 })).toBe(1.414214);
      expect(calculateQuadraticVotingWeight(2, { precision: null })).toBeCloseTo(
        Math.SQRT2,
        10
      );
    });

    it('supports floor and ceil rounding modes', () => {
      // sqrt(2) = 1.41421356...
      expect(calculateQuadraticVotingWeight(2, { precision: 3, roundMode: 'floor' })).toBe(1.414);
      expect(calculateQuadraticVotingWeight(2, { precision: 3, roundMode: 'ceil' })).toBe(1.415);
      expect(calculateQuadraticVotingWeight(2, { precision: 3, roundMode: 'round' })).toBe(1.414);

      // sqrt(8) = 2.828427...
      expect(calculateQuadraticVotingWeight(8, { precision: 2, roundMode: 'floor' })).toBe(2.82);
      expect(calculateQuadraticVotingWeight(8, { precision: 2, roundMode: 'ceil' })).toBe(2.83);
    });

    it('safely handles zero and negative numbers', () => {
      expect(calculateQuadraticVotingWeight(0)).toBe(0);
      expect(calculateQuadraticVotingWeight(-1)).toBe(0);
      expect(calculateQuadraticVotingWeight(-1000)).toBe(0);
      expect(calculateQuadraticVotingWeight('-50')).toBe(0);
    });

    it('safely handles invalid, NaN, infinite, and empty inputs', () => {
      expect(calculateQuadraticVotingWeight(NaN)).toBe(0);
      expect(calculateQuadraticVotingWeight(Infinity)).toBe(0);
      expect(calculateQuadraticVotingWeight(-Infinity)).toBe(0);
      expect(calculateQuadraticVotingWeight(null)).toBe(0);
      expect(calculateQuadraticVotingWeight(undefined)).toBe(0);
      expect(calculateQuadraticVotingWeight('')).toBe(0);
      expect(calculateQuadraticVotingWeight('   ')).toBe(0);
      expect(calculateQuadraticVotingWeight('not-a-number')).toBe(0);
    });
  });

  describe('calculateVotingPower helper', () => {
    it('returns linear balance for linear mode', () => {
      expect(calculateVotingPower(100, 'linear')).toBe(100);
      expect(calculateVotingPower('500', 'linear')).toBe(500);
      expect(calculateVotingPower(-10, 'linear')).toBe(0);
      expect(calculateVotingPower('invalid', 'linear')).toBe(0);
    });

    it('returns quadratic weight for quadratic mode', () => {
      expect(calculateVotingPower(100, 'quadratic')).toBe(10);
      expect(calculateVotingPower(10000, 'quadratic')).toBe(100);
    });
  });

  describe('Linear vs Quadratic Comparison and Whale Mitigation', () => {
    it('demonstrates whale mitigation where quadratic voting allows community to overturn whale dominance', () => {
      // Whale has 10,000 tokens and votes reject
      // 100 community members have 100 tokens each (total 10,000 tokens) and vote approve
      const votes = [
        { voter: 'G_WHALE', tokenBalance: 10000, choice: 'reject' as const, isSybilVerified: true },
        ...Array.from({ length: 100 }, (_, i) => ({
          voter: `G_COMMUNITY_${i}`,
          tokenBalance: 100,
          choice: 'approve' as const,
          isSybilVerified: true,
        })),
      ];

      const comparison = compareLinearVsQuadraticVotes(votes, {
        requiredApprovalRatio: 0.6,
        minQuorumRatio: 0.2,
      });

      // Under Linear Voting:
      // Approvals = 10,000, Rejections = 10,000. Total = 20,000.
      // Approval Ratio = 50%, below 60% requirement -> REJECTED
      expect(comparison.linearTally.approvals).toBe(10000);
      expect(comparison.linearTally.rejections).toBe(10000);
      expect(comparison.linearTally.approvalRatio).toBe(0.5);
      expect(comparison.linearOutcome).toBe('rejected');

      // Under Quadratic Voting:
      // Whale: sqrt(10000) = 100 votes
      // Community: 100 * sqrt(100) = 100 * 10 = 1,000 votes!
      // Total Quad Votes = 1,100.
      // Approval Ratio = 1,000 / 1,100 = 90.9% -> PASSED!
      expect(comparison.quadraticTally.rejections).toBe(100);
      expect(comparison.quadraticTally.approvals).toBe(1000);
      expect(comparison.quadraticTally.approvalRatio).toBeCloseTo(0.909, 2);
      expect(comparison.quadraticOutcome).toBe('approved');

      // Outcome was flipped by community consensus!
      expect(comparison.outcomeFlipped).toBe(true);
      expect(comparison.whaleInfluenceReductionPercent).toBeGreaterThan(0);
    });

    it('correctly tracks holder tiers and calculates whale reduction percentage', () => {
      const votes = [
        { voter: 'G_WHALE', tokenBalance: 50000, choice: 'reject' as const },
        { voter: 'G_USER1', tokenBalance: 500, choice: 'approve' as const },
        { voter: 'G_USER2', tokenBalance: 100, choice: 'approve' as const },
      ];

      const comparison = compareLinearVsQuadraticVotes(votes);
      expect(comparison.distributionByTier.length).toBe(4);
      expect(comparison.whaleInfluenceReductionPercent).toBeGreaterThan(0);
    });
  });

  describe('Sybil-Resistance Verification Check', () => {
    it('fails accounts younger than minimum account age', () => {
      const now = Date.now();
      const tenDaysAgo = new Date(now - 10 * 24 * 60 * 60 * 1000);

      const result = evaluateSybilResistance({
        createdAt: tenDaysAgo,
        transactionCount: 20,
      });

      expect(result.isVerified).toBe(false);
      expect(result.passedAccountAge).toBe(false);
      expect(result.passedTransactionCount).toBe(true);
      expect(result.reasons[0]).toContain('less than required minimum of 30 days');
    });

    it('fails accounts with insufficient transaction history', () => {
      const now = Date.now();
      const sixtyDaysAgo = new Date(now - 60 * 24 * 60 * 60 * 1000);

      const result = evaluateSybilResistance({
        createdAt: sixtyDaysAgo,
        transactionCount: 2, // Required is 5
      });

      expect(result.isVerified).toBe(false);
      expect(result.passedAccountAge).toBe(true);
      expect(result.passedTransactionCount).toBe(false);
      expect(result.reasons[0]).toContain('lower than required minimum of 5 transactions');
    });

    it('passes verified accounts meeting both age and transaction thresholds', () => {
      const now = Date.now();
      const ninetyDaysAgo = new Date(now - 90 * 24 * 60 * 60 * 1000);

      const result = evaluateSybilResistance({
        createdAt: ninetyDaysAgo,
        transactionCount: 25,
      });

      expect(result.isVerified).toBe(true);
      expect(result.passedAccountAge).toBe(true);
      expect(result.passedTransactionCount).toBe(true);
      expect(result.reasons.length).toBe(0);
    });

    it('handles missing creation date gracefully', () => {
      const result = evaluateSybilResistance({
        createdAt: null,
        transactionCount: 10,
      });

      expect(result.isVerified).toBe(false);
      expect(result.accountAgeDays).toBe(0);
      expect(result.passedAccountAge).toBe(false);
    });
  });
});

describe('Governance Approval with Quadratic Voting', () => {
  const baseConfig: GovernanceConfig = {
    network: 'testnet',
    governanceAccount: 'GOV',
    treasuryAccount: 'TREASURY',
    governanceToken: {
      code: 'GOV',
      issuer: 'ISSUER',
    },
    sorobanContractId: 'CONTRACT',
    requiredApprovalRatio: 0.6,
    minQuorumRatio: 0.2,
    timelockSeconds: 3600,
    useQuadraticVoting: true,
  };

  const sampleProposal: Proposal = {
    id: 'prop-1',
    title: 'Test Quadratic Proposal',
    description: 'Testing quadratic voting in proposal approvals',
    type: 'update_params',
    creator: 'CREATOR',
    createdAt: new Date().toISOString(),
    startTime: new Date().toISOString(),
    endTime: new Date().toISOString(),
    status: 'active',
    action: {
      type: 'update_params',
      params: { fee: 5 },
    },
    approvals: 10000,
    rejections: 10000,
    abstentions: 0,
    totalVotingPowerAtCreation: 25000,
    quadraticApprovals: 1000,
    quadraticRejections: 100,
    quadraticAbstentions: 0,
    totalQuadraticVotingPowerAtCreation: 1200,
  };

  it('fails under linear voting but passes under quadratic voting', () => {
    // Under linear: 10,000 / 20,000 = 50% (fails 60% requirement)
    const linearApproved = isProposalApproved(
      sampleProposal,
      25000,
      { ...baseConfig, useQuadraticVoting: false }
    );
    expect(linearApproved).toBe(false);

    // Under quadratic: 1,000 / 1,100 = 90.9% (passes 60% requirement)
    const quadraticApproved = isProposalApproved(
      sampleProposal,
      25000,
      { ...baseConfig, useQuadraticVoting: true }
    );
    expect(quadraticApproved).toBe(true);
  });
});
