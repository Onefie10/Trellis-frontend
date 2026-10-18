/**
 * Impermanent loss (IL) math for constant-product (`x * y = k`) AMM pools.
 *
 * For a 50/50 constant-product pool the IL relative to simply holding both
 * assets is
 *
 *     IL(k) = 2 * sqrt(k) / (1 + k) - 1
 *
 * where `k` is the price ratio `currentPrice / entryPrice` of the volatile
 * asset. The result is a fraction in `(-1, 0]`, so a ratio of `k = 2` (or
 * `k = 0.5`) gives `-0.0572` (`-5.72%`), `k = 4` (`k = 0.25`) gives `-0.2`
 * (`-20%`), and `k = 1` gives `0`.
 *
 * These helpers are pure and dependency-free so they can be reused by the
 * bonus store, the calculator UI and the unit tests.
 */

export interface LiquidityPosition {
  id: string;
  /** Pool / venue the liquidity sits in (e.g. a Soroban AMM). */
  pool: string;
  /** Human readable pair label, e.g. `XLM/USDC`. */
  pair: string;
  assetA: string;
  assetB: string;
  /** Price of `assetB` denominated in `assetA` when liquidity was deposited. */
  entryPrice: number;
  /** Latest observed price of `assetB` denominated in `assetA`. */
  currentPrice: number;
  /** Deposited value in the reward asset (XLM) at the entry price. */
  depositedValue: number;
  /** Provider's share of the pool, `0..1`. */
  share: number;
  /** Trading fees accrued to the position, in XLM. */
  feesEarned: number;
}

export interface ImpermanentLossResult {
  /** `currentPrice / entryPrice`. */
  priceRatio: number;
  /** Fractional IL, always `<= 0` (e.g. `-0.0572`). */
  lossFraction: number;
  /** `lossFraction` expressed as a percentage (e.g. `-5.72`). */
  lossPercent: number;
  /** Value of simply holding the deposited assets at the new price. */
  holdValue: number;
  /** Value of the constant-product LP position at the new price. */
  lpValue: number;
  /** `holdValue - lpValue`, i.e. the value lost to IL. */
  valueLoss: number;
  /** Fees accrued to the position. */
  feesEarned: number;
  /** `valueLoss - feesEarned`; negative means fees out-earned the IL. */
  netValueLoss: number;
  /** Whether the position is currently underwater versus HODL. */
  isImpermanentLoss: boolean;
}

export interface PositionMetric extends ImpermanentLossResult {
  /** Absolute price divergence versus entry, as a percentage. */
  divergencePercent: number;
  /** Whether divergence breached the configured rebalancing threshold. */
  needsRebalance: boolean;
}

export interface RebalanceAlert {
  shouldAlert: boolean;
  divergencePercent: number;
  thresholdPercent: number;
}

export interface IlScenario {
  priceRatio: number;
  lossPercent: number;
}

/** Default divergence (percent) above which a pool is flagged for rebalancing. */
export const DEFAULT_IL_THRESHOLD_PERCENT = 5;

/** Ratios used by the calculator's projection table. */
export const DEFAULT_SCENARIO_RATIOS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

const roundTo = (value: number, decimals: number): number => {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
};

/**
 * Constant-product impermanent loss for a given price ratio.
 * Returns a fraction in `(-1, 0]`; non-positive/non-finite ratios return `0`.
 */
export function impermanentLoss(priceRatioValue: number): number {
  if (!Number.isFinite(priceRatioValue) || priceRatioValue <= 0) return 0;
  return (2 * Math.sqrt(priceRatioValue)) / (1 + priceRatioValue) - 1;
}

/** `impermanentLoss` expressed as a percentage (e.g. `-5.72`). */
export function impermanentLossPercent(priceRatioValue: number): number {
  return impermanentLoss(priceRatioValue) * 100;
}

/** Price ratio of `assetB` in terms of `assetA`, guarding bad inputs with `1`. */
export function priceRatio(entryPrice: number, currentPrice: number): number {
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) return 1;
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) return 1;
  return currentPrice / entryPrice;
}

/** Absolute price divergence from parity, as a percentage (rounded to 4dp). */
export function divergencePercent(priceRatioValue: number): number {
  if (!Number.isFinite(priceRatioValue) || priceRatioValue <= 0) return 0;
  return roundTo(Math.abs(priceRatioValue - 1) * 100, 4);
}

/**
 * Value-based IL for a position. The HODL baseline grows by `(ratio - 1) / 2`
 * because only half of a 50/50 basket is exposed to the volatile asset, and the
 * LP value is the HODL value scaled by `1 + il(ratio)`.
 */
export function positionImpermanentLoss(
  entryPrice: number,
  currentPrice: number,
  depositedValue: number,
  feesEarned = 0,
): ImpermanentLossResult {
  const ratio = priceRatio(entryPrice, currentPrice);
  const lossFraction = impermanentLoss(ratio);
  const value = Number.isFinite(depositedValue) && depositedValue > 0 ? depositedValue : 0;
  const fees = Number.isFinite(feesEarned) && feesEarned > 0 ? feesEarned : 0;

  const holdValue = value * (1 + (ratio - 1) / 2);
  const lpValue = holdValue * (1 + lossFraction);
  const valueLoss = holdValue - lpValue;

  return {
    priceRatio: ratio,
    lossFraction,
    lossPercent: lossFraction * 100,
    holdValue,
    lpValue,
    valueLoss,
    feesEarned: fees,
    netValueLoss: valueLoss - fees,
    isImpermanentLoss: lossFraction < 0,
  };
}

/** Full IL + divergence metrics for a stored liquidity position. */
export function positionMetrics(
  position: LiquidityPosition,
  thresholdPercent: number = DEFAULT_IL_THRESHOLD_PERCENT,
): PositionMetric {
  const result = positionImpermanentLoss(
    position.entryPrice,
    position.currentPrice,
    position.depositedValue,
    position.feesEarned,
  );
  const alert = evaluateRebalance(position.entryPrice, position.currentPrice, thresholdPercent);

  return {
    ...result,
    divergencePercent: alert.divergencePercent,
    needsRebalance: alert.shouldAlert,
  };
}

/** Decides whether a pool's price divergence breaches the given threshold. */
export function evaluateRebalance(
  entryPrice: number,
  currentPrice: number,
  thresholdPercent: number = DEFAULT_IL_THRESHOLD_PERCENT,
): RebalanceAlert {
  const divergence = divergencePercent(priceRatio(entryPrice, currentPrice));
  const threshold =
    Number.isFinite(thresholdPercent) && thresholdPercent >= 0
      ? thresholdPercent
      : DEFAULT_IL_THRESHOLD_PERCENT;

  return {
    shouldAlert: divergence > threshold,
    divergencePercent: divergence,
    thresholdPercent: threshold,
  };
}

/** Projects IL across a set of candidate price ratios. */
export function ilScenarios(ratios: number[] = DEFAULT_SCENARIO_RATIOS): IlScenario[] {
  return ratios.map((ratio) => ({
    priceRatio: ratio,
    lossPercent: impermanentLossPercent(ratio),
  }));
}
