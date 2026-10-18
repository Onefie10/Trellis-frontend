export interface EpochParameters {
  epochNumber: number;
  totalEpochReward: number; // The base reward allocated for the current epoch
  totalEpochVolume: number; // Total volume traded by all users in the epoch
  decayRate: number; // Decay rate for rewards over epochs (e.g., 0.95 for 5% decay)
}

export interface UserRewardInputs {
  userVolume: number; // User's trading volume
  lockDurationDays: number; // Number of days user locks their reward
  poolMultiplier: number; // Multiplier based on the specific liquidity pool
}

/**
 * Calculates the total available reward for a given epoch applying the decay curve.
 * Formula: totalEpochReward * (decayRate ^ (epochNumber - 1))
 */
export function calculateEpochRewardTotal(params: EpochParameters): number {
  if (params.decayRate < 0) return 0;
  return params.totalEpochReward * Math.pow(params.decayRate, params.epochNumber > 0 ? params.epochNumber - 1 : 0);
}

/**
 * Calculates the user's estimated reward distribution based on their share of the pool,
 * applying lock duration multipliers and pool multipliers.
 */
export function calculateUserReward(epochParams: EpochParameters, userInputs: UserRewardInputs): number {
  if (epochParams.totalEpochVolume <= 0 || userInputs.userVolume <= 0) {
    return 0;
  }

  const effectiveEpochReward = calculateEpochRewardTotal(epochParams);
  
  // Calculate base share based on volume
  const userSharePercentage = Math.min(userInputs.userVolume / epochParams.totalEpochVolume, 1.0);
  
  // Calculate lock multiplier
  // Example curve: 1x for 0 days, up to 2.5x for 365 days
  const maxLockMultiplier = 2.5;
  const lockMultiplier = 1 + ((Math.min(userInputs.lockDurationDays, 365) / 365) * (maxLockMultiplier - 1));
  
  // Apply pool multiplier
  // Ensures pool multiplier isn't negative
  const effectivePoolMultiplier = Math.max(userInputs.poolMultiplier, 0);

  const finalReward = effectiveEpochReward * userSharePercentage * lockMultiplier * effectivePoolMultiplier;
  
  return finalReward;
}

/**
 * Helper to estimate daily or weekly distributions
 */
export function estimateDistribution(
  reward: number,
  period: 'daily' | 'weekly',
  epochDurationDays: number = 7
): number {
  if (epochDurationDays <= 0) return 0;
  
  if (period === 'daily') {
    return reward / epochDurationDays;
  }
  
  if (period === 'weekly') {
    return (reward / epochDurationDays) * 7;
  }
  
  return reward;
}
