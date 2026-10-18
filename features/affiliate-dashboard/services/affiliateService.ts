import { apiClient } from '@/lib/api';
import {
  AffiliateStats,
  EarningsHistory,
  ReferralRecord,
  PayoutRequest,
  AffiliateProgram,
  ReferralClickMetrics,
} from '../types';

const API_BASE = '/api/affiliates';

export const affiliateService = {
  /**
   * Fetch affiliate statistics for the authenticated user
   */
  getStats: async (walletAddress: string): Promise<AffiliateStats> => {
    return apiClient.get(`${API_BASE}/stats?wallet=${walletAddress}`);
  },

  /**
   * Fetch all referral records for the affiliate
   */
  getReferrals: async (walletAddress: string): Promise<ReferralRecord[]> => {
    return apiClient.get(`${API_BASE}/referrals?wallet=${walletAddress}`);
  },

  /**
   * Fetch payout history and pending requests
   */
  getPayoutRequests: async (walletAddress: string): Promise<PayoutRequest[]> => {
    return apiClient.get(`${API_BASE}/payouts?wallet=${walletAddress}`);
  },

  /**
   * Fetch affiliate program details
   */
  getProgram: async (): Promise<AffiliateProgram> => {
    return apiClient.get(`${API_BASE}/program`);
  },

  /**
   * Request a payout. The backend queues settlement — the browser never
   * signs. Pass an idempotency key so retries cannot pay twice.
   */
  requestPayout: async (
    walletAddress: string,
    amount: string,
    destinationAddress: string,
    idempotencyKey?: string,
  ): Promise<PayoutRequest> => {
    // Money path. The key identifies the *attempt*, so a double submit cannot
    // queue two payouts, and the outcome is remembered: a retry after a
    // success replays the queued payout instead of asking for a second one.
    const { value } = await apiClient.postIdempotent<PayoutRequest>(
      `${API_BASE}/payouts`,
      { walletAddress, amount, destinationAddress },
      { key: idempotencyKey, scope: `payout:${walletAddress}` },
    );
    return value;
  },

  /**
   * Get-or-create the wallet's referral code. Repeated calls return the
   * same persisted code.
   */
  generateReferralCode: async (walletAddress: string): Promise<{ code: string }> => {
    return apiClient.post(`${API_BASE}/referrals`, {
      walletAddress,
    });
  },

  /**
   * Build the shareable referral link for a code (no backend call needed).
   */
  getReferralLink: async (code: string): Promise<{ link: string }> => {
    const baseUrl =
      typeof window !== 'undefined' ? window.location.origin : 'https://Trellis.com';
    return { link: `${baseUrl}/ref/${code}` };
  },

  /**
   * Validate affiliate eligibility. Returns a machine-readable reasonCode
   * on rejection so the UI can explain it. Evidence for the verifiable
   * criteria (account age, volume, KYC, referrer) can be supplied when
   * known; unverifiable criteria fail closed.
   */
  validateEligibility: async (
    walletAddress: string,
    evidence?: {
      accountCreatedAt?: string;
      tradingVolumeXlm?: number;
      verified?: boolean;
      referrerCode?: string;
    },
  ): Promise<{ eligible: boolean; reason?: string; reasonCode?: string }> => {
    const params = new URLSearchParams({ wallet: walletAddress });
    if (evidence?.accountCreatedAt) params.set('accountCreatedAt', evidence.accountCreatedAt);
    if (evidence?.tradingVolumeXlm !== undefined)
      params.set('tradingVolumeXlm', String(evidence.tradingVolumeXlm));
    if (evidence?.verified !== undefined) params.set('verified', String(evidence.verified));
    if (evidence?.referrerCode) params.set('referrerCode', evidence.referrerCode);
    return apiClient.get(`${API_BASE}/validate?${params.toString()}`);
  },

  /**
   * Get earnings history for charts
   */
  getEarningsHistory: async (
    walletAddress: string,
    days: number = 30
  ): Promise<EarningsHistory[]> => {
    return apiClient.get(`${API_BASE}/earnings?wallet=${walletAddress}&days=${days}`);
  },

  /**
   * CTR / conversion metrics for the wallet's vanity referral links (#128).
   * Derived server-side from the recorded click ledger so the chart can never
   * disagree with the attribution data.
   */
  getReferralClickMetrics: async (
    walletAddress: string,
    days: number = 30
  ): Promise<ReferralClickMetrics> => {
    return apiClient.get(`${API_BASE}/referral-clicks?wallet=${walletAddress}&days=${days}`);
  },
};
