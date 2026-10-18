'use client';

import React, { useState } from 'react';
import Card from '@/components/Card';
import Button from '@/components/Button';
import { ReferralRecord } from '../types';

interface ReferralTableProps {
  referrals: ReferralRecord[];
  isLoading: boolean;
}

export const ReferralTable: React.FC<ReferralTableProps> = ({ referrals, isLoading }) => {
  const [sortBy, setSortBy] = useState<'date' | 'commission' | 'status'>('date');
  const [filterStatus, setFilterStatus] = useState<'all' | 'active' | 'converted' | 'inactive'>(
    'all'
  );

  if (isLoading) {
    return (
      <Card className="animate-pulse motion-reduce:animate-none">
        <div
          role="status"
          aria-busy="true"
          aria-label="Loading referrals"
          className="h-96 bg-trellis-vine/20 rounded"
        />
      </Card>
    );
  }

  if (!referrals || referrals.length === 0) {
    return (
      <Card className="text-center py-12">
        <p role="status" className="text-trellis-vine/60">No referrals yet. Start sharing your code!</p>
      </Card>
    );
  }

  // Filter referrals
  let filtered = referrals;
  if (filterStatus !== 'all') {
    filtered = referrals.filter((r) => r.status === filterStatus);
  }

  // Sort referrals
  const sorted = [...filtered].sort((a, b) => {
    switch (sortBy) {
      case 'commission':
        return parseFloat(b.commissionAmount) - parseFloat(a.commissionAmount);
      case 'status':
        return a.status.localeCompare(b.status);
      case 'date':
      default:
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    }
  });

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'converted':
        return 'text-green-400';
      case 'active':
        return 'text-blue-400';
      case 'inactive':
        return 'text-gray-400';
      default:
        return 'text-gray-400';
    }
  };

  const getStatusBg = (status: string) => {
    switch (status) {
      case 'converted':
        return 'bg-green-500/10';
      case 'active':
        return 'bg-blue-500/10';
      case 'inactive':
        return 'bg-gray-500/10';
      default:
        return 'bg-gray-500/10';
    }
  };

  return (
    <Card>
      <div className="mb-6">
        <h3 className="text-lg font-semibold mb-4 text-white">Referral Management</h3>

        {/* Controls */}
        <div className="flex flex-col sm:flex-row gap-4 mb-6">
          <div className="flex gap-2 items-center">
            <label htmlFor="referral-sort-by" className="text-sm text-trellis-vine/60">Sort by:</label>
            <select
              id="referral-sort-by"
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as any)}
              className="bg-trellis-ground/50 border border-trellis-vine/30 rounded px-3 py-1 text-sm text-white focus:outline-none focus:border-trellis-vine/60"
            >
              <option value="date">Date</option>
              <option value="commission">Commission</option>
              <option value="status">Status</option>
            </select>
          </div>

          <div className="flex gap-2 items-center">
            <label htmlFor="referral-filter-status" className="text-sm text-trellis-vine/60">Filter:</label>
            <select
              id="referral-filter-status"
              value={filterStatus}
              onChange={(e) => setFilterStatus(e.target.value as any)}
              className="bg-trellis-ground/50 border border-trellis-vine/30 rounded px-3 py-1 text-sm text-white focus:outline-none focus:border-trellis-vine/60"
            >
              <option value="all">All ({referrals.length})</option>
              <option value="active">Active ({referrals.filter((r) => r.status === 'active').length})</option>
              <option value="converted">Converted ({referrals.filter((r) => r.status === 'converted').length})</option>
              <option value="inactive">Inactive ({referrals.filter((r) => r.status === 'inactive').length})</option>
            </select>
          </div>
        </div>

        {/* Table */}
        <div className="overflow-x-auto">
          <table aria-label="Referrals" className="w-full text-sm">
            <thead>
              <tr className="border-b border-trellis-vine/20">
                <th scope="col" className="text-start py-3 px-4 text-trellis-vine/60 font-semibold">Code</th>
                <th scope="col" className="text-start py-3 px-4 text-trellis-vine/60 font-semibold">User</th>
                <th
                  scope="col"
                  aria-sort={sortBy === 'status' ? 'ascending' : 'none'}
                  className="text-start py-3 px-4 text-trellis-vine/60 font-semibold"
                >
                  Status
                </th>
                <th
                  scope="col"
                  aria-sort={sortBy === 'commission' ? 'descending' : 'none'}
                  className="text-end py-3 px-4 text-trellis-vine/60 font-semibold"
                >
                  Commission
                </th>
                <th
                  scope="col"
                  aria-sort={sortBy === 'date' ? 'descending' : 'none'}
                  className="text-start py-3 px-4 text-trellis-vine/60 font-semibold"
                >
                  Date
                </th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((referral) => (
                <tr
                  key={referral.id}
                  className="border-b border-trellis-vine/10 hover:bg-trellis-vine/5 transition-colors motion-reduce:transition-none"
                >
                  <td className="py-3 px-4">
                    <code className="bg-trellis-ground/50 px-2 py-1 rounded text-trellis-leaf">
                      {referral.referralCode}
                    </code>
                  </td>
                  <td className="py-3 px-4">
                    <div className="text-white truncate">
                      {referral.referredUserName || 'Unknown'}
                    </div>
                    <div className="text-xs text-trellis-vine/40 truncate">
                      {referral.referredUserAddress.slice(0, 10)}...
                    </div>
                  </td>
                  <td className="py-3 px-4">
                    <span
                      className={`px-3 py-1 rounded-full text-xs font-semibold ${getStatusBg(
                        referral.status
                      )} ${getStatusColor(referral.status)} capitalize`}
                    >
                      {referral.status}
                    </span>
                  </td>
                  <td className="py-3 px-4 text-end font-semibold text-trellis-leaf">
                    {referral.commissionAmount} XLM
                  </td>
                  <td className="py-3 px-4 text-trellis-vine/60 text-xs">
                    {new Date(referral.createdAt).toLocaleDateString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {sorted.length === 0 && (
          <div role="status" aria-live="polite" className="text-center py-8 text-trellis-vine/60">
            No referrals match the selected filter
          </div>
        )}
      </div>
    </Card>
  );
};

export default ReferralTable;
