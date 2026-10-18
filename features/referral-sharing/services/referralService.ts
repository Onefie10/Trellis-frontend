/* Service for managing referral links and analytics */

import { apiClient } from '../../../lib/api';
import { ReferralLink, ReferralStats, ReferralAnalytics, ReferralReward } from '../types';
import {
  buildVanityReferralUrl,
  findVanitySlugCollision,
  normalizeVanitySlug,
  validateVanitySlug,
  VanitySlugError,
  type VanitySlugValidation,
} from '@/lib/vanity-slug';

export interface RegisterVanitySlugParams {
  userId: string;
  slug: string;
  targetAgentId: string;
  reward?: string;
  /** Slugs the user already owns, checked for collisions before the request. */
  existingSlugs?: Array<string | null | undefined>;
}

export class ReferralService {
  private static baseUrl = '/referrals';
  /** Affiliate API host for vanity aliases and click metrics (#128). */
  private static affiliateBaseUrl = '/api/affiliates';

  // Generate a new referral link
  static async generateReferralLink(userId: string, reward: string = '10 XLM'): Promise<ReferralLink> {
    const referralCode = this.generateReferralCode();
    const baseUrl = typeof window !== 'undefined' ? window.location.origin : 'https://Trellis.com';
    const referralUrl = `${baseUrl}/ref/${referralCode}`;

    const referralLink: Omit<ReferralLink, 'id' | 'createdAt'> = {
      code: referralCode,
      url: referralUrl,
      userId,
      isActive: true,
      uses: 0,
      maxUses: 100,
      reward,
    };

    try {
      const response = await apiClient.post(`${this.baseUrl}/generate`, referralLink);
      return response;
    } catch (error) {
      // Fallback to client-side generation if API fails
      return {
        ...referralLink,
        id: `ref_${Date.now()}_${userId}`,
        createdAt: new Date().toISOString(),
      };
    }
  }

  // Get user's referral links
  static async getUserReferralLinks(userId: string): Promise<ReferralLink[]> {
    try {
      return await apiClient.get(`${this.baseUrl}/user/${userId}/links`);
    } catch (error) {
      return [];
    }
  }

  // Get referral statistics
  static async getReferralStats(userId: string): Promise<ReferralStats> {
    try {
      return await apiClient.get(`${this.baseUrl}/user/${userId}/stats`);
    } catch (error) {
      return {
        totalClicks: 0,
        totalSignups: 0,
        totalRewards: '0',
        pendingRewards: '0',
        activeLinks: 0,
        conversionRate: 0,
      };
    }
  }

  // Track referral click
  static async trackReferralClick(referralCode: string, source: string, metadata?: any): Promise<void> {
    const analytics: Omit<ReferralAnalytics, 'id' | 'timestamp'> = {
      referralCode,
      eventType: 'click',
      source,
      userAgent: typeof window !== 'undefined' ? window.navigator.userAgent : undefined,
      referrer: typeof window !== 'undefined' ? document.referrer : undefined,
      ...metadata,
    };

    try {
      await apiClient.post(`${this.baseUrl}/track`, analytics);
    } catch (error) {
      console.warn('Failed to track referral click:', error);
    }
  }

  // Track referral signup
  static async trackReferralSignup(referralCode: string, userId: string): Promise<void> {
    const analytics: Omit<ReferralAnalytics, 'id' | 'timestamp'> = {
      referralCode,
      eventType: 'signup',
      source: 'direct',
    };

    try {
      await apiClient.post(`${this.baseUrl}/track`, analytics);
    } catch (error) {
      console.warn('Failed to track referral signup:', error);
    }
  }

  // Get referral rewards
  static async getReferralRewards(userId: string): Promise<ReferralReward[]> {
    try {
      return await apiClient.get(`${this.baseUrl}/user/${userId}/rewards`);
    } catch (error) {
      return [];
    }
  }

  // Claim referral reward. A reward can only be claimed once, so the request
  // is idempotent by reward id: a retry (or a second click) replays the stored
  // outcome instead of claiming again.
  static async claimReward(rewardId: string): Promise<boolean> {
    try {
      await apiClient.postIdempotent(
        `${this.baseUrl}/rewards/${rewardId}/claim`,
        {},
        { scope: `claim:${rewardId}` },
      );
      return true;
    } catch (error) {
      console.warn('Failed to claim reward:', error);
      return false;
    }
  }

  // Validate referral code
  static async validateReferralCode(referralCode: string): Promise<boolean> {
    try {
      const response = await apiClient.get(`${this.baseUrl}/validate/${referralCode}`);
      return response.isValid;
    } catch (error) {
      return false;
    }
  }

  // Generate a unique referral code
  private static generateReferralCode(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < 8; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  }

  // Get referral link by code
  static async getReferralByCode(referralCode: string): Promise<ReferralLink | null> {
    try {
      return await apiClient.get(`${this.baseUrl}/code/${referralCode}`);
    } catch (error) {
      return null;
    }
  }

  // Update referral link
  static async updateReferralLink(id: string, updates: Partial<ReferralLink>): Promise<ReferralLink> {
    return await apiClient.put(`${this.baseUrl}/links/${id}`, updates);
  }

  // Delete referral link
  static async deleteReferralLink(id: string): Promise<void> {
    await apiClient.delete(`${this.baseUrl}/links/${id}`);
  }

  // --- Vanity referral links (issue #128) ---

  /** Canonicalize a candidate slug: trim, lowercase, spaces/underscores -> hyphen. */
  static normalizeVanitySlug(raw: string): string {
    return normalizeVanitySlug(raw);
  }

  /**
   * Validate a candidate alias against the shared rules: allowed charset,
   * length bounds, reserved words and collisions with slugs the user owns.
   */
  static validateVanitySlug(
    raw: string,
    existingSlugs: Array<string | null | undefined> = [],
  ): VanitySlugValidation {
    return validateVanitySlug(raw, { taken: this.cleanSlugs(existingSlugs) });
  }

  /** First slug that collides with the candidate (case-insensitive), or null. */
  static findVanitySlugCollision(
    raw: string,
    existingSlugs: Array<string | null | undefined> = [],
  ): string | null {
    return findVanitySlugCollision(raw, this.cleanSlugs(existingSlugs));
  }

  /** Build the clean share URL: https://trellis.market/r/<slug>. */
  static buildVanityUrl(slug: string): string {
    return buildVanityReferralUrl(slug);
  }

  /**
   * Ask the backend whether an alias is free. Static validation runs first so
   * a rejected slug never needs a round trip; the server stays the authority
   * because only it can see every user's aliases.
   */
  static async isVanitySlugAvailable(
    slug: string,
    existingSlugs: Array<string | null | undefined> = [],
  ): Promise<boolean> {
    const validation = this.validateVanitySlug(slug, existingSlugs);
    if (!validation.valid) return false;
    try {
      const response = await apiClient.get(
        `${this.affiliateBaseUrl}/vanity-slugs?slug=${encodeURIComponent(validation.normalized)}`,
      );
      return response?.available !== false;
    } catch (error) {
      // Backend unavailable: the local checks still hold and registration
      // re-validates server-side, so a valid slug is not blocked here.
      return true;
    }
  }

  /**
   * Register a custom vanity alias pointing at a marketplace agent. Invalid
   * or colliding slugs are rejected before the request; the backend enforces
   * the same rules to cover races between two users.
   */
  static async registerVanitySlug(params: RegisterVanitySlugParams): Promise<ReferralLink> {
    const { userId, slug, targetAgentId, reward = '10 XLM', existingSlugs = [] } = params;

    const validation = this.validateVanitySlug(slug, existingSlugs);
    if (!validation.valid) {
      throw new VanitySlugError(
        validation.reason ?? 'INVALID_CHARACTERS',
        validation.error ?? 'Invalid vanity slug',
      );
    }
    if (!targetAgentId || targetAgentId.trim() === '') {
      throw new VanitySlugError('AGENT_REQUIRED', 'Choose a marketplace agent for this link');
    }

    const url = this.buildVanityUrl(validation.normalized);
    const response = await apiClient.post(`${this.affiliateBaseUrl}/vanity-slugs`, {
      walletAddress: userId,
      slug: validation.normalized,
      targetAgentId: targetAgentId.trim(),
      url,
      reward,
    });

    if (!response || typeof response !== 'object') {
      throw new VanitySlugError('REGISTRATION_FAILED', 'The backend did not confirm the alias');
    }

    // Normalize the backend record into a full ReferralLink: the registry only
    // stores the alias, while the UI renders the same link shape as any other
    // referral link.
    return {
      id: typeof response.id === 'string' ? response.id : `vanity_${validation.normalized}`,
      code: typeof response.code === 'string' ? response.code : validation.normalized,
      url,
      userId,
      createdAt:
        typeof response.createdAt === 'string'
          ? response.createdAt
          : new Date().toISOString(),
      isActive: true,
      uses: 0,
      reward,
      slug: validation.normalized,
      targetAgentId: targetAgentId.trim(),
    };
  }

  private static cleanSlugs(slugs: Array<string | null | undefined>): string[] {
    return slugs.filter((slug): slug is string => typeof slug === 'string' && slug.length > 0);
  }
}
