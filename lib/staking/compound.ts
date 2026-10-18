export interface CompoundProjection { principal: number; standardYield: number; compoundedYield: number; apy: number; periods: number; }

export function projectCompoundYield(principal: number, annualRate: number, periodsPerYear: number, years = 1): CompoundProjection {
  if (![principal, annualRate, periodsPerYear, years].every(Number.isFinite) || principal < 0 || periodsPerYear <= 0 || years < 0) throw new Error('Invalid compounding inputs');
  const periods = Math.max(0, Math.floor(periodsPerYear * years));
  return { principal, standardYield: principal * annualRate * years, compoundedYield: principal * (Math.pow(1 + annualRate / periodsPerYear, periods) - 1), apy: Math.pow(1 + annualRate / periodsPerYear, periodsPerYear) - 1, periods };
}

export interface CompoundInvocation { contractId: string; method: string; args: unknown[]; }
export function buildAutoCompoundInvocation(poolContractId: string, account: string, assetId: string): CompoundInvocation {
  if (!poolContractId || !account || !assetId) throw new Error('Pool, account, and asset are required');
  return { contractId: poolContractId, method: 'harvest_and_stake', args: [account, assetId] };
}
export async function executeAutoCompound(invoke: (invocation: CompoundInvocation) => Promise<unknown>, poolContractId: string, account: string, assetId: string) { return invoke(buildAutoCompoundInvocation(poolContractId, account, assetId)); }
