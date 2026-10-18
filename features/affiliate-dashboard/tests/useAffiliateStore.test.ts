import { useAffiliateStore } from '../store/useAffiliateStore';
import { affiliateService } from '../services/affiliateService';

// 'G' + 55 base32 chars = valid Stellar address format.
const WALLET = `G${'A'.repeat(55)}`;

jest.mock('../services/affiliateService', () => ({
  affiliateService: {
    getStats: jest.fn(),
    getReferrals: jest.fn(),
    getPayoutRequests: jest.fn(),
    getProgram: jest.fn(),
    getEarningsHistory: jest.fn(),
    getReferralClickMetrics: jest.fn(),
    requestPayout: jest.fn(),
    generateReferralCode: jest.fn(),
  },
}));

const mockedService = jest.mocked(affiliateService);

const emptyClickMetrics = {
  totalImpressions: 0,
  totalClicks: 0,
  totalConversions: 0,
  clickThroughRate: 0,
  conversionRate: 0,
  bySource: [],
  byDevice: [],
  series: [],
};

const baseServiceState = () => {
  mockedService.getStats.mockResolvedValue({
    totalReferrals: 1,
    activeReferrals: 1,
    totalEarnings: '150.00',
    pendingEarnings: '150.00',
    totalPayouts: '0.00',
    conversionRate: 100,
  });
  mockedService.getReferrals.mockResolvedValue([]);
  mockedService.getPayoutRequests.mockResolvedValue([]);
  mockedService.getProgram.mockResolvedValue({
    id: 'prog-001',
    name: 'Trellis Affiliate Program',
    status: 'active',
    commissionStructure: { direct: 10, tier2: 5, tier3: 2 },
    minimumPayout: '100.00',
    payoutFrequency: 'weekly',
    guidelines: [],
    joinedAt: new Date().toISOString(),
  });
  mockedService.getReferralClickMetrics.mockResolvedValue(emptyClickMetrics);
};

describe('useAffiliateStore earnings history (issue #8)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    baseServiceState();
    useAffiliateStore.setState({
      stats: null,
      referrals: [],
      commissionBreakdown: [],
      payoutRequests: [],
      program: null,
      earningsHistory: [],
      clickMetrics: null,
      isLoading: false,
      error: null,
    });
  });

  it('populates earnings history on success', async () => {
    const history = [{ date: '2026-09-21', amount: 150, source: 'direct' as const }];
    mockedService.getEarningsHistory.mockResolvedValue(history);

    await useAffiliateStore.getState().fetchAffiliateData(WALLET);

    const state = useAffiliateStore.getState();
    expect(state.earningsHistory).toEqual(history);
    expect(state.error).toBeNull();
    expect(state.isLoading).toBe(false);
  });

  it('stores an empty result without an error', async () => {
    mockedService.getEarningsHistory.mockResolvedValue([]);

    await useAffiliateStore.getState().fetchAffiliateData(WALLET);

    const state = useAffiliateStore.getState();
    expect(state.earningsHistory).toEqual([]);
    expect(state.error).toBeNull();
  });

  it('surfaces a backend failure as a real error state', async () => {
    mockedService.getEarningsHistory.mockRejectedValue(new Error('API error: Internal Server Error'));

    await useAffiliateStore.getState().fetchAffiliateData(WALLET);

    const state = useAffiliateStore.getState();
    expect(state.error).toBe('API error: Internal Server Error');
    expect(state.isLoading).toBe(false);
  });
});
