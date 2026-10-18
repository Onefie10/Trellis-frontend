import {
  __resetAffiliateStore,
  getReferralClickMetrics,
  listVanitySlugs,
  recordReferralClickEvent,
  registerVanitySlug,
  resolveVanitySlug,
} from '../affiliate-store';

// 'G' + 55 base32 chars = valid Stellar address format.
const wallet = (ch: string) => `G${ch.repeat(55)}`;
const W1 = wallet('A');
const W2 = wallet('B');

const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile';

beforeEach(() => {
  __resetAffiliateStore();
});

describe('issue #128 — vanity slug registry', () => {
  it('registers, canonicalizes and resolves an alias', () => {
    const record = registerVanitySlug(W1, 'Alice Agent', 'agent-42');
    expect(record.slug).toBe('alice-agent');
    expect(record.ownerWallet).toBe(W1);
    expect(record.targetAgentId).toBe('agent-42');
    expect(resolveVanitySlug('ALICE-AGENT')).toEqual(record);
    expect(resolveVanitySlug('nope')).toBeNull();
  });

  it('rejects reserved words, bad length and bad charset', () => {
    expect(() => registerVanitySlug(W1, 'admin', 'agent-42')).toThrow(
      expect.objectContaining({ reason: 'RESERVED' }),
    );
    expect(() => registerVanitySlug(W1, 'ab', 'agent-42')).toThrow(
      expect.objectContaining({ reason: 'TOO_SHORT' }),
    );
    expect(() => registerVanitySlug(W1, 'a'.repeat(33), 'agent-42')).toThrow(
      expect.objectContaining({ reason: 'TOO_LONG' }),
    );
    expect(() => registerVanitySlug(W1, 'bad@slug', 'agent-42')).toThrow(
      expect.objectContaining({ reason: 'INVALID_CHARACTERS' }),
    );
  });

  it('rejects a collision case-insensitively', () => {
    registerVanitySlug(W1, 'alice-agent', 'agent-42');
    expect(() => registerVanitySlug(W2, 'Alice-Agent', 'agent-7')).toThrow(
      expect.objectContaining({ reason: 'COLLISION' }),
    );
    expect(listVanitySlugs(W2)).toEqual([]);
  });

  it('requires an owner and a target agent', () => {
    expect(() => registerVanitySlug('', 'alice', 'agent-42')).toThrow(
      expect.objectContaining({ reason: 'INVALID_WALLET' }),
    );
    expect(() => registerVanitySlug(W1, 'alice', '   ')).toThrow(
      expect.objectContaining({ reason: 'AGENT_REQUIRED' }),
    );
  });

  it('lets one wallet own several aliases and isolates them per wallet', () => {
    registerVanitySlug(W1, 'alice', 'agent-1');
    registerVanitySlug(W1, 'alice-store', 'agent-2');
    registerVanitySlug(W2, 'bob', 'agent-3');

    expect(listVanitySlugs(W1).map((r) => r.slug).sort()).toEqual(['alice', 'alice-store']);
    expect(listVanitySlugs(W2).map((r) => r.slug)).toEqual(['bob']);
  });
});

describe('issue #128 — click analytics ledger', () => {
  it('records referrer source, device type and conversion status', () => {
    registerVanitySlug(W1, 'alice-agent', 'agent-42');

    const event = recordReferralClickEvent({
      slug: 'ALICE-AGENT',
      referrer: 'https://x.com/alice/status/1',
      userAgent: IPHONE_UA,
      conversionStatus: 'converted',
    });

    expect(event.slug).toBe('alice-agent');
    expect(event.targetAgentId).toBe('agent-42');
    expect(event.referrerSource).toBe('twitter');
    expect(event.deviceType).toBe('mobile');
    expect(event.conversionStatus).toBe('converted');
    expect(event.kind).toBe('click');
  });

  it('aggregates impressions, clicks, CTR and conversions', () => {
    registerVanitySlug(W1, 'alice-agent', 'agent-42');

    recordReferralClickEvent({ slug: 'alice-agent', kind: 'view', referrer: '' });
    recordReferralClickEvent({ slug: 'alice-agent', kind: 'view', referrer: 'https://x.com/a' });
    recordReferralClickEvent({
      slug: 'alice-agent',
      referrer: 'https://x.com/a',
      userAgent: IPHONE_UA,
      conversionStatus: 'converted',
    });
    recordReferralClickEvent({ slug: 'alice-agent', referrer: 'https://google.com/' });

    const metrics = getReferralClickMetrics(W1);
    expect(metrics.totalImpressions).toBe(2);
    expect(metrics.totalClicks).toBe(2);
    expect(metrics.totalConversions).toBe(1);
    expect(metrics.clickThroughRate).toBe(1);
    expect(metrics.conversionRate).toBe(0.5);
    expect(metrics.bySource[0].source).toBe('twitter');
    expect(metrics.byDevice.find((d) => d.deviceType === 'mobile')?.clicks).toBe(1);
    expect(metrics.series).toHaveLength(1);
  });

  it('refuses events for unknown slugs instead of inventing attribution', () => {
    expect(() => recordReferralClickEvent({ slug: 'ghost' })).toThrow(
      expect.objectContaining({ reason: 'NOT_FOUND' }),
    );
  });

  it('keeps metrics isolated per wallet', () => {
    registerVanitySlug(W1, 'alice-agent', 'agent-42');
    registerVanitySlug(W2, 'bob-agent', 'agent-7');
    recordReferralClickEvent({ slug: 'alice-agent' });
    recordReferralClickEvent({ slug: 'bob-agent' });
    recordReferralClickEvent({ slug: 'bob-agent' });

    expect(getReferralClickMetrics(W1).totalClicks).toBe(1);
    expect(getReferralClickMetrics(W2).totalClicks).toBe(2);
  });

  it('returns empty metrics for a wallet with no aliases', () => {
    expect(getReferralClickMetrics(W1)).toMatchObject({
      totalImpressions: 0,
      totalClicks: 0,
      totalConversions: 0,
      clickThroughRate: 0,
      conversionRate: 0,
    });
  });
});
