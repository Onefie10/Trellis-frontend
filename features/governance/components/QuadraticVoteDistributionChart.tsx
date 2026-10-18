'use client';

import React, { useState } from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
} from 'recharts';
import type { LinearVsQuadraticComparisonResult } from '../utils/quadraticVoting';

interface QuadraticVoteDistributionChartProps {
  comparison: LinearVsQuadraticComparisonResult;
}

export function QuadraticVoteDistributionChart({
  comparison,
}: QuadraticVoteDistributionChartProps) {
  const [activeTab, setActiveTab] = useState<'tallies' | 'tiers'>('tallies');

  const tallyData = [
    {
      name: 'Approve',
      Linear: comparison.linearTally.approvals,
      Quadratic: comparison.quadraticTally.approvals,
      'Linear %': Math.round(comparison.linearTally.approvalRatio * 100),
      'Quadratic %': Math.round(comparison.quadraticTally.approvalRatio * 100),
    },
    {
      name: 'Reject',
      Linear: comparison.linearTally.rejections,
      Quadratic: comparison.quadraticTally.rejections,
      'Linear %': Math.round(comparison.linearTally.rejectionRatio * 100),
      'Quadratic %': Math.round(comparison.quadraticTally.rejectionRatio * 100),
    },
    {
      name: 'Abstain',
      Linear: comparison.linearTally.abstentions,
      Quadratic: comparison.quadraticTally.abstentions,
      'Linear %': Math.round(comparison.linearTally.abstentionRatio * 100),
      'Quadratic %': Math.round(comparison.quadraticTally.abstentionRatio * 100),
    },
  ];

  const tierData = comparison.distributionByTier.map((t) => ({
    name: t.tier,
    'Linear Voting Power': Math.round(t.linearVotingPower),
    'Quadratic Voting Power': Math.round(t.quadraticVotingPower),
    'Linear Share %': Math.round(t.linearShare * 100),
    'Quadratic Share %': Math.round(t.quadraticShare * 100),
    voters: t.voterCount,
  }));

  const COLORS = ['#10b981', '#3b82f6', '#8b5cf6', '#f59e0b'];

  return (
    <div className="p-5 rounded-xl border border-trellis-vine/30 bg-black/40 backdrop-blur-md space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-white/10 pb-3">
        <div>
          <h3 className="text-lg font-bold text-white flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse" />
            Vote Distribution Graph
          </h3>
          <p className="text-xs text-gray-400">
            Comparing linear token dominance (1 token = 1 vote) against quadratic scaling (√tokens = voting power)
          </p>
        </div>

        <div className="flex bg-black/60 p-1 rounded-lg border border-white/10 text-xs">
          <button
            onClick={() => setActiveTab('tallies')}
            className={`px-3 py-1.5 rounded-md font-medium transition-all ${
              activeTab === 'tallies'
                ? 'bg-trellis-vine text-white shadow-sm'
                : 'text-gray-400 hover:text-white'
            }`}
          >
            Outcome Tallies
          </button>
          <button
            onClick={() => setActiveTab('tiers')}
            className={`px-3 py-1.5 rounded-md font-medium transition-all ${
              activeTab === 'tiers'
                ? 'bg-trellis-vine text-white shadow-sm'
                : 'text-gray-400 hover:text-white'
            }`}
          >
            Voter Tiers & Whales
          </button>
        </div>
      </div>

      {activeTab === 'tallies' ? (
        <div className="space-y-4">
          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={tallyData}
                margin={{ top: 10, right: 10, left: 10, bottom: 20 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#222" />
                <XAxis dataKey="name" stroke="#888" tick={{ fill: '#aaa', fontSize: 12 }} />
                <YAxis stroke="#888" tick={{ fill: '#aaa', fontSize: 12 }} />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#121218',
                    border: '1px solid rgba(255, 255, 255, 0.15)',
                    borderRadius: '8px',
                    fontSize: '12px',
                    color: '#fff',
                  }}
                  formatter={(value: any, name: any) => [
                    `${typeof value === 'number' ? value.toLocaleString() : value}`,
                    name,
                  ]}
                />
                <Legend wrapperStyle={{ fontSize: '12px', paddingTop: '10px' }} />
                <Bar dataKey="Linear" fill="#f59e0b" radius={[4, 4, 0, 0]} name="Linear Votes (Tokens)" />
                <Bar dataKey="Quadratic" fill="#10b981" radius={[4, 4, 0, 0]} name="Quadratic Weight (√Tokens)" />
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div className="grid grid-cols-3 gap-3 text-center pt-2 border-t border-white/5">
            {tallyData.map((item) => (
              <div key={item.name} className="p-2.5 rounded-lg bg-white/5">
                <span className="text-xs text-gray-400">{item.name} Ratio</span>
                <div className="flex items-center justify-center gap-2 mt-1">
                  <span className="text-xs text-amber-400 font-mono">
                    Linear: {item['Linear %']}%
                  </span>
                  <span className="text-xs text-gray-500">→</span>
                  <span className="text-xs text-emerald-400 font-semibold font-mono">
                    Quad: {item['Quadratic %']}%
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={tierData}
                margin={{ top: 10, right: 10, left: 10, bottom: 20 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#222" />
                <XAxis dataKey="name" stroke="#888" tick={{ fill: '#aaa', fontSize: 11 }} />
                <YAxis stroke="#888" tick={{ fill: '#aaa', fontSize: 12 }} />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#121218',
                    border: '1px solid rgba(255, 255, 255, 0.15)',
                    borderRadius: '8px',
                    fontSize: '12px',
                    color: '#fff',
                  }}
                  formatter={(value: any, name: any) => [
                    `${typeof value === 'number' ? value.toLocaleString() : value}`,
                    name,
                  ]}
                />
                <Legend wrapperStyle={{ fontSize: '12px', paddingTop: '10px' }} />
                <Bar dataKey="Linear Share %" fill="#ef4444" radius={[4, 4, 0, 0]} name="Linear Share %" />
                <Bar dataKey="Quadratic Share %" fill="#3b82f6" radius={[4, 4, 0, 0]} name="Quadratic Share %" />
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div className="p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-xs text-emerald-300 flex items-center justify-between">
            <span>🛡️ Whale Influence Reduction:</span>
            <span className="font-bold text-sm">
              -{comparison.whaleInfluenceReductionPercent}% voting concentration
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
