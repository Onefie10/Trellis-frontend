import { 
  isProposalApproved, 
  isTimelockExpired, 
  calculateDelegatedVotingPower 
} from '@/lib/governance/stellar-governance';
import type { GovernanceConfig, Proposal, Delegation } from '@/lib/governance/types';

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
};

function makeProposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: '1',
    title: 'Test',
    description: 'desc',
    type: 'update_params',
    creator: 'CREATOR',
    createdAt: new Date().toISOString(),
    startTime: new Date().toISOString(),
    endTime: new Date().toISOString(),
    status: 'active',
    action: {
      type: 'update_params',
      params: { a: 1 },
    },
    approvals: 0,
    rejections: 0,
    abstentions: 0,
    totalVotingPowerAtCreation: 100,
    ...overrides,
  };
}

describe('isProposalApproved', () => {
  it('fails when quorum not reached', () => {
    const proposal = makeProposal({
      approvals: 5,
      rejections: 0,
      abstentions: 0,
      totalVotingPowerAtCreation: 100,
    });
    const approved = isProposalApproved(proposal, 100, baseConfig);
    expect(approved).toBe(false);
  });

  it('fails when approval ratio below threshold', () => {
    const proposal = makeProposal({
      approvals: 30,
      rejections: 30,
      abstentions: 0,
      totalVotingPowerAtCreation: 100,
    });
    const approved = isProposalApproved(proposal, 100, baseConfig);
    expect(approved).toBe(false);
  });

  it('passes when quorum and approval threshold met', () => {
    const proposal = makeProposal({
      approvals: 70,
      rejections: 10,
      abstentions: 0,
      totalVotingPowerAtCreation: 100,
    });
    const approved = isProposalApproved(proposal, 100, baseConfig);
    expect(approved).toBe(true);
  });

  describe('with quadratic voting enabled', () => {
    const quadConfig: GovernanceConfig = {
      ...baseConfig,
      useQuadraticVoting: true,
    };

    it('uses quadratic weight scaling to overturn whale-dominated vote', () => {
      // Linear: 10,000 approvals vs 10,000 rejections (50% approval, fails 60% requirement)
      // Quadratic: 1,000 approvals vs 100 rejections (90.9% approval, passes 60% requirement)
      const proposal = makeProposal({
        approvals: 10000,
        rejections: 10000,
        abstentions: 0,
        totalVotingPowerAtCreation: 25000,
        quadraticApprovals: 1000,
        quadraticRejections: 100,
        quadraticAbstentions: 0,
        totalQuadraticVotingPowerAtCreation: 1200,
      });

      // Linear check fails
      expect(isProposalApproved(proposal, 25000, baseConfig)).toBe(false);

      // Quadratic check passes
      expect(isProposalApproved(proposal, 25000, quadConfig)).toBe(true);
    });

    it('fails when quadratic quorum is not reached', () => {
      const proposal = makeProposal({
        approvals: 100,
        rejections: 0,
        abstentions: 0,
        quadraticApprovals: 10,
        quadraticRejections: 0,
        quadraticAbstentions: 0,
        totalQuadraticVotingPowerAtCreation: 1000, // minQuorumRatio (0.2) requires 200 votes
      });

      expect(isProposalApproved(proposal, 1000000, quadConfig)).toBe(false);
    });
  });
});


describe('isTimelockExpired', () => {
  it('returns false if executionEta is not set', () => {
    const proposal = makeProposal({ executionEta: undefined });
    expect(isTimelockExpired(proposal)).toBe(false);
  });

  it('returns false if executionEta is in the future', () => {
    const futureDate = new Date(Date.now() + 10000).toISOString();
    const proposal = makeProposal({ executionEta: futureDate });
    expect(isTimelockExpired(proposal)).toBe(false);
  });

  it('returns true if executionEta is in the past', () => {
    const pastDate = new Date(Date.now() - 10000).toISOString();
    const proposal = makeProposal({ executionEta: pastDate });
    expect(isTimelockExpired(proposal)).toBe(true);
  });
});

describe('calculateDelegatedVotingPower', () => {
  const balances = {
    'alice': 100,
    'bob': 50,
    'charlie': 25,
    'dave': 0,
  };

  it('returns own balance if no delegations', () => {
    expect(calculateDelegatedVotingPower('alice', [], balances)).toBe(100);
  });

  it('adds delegated voting power correctly', () => {
    const delegations = [
      { delegator: 'bob', delegate: 'alice', weight: 1 },
      { delegator: 'charlie', delegate: 'alice', weight: 1 },
    ];
    expect(calculateDelegatedVotingPower('alice', delegations as any, balances)).toBe(175);
  });

  it('returns 0 if account not in balances and no delegations', () => {
    expect(calculateDelegatedVotingPower('eve', [], balances)).toBe(0);
  });
});

