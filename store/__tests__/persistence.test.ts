import { act } from '@testing-library/react';
import { useApiMetricsStore } from '../apiMetricsStore';
import { useReferralStore } from '../referralStore';
import { useSearchStore } from '../searchStore';

const resetSearchStore = () => {
  useSearchStore.setState({
    query: '',
    filters: {},
    results: [],
    loading: false,
    error: null,
    hasHydrated: false,
  });
};

const resetReferralStore = () => {
  useReferralStore.setState({
    stats: null,
    links: [],
    rewards: [],
    loading: false,
    error: null,
    hasHydrated: false,
  });
};

const resetApiMetricsStore = () => {
  useApiMetricsStore.setState({
    totalRequests: 0,
    cacheHits: 0,
    networkRequests: 0,
    batchedRequests: 0,
    lastRequestAt: null,
    hasHydrated: false,
  });
};

describe('zustand store persistence', () => {
  beforeEach(() => {
    localStorage.clear();
    resetSearchStore();
    resetReferralStore();
    resetApiMetricsStore();
  });

  it('serializes and rehydrates search state from local storage', async () => {
    const persistedState = {
      state: {
        query: 'neural-labs',
        filters: { status: 'active' },
        results: [{ id: 'search-result-1' }],
        loading: false,
        error: null,
        hasHydrated: false,
      },
      version: 1,
    };

    localStorage.setItem('trellis-search-store', JSON.stringify(persistedState));

    await act(async () => {
      await useSearchStore.persist.rehydrate();
    });

    expect(useSearchStore.getState().query).toBe('neural-labs');
    expect(useSearchStore.getState().filters).toEqual({ status: 'active' });
    expect(useSearchStore.getState().results).toEqual([{ id: 'search-result-1' }]);
    expect(useSearchStore.getState().hasHydrated).toBe(true);
  });

  it('persists referral and api metrics state with a stable serialized shape', async () => {
    await act(async () => {
      useReferralStore.setState({
        stats: {
          totalClicks: 42,
          totalSignups: 7,
          totalRewards: '12',
          pendingRewards: '4',
          activeLinks: 3,
          conversionRate: 0.17,
        },
        links: [
          {
            id: 'link-1',
            code: 'REF-1',
            url: 'https://example.com/ref',
            userId: 'user-1',
            createdAt: '2026-09-27T00:00:00.000Z',
            isActive: true,
            uses: 10,
            reward: '5',
          },
        ],
        rewards: [
          {
            id: 'reward-1',
            referralCode: 'REF-1',
            amount: '5',
            asset: 'XLM',
            status: 'pending',
            createdAt: '2026-09-27T00:00:00.000Z',
          },
        ],
        loading: false,
        error: null,
        hasHydrated: false,
      });

      useApiMetricsStore.setState({
        totalRequests: 4,
        cacheHits: 2,
        networkRequests: 1,
        batchedRequests: 1,
        lastRequestAt: '2026-09-27T00:00:00.000Z',
        hasHydrated: false,
      });

      await Promise.resolve();
    });

    const referralPayload = JSON.parse(
      localStorage.getItem('trellis-referral-store') ?? 'null',
    );
    const apiMetricsPayload = JSON.parse(
      localStorage.getItem('trellis-api-metrics-store') ?? 'null',
    );

    expect(referralPayload?.state?.links).toHaveLength(1);
    expect(referralPayload?.state?.stats?.totalClicks).toBe(42);
    expect(apiMetricsPayload?.state?.cacheHits).toBe(2);
    expect(apiMetricsPayload?.state?.networkRequests).toBe(1);
    expect(apiMetricsPayload?.state?.batchedRequests).toBe(1);
    expect(apiMetricsPayload?.state?.lastRequestAt).toBe('2026-09-27T00:00:00.000Z');
  });
});
