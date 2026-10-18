/* Service for tracking referral analytics */

import { ReferralAnalytics } from '../types';
import {
  classifyReferrerSource,
  computeReferralClickMetrics,
  detectDeviceType,
  toConversionStatus,
  type ConversionStatus,
  type ReferralClickMetrics,
  type ReferralEventKind,
  type ReferralLinkEvent,
} from '@/lib/referral-metrics';

/** In-repo affiliate backend that owns the click ledger (issue #128). */
const LINK_EVENTS_ENDPOINT = '/api/affiliates/referral-clicks';
const LINK_EVENTS_STORAGE_KEY = 'referral_link_events';
const MAX_LINK_EVENTS = 500;

export interface RecordClickEventInput {
  slug: string;
  targetAgentId?: string;
  referralCode?: string;
  referrer?: string | null;
  userAgent?: string | null;
  conversionStatus?: ConversionStatus | boolean;
  kind?: ReferralEventKind;
}

export class AnalyticsService {
  private static baseUrl = '/analytics';

  // Track referral event
  static async trackEvent(event: Omit<ReferralAnalytics, 'id' | 'timestamp'>): Promise<void> {
    const eventData = {
      ...event,
      timestamp: new Date().toISOString(),
      id: `event_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    };

    try {
      // Send to analytics backend
      await fetch(`${this.baseUrl}/track`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(eventData),
      });
    } catch (error) {
      console.warn('Failed to track analytics event:', error);
      // Fallback to local storage for offline tracking
      this.storeEventLocally(eventData);
    }
  }

  // Get referral analytics
  static async getReferralAnalytics(referralCode: string): Promise<ReferralAnalytics[]> {
    try {
      const response = await fetch(`${this.baseUrl}/referral/${referralCode}`);
      if (!response.ok) throw new Error('Failed to fetch analytics');
      return await response.json();
    } catch (error) {
      console.warn('Failed to fetch analytics:', error);
      return this.getStoredEvents(referralCode);
    }
  }

  // Get user analytics summary
  static async getUserAnalyticsSummary(userId: string): Promise<{
    totalClicks: number;
    totalSignups: number;
    conversionRate: number;
    topSources: Array<{ source: string; count: number }>;
    dailyStats: Array<{ date: string; clicks: number; signups: number }>;
  }> {
    try {
      const response = await fetch(`${this.baseUrl}/user/${userId}/summary`);
      if (!response.ok) throw new Error('Failed to fetch user analytics');
      return await response.json();
    } catch (error) {
      console.warn('Failed to fetch user analytics:', error);
      return {
        totalClicks: 0,
        totalSignups: 0,
        conversionRate: 0,
        topSources: [],
        dailyStats: [],
      };
    }
  }

  // Track page view with referral context
  static trackPageView(referralCode?: string): void {
    if (typeof window === 'undefined') return;

    const event: Omit<ReferralAnalytics, 'id' | 'timestamp'> = {
      referralCode: referralCode || '',
      eventType: 'click',
      source: 'direct',
      userAgent: window.navigator.userAgent,
      referrer: document.referrer,
    };

    this.trackEvent(event);
  }

  // Track user signup from referral
  static trackSignup(referralCode: string, userId: string): void {
    const event: Omit<ReferralAnalytics, 'id' | 'timestamp'> = {
      referralCode,
      eventType: 'signup',
      source: 'direct',
    };

    this.trackEvent(event);
  }

  // Track conversion (when referred user completes key action)
  static trackConversion(referralCode: string, userId: string, actionType: string): void {
    const event: Omit<ReferralAnalytics, 'id' | 'timestamp'> = {
      referralCode,
      eventType: 'conversion',
      source: actionType,
    };

    this.trackEvent(event);
  }

  // Store events locally when offline
  private static storeEventLocally(event: ReferralAnalytics): void {
    if (typeof window === 'undefined') return;

    try {
      const storedEvents = localStorage.getItem('referral_events');
      const events = storedEvents ? JSON.parse(storedEvents) : [];
      events.push(event);
      
      // Keep only last 100 events to avoid storage issues
      if (events.length > 100) {
        events.splice(0, events.length - 100);
      }
      
      localStorage.setItem('referral_events', JSON.stringify(events));
    } catch (error) {
      console.warn('Failed to store event locally:', error);
    }
  }

  // Get stored events for a referral
  private static getStoredEvents(referralCode: string): ReferralAnalytics[] {
    if (typeof window === 'undefined') return [];

    try {
      const storedEvents = localStorage.getItem('referral_events');
      const events = storedEvents ? JSON.parse(storedEvents) : [];
      return events.filter((event: ReferralAnalytics) => event.referralCode === referralCode);
    } catch (error) {
      console.warn('Failed to retrieve stored events:', error);
      return [];
    }
  }

  // Sync stored events when back online
  static async syncStoredEvents(): Promise<void> {
    if (typeof window === 'undefined') return;

    try {
      const storedEvents = localStorage.getItem('referral_events');
      if (!storedEvents) return;

      const events = JSON.parse(storedEvents);
      for (const event of events) {
        await this.trackEvent(event);
      }

      // Clear stored events after successful sync
      localStorage.removeItem('referral_events');
    } catch (error) {
      console.warn('Failed to sync stored events:', error);
    }
  }

  // Get device info for analytics
  static getDeviceInfo(): {
    deviceType: 'mobile' | 'tablet' | 'desktop';
    browser: string;
    os: string;
  } {
    if (typeof window === 'undefined') {
      return { deviceType: 'desktop', browser: 'unknown', os: 'unknown' };
    }

    const userAgent = window.navigator.userAgent.toLowerCase();
    
    // Device type detection (shared with the click analytics ledger).
    const deviceType = detectDeviceType(userAgent);

    // Browser detection
    let browser = 'unknown';
    if (userAgent.includes('chrome')) browser = 'chrome';
    else if (userAgent.includes('firefox')) browser = 'firefox';
    else if (userAgent.includes('safari')) browser = 'safari';
    else if (userAgent.includes('edge')) browser = 'edge';

    // OS detection
    let os = 'unknown';
    if (userAgent.includes('windows')) os = 'windows';
    else if (userAgent.includes('mac')) os = 'macos';
    else if (userAgent.includes('linux')) os = 'linux';
    else if (userAgent.includes('android')) os = 'android';
    else if (userAgent.includes('ios') || userAgent.includes('iphone') || userAgent.includes('ipad')) os = 'ios';

    return { deviceType, browser, os };
  }

  // --- Referral link click analytics (issue #128) ---

  /**
   * Record a link view or click and return the stored event. Captures the
   * three fields the affiliate dashboard needs — referrer source, device type
   * and conversion status — and mirrors the event locally so metrics keep
   * working offline.
   */
  static async recordClickEvent(input: RecordClickEventInput): Promise<ReferralLinkEvent> {
    const event = this.buildLinkEvent(input);

    try {
      await fetch(LINK_EVENTS_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(event),
      });
    } catch (error) {
      console.warn('Failed to track referral link event:', error);
    }

    this.storeLinkEventLocally(event);
    return event;
  }

  /** Build (without sending) a fully classified link event. */
  static buildLinkEvent(input: RecordClickEventInput): ReferralLinkEvent {
    const referrer =
      input.referrer !== undefined
        ? input.referrer
        : typeof document !== 'undefined'
          ? document.referrer
          : null;
    const userAgent =
      input.userAgent !== undefined
        ? input.userAgent
        : typeof window !== 'undefined'
          ? window.navigator.userAgent
          : null;

    return {
      id: `linkevt_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
      kind: input.kind === 'view' ? 'view' : 'click',
      slug: input.slug,
      targetAgentId: input.targetAgentId,
      referralCode: input.referralCode,
      timestamp: new Date().toISOString(),
      referrerSource: classifyReferrerSource(referrer),
      deviceType: detectDeviceType(userAgent),
      conversionStatus: toConversionStatus(input.conversionStatus),
      referrer: referrer ?? undefined,
      userAgent: userAgent ?? undefined,
    };
  }

  /** Derive CTR / conversion metrics from a set of recorded events. */
  static computeClickMetrics(events: ReferralLinkEvent[]): ReferralClickMetrics {
    return computeReferralClickMetrics(events);
  }

  /** The locally mirrored ledger (offline fallback for the backend store). */
  static getStoredLinkEvents(): ReferralLinkEvent[] {
    if (typeof window === 'undefined') return [];
    try {
      const stored = window.localStorage.getItem(LINK_EVENTS_STORAGE_KEY);
      return stored ? (JSON.parse(stored) as ReferralLinkEvent[]) : [];
    } catch (error) {
      console.warn('Failed to retrieve stored link events:', error);
      return [];
    }
  }

  private static storeLinkEventLocally(event: ReferralLinkEvent): void {
    if (typeof window === 'undefined') return;
    try {
      const events = this.getStoredLinkEvents();
      events.push(event);
      if (events.length > MAX_LINK_EVENTS) {
        events.splice(0, events.length - MAX_LINK_EVENTS);
      }
      window.localStorage.setItem(LINK_EVENTS_STORAGE_KEY, JSON.stringify(events));
    } catch (error) {
      console.warn('Failed to store link event locally:', error);
    }
  }
}
