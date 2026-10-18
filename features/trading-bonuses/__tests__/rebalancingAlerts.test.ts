import { useBonusStore } from '@/store/useBonusStore';
import type { LiquidityPosition } from '../lib/impermanentLoss';

const position = (overrides: Partial<LiquidityPosition> = {}): LiquidityPosition => ({
  id: 'lp-usdc',
  pool: 'Soroban AMM',
  pair: 'XLM/USDC',
  assetA: 'XLM',
  assetB: 'USDC',
  entryPrice: 1,
  currentPrice: 2,
  depositedValue: 1000,
  share: 0.01,
  feesEarned: 0,
  ...overrides,
});

const resetStore = (positions: LiquidityPosition[] = []) => {
  useBonusStore.setState({
    liquidityPositions: positions,
    notifications: [],
    rebalanceAlertedIds: [],
    ilThresholdPercent: 5,
    ilPriceRatio: 2,
  });
};

describe('pool rebalancing alerts (issue #130)', () => {
  beforeEach(() => resetStore());

  it('raises a rebalancing notification when divergence exceeds the threshold', () => {
    resetStore([position({ entryPrice: 1, currentPrice: 2 })]);

    useBonusStore.getState().evaluateRebalanceAlerts();

    const { notifications } = useBonusStore.getState();
    expect(notifications).toHaveLength(1);
    expect(notifications[0].kind).toBe('rebalance');
    expect(notifications[0].message).toContain('XLM/USDC');
    expect(notifications[0].detail ?? '').toContain('100.00%');
    expect(notifications[0].detail ?? '').toContain('5% threshold');
  });

  it('does not repeat an alert for a position that is already flagged', () => {
    resetStore([position({ entryPrice: 1, currentPrice: 2 })]);

    useBonusStore.getState().evaluateRebalanceAlerts();
    useBonusStore.getState().evaluateRebalanceAlerts();

    const { notifications, rebalanceAlertedIds } = useBonusStore.getState();
    expect(notifications).toHaveLength(1);
    expect(rebalanceAlertedIds).toEqual(['lp-usdc']);
  });

  it('leaves pools that are within the threshold alone', () => {
    resetStore([position({ entryPrice: 1, currentPrice: 1.02 })]);

    useBonusStore.getState().evaluateRebalanceAlerts();

    expect(useBonusStore.getState().notifications).toHaveLength(0);
  });

  it('re-evaluates immediately when the threshold is lowered', () => {
    resetStore([position({ entryPrice: 1, currentPrice: 1.2 })]);

    useBonusStore.getState().setIlThresholdPercent(50);
    expect(useBonusStore.getState().notifications).toHaveLength(0);

    useBonusStore.getState().setIlThresholdPercent(10);
    const { notifications, ilThresholdPercent } = useBonusStore.getState();
    expect(ilThresholdPercent).toBe(10);
    expect(notifications).toHaveLength(1);
    expect(notifications[0].detail ?? '').toContain('20.00%');
  });

  it('loads the active liquidity positions and evaluates them on fetch', () => {
    useBonusStore.getState().fetchLiquidityPositions();

    const { liquidityPositions, notifications } = useBonusStore.getState();
    expect(liquidityPositions.length).toBeGreaterThan(0);
    // XLM/USDC diverged ~32% and XLM/AQUA ~11%, both above the 5% default.
    expect(notifications.length).toBeGreaterThan(0);
    notifications.forEach((notif) => expect(notif.kind).toBe('rebalance'));
  });

  it('keeps the calculator price ratio in a sane range', () => {
    useBonusStore.getState().setIlPriceRatio(3);
    expect(useBonusStore.getState().ilPriceRatio).toBe(3);

    useBonusStore.getState().setIlPriceRatio(-1);
    expect(useBonusStore.getState().ilPriceRatio).toBe(1);

    useBonusStore.getState().setIlPriceRatio(Number.NaN);
    expect(useBonusStore.getState().ilPriceRatio).toBe(1);
  });
});
