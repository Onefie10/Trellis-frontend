/* Type definitions for referral sharing feature */

import type { ConversionStatus, DeviceType } from '@/lib/referral-metrics';

export interface ReferralLink {
  id: string;
  code: string;
  url: string;
  userId: string;
  createdAt: string;
  expiresAt?: string;
  isActive: boolean;
  uses: number;
  maxUses?: number;
  reward: string; // XLM amount or token amount
  /** Custom vanity alias, when the link was registered with one (#128). */
  slug?: string;
  /** Marketplace agent the vanity link resolves to (#128). */
  targetAgentId?: string;
}

export interface ReferralStats {
  totalClicks: number;
  totalSignups: number;
  totalRewards: string;
  pendingRewards: string;
  activeLinks: number;
  conversionRate: number;
}

export interface ReferralAnalytics {
  id: string;
  referralCode: string;
  timestamp: string;
  eventType: 'click' | 'signup' | 'conversion';
  source: string; // 'twitter', 'facebook', 'copy', 'qr', etc.
  userAgent?: string;
  ip?: string;
  referrer?: string;
  /** Device the event came from (#128). */
  deviceType?: DeviceType;
  /** How far the click got toward a conversion (#128). */
  conversionStatus?: ConversionStatus;
  /** Marketplace agent the referral pointed at (#128). */
  agentId?: string;
}

export interface SocialShareConfig {
  platform: 'twitter' | 'facebook' | 'linkedin' | 'whatsapp' | 'telegram';
  url: string;
  title: string;
  description: string;
  hashtags?: string[];
}

export interface QRCodeConfig {
  url: string;
  size?: number;
  bgColor?: string;
  fgColor?: string;
  logo?: string;
  logoSize?: number;
}

export interface ReferralReward {
  id: string;
  referralCode: string;
  amount: string;
  asset: string;
  status: 'pending' | 'claimed' | 'expired';
  createdAt: string;
  claimedAt?: string;
}

// ---------------------------------------------------------------------------
// Referral click analytics types (#128)
// ---------------------------------------------------------------------------
// Canonical shapes live in lib/referral-metrics so the client recorder and the
// API store agree on every field.
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
