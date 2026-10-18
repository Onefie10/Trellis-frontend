'use client';

import React from 'react';
import type { LinearVsQuadraticComparisonResult } from '../utils/quadraticVoting';

interface LinearVsQuadraticComparisonProps {
  comparison: LinearVsQuadraticComparisonResult;
  minQuorumRatio?: number;
  requiredApprovalRatio?: number;
}

export function LinearVsQuadraticComparison({
  comparison,
  minQuorumRatio = 0.2,
  requiredApprovalRatio = 0.6,
}: LinearVsQuadraticComparisonProps) {
  const {
    linearTally,
    quadraticTally,
    linearOutcome,
    quadraticOutcome,
    outcomeFlipped,
    whaleInfluenceReductionPercent,
  } = comparison;

  const getStatusBadge = (outcome: 'approved' | 'rejected' | 'quorum_not_met') => {
    switch (outcome) {
      case 'approved':
        return (
          <span className="px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
            PASSED
          </span>
        );
      case 'rejected':
        return (
          <span className="px-2.5 py-1 rounded-full text-xs font-semibold bg-red-500/20 text-red-300 border border-red-500/30">
            REJECTED
          </span>
        );
      case 'quorum_not_met':
      default:
        return (
          <span className="px-2.5 py-1 rounded-full text-xs font-semibold bg-yellow-500/20 text-yellow-300 border border-yellow-500/30">
            NO QUORUM
          </span>
        );
    }
  };

  return (
    <div className="space-y-4">
      {outcomeFlipped && (
        <div className="p-3.5 rounded-xl border border-amber-500/40 bg-amber-500/10 text-amber-200 text-xs flex items-center gap-3">
          <span className="text-xl">⚖️</span>
          <div>
            <span className="font-bold">Quadratic Voting Altered Proposal Outcome!</span>
            <p className="text-amber-300/80 mt-0.5">
              Under standard linear voting, whales dictated a {linearOutcome.toUpperCase()} outcome.
              Quadratic voting weighted community consensus, yielding a {quadraticOutcome.toUpperCase()} decision.
            </p>
          </div>
        </div>
      )}

      <div className="grid md:grid-cols-2 gap-4">
        {/* Linear Voting Card */}
        <div className="p-4 rounded-xl border border-amber-500/20 bg-black/40 backdrop-blur-sm relative overflow-hidden">
          <div className="absolute top-0 right-0 left-0 h-1 bg-gradient-to-r from-amber-500/50 to-amber-400" />
          <div className="flex items-center justify-between mb-3">
            <div>
              <h4 className="font-bold text-amber-300 flex items-center gap-1.5">
                <span>Linear Voting</span>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400 border border-amber-500/30">
                  1 Token = 1 Vote
                </span>
              </h4>
              <p className="text-xs text-gray-400 mt-0.5">Vulnerable to whale domination</p>
            </div>
            {getStatusBadge(linearOutcome)}
          </div>

          <div className="space-y-2 mt-3">
            <div>
              <div className="flex justify-between text-xs text-gray-300 mb-1">
                <span>Approval Ratio</span>
                <span className="font-mono font-semibold text-amber-400">
                  {Math.round(linearTally.approvalRatio * 100)}% (Req: {Math.round(requiredApprovalRatio * 100)}%)
                </span>
              </div>
              <div className="w-full h-2.5 bg-white/10 rounded-full overflow-hidden">
                <div
                  className="h-full bg-amber-500 transition-all duration-500"
                  style={{ width: `${Math.min(100, linearTally.approvalRatio * 100)}%` }}
                />
              </div>
            </div>

            <div className="grid grid-cols-3 gap-2 pt-3 border-t border-white/5 text-center">
              <div className="p-2 rounded-lg bg-white/5">
                <div className="text-[10px] text-gray-400">Approvals</div>
                <div className="text-xs font-bold text-emerald-400 mt-0.5">
                  {Math.round(linearTally.approvals).toLocaleString()}
                </div>
              </div>
              <div className="p-2 rounded-lg bg-white/5">
                <div className="text-[10px] text-gray-400">Rejections</div>
                <div className="text-xs font-bold text-red-400 mt-0.5">
                  {Math.round(linearTally.rejections).toLocaleString()}
                </div>
              </div>
              <div className="p-2 rounded-lg bg-white/5">
                <div className="text-[10px] text-gray-400">Abstentions</div>
                <div className="text-xs font-bold text-gray-400 mt-0.5">
                  {Math.round(linearTally.abstentions).toLocaleString()}
                </div>
              </div>
            </div>

            <div className="pt-2 text-[11px] text-gray-400 flex justify-between">
              <span>Total Linear Tokens:</span>
              <span className="font-mono font-medium text-white">
                {Math.round(linearTally.totalVotes).toLocaleString()}
              </span>
            </div>
          </div>
        </div>

        {/* Quadratic Voting Card */}
        <div className="p-4 rounded-xl border border-emerald-500/30 bg-black/40 backdrop-blur-sm relative overflow-hidden">
          <div className="absolute top-0 right-0 left-0 h-1 bg-gradient-to-r from-emerald-500 to-trellis-vine" />
          <div className="flex items-center justify-between mb-3">
            <div>
              <h4 className="font-bold text-emerald-300 flex items-center gap-1.5">
                <span>Quadratic Voting</span>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 font-mono">
                  Voting Power = √Tokens
                </span>
              </h4>
              <p className="text-xs text-gray-400 mt-0.5">Community-weighted governance</p>
            </div>
            {getStatusBadge(quadraticOutcome)}
          </div>

          <div className="space-y-2 mt-3">
            <div>
              <div className="flex justify-between text-xs text-gray-300 mb-1">
                <span>Approval Ratio</span>
                <span className="font-mono font-semibold text-emerald-400">
                  {Math.round(quadraticTally.approvalRatio * 100)}% (Req: {Math.round(requiredApprovalRatio * 100)}%)
                </span>
              </div>
              <div className="w-full h-2.5 bg-white/10 rounded-full overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-emerald-500 to-trellis-vine transition-all duration-500"
                  style={{ width: `${Math.min(100, quadraticTally.approvalRatio * 100)}%` }}
                />
              </div>
            </div>

            <div className="grid grid-cols-3 gap-2 pt-3 border-t border-white/5 text-center">
              <div className="p-2 rounded-lg bg-white/5">
                <div className="text-[10px] text-gray-400">Quad Approvals</div>
                <div className="text-xs font-bold text-emerald-400 mt-0.5">
                  {quadraticTally.approvals.toFixed(2)}
                </div>
              </div>
              <div className="p-2 rounded-lg bg-white/5">
                <div className="text-[10px] text-gray-400">Quad Rejections</div>
                <div className="text-xs font-bold text-red-400 mt-0.5">
                  {quadraticTally.rejections.toFixed(2)}
                </div>
              </div>
              <div className="p-2 rounded-lg bg-white/5">
                <div className="text-[10px] text-gray-400">Quad Abstentions</div>
                <div className="text-xs font-bold text-gray-400 mt-0.5">
                  {quadraticTally.abstentions.toFixed(2)}
                </div>
              </div>
            </div>

            <div className="pt-2 text-[11px] text-gray-400 flex justify-between">
              <span>Total Quadratic Power:</span>
              <span className="font-mono font-medium text-emerald-300">
                {quadraticTally.totalVotes.toFixed(2)}
              </span>
            </div>
          </div>
        </div>
      </div>

      {whaleInfluenceReductionPercent > 0 && (
        <div className="flex items-center justify-between p-3 rounded-lg bg-trellis-vine/10 border border-trellis-vine/30 text-xs">
          <div className="flex items-center gap-2">
            <span className="text-emerald-400">🛡️ Sybil-Protected Quadratic Scaling</span>
            <span className="text-gray-400">|</span>
            <span className="text-gray-300">
              Large whale influence reduced by <span className="font-bold text-emerald-300">-{whaleInfluenceReductionPercent}%</span>
            </span>
          </div>
          <span className="text-[10px] text-gray-400">
            Verified accounts only
          </span>
        </div>
      )}
    </div>
  );
}
