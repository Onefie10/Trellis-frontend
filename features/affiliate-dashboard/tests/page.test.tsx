import { render, screen } from '@testing-library/react';
import AffiliateDashboardPage from '../page';
import { useAffiliateData } from '../hooks/useAffiliateData';

const mockUseStellarWallet = jest.fn();

jest.mock('@/components/context/StellarWalletProvider', () => ({
  useStellarWallet: () => mockUseStellarWallet(),
  StellarWalletProvider: ({ children }: { children: React.ReactNode }) => children,
}));

jest.mock('../hooks/useAffiliateData', () => ({
  useAffiliateData: jest.fn(),
}));

jest.mock('@/components/ConnectWallet', () => ({
  __esModule: true,
  default: () => <button type="button">Connect Wallet</button>,
}));

const disconnectedData = {
  stats: null,
  referrals: [],
  commissionBreakdown: [],
  payoutRequests: [],
  program: null,
  earningsHistory: [],
  clickMetrics: null,
  isLoading: false,
  error: null,
  requestPayout: jest.fn(),
  generateReferralCode: jest.fn(),
  clearError: jest.fn(),
  isAuthenticated: false,
  hasActiveProgram: false,
  pendingPayouts: [],
  completedPayouts: [],
};

const connectedData = {
  ...disconnectedData,
  isAuthenticated: true,
  hasActiveProgram: true,
  program: {
    status: 'active',
    guidelines: ['No misleading marketing claims'],
    minimumPayout: '100.00',
  },
  requestPayout: jest.fn(),
  generateReferralCode: jest.fn(),
  clearError: jest.fn(),
};

describe('AffiliateDashboardPage wallet integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('shows a connect prompt when no wallet is connected', () => {
    mockUseStellarWallet.mockReturnValue({ wallet: null });
    (useAffiliateData as jest.Mock).mockReturnValue(disconnectedData);

    render(<AffiliateDashboardPage />);

    expect(
      screen.getByText(/connect your stellar wallet/i),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect Wallet' })).toBeInTheDocument();
    expect(useAffiliateData).toHaveBeenCalledWith(null);
  });

  it('passes the connected wallet address from context into useAffiliateData', () => {
    const publicKey = 'GTESTWALLETADDRESSFORAFFILIATEDASHBOARD0000000000000';
    mockUseStellarWallet.mockReturnValue({
      wallet: { publicKey, isConnected: true },
    });
    (useAffiliateData as jest.Mock).mockReturnValue(connectedData);

    render(<AffiliateDashboardPage />);

    expect(useAffiliateData).toHaveBeenCalledWith(publicKey);
    expect(screen.getByRole('heading', { name: 'Affiliate Dashboard' })).toBeInTheDocument();
    expect(
      screen.queryByText(/connect your stellar wallet/i),
    ).not.toBeInTheDocument();
  });

  it('does not request a payout when the wallet address is missing', () => {
    mockUseStellarWallet.mockReturnValue({ wallet: null });
    const requestPayout = jest.fn();
    (useAffiliateData as jest.Mock).mockReturnValue({
      ...connectedData,
      isAuthenticated: false,
      requestPayout,
    });

    const { container } = render(<AffiliateDashboardPage />);
    expect(container).toBeTruthy();
    expect(requestPayout).not.toHaveBeenCalled();
  });

  it('renders referral CTR and conversion metrics on the dashboard', () => {
    mockUseStellarWallet.mockReturnValue({
      wallet: { publicKey: 'GABC', isConnected: true },
    });
    (useAffiliateData as jest.Mock).mockReturnValue({
      ...connectedData,
      clickMetrics: {
        totalImpressions: 10,
        totalClicks: 4,
        totalConversions: 1,
        clickThroughRate: 0.4,
        conversionRate: 0.25,
        bySource: [],
        byDevice: [],
        series: [
          { date: '2026-09-21', impressions: 10, clicks: 4, conversions: 1, ctr: 0.4 },
        ],
      },
    });

    render(<AffiliateDashboardPage />);

    expect(screen.getByText('Click-through Rate')).toBeInTheDocument();
    expect(screen.getByText('40%')).toBeInTheDocument();
    expect(screen.getByText('25%')).toBeInTheDocument();
  });
});
