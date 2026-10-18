import { getStellarServer } from '@/lib/stellar';
import type { StellarNetwork } from '@/lib/types';

export interface SybilRequirements {
  /**
   * Minimum account age in days required to pass verification.
   * Default: 30 days.
   */
  minAccountAgeDays: number;
  /**
   * Minimum number of successful transactions in history.
   * Default: 5 transactions.
   */
  minTransactionCount: number;
  /**
   * If true, failure to meet requirements prevents quadratic weight amplification.
   */
  enforceStrictRejection?: boolean;
}

export const DEFAULT_SYBIL_REQUIREMENTS: SybilRequirements = {
  minAccountAgeDays: 30,
  minTransactionCount: 5,
  enforceStrictRejection: true,
};

export interface SybilVerificationResult {
  isVerified: boolean;
  accountAgeDays: number;
  transactionCount: number;
  passedAccountAge: boolean;
  passedTransactionCount: boolean;
  accountCreatedAt: string | null;
  reasons: string[];
  warnings: string[];
}

/**
 * Pure evaluation function for Sybil resistance.
 * Evaluates given account creation time and transaction count against requirements.
 */
export function evaluateSybilResistance(
  accountData: {
    createdAt?: Date | string | number | null;
    transactionCount?: number | null;
  },
  requirements: Partial<SybilRequirements> = {}
): SybilVerificationResult {
  const reqs: SybilRequirements = {
    ...DEFAULT_SYBIL_REQUIREMENTS,
    ...requirements,
  };

  const now = Date.now();
  let createdTimeMs: number | null = null;
  let createdAtStr: string | null = null;

  if (accountData.createdAt) {
    const parsed = new Date(accountData.createdAt);
    if (!isNaN(parsed.getTime())) {
      createdTimeMs = parsed.getTime();
      createdAtStr = parsed.toISOString();
    }
  }

  const accountAgeDays =
    createdTimeMs !== null
      ? Math.max(0, Math.floor((now - createdTimeMs) / (1000 * 60 * 60 * 24)))
      : 0;

  const transactionCount = Math.max(0, accountData.transactionCount || 0);

  const passedAccountAge =
    createdTimeMs !== null && accountAgeDays >= reqs.minAccountAgeDays;
  const passedTransactionCount = transactionCount >= reqs.minTransactionCount;

  const isVerified = passedAccountAge && passedTransactionCount;
  const reasons: string[] = [];
  const warnings: string[] = [];

  if (!passedAccountAge) {
    if (createdTimeMs === null) {
      reasons.push('Account creation date could not be established.');
    } else {
      reasons.push(
        `Account age (${accountAgeDays} days) is less than required minimum of ${reqs.minAccountAgeDays} days.`
      );
    }
  }

  if (!passedTransactionCount) {
    reasons.push(
      `Transaction count (${transactionCount}) is lower than required minimum of ${reqs.minTransactionCount} transactions.`
    );
  }

  if (isVerified) {
    warnings.push('Account passed all Sybil-resistance checks.');
  }

  return {
    isVerified,
    accountAgeDays,
    transactionCount,
    passedAccountAge,
    passedTransactionCount,
    accountCreatedAt: createdAtStr,
    reasons,
    warnings,
  };
}

/**
 * Live verification against Stellar Horizon RPC.
 * Queries account details and transaction history to verify account age and activity.
 */
export async function verifyStellarAccountSybilResistance(
  accountId: string,
  network: StellarNetwork,
  requirements: Partial<SybilRequirements> = {}
): Promise<SybilVerificationResult> {
  const reqs: SybilRequirements = {
    ...DEFAULT_SYBIL_REQUIREMENTS,
    ...requirements,
  };

  try {
    const server = getStellarServer(network);

    // Load account
    const account = await server.loadAccount(accountId);
    if (!account) {
      return {
        isVerified: false,
        accountAgeDays: 0,
        transactionCount: 0,
        passedAccountAge: false,
        passedTransactionCount: false,
        accountCreatedAt: null,
        reasons: ['Account not found on Stellar network.'],
        warnings: [],
      };
    }

    // Fetch account transactions (oldest first or limit recent)
    // Stellar Horizon allows querying transactions
    const txRecords = await server
      .transactions()
      .forAccount(accountId)
      .limit(Math.max(reqs.minTransactionCount + 5, 20))
      .order('asc')
      .call();

    const transactions = txRecords.records || [];
    const transactionCount = transactions.length;

    // Earliest transaction timestamp marks account activity start
    let createdAt: string | null = null;
    if (transactions.length > 0 && transactions[0].created_at) {
      createdAt = transactions[0].created_at;
    }

    return evaluateSybilResistance(
      {
        createdAt,
        transactionCount,
      },
      reqs
    );
  } catch (error: any) {
    // If account doesn't exist on-chain or network fails
    const errorMessage = error?.message || 'Error communicating with Stellar Horizon';
    return {
      isVerified: false,
      accountAgeDays: 0,
      transactionCount: 0,
      passedAccountAge: false,
      passedTransactionCount: false,
      accountCreatedAt: null,
      reasons: [`Sybil verification failed: ${errorMessage}`],
      warnings: [],
    };
  }
}
