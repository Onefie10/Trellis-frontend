export interface QuadraticVotingOptions {
  /**
   * Number of decimal places to round the resulting voting weight.
   * Defaults to 4 decimal places. Set to null for unrounded floating point.
   */
  precision?: number | null;
  /**
   * Rounding mode: 'round' (standard Math.round), 'floor', or 'ceil'.
   * Defaults to 'round'.
   */
  roundMode?: 'round' | 'floor' | 'ceil';
}

export type VotingMechanism = 'linear' | 'quadratic';

export interface VoteTally {
  approvals: number;
  rejections: number;
  abstentions: number;
  totalVotes: number;
  approvalRatio: number;
  rejectionRatio: number;
  abstentionRatio: number;
}

export interface VoterDistributionTier {
  tier: 'Whale (>10%)' | 'Large (2-10%)' | 'Medium (0.5-2%)' | 'Community (<0.5%)';
  voterCount: number;
  totalTokens: number;
  linearVotingPower: number;
  quadraticVotingPower: number;
  linearShare: number;
  quadraticShare: number;
}

export interface LinearVsQuadraticComparisonResult {
  linearTally: VoteTally;
  quadraticTally: VoteTally;
  linearQuorumReached: boolean;
  quadraticQuorumReached: boolean;
  linearOutcome: 'approved' | 'rejected' | 'quorum_not_met';
  quadraticOutcome: 'approved' | 'rejected' | 'quorum_not_met';
  outcomeFlipped: boolean;
  whaleInfluenceReductionPercent: number;
  distributionByTier: VoterDistributionTier[];
  voteChoiceDistribution: {
    choice: 'approve' | 'reject' | 'abstain';
    linearVotes: number;
    linearPercent: number;
    quadraticVotes: number;
    quadraticPercent: number;
  }[];
}

/**
 * Calculates the quadratic voting power from a staked token balance.
 * Formula: voting_power = Math.sqrt(staked_balance)
 *
 * Edge cases handled:
 * - Negative balances or 0 return 0
 * - NaN, null, undefined or non-numeric strings return 0
 * - Fractional balances and decimal precision handled accurately
 * - Optional rounding to specified precision
 */
export function calculateQuadraticVotingWeight(
  stakedBalance: number | string | bigint | null | undefined,
  options: QuadraticVotingOptions = {}
): number {
  if (stakedBalance === null || stakedBalance === undefined) {
    return 0;
  }

  let numericBalance: number;

  if (typeof stakedBalance === 'bigint') {
    numericBalance = Number(stakedBalance);
  } else if (typeof stakedBalance === 'string') {
    const trimmed = stakedBalance.trim();
    if (trimmed === '') return 0;
    numericBalance = parseFloat(trimmed);
  } else {
    numericBalance = stakedBalance;
  }

  if (isNaN(numericBalance) || numericBalance <= 0 || !isFinite(numericBalance)) {
    return 0;
  }

  // Calculate raw square root weight
  const rawWeight = Math.sqrt(numericBalance);

  const precision = options.precision !== undefined ? options.precision : 4;
  const roundMode = options.roundMode || 'round';

  if (precision === null) {
    return rawWeight;
  }

  const factor = Math.pow(10, precision);
  let rounded: number;

  switch (roundMode) {
    case 'floor':
      rounded = Math.floor(rawWeight * factor) / factor;
      break;
    case 'ceil':
      rounded = Math.ceil(rawWeight * factor) / factor;
      break;
    case 'round':
    default:
      // Avoid floating point precision issues like 1.0000000000000002
      rounded = Math.round((rawWeight + Number.EPSILON) * factor) / factor;
      break;
  }

  return rounded;
}

/**
 * Returns voting power given a balance and voting mechanism ('linear' or 'quadratic').
 */
export function calculateVotingPower(
  stakedBalance: number | string | bigint | null | undefined,
  mechanism: VotingMechanism = 'quadratic',
  options?: QuadraticVotingOptions
): number {
  if (mechanism === 'linear') {
    const num = typeof stakedBalance === 'string' ? parseFloat(stakedBalance) : Number(stakedBalance || 0);
    return isNaN(num) || num <= 0 || !isFinite(num) ? 0 : num;
  }
  return calculateQuadraticVotingWeight(stakedBalance, options);
}

/**
 * Computes side-by-side comparison of linear vs quadratic voting tallies,
 * including tier distribution and outcome comparisons.
 */
export function compareLinearVsQuadraticVotes(
  votes: Array<{
    voter: string;
    tokenBalance: number;
    choice: 'approve' | 'reject' | 'abstain';
    isSybilVerified?: boolean;
  }>,
  config: {
    totalVotingPowerAtCreation?: number;
    requiredApprovalRatio?: number;
    minQuorumRatio?: number;
    requireSybilVerification?: boolean;
  } = {}
): LinearVsQuadraticComparisonResult {
  const requiredApprovalRatio = config.requiredApprovalRatio ?? 0.6;
  const minQuorumRatio = config.minQuorumRatio ?? 0.2;
  const totalPowerAtCreation = config.totalVotingPowerAtCreation || 0;

  // Filter votes if sybil verification is strictly required
  const eligibleVotes = config.requireSybilVerification
    ? votes.filter((v) => v.isSybilVerified !== false)
    : votes;

  let linearApprovals = 0;
  let linearRejections = 0;
  let linearAbstentions = 0;

  let quadApprovals = 0;
  let quadRejections = 0;
  let quadAbstentions = 0;

  let totalLinearTokens = 0;
  let totalQuadTokens = 0;

  // First pass: sum totals for percentage calculations
  for (const v of eligibleVotes) {
    const tokens = Math.max(0, v.tokenBalance || 0);
    const quad = calculateQuadraticVotingWeight(tokens);

    totalLinearTokens += tokens;
    totalQuadTokens += quad;

    if (v.choice === 'approve') {
      linearApprovals += tokens;
      quadApprovals += quad;
    } else if (v.choice === 'reject') {
      linearRejections += tokens;
      quadRejections += quad;
    } else {
      linearAbstentions += tokens;
      quadAbstentions += quad;
    }
  }

  const linearTotalVotes = linearApprovals + linearRejections + linearAbstentions;
  const quadTotalVotes = quadApprovals + quadRejections + quadAbstentions;

  const linearTally: VoteTally = {
    approvals: linearApprovals,
    rejections: linearRejections,
    abstentions: linearAbstentions,
    totalVotes: linearTotalVotes,
    approvalRatio: linearTotalVotes > 0 ? linearApprovals / linearTotalVotes : 0,
    rejectionRatio: linearTotalVotes > 0 ? linearRejections / linearTotalVotes : 0,
    abstentionRatio: linearTotalVotes > 0 ? linearAbstentions / linearTotalVotes : 0,
  };

  const quadraticTally: VoteTally = {
    approvals: quadApprovals,
    rejections: quadRejections,
    abstentions: quadAbstentions,
    totalVotes: quadTotalVotes,
    approvalRatio: quadTotalVotes > 0 ? quadApprovals / quadTotalVotes : 0,
    rejectionRatio: quadTotalVotes > 0 ? quadRejections / quadTotalVotes : 0,
    abstentionRatio: quadTotalVotes > 0 ? quadAbstentions / quadTotalVotes : 0,
  };

  // Quorum calculations
  const linearQuorumTarget = (totalPowerAtCreation || linearTotalVotes) * minQuorumRatio;
  const quadQuorumTarget =
    (calculateQuadraticVotingWeight(totalPowerAtCreation) || quadTotalVotes) * minQuorumRatio;

  const linearQuorumReached = linearTotalVotes >= linearQuorumTarget && linearTotalVotes > 0;
  const quadraticQuorumReached = quadTotalVotes >= quadQuorumTarget && quadTotalVotes > 0;

  const linearOutcome: 'approved' | 'rejected' | 'quorum_not_met' = !linearQuorumReached
    ? 'quorum_not_met'
    : linearTally.approvalRatio >= requiredApprovalRatio
    ? 'approved'
    : 'rejected';

  const quadraticOutcome: 'approved' | 'rejected' | 'quorum_not_met' = !quadraticQuorumReached
    ? 'quorum_not_met'
    : quadraticTally.approvalRatio >= requiredApprovalRatio
    ? 'approved'
    : 'rejected';

  const outcomeFlipped = linearOutcome !== quadraticOutcome;

  // Breakdown by holder tiers
  const tiers: Record<
    VoterDistributionTier['tier'],
    { count: number; tokens: number; quad: number }
  > = {
    'Whale (>10%)': { count: 0, tokens: 0, quad: 0 },
    'Large (2-10%)': { count: 0, tokens: 0, quad: 0 },
    'Medium (0.5-2%)': { count: 0, tokens: 0, quad: 0 },
    'Community (<0.5%)': { count: 0, tokens: 0, quad: 0 },
  };

  let whaleLinearPower = 0;
  let whaleQuadPower = 0;

  for (const v of eligibleVotes) {
    const tokens = Math.max(0, v.tokenBalance || 0);
    const quad = calculateQuadraticVotingWeight(tokens);
    const shareOfTotal = totalLinearTokens > 0 ? tokens / totalLinearTokens : 0;

    let tierKey: VoterDistributionTier['tier'];
    if (shareOfTotal >= 0.1) {
      tierKey = 'Whale (>10%)';
      whaleLinearPower += tokens;
      whaleQuadPower += quad;
    } else if (shareOfTotal >= 0.02) {
      tierKey = 'Large (2-10%)';
    } else if (shareOfTotal >= 0.005) {
      tierKey = 'Medium (0.5-2%)';
    } else {
      tierKey = 'Community (<0.5%)';
    }

    tiers[tierKey].count += 1;
    tiers[tierKey].tokens += tokens;
    tiers[tierKey].quad += quad;
  }

  const distributionByTier: VoterDistributionTier[] = (
    Object.keys(tiers) as Array<VoterDistributionTier['tier']>
  ).map((tierKey) => {
    const t = tiers[tierKey];
    return {
      tier: tierKey,
      voterCount: t.count,
      totalTokens: t.tokens,
      linearVotingPower: t.tokens,
      quadraticVotingPower: t.quad,
      linearShare: totalLinearTokens > 0 ? t.tokens / totalLinearTokens : 0,
      quadraticShare: totalQuadTokens > 0 ? t.quad / totalQuadTokens : 0,
    };
  });

  const whaleLinearShare = totalLinearTokens > 0 ? whaleLinearPower / totalLinearTokens : 0;
  const whaleQuadShare = totalQuadTokens > 0 ? whaleQuadPower / totalQuadTokens : 0;
  const whaleInfluenceReductionPercent =
    whaleLinearShare > 0
      ? Math.max(0, Math.round(((whaleLinearShare - whaleQuadShare) / whaleLinearShare) * 100))
      : 0;

  const voteChoiceDistribution = [
    {
      choice: 'approve' as const,
      linearVotes: linearApprovals,
      linearPercent: linearTotalVotes > 0 ? (linearApprovals / linearTotalVotes) * 100 : 0,
      quadraticVotes: quadApprovals,
      quadraticPercent: quadTotalVotes > 0 ? (quadApprovals / quadTotalVotes) * 100 : 0,
    },
    {
      choice: 'reject' as const,
      linearVotes: linearRejections,
      linearPercent: linearTotalVotes > 0 ? (linearRejections / linearTotalVotes) * 100 : 0,
      quadraticVotes: quadRejections,
      quadraticPercent: quadTotalVotes > 0 ? (quadRejections / quadTotalVotes) * 100 : 0,
    },
    {
      choice: 'abstain' as const,
      linearVotes: linearAbstentions,
      linearPercent: linearTotalVotes > 0 ? (linearAbstentions / linearTotalVotes) * 100 : 0,
      quadraticVotes: quadAbstentions,
      quadraticPercent: quadTotalVotes > 0 ? (quadAbstentions / quadTotalVotes) * 100 : 0,
    },
  ];

  return {
    linearTally,
    quadraticTally,
    linearQuorumReached,
    quadraticQuorumReached,
    linearOutcome,
    quadraticOutcome,
    outcomeFlipped,
    whaleInfluenceReductionPercent,
    distributionByTier,
    voteChoiceDistribution,
  };
}
