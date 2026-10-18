/**
 * Referral click analytics: event shape and metric derivation.
 *
 * Shared by the referral-sharing client recorder and the affiliate API store
 * so the dashboard numbers always match the events that were recorded. Pure
 * functions only — no browser or backend access here.
 */

export type DeviceType = 'mobile' | 'tablet' | 'desktop';

export type ReferrerSource =
  | 'twitter'
  | 'facebook'
  | 'linkedin'
  | 'whatsapp'
  | 'telegram'
  | 'google'
  | 'direct'
  | 'other';

/** How far a recorded click got toward a paid conversion. */
export type ConversionStatus = 'none' | 'signup' | 'converted';

/** A view is an impression (link rendered); a click is an actual open. */
export type ReferralEventKind = 'view' | 'click';

export interface ReferralLinkEvent {
  id: string;
  kind: ReferralEventKind;
  /** Vanity slug the event belongs to. */
  slug: string;
  /** Marketplace agent the slug resolves to, when known. */
  targetAgentId?: string;
  referralCode?: string;
  timestamp: string;
  referrerSource: ReferrerSource;
  deviceType: DeviceType;
  conversionStatus: ConversionStatus;
  referrer?: string;
  userAgent?: string;
}

export interface ReferralMetricPoint {
  /** YYYY-MM-DD */
  date: string;
  impressions: number;
  clicks: number;
  conversions: number;
  /** clicks / impressions, 0 when there are no impressions. */
  ctr: number;
}

export interface ReferralSourceMetric {
  source: ReferrerSource;
  impressions: number;
  clicks: number;
  conversions: number;
  ctr: number;
}

export interface ReferralDeviceMetric {
  deviceType: DeviceType;
  impressions: number;
  clicks: number;
  conversions: number;
  ctr: number;
}

export interface ReferralClickMetrics {
  totalImpressions: number;
  totalClicks: number;
  totalConversions: number;
  /** clicks / impressions. */
  clickThroughRate: number;
  /** conversions / clicks. */
  conversionRate: number;
  bySource: ReferralSourceMetric[];
  byDevice: ReferralDeviceMetric[];
  series: ReferralMetricPoint[];
}

const SOURCE_PATTERNS: ReadonlyArray<[ReferrerSource, RegExp]> = [
  ['twitter', /(^|\.)(twitter\.com|x\.com)$/],
  ['facebook', /(^|\.)facebook\.com$/],
  ['linkedin', /(^|\.)linkedin\.com$/],
  ['whatsapp', /(^|\.)(whatsapp\.com|wa\.me)$/],
  ['telegram', /(^|\.)(telegram\.org|telegram\.me|t\.me)$/],
  ['google', /(^|\.)google\.[a-z.]+$/],
];

const MOBILE_UA = /mobile|iphone|ipod|blackberry|opera mini|iemobile|windows phone/i;
const TABLET_UA = /ipad|tablet|kindle|silk|playbook|android(?!.*mobile)/i;

/** Resolve a referrer URL (or bare host) to a known sharing source. */
export function classifyReferrerSource(referrer?: string | null): ReferrerSource {
  if (!referrer || referrer.trim() === '') return 'direct';
  let host = '';
  try {
    host = new URL(referrer).hostname.toLowerCase();
  } catch {
    host = referrer.trim().toLowerCase();
  }
  if (!host) return 'direct';
  for (const [source, pattern] of SOURCE_PATTERNS) {
    if (pattern.test(host)) return source;
  }
  return 'other';
}

/** Best-effort device classification from a user agent string. */
export function detectDeviceType(userAgent?: string | null): DeviceType {
  if (!userAgent) return 'desktop';
  if (TABLET_UA.test(userAgent)) return 'tablet';
  if (MOBILE_UA.test(userAgent)) return 'mobile';
  return 'desktop';
}

/** Coerce loosely typed recorder input into a conversion status. */
export function toConversionStatus(value: unknown): ConversionStatus {
  if (value === 'converted' || value === true) return 'converted';
  if (value === 'signup') return 'signup';
  return 'none';
}

/** Safe rate: 0 when the denominator is not positive. */
export function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

export function emptyReferralClickMetrics(): ReferralClickMetrics {
  return {
    totalImpressions: 0,
    totalClicks: 0,
    totalConversions: 0,
    clickThroughRate: 0,
    conversionRate: 0,
    bySource: [],
    byDevice: [],
    series: [],
  };
}

interface MetricBucket {
  impressions: number;
  clicks: number;
  conversions: number;
}

function ensureBucket<K>(map: Map<K, MetricBucket>, key: K): MetricBucket {
  let bucket = map.get(key);
  if (!bucket) {
    bucket = { impressions: 0, clicks: 0, conversions: 0 };
    map.set(key, bucket);
  }
  return bucket;
}

/**
 * Derive CTR and conversion metrics from recorded link events.
 *
 * impressions = view events, clicks = click events, conversions = clicks whose
 * conversionStatus is 'converted'. Everything is aggregated by day, source and
 * device so the affiliate dashboard can chart all three.
 */
export function computeReferralClickMetrics(
  events: ReferralLinkEvent[],
): ReferralClickMetrics {
  const bySource = new Map<ReferrerSource, MetricBucket>();
  const byDevice = new Map<DeviceType, MetricBucket>();
  const byDay = new Map<string, MetricBucket>();
  let totalImpressions = 0;
  let totalClicks = 0;
  let totalConversions = 0;

  for (const event of events) {
    const isView = event.kind === 'view';
    const converted = !isView && event.conversionStatus === 'converted';
    const day = typeof event.timestamp === 'string' ? event.timestamp.slice(0, 10) : '';
    const buckets = [
      ensureBucket(bySource, event.referrerSource),
      ensureBucket(byDevice, event.deviceType),
      ...(day ? [ensureBucket(byDay, day)] : []),
    ];
    for (const bucket of buckets) {
      if (isView) bucket.impressions += 1;
      else bucket.clicks += 1;
      if (converted) bucket.conversions += 1;
    }
    if (isView) totalImpressions += 1;
    else totalClicks += 1;
    if (converted) totalConversions += 1;
  }

  const toPoint = (date: string, bucket: MetricBucket): ReferralMetricPoint => ({
    date,
    impressions: bucket.impressions,
    clicks: bucket.clicks,
    conversions: bucket.conversions,
    ctr: ratio(bucket.clicks, bucket.impressions),
  });

  const sortByClicks = <T extends { clicks: number }>(a: T, b: T) => b.clicks - a.clicks;

  return {
    totalImpressions,
    totalClicks,
    totalConversions,
    clickThroughRate: ratio(totalClicks, totalImpressions),
    conversionRate: ratio(totalConversions, totalClicks),
    bySource: [...bySource.entries()]
      .map(([source, bucket]) => ({
        source,
        impressions: bucket.impressions,
        clicks: bucket.clicks,
        conversions: bucket.conversions,
        ctr: ratio(bucket.clicks, bucket.impressions),
      }))
      .sort(sortByClicks),
    byDevice: [...byDevice.entries()]
      .map(([deviceType, bucket]) => ({
        deviceType,
        impressions: bucket.impressions,
        clicks: bucket.clicks,
        conversions: bucket.conversions,
        ctr: ratio(bucket.clicks, bucket.impressions),
      }))
      .sort(sortByClicks),
    series: [...byDay.entries()]
      .map(([date, bucket]) => toPoint(date, bucket))
      .sort((a, b) => (a.date < b.date ? -1 : 1)),
  };
}
