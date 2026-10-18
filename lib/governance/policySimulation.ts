import type { Policy } from '@/features/agent-telemetry/services/quotaService';

export type PolicySimulation = {
  valid: boolean;
  errors: string[];
  quotaChangePercent: number;
  rateChangePercent: number;
  highImpact: boolean;
};

function percentChange(current: number, proposed: number): number {
  if (current === 0) return proposed === 0 ? 0 : 100;
  return ((proposed - current) / current) * 100;
}

/** Compare a draft with the active policy before it is sent to the policy service. */
export function simulatePolicyChange(current: Policy, proposed: Policy): PolicySimulation {
  const errors: string[] = [];
  if (!Number.isSafeInteger(proposed.quotaLimit) || proposed.quotaLimit < 1) {
    errors.push('Daily quota must be a positive whole number.');
  }
  if (!Number.isSafeInteger(proposed.rateLimit) || proposed.rateLimit < 1) {
    errors.push('Rate limit must be a positive whole number.');
  }

  const quotaChangePercent = percentChange(current.quotaLimit, proposed.quotaLimit);
  const rateChangePercent = percentChange(current.rateLimit, proposed.rateLimit);
  return {
    valid: errors.length === 0,
    errors,
    quotaChangePercent,
    rateChangePercent,
    highImpact: Math.abs(quotaChangePercent) >= 25 || Math.abs(rateChangePercent) >= 25,
  };
}
