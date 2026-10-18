import { AnalyticsService } from '../services/analyticsService';

function mockFetchOnce(data: unknown, ok = true) {
  global.fetch = jest.fn().mockResolvedValueOnce({
    ok,
    statusText: ok ? 'OK' : 'Internal Server Error',
    json: () => Promise.resolve(data),
  }) as unknown as typeof fetch;
}

describe('AnalyticsService click analytics (issue #128)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    window.localStorage.clear();
    mockFetchOnce({});
  });

  it('records referrer source, device type and conversion status', async () => {
    const event = await AnalyticsService.recordClickEvent({
      slug: 'alice-agent',
      targetAgentId: 'agent-42',
      referrer: 'https://x.com/alice/status/1',
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile',
      conversionStatus: 'converted',
    });

    expect(event.slug).toBe('alice-agent');
    expect(event.referrerSource).toBe('twitter');
    expect(event.deviceType).toBe('mobile');
    expect(event.conversionStatus).toBe('converted');
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/affiliates/referral-clicks',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('records link views as impressions', async () => {
    const view = await AnalyticsService.recordClickEvent({
      slug: 'alice-agent',
      kind: 'view',
      referrer: 'https://www.google.com/',
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
    });

    expect(view.kind).toBe('view');
    expect(view.referrerSource).toBe('google');
    expect(view.deviceType).toBe('desktop');
    expect(view.conversionStatus).toBe('none');
  });

  it('keeps a local ledger and derives CTR plus conversions from it', async () => {
    await AnalyticsService.recordClickEvent({ slug: 'alice-agent', kind: 'view' });
    await AnalyticsService.recordClickEvent({
      slug: 'alice-agent',
      conversionStatus: 'converted',
    });

    const stored = AnalyticsService.getStoredLinkEvents();
    expect(stored).toHaveLength(2);

    const metrics = AnalyticsService.computeClickMetrics(stored);
    expect(metrics.totalImpressions).toBe(1);
    expect(metrics.totalClicks).toBe(1);
    expect(metrics.totalConversions).toBe(1);
    expect(metrics.clickThroughRate).toBe(1);
    expect(metrics.conversionRate).toBe(1);
  });

  it('still records locally when the backend is unreachable', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch;

    const event = await AnalyticsService.recordClickEvent({
      slug: 'alice-agent',
      referrer: '',
    });

    expect(event.referrerSource).toBe('direct');
    expect(AnalyticsService.getStoredLinkEvents()).toHaveLength(1);
  });
});
