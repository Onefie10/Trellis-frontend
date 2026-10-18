import { create } from 'zustand';
import {
  AffiliateStats,
  ReferralRecord,
  CommissionBreakdown,
  PayoutRequest,
  AffiliateProgram,
  EarningsHistory,
  ReferralClickMetrics,
} from '../types';
import { affiliateService } from '../services/affiliateService';
import {
  beginIdempotentAttempt,
  finishIdempotentAttempt,
} from '@/lib/idempotency';

interface AffiliateStore {
  // State
  walletAddress: string | null;
  stats: AffiliateStats | null;
  referrals: ReferralRecord[];
  commissionBreakdown: CommissionBreakdown[];
  payoutRequests: PayoutRequest[];
  program: AffiliateProgram | null;
  earningsHistory: EarningsHistory[];
  /** CTR / conversion metrics for the wallet's vanity links (#128). */
  clickMetrics: ReferralClickMetrics | null;
  isLoading: boolean;
  error: string | null;

  // Actions
  fetchAffiliateData: (walletAddress: string) => Promise<void>;
  requestPayout: (amount: string, walletAddress: string) => Promise<void>;
  generateReferralCode: () => Promise<string>;
  clearError: () => void;
}

/**
 * Derive the commission breakdown from real referral records.
 * Tiers beyond direct are reported when present in the data.
 */
function buildCommissionBreakdown(referrals: ReferralRecord[]): CommissionBreakdown[] {
  const converted = referrals.filter((r) => r.status === 'converted');
  const total = converted.reduce((sum, r) => sum + (parseFloat(r.commissionAmount) || 0), 0);
  if (converted.length === 0 || total <= 0) {
    return [];
  }
  return [
    {
      type: 'direct',
      amount: total.toFixed(2),
      percentage: 100,
      count: converted.length,
    },
  ];
}

function toErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export const useAffiliateStore = create<AffiliateStore>((set, get) => ({
  walletAddress: null,
  stats: null,
  referrals: [],
  commissionBreakdown: [],
  payoutRequests: [],
  program: null,
  earningsHistory: [],
  clickMetrics: null,
  isLoading: false,
  error: null,

  fetchAffiliateData: async (walletAddress: string) => {
    set({ isLoading: true, error: null, walletAddress });
    try {
      if (!walletAddress) {
        throw new Error('Wallet address required');
      }

      const [stats, referrals, payoutRequests, program, earningsHistory, clickMetrics] =
        await Promise.all([
          affiliateService.getStats(walletAddress),
          affiliateService.getReferrals(walletAddress),
          affiliateService.getPayoutRequests(walletAddress),
          affiliateService.getProgram(),
          affiliateService.getEarningsHistory(walletAddress),
          affiliateService.getReferralClickMetrics(walletAddress),
        ]);

      set({
        stats,
        referrals,
        commissionBreakdown: buildCommissionBreakdown(referrals),
        payoutRequests,
        program,
        earningsHistory,
        clickMetrics,
        isLoading: false,
      });
    } catch (error) {
      set({
        error: toErrorMessage(error, 'Failed to fetch affiliate data'),
        isLoading: false,
      });
    }
  },

  requestPayout: async (amount: string, walletAddress: string) => {
    set({ isLoading: true, error: null });
    try {
      // Validate amount
      const amountNum = parseFloat(amount);
      if (isNaN(amountNum) || amountNum <= 0) {
        throw new Error('Invalid payout amount');
      }

      if (!walletAddress) {
        throw new Error('Wallet address required');
      }

      const { stats, program } = get();
      const minimum = parseFloat(program?.minimumPayout ?? '100');
      if (amountNum < minimum) {
        throw new Error(`Minimum payout is ${program?.minimumPayout ?? '100.00'} XLM`);
      }
      const pending = parseFloat(stats?.pendingEarnings ?? '0');
      if (amountNum > pending) {
        throw new Error(`Insufficient pending earnings. Available: ${stats?.pendingEarnings ?? '0.00'} XLM`);
      }

      // The backend queues settlement; surface its failures instead of
      // reporting success. The key is bound to this *attempt* and persists
      // across a reload, so a retry reuses it — a random key per click, which
      // is what this used to mint, protects nothing: the second click simply
      // looked like a new request. Once the request lands the attempt is
      // closed, so deliberately paying out the same amount again later is a
      // new intent and gets a new key.
      const attemptScope = `payout:${walletAddress}:${amount}:${walletAddress}`;
      const idempotencyKey = await beginIdempotentAttempt(attemptScope);
      await affiliateService.requestPayout(walletAddress, amount, walletAddress, idempotencyKey);
      // Only after the request lands; a failure leaves the attempt open so the
      // retry reuses this key.
      finishIdempotentAttempt(attemptScope);

      // Refresh from the backend so the UI reflects real state.
      const [payoutRequests, refreshedStats] = await Promise.all([
        affiliateService.getPayoutRequests(walletAddress),
        affiliateService.getStats(walletAddress),
      ]);

      set({
        payoutRequests,
        stats: refreshedStats,
        isLoading: false,
      });
    } catch (error) {
      const message = toErrorMessage(error, 'Failed to request payout');
      set({ error: message, isLoading: false });
      throw new Error(message);
    }
  },

  generateReferralCode: async () => {
    set({ isLoading: true, error: null });
    try {
      const walletAddress = get().walletAddress;
      if (!walletAddress) {
        throw new Error('Wallet address required');
      }

      const { code } = await affiliateService.generateReferralCode(walletAddress);
      set({ isLoading: false });
      return code;
    } catch (error) {
      const message = toErrorMessage(error, 'Failed to generate referral code');
      set({ error: message, isLoading: false });
      throw new Error(message);
    }
  },

  clearError: () => set({ error: null }),
}));
