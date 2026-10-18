'use client';

import React, { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useStellarWallet } from '@/components/context/StellarWalletProvider';
import { formatXlmAmount } from '@/lib/stellar';
import {
  GovernanceConfig,
  Proposal,
  VoteChoice,
  TreasuryBalance,
  TreasuryTransaction,
} from '@/lib/governance/types';
import {
  getTreasuryBalance,
  getTreasuryHistory,
  isProposalApproved,
  isTimelockExpired,
  getVotingPowerForAccount,
} from '@/lib/governance/stellar-governance';
import { calculateQuadraticVotingWeight } from '../utils/quadraticVoting';
import { ProposalDetailModal } from './ProposalDetailModal';
import { MultisigTransactionBuilder } from './MultisigTransactionBuilder';
import { VoteDelegation } from './VoteDelegation';
import { getNetworkPassphrase } from '@/lib/stellar';
import { buildTreasurySpendEnvelope } from '@/lib/governance/multisig';
import {
  verifyStellarAccountSybilResistance,
  type SybilVerificationResult,
} from '../utils/sybilResistance';

function TimelockCountdown({ executionEta }: { executionEta: string; onExpire?: () => void }) {
  return (
    <span className="px-2 py-0.5 rounded text-[10px] bg-amber-500/20 text-amber-300 font-mono">
      ETA: {new Date(executionEta).toLocaleTimeString()}
    </span>
  );
}

interface GovernanceDashboardProps {
  config: GovernanceConfig;
  proposals: Proposal[];
  onCreateProposal: () => void;
  onVote: (proposal: Proposal, choice: VoteChoice) => void;
  onQueue?: (proposal: Proposal) => void;
  onExecute: (proposal: Proposal) => void;
  onDelegate?: (delegateAddress: string) => Promise<void>;
  isVoting?: boolean;
}

export function GovernanceDashboard({
  config,
  proposals,
  onCreateProposal,
  onVote,
  onQueue,
  onExecute,
  onDelegate,
  isVoting = false,
}: GovernanceDashboardProps) {
  const { wallet } = useStellarWallet();
  const [selectedProposal, setSelectedProposal] = React.useState<Proposal | null>(null);
  const [multisigProposal, setMultisigProposal] = React.useState<Proposal | null>(null);

  const { data: userVotingPower } = useQuery<{
    tokenBalance: number;
    quadraticWeight: number;
    sybilStatus: SybilVerificationResult;
  }>({
    queryKey: ['user-voting-power', wallet?.publicKey, config.network],
    queryFn: async () => {
      if (!wallet?.publicKey) {
        return {
          tokenBalance: 0,
          quadraticWeight: 0,
          sybilStatus: {
            isVerified: false,
            accountAgeDays: 0,
            transactionCount: 0,
            passedAccountAge: false,
            passedTransactionCount: false,
            accountCreatedAt: null,
            reasons: ['Wallet not connected'],
            warnings: [],
          },
        };
      }

      let balance = 0;
      try {
        balance = await getVotingPowerForAccount(wallet.publicKey, config);
      } catch (e) {
        // Fallback or demo default
        balance = 100;
      }

      const sybilStatus = await verifyStellarAccountSybilResistance(
        wallet.publicKey,
        config.network,
        {
          minAccountAgeDays: config.minAccountAgeDays ?? 30,
          minTransactionCount: config.minTransactionCount ?? 5,
        }
      );

      const quadraticWeight = calculateQuadraticVotingWeight(balance);

      return {
        tokenBalance: balance,
        quadraticWeight,
        sybilStatus,
      };
    },
    enabled: !!wallet?.publicKey,
  });

  const { data: treasuryBalance } = useQuery<TreasuryBalance>({
    queryKey: ['treasury-balance', config.treasuryAccount, config.network],
    queryFn: () => getTreasuryBalance(config),
    refetchInterval: 15_000,
  });

  const { data: treasuryHistory } = useQuery<TreasuryTransaction[]>({
    queryKey: ['treasury-history', config.treasuryAccount, config.network],
    queryFn: () => getTreasuryHistory(config),
    refetchInterval: 30_000,
  });

  return (
    <div className="space-y-8">
      <header className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold glow-text">Agent Governance</h1>
          <p className="text-gray-300">
            Manage upgrades, parameters, and treasury for this agent via Stellar multisig
            and Soroban voting.
          </p>
        </div>
        <button
          onClick={onCreateProposal}
          className="px-4 py-2 rounded-lg bg-gradient-to-r from-trellis-vine to-trellis-leaf font-semibold hover:shadow-lg hover:shadow-trellis-vine/40 transition-smooth disabled:opacity-50"
          disabled={!wallet}
        >
          Create Proposal
        </button>
      </header>

      <section className="grid md:grid-cols-4 gap-6">
        <div className="p-4 rounded-lg border border-trellis-vine/40 nebula-bg">
          <h2 className="text-lg font-semibold glow-text mb-2">Treasury (XLM)</h2>
          <p className="text-3xl font-bold">
            {treasuryBalance ? formatXlmAmount(treasuryBalance.balanceXlm) : '...'}
          </p>
          <p className="text-xs text-gray-400 break-all mt-2">
            {config.treasuryAccount}
          </p>
        </div>
        <div className="p-4 rounded-lg border border-trellis-vine/40 nebula-bg">
          <h2 className="text-lg font-semibold glow-text mb-2">Quorum & Approval</h2>
          <p className="text-xl">
            {Math.round(config.minQuorumRatio * 100)}% quorum
          </p>
          <p className="text-sm text-gray-400">
            {Math.round(config.requiredApprovalRatio * 100)}% approvals to pass
          </p>
        </div>
        <div className="p-4 rounded-lg border border-trellis-vine/40 nebula-bg">
          <h2 className="text-lg font-semibold glow-text mb-2">Voting Mechanism</h2>
          <p className="text-xl text-emerald-300 font-semibold flex items-center gap-1.5">
            <span>Quadratic Voting</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/20 border border-emerald-500/30">
              √Tokens
            </span>
          </p>
          <p className="text-xs text-gray-400 mt-1">
            Balances whale vs community influence
          </p>
        </div>
        <div className="p-4 rounded-lg border border-trellis-vine/40 nebula-bg">
          <h2 className="text-lg font-semibold glow-text mb-2">Sybil Shield</h2>
          {wallet ? (
            <div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-emerald-400">
                  {userVotingPower?.sybilStatus?.isVerified ? '✓ Verified Account' : '⚠️ Sybil Check Pending'}
                </span>
              </div>
              <p className="text-xs text-gray-400 mt-1">
                Your Power: <strong className="text-emerald-300 font-mono">{userVotingPower?.quadraticWeight.toFixed(2)} votes</strong>
              </p>
            </div>
          ) : (
            <p className="text-xs text-gray-400">Connect wallet to verify account</p>
          )}
        </div>
      </section>

      <section className="grid lg:grid-cols-3 gap-8">
        <div className="lg:col-span-2 space-y-4">
          
          {onDelegate && (
            <div className="mb-6">
              <VoteDelegation onDelegate={onDelegate} />
            </div>
          )}

          <div className="flex items-center justify-between">
            <h2 className="text-2xl font-semibold glow-text">Proposals</h2>
          </div>

          <div className="space-y-3">
            {proposals.length === 0 && (
              <p className="text-gray-400 text-sm">No proposals yet. Be the first to create one.</p>
            )}
            {proposals.map((proposal) => {
              const totalLinearVotes =
                proposal.approvals + proposal.rejections + proposal.abstentions;
              const linearApprovalRatio =
                totalLinearVotes === 0 ? 0 : proposal.approvals / totalLinearVotes;

              // Quadratic voting tallies
              const quadApprovals =
                proposal.quadraticApprovals ??
                (proposal.approvals > 0 ? Math.sqrt(proposal.approvals) : 0);
              const quadRejections =
                proposal.quadraticRejections ??
                (proposal.rejections > 0 ? Math.sqrt(proposal.rejections) : 0);
              const quadAbstentions =
                proposal.quadraticAbstentions ??
                (proposal.abstentions > 0 ? Math.sqrt(proposal.abstentions) : 0);

              const totalQuadVotes = quadApprovals + quadRejections + quadAbstentions;
              const quadApprovalRatio =
                totalQuadVotes === 0 ? 0 : quadApprovals / totalQuadVotes;

              const approved = isProposalApproved(
                proposal,
                proposal.totalVotingPowerAtCreation,
                { ...config, useQuadraticVoting: true }
              );
              const timelockExpired = isTimelockExpired(proposal);

              return (
                <div
                  key={proposal.id}
                  className="p-5 rounded-xl border border-trellis-vine/40 hover:border-trellis-vine/70 transition-smooth nebula-bg space-y-3"
                >
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <h3 className="text-lg font-semibold glow-text">
                        {proposal.title}
                      </h3>
                      <p className="text-xs text-gray-400">
                        {proposal.type} • Created by {proposal.creator}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      {proposal.status === 'queued' && proposal.executionEta && !timelockExpired && (
                        <TimelockCountdown executionEta={proposal.executionEta} onExpire={() => {}} />
                      )}
                      <span
                        className={`px-3 py-1 rounded-full text-xs font-semibold ${
                          proposal.status === 'executed'
                            ? 'bg-emerald-500/20 text-emerald-300'
                            : proposal.status === 'queued'
                            ? 'bg-amber-500/20 text-amber-300'
                            : proposal.status === 'active'
                            ? 'bg-blue-500/20 text-blue-300'
                            : proposal.status === 'failed'
                            ? 'bg-red-500/20 text-red-300'
                            : 'bg-gray-500/20 text-gray-300'
                        }`}
                      >
                        {proposal.status.toUpperCase()}
                      </span>
                    </div>
                  </div>

                  <p className="text-sm text-gray-300">{proposal.description}</p>

                  {/* Dual Linear vs Quadratic Progress Bars */}
                  <div className="p-3 rounded-lg bg-black/40 border border-white/5 space-y-2.5">
                    {/* Linear Bar */}
                    <div>
                      <div className="flex justify-between text-xs text-gray-400">
                        <span className="text-amber-400/90 font-medium">Linear Approval (Whale Weighted)</span>
                        <span className="font-mono text-amber-300">{Math.round(linearApprovalRatio * 100)}%</span>
                      </div>
                      <div className="w-full h-1.5 bg-black/60 rounded-full overflow-hidden mt-1">
                        <div
                          className="h-full bg-amber-500 transition-all"
                          style={{ width: `${linearApprovalRatio * 100}%` }}
                        />
                      </div>
                    </div>

                    {/* Quadratic Bar */}
                    <div>
                      <div className="flex justify-between text-xs text-gray-300">
                        <span className="text-emerald-400 font-semibold flex items-center gap-1">
                          <span>Quadratic Weight (Community Consensus)</span>
                          <span className="text-[10px] px-1 rounded bg-emerald-500/20 text-emerald-300">√Power</span>
                        </span>
                        <span className="font-mono text-emerald-300 font-bold">{Math.round(quadApprovalRatio * 100)}%</span>
                      </div>
                      <div className="w-full h-2 bg-black/60 rounded-full overflow-hidden mt-1">
                        <div
                          className="h-full bg-gradient-to-r from-emerald-500 to-trellis-vine transition-all"
                          style={{ width: `${quadApprovalRatio * 100}%` }}
                        />
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center justify-between text-xs text-gray-400 pt-1 border-t border-white/5">
                      <div className="flex gap-3">
                        <span title="Quadratic Approvals">√✅ {quadApprovals.toFixed(1)}</span>
                        <span title="Quadratic Rejections">√❌ {quadRejections.toFixed(1)}</span>
                        <span title="Quadratic Abstentions">√⏸ {quadAbstentions.toFixed(1)}</span>
                      </div>
                      <span className="text-[11px] text-gray-500">
                        Linear: {proposal.approvals} | {proposal.rejections} | {proposal.abstentions}
                      </span>
                    </div>
                  </div>

                  <div className="pt-2 flex flex-wrap items-center gap-2">
                    <button
                      onClick={() => onVote(proposal, 'approve')}
                      disabled={!wallet || proposal.status !== 'active' || isVoting}
                      className="px-3 py-1.5 rounded-md border border-emerald-500/60 text-emerald-300 text-xs hover:bg-emerald-500/10 disabled:opacity-40 transition-colors"
                    >
                      Approve (√Weight)
                    </button>
                    <button
                      onClick={() => onVote(proposal, 'reject')}
                      disabled={!wallet || proposal.status !== 'active' || isVoting}
                      className="px-3 py-1.5 rounded-md border border-red-500/60 text-red-300 text-xs hover:bg-red-500/10 disabled:opacity-40 transition-colors"
                    >
                      Reject (√Weight)
                    </button>
                    <button
                      onClick={() => onVote(proposal, 'abstain')}
                      disabled={!wallet || proposal.status !== 'active' || isVoting}
                      className="px-3 py-1.5 rounded-md border border-gray-500/60 text-gray-300 text-xs hover:bg-gray-500/10 disabled:opacity-40 transition-colors"
                    >
                      Abstain
                    </button>

                    <button
                      onClick={() => setSelectedProposal(proposal)}
                      className="px-3 py-1.5 rounded-md bg-white/10 hover:bg-white/15 text-white text-xs font-medium border border-white/10 transition-colors ml-auto flex items-center gap-1.5"
                    >
                      <span>📊 Compare & Graph</span>
                    </button>

                    {proposal.type === 'treasury_spend' && (
                      <button
                        onClick={() => setMultisigProposal(proposal)}
                        className="px-3 py-1.5 rounded-md border border-indigo-500/50 text-indigo-300 text-xs hover:bg-indigo-500/10 transition-colors"
                      >
                        Multi-Sig Signers
                      </button>
                    )}

                    {approved && proposal.status === 'active' && (
                      <button
                        onClick={() => onExecute(proposal)}
                        className="px-3 py-1.5 rounded-md bg-gradient-to-r from-trellis-clay to-trellis-vine text-xs font-semibold hover:shadow-md hover:shadow-trellis-vine/40"
                      >
                        Execute On-Chain
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="space-y-4">
          <h2 className="text-2xl font-semibold glow-text">Treasury Activity</h2>
          <div className="space-y-2 max-h-96 overflow-y-auto pr-2">
            {!treasuryHistory && (
              <p className="text-gray-400 text-sm">Loading treasury history...</p>
            )}
            {treasuryHistory &&
              treasuryHistory.map((tx) => (
                <div
                  key={tx.id}
                  className="p-3 rounded-lg border border-trellis-vine/30 text-xs nebula-bg"
                >
                  <div className="flex justify-between mb-1">
                    <span
                      className={
                        tx.type === 'incoming'
                          ? 'text-emerald-300'
                          : tx.type === 'outgoing'
                          ? 'text-red-300'
                          : 'text-gray-300'
                      }
                    >
                      {tx.type.toUpperCase()}
                    </span>
                    <span className="text-gray-400">
                      {new Date(tx.createdAt).toLocaleString()}
                    </span>
                  </div>
                  <div className="text-gray-200">
                    {tx.amountXlm} XLM
                  </div>
                  <div className="text-gray-400 mt-1">
                    <div>From: {tx.source}</div>
                    <div>To: {tx.destination}</div>
                  </div>
                  {tx.memo && (
                    <div className="text-gray-400 mt-1">Memo: {tx.memo}</div>
                  )}
                </div>
              ))}
          </div>
        </div>
      </section>

      {selectedProposal && (
        <ProposalDetailModal
          proposal={selectedProposal}
          config={config}
          isOpen={!!selectedProposal}
          onClose={() => setSelectedProposal(null)}
          onVote={onVote}
          userVotingPower={userVotingPower}
          isVoting={isVoting}
        />
      )}

      {multisigProposal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md overflow-y-auto">
          <div className="relative w-full max-w-3xl my-8">
            <MultisigTransactionBuilder
              initialXdr={
                multisigProposal.action?.type === 'treasury_spend' && config.treasuryAccount
                  ? buildTreasurySpendEnvelope({
                      networkPassphrase: getNetworkPassphrase(config.network),
                      treasuryAccount: config.treasuryAccount,
                      destination: multisigProposal.action.destination,
                      amount: multisigProposal.action.amount,
                      memo: multisigProposal.action.memo,
                    })
                  : ''
              }
              networkPassphrase={getNetworkPassphrase(config.network)}
              signers={
                config.treasuryMultisig?.signers || [
                  multisigProposal.creator,
                  config.governanceAccount,
                  config.treasuryAccount,
                ]
              }
              threshold={config.treasuryMultisig?.threshold || 2}
              treasuryAccount={config.treasuryAccount}
              proposalId={multisigProposal.id}
              proposalTitle={multisigProposal.title}
              onClose={() => setMultisigProposal(null)}
              onSubmit={async () => {
                onExecute(multisigProposal);
                setMultisigProposal(null);
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

