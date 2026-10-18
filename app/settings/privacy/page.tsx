'use client';

import React, { useEffect, useState } from 'react';
import {
  isRecommendationEnabled,
  setRecommendationEnabled,
  clearUserVector
} from '@/features/recommendations/utils/userVectorStore';

export default function PrivacySettingsPage() {
  const [recommendationEnabled, setEnabled] = useState(true);
  const [cleared, setCleared] = useState(false);

  useEffect(() => {
    setEnabled(isRecommendationEnabled());
  }, []);

  const handleToggle = () => {
    const newValue = !recommendationEnabled;
    setEnabled(newValue);
    setRecommendationEnabled(newValue);
  };

  const handleClear = () => {
    clearUserVector();
    setCleared(true);
    setTimeout(() => setCleared(false), 3000);
  };

  return (
    <main className="pt-20 pb-20 px-4 min-h-screen">
      <div className="max-w-4xl mx-auto">
        <div className="mb-8">
          <h1 className="text-4xl font-bold text-white mb-4">Privacy & Security</h1>
          <p className="text-gray-300 text-lg">
            Manage your personal data, local storage preferences, and recommendation engine tracking.
          </p>
        </div>

        <div className="space-y-6">
          <div className="p-6 rounded-lg border border-white/10 bg-white/5">
            <h2 className="text-2xl font-semibold text-white mb-2">Personalized Recommendations</h2>
            <p className="text-gray-400 mb-6">
              We use a lightweight, local-only recommendation engine to suggest agents tailored to your workflow. 
              No interaction data ever leaves your device or is sent to our servers.
            </p>
            
            <div className="flex items-center justify-between py-4 border-t border-white/5">
              <div>
                <h3 className="text-lg font-medium text-white">Enable Recommendation Tracking</h3>
                <p className="text-sm text-gray-400">
                  Allow your interactions (views, clicks) to inform your personalized recommendations.
                </p>
              </div>
              
              <label className="relative inline-flex items-center cursor-pointer">
                <input 
                  type="checkbox" 
                  className="sr-only peer" 
                  checked={recommendationEnabled}
                  onChange={handleToggle}
                />
                <div className="w-11 h-6 bg-gray-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-trellis-vine"></div>
              </label>
            </div>

            <div className="flex items-center justify-between py-4 border-t border-white/5">
              <div>
                <h3 className="text-lg font-medium text-white">Clear Recommendation Data</h3>
                <p className="text-sm text-gray-400">
                  Reset your interaction history and start fresh. Your recommendations will revert to trending agents.
                </p>
              </div>
              
              <button 
                onClick={handleClear}
                className="px-4 py-2 bg-red-500/20 text-red-400 border border-red-500/30 rounded hover:bg-red-500/30 transition-smooth text-sm font-semibold"
              >
                {cleared ? 'Cleared!' : 'Reset Data'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
