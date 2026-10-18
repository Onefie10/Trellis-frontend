export interface AffiliateStats {
  totalReferrals: number;
  activeReferrals: number;
  totalEarnings: string;
  pendingEarnings: string;
  totalPayouts: string;
  conversionRate: number;
}

export interface ReferralRecord {
  id: string;
  referralCode: string;
  referredUserAddress: string;
  referredUserName?: string;
  status: 'active' | 'inactive' | 'converted';
  commissionRate: number;
  commissionAmount: string;
  createdAt: string;
  convertedAt?: string;
}

export interface CommissionBreakdown {
  type: 'direct' | 'tier2' | 'tier3';
  amount: string;
  percentage: number;
  count: number;
}

export interface PayoutRequest {
  id: string;
  amount: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  requestedAt: string;
  processedAt?: string;
  walletAddress: string;
  transactionHash?: string;
}

export interface AffiliateProgram {
  id: string;
  name: string;
  status: 'active' | 'inactive' | 'suspended';
  commissionStructure: {
    direct: number;
    tier2?: number;
    tier3?: number;
  };
  minimumPayout: string;
  payoutFrequency: 'daily' | 'weekly' | 'monthly';
  guidelines: string[];
  joinedAt: string;
}

export interface EarningsHistory {
  date: string;
  amount: number;
  source: 'direct' | 'tier2' | 'tier3';
}

// ---------------------------------------------------------------------------
// Referral click analytics & vanity aliases (#128)
// ---------------------------------------------------------------------------
// The canonical shapes live in lib/referral-metrics and lib/vanity-slug so the
// client recorder, the API store and the dashboard cannot drift apart.
export type {
  ConversionStatus,
  DeviceType,
  ReferralClickMetrics,
  ReferralDeviceMetric,
  ReferralEventKind,
  ReferralLinkEvent,
  ReferralMetricPoint,
  ReferralSourceMetric,
  ReferrerSource,
} from '@/lib/referral-metrics';
export type {
  VanitySlugRecord,
  VanitySlugRejectionReason,
  VanitySlugValidation,
} from '@/lib/vanity-slug';
