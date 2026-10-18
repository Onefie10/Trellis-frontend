'use client';

import React from 'react';
import { useNotifications } from '@/hooks/useNotifications';

export function EmailDigestSettings() {
  const { emailDigest, updateEmailDigest } = useNotifications();

  const handleToggleTrigger = (key: keyof typeof emailDigest.triggers) => {
    updateEmailDigest({
      triggers: {
        ...emailDigest.triggers,
        [key]: !emailDigest.triggers[key],
      },
    });
  };

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-xl font-semibold text-white">Email Digest Preferences</h3>
        <p className="text-gray-400 text-sm mt-1">
          Receive periodic summary emails of critical platform activities and maintainer alerts.
        </p>
      </div>

      {/* Main Email Digest Toggle */}
      <div className="flex items-center justify-between p-4 rounded-lg border border-white/10 bg-white/5">
        <div>
          <p className="text-white font-medium">Enable Email Digests</p>
          <p className="text-gray-400 text-sm">Send platform activity reports directly to your inbox</p>
        </div>
        <label className="relative inline-flex items-center cursor-pointer">
          <input
            type="checkbox"
            checked={emailDigest.enabled}
            onChange={(e) => updateEmailDigest({ enabled: e.target.checked })}
            className="sr-only peer"
          />
          <div className="w-11 h-6 bg-gray-600 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-trellis-vine" />
        </label>
      </div>

      {emailDigest.enabled && (
        <div className="p-5 rounded-lg border border-white/10 bg-white/5 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">Recipient Email Address</label>
              <input
                type="email"
                placeholder="maintainer@trellis.stellar"
                value={emailDigest.email}
                onChange={(e) => updateEmailDigest({ email: e.target.value })}
                className="w-full px-3 py-2 bg-white/10 border border-white/20 rounded-lg text-white placeholder-gray-500 text-sm focus:outline-none focus:border-trellis-vine"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">Digest Frequency</label>
              <select
                value={emailDigest.frequency}
                onChange={(e) => updateEmailDigest({ frequency: e.target.value as any })}
                className="w-full px-3 py-2 bg-neutral-900 border border-white/20 rounded-lg text-white text-sm focus:outline-none focus:border-trellis-vine"
              >
                <option value="daily">Daily Summary</option>
                <option value="weekly">Weekly Digest</option>
                <option value="realtime">Real-time Immediate Alerts</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-300 mb-2">Digest Event Triggers</label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="flex items-center gap-3 p-3 rounded-lg border border-white/10 bg-white/5 cursor-pointer hover:bg-white/10 transition">
                <input
                  type="checkbox"
                  checked={emailDigest.triggers.newProposal}
                  onChange={() => handleToggleTrigger('newProposal')}
                  className="rounded bg-gray-700 border-gray-600 text-trellis-vine focus:ring-trellis-vine"
                />
                <span className="text-sm font-medium text-white">New Proposal Alerts</span>
              </label>

              <label className="flex items-center gap-3 p-3 rounded-lg border border-white/10 bg-white/5 cursor-pointer hover:bg-white/10 transition">
                <input
                  type="checkbox"
                  checked={emailDigest.triggers.highErrorRate}
                  onChange={() => handleToggleTrigger('highErrorRate')}
                  className="rounded bg-gray-700 border-gray-600 text-trellis-vine focus:ring-trellis-vine"
                />
                <span className="text-sm font-medium text-white">High Error Rate Warnings</span>
              </label>

              <label className="flex items-center gap-3 p-3 rounded-lg border border-white/10 bg-white/5 cursor-pointer hover:bg-white/10 transition">
                <input
                  type="checkbox"
                  checked={emailDigest.triggers.payoutExecuted}
                  onChange={() => handleToggleTrigger('payoutExecuted')}
                  className="rounded bg-gray-700 border-gray-600 text-trellis-vine focus:ring-trellis-vine"
                />
                <span className="text-sm font-medium text-white">Payout Executed Reports</span>
              </label>

              <label className="flex items-center gap-3 p-3 rounded-lg border border-white/10 bg-white/5 cursor-pointer hover:bg-white/10 transition">
                <input
                  type="checkbox"
                  checked={emailDigest.triggers.agentMinted}
                  onChange={() => handleToggleTrigger('agentMinted')}
                  className="rounded bg-gray-700 border-gray-600 text-trellis-vine focus:ring-trellis-vine"
                />
                <span className="text-sm font-medium text-white">Agent Minted Confirmations</span>
              </label>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
