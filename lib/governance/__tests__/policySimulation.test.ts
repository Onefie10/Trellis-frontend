import { simulatePolicyChange } from '../policySimulation';
import type { Policy } from '@/features/agent-telemetry/services/quotaService';

const policy: Policy = {
  id: 'free',
  name: 'Free',
  description: 'Basic tier',
  quotaLimit: 1000,
  rateLimit: 4,
};

describe('simulatePolicyChange', () => {
  it('reports limit deltas and flags changes of at least 25 percent', () => {
    const result = simulatePolicyChange(policy, { ...policy, quotaLimit: 1250, rateLimit: 3 });

    expect(result).toMatchObject({
      valid: true,
      quotaChangePercent: 25,
      rateChangePercent: -25,
      highImpact: true,
      errors: [],
    });
  });

  it('rejects non-positive or fractional limits', () => {
    const result = simulatePolicyChange(policy, { ...policy, quotaLimit: 0, rateLimit: 1.5 });

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([
      'Daily quota must be a positive whole number.',
      'Rate limit must be a positive whole number.',
    ]);
  });
});
