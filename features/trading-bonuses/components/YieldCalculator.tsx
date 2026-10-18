import * as React from 'react';
import { useState, useEffect } from 'react';
import { 
  calculateUserReward, 
  estimateDistribution, 
  EpochParameters, 
  UserRewardInputs 
} from '../utils/rewardCalculator';
import { fetchLiveEpochParameters } from '../utils/sorobanRewardClient';
import { StellarNetwork } from '@/lib/types';

export const YieldCalculator: React.FC = () => {
  const [epochParams, setEpochParams] = useState<EpochParameters | null>(null);
  const [userVolume, setUserVolume] = useState<number>(1000);
  const [lockDurationDays, setLockDurationDays] = useState<number>(0);
  const [poolMultiplier, setPoolMultiplier] = useState<number>(1.0);
  const [isLoading, setIsLoading] = useState<boolean>(true);

  const fetchParams = async () => {
    setIsLoading(true);
    const params = await fetchLiveEpochParameters(StellarNetwork.TESTNET);
    setEpochParams({
      epochNumber: params.epochNumber,
      totalEpochReward: params.totalEpochReward,
      totalEpochVolume: params.totalEpochVolume,
      decayRate: params.decayRate
    });
    setIsLoading(false);
  };

  useEffect(() => {
    fetchParams();
    // Simulate instant recalculation triggered by contract state changes via polling
    // In a real app with WebSockets, this would listen to specific events.
    const interval = setInterval(() => {
      fetchParams();
    }, 15000); // Check for epoch updates every 15s

    return () => clearInterval(interval);
  }, []);

  if (isLoading && !epochParams) {
    return <div className="p-6 rounded-xl border border-trellis-vine/20 bg-background/50">Loading Yield Calculator...</div>;
  }

  const userInputs: UserRewardInputs = {
    userVolume,
    lockDurationDays,
    poolMultiplier,
  };

  const currentReward = epochParams ? calculateUserReward(epochParams, userInputs) : 0;
  const dailyEstimate = estimateDistribution(currentReward, 'daily', 7);
  const weeklyEstimate = estimateDistribution(currentReward, 'weekly', 7);

  return (
    <div className="p-6 rounded-xl border border-trellis-vine/20 bg-background/50 shadow-lg mt-8">
      <div className="flex justify-between items-center mb-6">
        <h3 className="text-xl font-bold glow-text">Interactive Yield Calculator</h3>
        {epochParams && (
          <span className="text-sm text-gray-400">
            Current Epoch: {epochParams.epochNumber} | Total Vol: {epochParams.totalEpochVolume.toLocaleString()}
          </span>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
        <div className="space-y-6">
          {/* User Volume Slider */}
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-2">
              Your Trading Volume (XLM): {userVolume.toLocaleString()}
            </label>
            <input 
              type="range" 
              min="0" 
              max={epochParams ? Math.max(epochParams.totalEpochVolume, 10000) : 10000} 
              step="100"
              value={userVolume} 
              onChange={(e) => setUserVolume(Number(e.target.value))}
              className="w-full accent-trellis-vine"
            />
          </div>

          {/* Lock Duration Slider */}
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-2">
              Lock Duration (Days): {lockDurationDays}
            </label>
            <input 
              type="range" 
              min="0" 
              max="365" 
              step="1"
              value={lockDurationDays} 
              onChange={(e) => setLockDurationDays(Number(e.target.value))}
              className="w-full accent-trellis-vine"
            />
            <div className="flex justify-between text-xs text-gray-500 mt-1">
              <span>No Lock (1x)</span>
              <span>1 Year (2.5x)</span>
            </div>
          </div>

          {/* Pool Multiplier Selector */}
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-2">
              Pool Multiplier
            </label>
            <select 
              value={poolMultiplier}
              onChange={(e) => setPoolMultiplier(Number(e.target.value))}
              className="w-full p-2 bg-background border border-trellis-vine/20 rounded-md text-white"
            >
              <option value="1.0">Standard Pool (1x)</option>
              <option value="1.5">Boosted Pool (1.5x)</option>
              <option value="2.0">Premium Pool (2x)</option>
              <option value="5.0">Genesis Pool (5x)</option>
            </select>
          </div>
        </div>

        <div className="flex flex-col justify-center bg-trellis-vine/10 p-6 rounded-lg border border-trellis-vine/30">
          <h4 className="text-lg font-semibold text-trellis-vine mb-4 text-center">Estimated Rewards</h4>
          
          <div className="space-y-4">
            <div className="flex justify-between items-center border-b border-trellis-vine/20 pb-2">
              <span className="text-gray-400">Epoch Total (7 Days)</span>
              <span className="text-xl font-bold text-white">{currentReward.toFixed(2)} XLM</span>
            </div>
            
            <div className="flex justify-between items-center border-b border-trellis-vine/20 pb-2">
              <span className="text-gray-400">Weekly Rate</span>
              <span className="text-lg font-semibold text-white">{weeklyEstimate.toFixed(2)} XLM</span>
            </div>

            <div className="flex justify-between items-center">
              <span className="text-gray-400">Daily Rate</span>
              <span className="text-lg font-semibold text-white">{dailyEstimate.toFixed(2)} XLM</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
