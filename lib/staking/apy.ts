export function calculateAPY(
  emissionPerSecond: number,
  totalEffectiveStake: number,
  rewardTokenPrice: number = 1,
  stakedTokenPrice: number = 1
): number {
  if (totalEffectiveStake === 0) return 0;
  
  const SECONDS_PER_YEAR = 31536000;
  const annualEmission = emissionPerSecond * SECONDS_PER_YEAR;
  
  const annualRewardValue = annualEmission * rewardTokenPrice;
  const totalStakedValue = totalEffectiveStake * stakedTokenPrice;
  
  return (annualRewardValue / totalStakedValue) * 100;
}
