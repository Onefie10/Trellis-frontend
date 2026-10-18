import type { StellarNetwork } from '../types';

export type ProposalType = 'upgrade_agent' | 'update_params' | 'treasury_spend';

export type ProposalStatus = 'pending' | 'active' | 'failed' | 'queued' | 'executed' | 'expired';

export interface GovernanceConfig {
  network: StellarNetwork;
  governanceAccount: string; // multisig account that owns the agent
  treasuryAccount: string; // XLM treasury account
  governanceToken: {
    code: string;
    issuer: string;
  };
  sorobanContractId: string;
  requiredApprovalRatio: number; // e.g. 0.6 for 60%
  minQuorumRatio: number; // e.g. 0.2 for 20%
  timelockSeconds: number;
  useQuadraticVoting?: boolean;
  minAccountAgeDays?: number;
  minTransactionCount?: number;
  treasuryMultisig?: {
    signers: string[];
    threshold: number;
  };
}

export interface ProposalActionUpgradeAgent {
  type: 'upgrade_agent';
  newCodeHash: string;
}

export interface ProposalActionUpdateParams {
  type: 'update_params';
  params: Record<string, string | number | boolean>;
}

export interface ProposalActionTreasurySpend {
  type: 'treasury_spend';
  amount: string; // XLM in string lumens
  destination: string;
  memo?: string;
}

export type ProposalAction =
  | ProposalActionUpgradeAgent
  | ProposalActionUpdateParams
  | ProposalActionTreasurySpend;

export interface ProposalVoteBreakdown {
  voter: string;
  tokenBalance: number;
  linearVotingPower: number;
  quadraticVotingPower: number;
  choice: VoteChoice;
  timestamp: string;
  isSybilVerified?: boolean;
}

export interface Proposal {
  id: string;
  title: string;
  description: string;
  type: ProposalType;
  creator: string;
  createdAt: string;
  startTime: string;
  endTime: string;
  status: ProposalStatus;
  executionEta?: string;
  action: ProposalAction;
  approvals: number;
  rejections: number;
  abstentions: number;
  totalVotingPowerAtCreation: number;
  quadraticApprovals?: number;
  quadraticRejections?: number;
  quadraticAbstentions?: number;
  totalQuadraticVotingPowerAtCreation?: number;
  votes?: ProposalVoteBreakdown[];
  /** On-chain audit trail: one entry per lifecycle transaction. */
  executionHistory?: ProposalExecutionRecord[];
}

/** Lifecycle steps a governance proposal passes through on-chain. */
export type ProposalLifecycleStep =
  | 'created'
  | 'vote_cast'
  | 'voting_closed'
  | 'queued'
  | 'executed'
  | 'failed'
  | 'expired';

/** A Soroban contract event emitted by a lifecycle transaction. */
export interface ContractEventLog {
  type: 'contract' | 'system' | 'diagnostic';
  contractId?: string;
  /** Decoded topics, e.g. `["proposal", "queued"]`. */
  topics: string[];
  /** Decoded event value, rendered as text. */
  value: string;
}

/** A single on-chain transaction in a proposal's lifecycle. */
export interface ProposalExecutionRecord {
  step: ProposalLifecycleStep;
  txHash?: string;
  ledger?: number;
  /** Fee charged in stroops, as reported by Horizon/RPC. */
  feeChargedStroops?: string;
  /** Raw status as returned by Soroban RPC or Horizon. */
  status?: string;
  timestamp: string;
  actor?: string;
  events?: ContractEventLog[];
}

export type VoteChoice = 'approve' | 'reject' | 'abstain';

export interface Vote {
  proposalId: string;
  voter: string;
  votingPower: number;
  quadraticVotingPower?: number;
  choice: VoteChoice;
  txHash: string;
  timestamp: string;
  isSybilVerified?: boolean;
}

export interface TreasuryBalance {
  account: string;
  balanceXlm: string;
}

export interface TreasuryTransaction {
  id: string;
  type: 'payment' | 'incoming' | 'outgoing';
  source: string;
  destination: string;
  amountXlm: string;
  createdAt: string;
  hash: string;
  memo?: string | null;
}

export interface Delegation {
  delegator: string;
  delegate: string;
  weight: number;
}

