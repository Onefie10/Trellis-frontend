import { create } from 'zustand';
import { TradingBonus, BonusType, BonusBreakdown, BonusHistory } from '@/lib/types';
import {
  DEFAULT_IL_THRESHOLD_PERCENT,
  evaluateRebalance,
} from '@/features/trading-bonuses/lib/impermanentLoss';
import type { LiquidityPosition } from '@/features/trading-bonuses/lib/impermanentLoss';

export interface BonusNotification {
  id: string;
  message: string;
  amount: string;
  type?: BonusType;
  timestamp: number;
  /** Distinguishes reward toasts from pool rebalancing alerts. */
  kind?: 'bonus' | 'rebalance';
  /** Extra context rendered for non-bonus alerts (e.g. the divergence). */
  detail?: string;
}

interface BonusStore {
  bonuses: TradingBonus[];
  notifications: BonusNotification[];
  history: BonusHistory[];
  isLoading: boolean;

  // Stats
  totalEarned: string;
  totalPending: string;
  totalProjected: string;

  // Impermanent loss / liquidity state
  liquidityPositions: LiquidityPosition[];
  /** Price ratio modelled by the interactive IL calculator slider. */
  ilPriceRatio: number;
  /** Price divergence (percent) that triggers a rebalancing alert. */
  ilThresholdPercent: number;
  /** Position ids already alerted for, so alerts are not repeated. */
  rebalanceAlertedIds: string[];

  // Actions
  fetchBonuses: () => Promise<void>;
  addBonus: (bonus: TradingBonus) => void;
  removeNotification: (id: string) => void;
  simulateRealTimeBonus: () => void;
  fetchLiquidityPositions: () => void;
  setIlPriceRatio: (ratio: number) => void;
  setIlThresholdPercent: (percent: number) => void;
  evaluateRebalanceAlerts: () => void;
}

const MOCK_BONUSES: TradingBonus[] = [
  {
    id: '1',
    type: BonusType.REFERRAL,
    amount: '50.00',
    asset: 'XLM',
    timestamp: new Date(Date.now() - 86400000 * 2).toISOString(),
    status: 'earned',
    description: 'Referral bonus for user @astroguy',
  },
  {
    id: '2',
    type: BonusType.TRADING_VOLUME,
    amount: '125.50',
    asset: 'XLM',
    timestamp: new Date(Date.now() - 86400000).toISOString(),
    status: 'earned',
    description: 'Weekly volume milestone reached',
  },
  {
    id: '3',
    type: BonusType.STAKING,
    amount: '15.25',
    asset: 'XLM',
    timestamp: new Date().toISOString(),
    status: 'pending',
    description: 'Daily staking rewards',
  },
];

const MOCK_HISTORY: BonusHistory[] = [
  { date: '2024-04-18', amount: 45 },
  { date: '2024-04-19', amount: 52 },
  { date: '2024-04-20', amount: 48 },
  { date: '2024-04-21', amount: 70 },
  { date: '2024-04-22', amount: 65 },
  { date: '2024-04-23', amount: 90 },
  { date: '2024-04-24', amount: 85 },
];

/** Active Soroban liquidity positions used to surface live IL metrics. */
const MOCK_POSITIONS: LiquidityPosition[] = [
  {
    id: 'lp-xlm-usdc',
    pool: 'Soroban AMM',
    pair: 'XLM/USDC',
    assetA: 'XLM',
    assetB: 'USDC',
    entryPrice: 0.11,
    currentPrice: 0.145,
    depositedValue: 1200,
    share: 0.032,
    feesEarned: 18.4,
  },
  {
    id: 'lp-xlm-aqua',
    pool: 'Soroban AMM',
    pair: 'XLM/AQUA',
    assetA: 'XLM',
    assetB: 'AQUA',
    entryPrice: 12.5,
    currentPrice: 11.1,
    depositedValue: 800,
    share: 0.018,
    feesEarned: 9.75,
  },
  {
    id: 'lp-xlm-yxlm',
    pool: 'Soroban AMM',
    pair: 'XLM/yXLM',
    assetA: 'XLM',
    assetB: 'yXLM',
    entryPrice: 0.98,
    currentPrice: 0.995,
    depositedValue: 1500,
    share: 0.041,
    feesEarned: 6.2,
  },
];

export const useBonusStore = create<BonusStore>((set, get) => ({
  bonuses: [],
  notifications: [],
  history: MOCK_HISTORY,
  isLoading: false,
  totalEarned: '0.00',
  totalPending: '0.00',
  totalProjected: '0.00',
  liquidityPositions: [],
  ilPriceRatio: 2,
  ilThresholdPercent: DEFAULT_IL_THRESHOLD_PERCENT,
  rebalanceAlertedIds: [],

  fetchBonuses: async () => {
    set({ isLoading: true });
    // Simulate API delay
    await new Promise((resolve) => setTimeout(resolve, 1000));

    const earned = MOCK_BONUSES
      .filter(b => b.status === 'earned')
      .reduce((sum, b) => sum + parseFloat(b.amount), 0)
      .toFixed(2);

    const pending = MOCK_BONUSES
      .filter(b => b.status === 'pending')
      .reduce((sum, b) => sum + parseFloat(b.amount), 0)
      .toFixed(2);

    set({
      bonuses: MOCK_BONUSES,
      totalEarned: earned,
      totalPending: pending,
      totalProjected: '500.00',
      isLoading: false
    });
  },

  addBonus: (bonus: TradingBonus) => {
    set((state: BonusStore) => {
      const newBonuses = [bonus, ...state.bonuses];
      const earned = newBonuses
        .filter(b => b.status === 'earned')
        .reduce((sum, b) => sum + parseFloat(b.amount), 0)
        .toFixed(2);

      const newNotification: BonusNotification = {
        id: Math.random().toString(36).substr(2, 9),
        message: `New ${bonus.type} Bonus!`,
        amount: bonus.amount,
        type: bonus.type,
        kind: 'bonus',
        timestamp: Date.now(),
      };

      return {
        bonuses: newBonuses,
        totalEarned: earned,
        notifications: [newNotification, ...state.notifications],
      };
    });
  },

  removeNotification: (id: string) => {
    set((state: BonusStore) => ({
      notifications: state.notifications.filter((n: BonusNotification) => n.id !== id),
    }));
  },

  simulateRealTimeBonus: () => {
    const types = Object.values(BonusType);
    const randomType = types[Math.floor(Math.random() * types.length)];
    const randomAmount = (Math.random() * 10 + 1).toFixed(2);

    const newBonus: TradingBonus = {
      id: Math.random().toString(36).substr(2, 9),
      type: randomType,
      amount: randomAmount,
      asset: 'XLM',
      timestamp: new Date().toISOString(),
      status: 'earned',
      description: `Randomly generated ${randomType} bonus`,
    };

    get().addBonus(newBonus);

    // Also update history slightly
    set((state: BonusStore) => {
      const lastDay = state.history[state.history.length - 1];
      const updatedHistory = [...state.history];
      updatedHistory[updatedHistory.length - 1] = {
        ...lastDay,
        amount: lastDay.amount + parseFloat(randomAmount)
      };
      return { history: updatedHistory };
    });

    // Drift pool prices so the IL metrics stay "real-time", then re-check alerts.
    if (get().liquidityPositions.length > 0) {
      set((state: BonusStore) => ({
        liquidityPositions: state.liquidityPositions.map((position) => ({
          ...position,
          currentPrice: Number(
            (position.currentPrice * (1 + (Math.random() - 0.5) * 0.01)).toFixed(6)
          ),
        })),
      }));
      get().evaluateRebalanceAlerts();
    }
  },

  fetchLiquidityPositions: () => {
    set({ liquidityPositions: MOCK_POSITIONS });
    get().evaluateRebalanceAlerts();
  },

  setIlPriceRatio: (ratio: number) => {
    const safe = Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
    set({ ilPriceRatio: safe });
  },

  setIlThresholdPercent: (percent: number) => {
    const safe =
      Number.isFinite(percent) && percent >= 0 ? percent : DEFAULT_IL_THRESHOLD_PERCENT;
    // Reset the dedupe list so a newly lowered threshold can re-notify.
    set({ ilThresholdPercent: safe, rebalanceAlertedIds: [] });
    get().evaluateRebalanceAlerts();
  },

  evaluateRebalanceAlerts: () => {
    const {
      liquidityPositions,
      ilThresholdPercent,
      rebalanceAlertedIds,
      notifications,
    } = get();

    const breached = liquidityPositions.filter(
      (position) =>
        !rebalanceAlertedIds.includes(position.id) &&
        evaluateRebalance(position.entryPrice, position.currentPrice, ilThresholdPercent).shouldAlert
    );

    if (breached.length === 0) return;

    const now = Date.now();
    const alerts: BonusNotification[] = breached.map((position) => {
      const { divergencePercent } = evaluateRebalance(
        position.entryPrice,
        position.currentPrice,
        ilThresholdPercent
      );
      return {
        id: `rebalance-${position.id}-${now}`,
        message: `Rebalance ${position.pair} pool`,
        amount: '',
        kind: 'rebalance',
        detail: `Price divergence ${divergencePercent.toFixed(2)}% exceeds your ${ilThresholdPercent}% threshold`,
        timestamp: now,
      };
    });

    set({
      notifications: [...alerts, ...notifications],
      rebalanceAlertedIds: [...rebalanceAlertedIds, ...breached.map((position) => position.id)],
    });
  },
}));
