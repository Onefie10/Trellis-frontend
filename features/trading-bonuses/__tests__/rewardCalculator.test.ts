import { calculateUserReward, calculateEpochRewardTotal, estimateDistribution, EpochParameters, UserRewardInputs } from '../utils/rewardCalculator';

describe('rewardCalculator', () => {
  const defaultEpochParams: EpochParameters = {
    epochNumber: 1,
    totalEpochReward: 10000,
    totalEpochVolume: 100000,
    decayRate: 0.95,
  };

  const defaultUserInputs: UserRewardInputs = {
    userVolume: 1000,
    lockDurationDays: 0,
    poolMultiplier: 1.0,
  };

  describe('calculateEpochRewardTotal', () => {
    it('applies decay correctly across epochs', () => {
      // Epoch 1: 10000 * 0.95^0 = 10000
      expect(calculateEpochRewardTotal(defaultEpochParams)).toBe(10000);
      
      // Epoch 2: 10000 * 0.95^1 = 9500
      expect(calculateEpochRewardTotal({ ...defaultEpochParams, epochNumber: 2 })).toBe(9500);
      
      // Epoch 3: 10000 * 0.95^2 = 9025
      expect(calculateEpochRewardTotal({ ...defaultEpochParams, epochNumber: 3 })).toBe(9025);
    });
  });

  describe('calculateUserReward', () => {
    it('calculates reward correctly for base case', () => {
      // User has 1% of volume (1000 / 100000), 0 days lock (1x), 1.0 pool multiplier
      // 10000 * 0.01 * 1 * 1 = 100
      const reward = calculateUserReward(defaultEpochParams, defaultUserInputs);
      expect(reward).toBe(100);
    });

    it('handles zero total epoch volume gracefully', () => {
      const reward = calculateUserReward(
        { ...defaultEpochParams, totalEpochVolume: 0 },
        defaultUserInputs
      );
      expect(reward).toBe(0);
    });

    it('handles zero user volume', () => {
      const reward = calculateUserReward(
        defaultEpochParams,
        { ...defaultUserInputs, userVolume: 0 }
      );
      expect(reward).toBe(0);
    });

    it('applies lock duration multiplier correctly', () => {
      // 365 days lock should yield a max multiplier of 2.5x
      const rewardMaxLock = calculateUserReward(
        defaultEpochParams,
        { ...defaultUserInputs, lockDurationDays: 365 }
      );
      expect(rewardMaxLock).toBe(250); // 100 base * 2.5
      
      // 182.5 days lock should yield roughly 1.75x multiplier
      const rewardHalfLock = calculateUserReward(
        defaultEpochParams,
        { ...defaultUserInputs, lockDurationDays: 182.5 }
      );
      expect(rewardHalfLock).toBeCloseTo(175);
    });

    it('applies pool multipliers correctly (including max multiplier test)', () => {
      // 5x pool multiplier
      const reward = calculateUserReward(
        defaultEpochParams,
        { ...defaultUserInputs, poolMultiplier: 5.0 }
      );
      expect(reward).toBe(500); // 100 base * 5
    });

    it('calculates correct rewards during an epoch transition (epoch > 1)', () => {
      const reward = calculateUserReward(
        { ...defaultEpochParams, epochNumber: 2 }, // 9500 total reward
        defaultUserInputs
      );
      expect(reward).toBe(95); // 9500 * 0.01
    });
  });

  describe('estimateDistribution', () => {
    it('estimates daily and weekly distributions', () => {
      // 700 total reward over 7 days
      expect(estimateDistribution(700, 'daily', 7)).toBe(100);
      expect(estimateDistribution(700, 'weekly', 7)).toBe(700);
      
      // 700 total reward over 14 days
      expect(estimateDistribution(700, 'daily', 14)).toBe(50);
      expect(estimateDistribution(700, 'weekly', 14)).toBe(350);
    });
  });
});
