import {
  DEFAULT_IL_THRESHOLD_PERCENT,
  DEFAULT_SCENARIO_RATIOS,
  divergencePercent,
  evaluateRebalance,
  ilScenarios,
  impermanentLoss,
  impermanentLossPercent,
  positionImpermanentLoss,
  positionMetrics,
  priceRatio,
} from '../lib/impermanentLoss';
import type { LiquidityPosition } from '../lib/impermanentLoss';

const position = (overrides: Partial<LiquidityPosition> = {}): LiquidityPosition => ({
  id: 'lp-test',
  pool: 'Soroban AMM',
  pair: 'XLM/USDC',
  assetA: 'XLM',
  assetB: 'USDC',
  entryPrice: 1,
  currentPrice: 1,
  depositedValue: 1000,
  share: 0.01,
  feesEarned: 0,
  ...overrides,
});

describe('impermanent loss math (issue #130)', () => {
  it('is zero when the price is unchanged', () => {
    expect(impermanentLoss(1)).toBe(0);
    expect(impermanentLossPercent(1)).toBe(0);
  });

  it('matches the constant-product reference for a 2x price move', () => {
    // IL(k) = 2*sqrt(k)/(1+k) - 1, so k = 2 is the classic -5.72% case.
    expect(impermanentLoss(2)).toBeCloseTo(-0.0572, 4);
    expect(impermanentLoss(0.5)).toBeCloseTo(-0.0572, 4);
    expect(impermanentLossPercent(2)).toBeCloseTo(-5.72, 2);
  });

  it('matches the constant-product reference for a 4x price move', () => {
    expect(impermanentLoss(4)).toBeCloseTo(-0.2, 9);
    expect(impermanentLossPercent(4)).toBeCloseTo(-20, 9);
    expect(impermanentLoss(0.25)).toBeCloseTo(-0.2, 9);
  });

  it('is symmetric around a ratio of 1', () => {
    [1.1, 1.5, 2, 3, 4].forEach((ratio) => {
      expect(impermanentLoss(ratio)).toBeCloseTo(impermanentLoss(1 / ratio), 10);
    });
  });

  it('never reports a gain and worsens as divergence grows', () => {
    [0.25, 0.5, 0.9, 1, 1.1, 2, 4].forEach((ratio) => {
      expect(impermanentLoss(ratio)).toBeLessThanOrEqual(0);
    });
    expect(impermanentLoss(1.5)).toBeLessThan(impermanentLoss(1.1));
    expect(impermanentLoss(2)).toBeLessThan(impermanentLoss(1.5));
    expect(impermanentLoss(4)).toBeLessThan(impermanentLoss(2));
  });

  it('guards non-positive and non-finite ratios', () => {
    expect(impermanentLoss(0)).toBe(0);
    expect(impermanentLoss(-2)).toBe(0);
    expect(impermanentLoss(Number.NaN)).toBe(0);
    expect(impermanentLoss(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it('derives the price ratio and divergence from prices', () => {
    expect(priceRatio(2, 4)).toBe(2);
    expect(priceRatio(4, 2)).toBe(0.5);
    expect(priceRatio(0, 4)).toBe(1);
    expect(priceRatio(2, Number.NaN)).toBe(1);
    expect(divergencePercent(1.25)).toBeCloseTo(25, 6);
    expect(divergencePercent(0.8)).toBeCloseTo(20, 6);
  });

  it('computes the value-based loss for a position', () => {
    const doubled = positionImpermanentLoss(2, 4, 1000, 0);
    expect(doubled.lossPercent).toBeCloseTo(-5.7191, 3);
    expect(doubled.holdValue).toBeCloseTo(1500, 6);
    expect(doubled.lpValue).toBeCloseTo(1414.2135624, 6);
    expect(doubled.valueLoss).toBeCloseTo(85.7864376, 6);
    expect(doubled.isImpermanentLoss).toBe(true);

    const quadrupled = positionImpermanentLoss(1, 4, 1000, 0);
    expect(quadrupled.lossPercent).toBeCloseTo(-20, 9);
    expect(quadrupled.holdValue).toBeCloseTo(2500, 6);
    expect(quadrupled.lpValue).toBeCloseTo(2000, 6);
    expect(quadrupled.valueLoss).toBeCloseTo(500, 6);
  });

  it('treats a flat position as having no impermanent loss', () => {
    const flat = positionImpermanentLoss(3, 3, 500, 0);
    expect(flat.lossFraction).toBe(0);
    expect(flat.valueLoss).toBe(0);
    expect(flat.isImpermanentLoss).toBe(false);
  });

  it('nets accrued fees against the loss', () => {
    const gross = positionImpermanentLoss(1, 4, 1000, 0);
    const net = positionImpermanentLoss(1, 4, 1000, 250);
    expect(net.feesEarned).toBe(250);
    expect(net.netValueLoss).toBeCloseTo(gross.valueLoss - 250, 6);
    expect(net.netValueLoss).toBeCloseTo(250, 6);
  });

  it('flags a position that breaches the rebalancing threshold', () => {
    const calm = positionMetrics(position({ entryPrice: 1, currentPrice: 1.02 }), 5);
    expect(calm.needsRebalance).toBe(false);
    expect(calm.divergencePercent).toBeCloseTo(2, 6);

    const stressed = positionMetrics(position({ entryPrice: 1, currentPrice: 1.5 }), 5);
    expect(stressed.needsRebalance).toBe(true);
    expect(stressed.divergencePercent).toBeCloseTo(50, 6);
  });

  it('evaluates rebalance alerts against a configurable threshold', () => {
    expect(evaluateRebalance(1, 1.05, 5).shouldAlert).toBe(false);
    expect(evaluateRebalance(1, 1.05, 4).shouldAlert).toBe(true);
    expect(evaluateRebalance(1, 0.5, 10).shouldAlert).toBe(true);
    expect(evaluateRebalance(1, 1, 0).shouldAlert).toBe(false);
    expect(evaluateRebalance(1, 2, Number.NaN).thresholdPercent).toBe(
      DEFAULT_IL_THRESHOLD_PERCENT
    );
  });

  it('projects IL across the default scenario ratios', () => {
    const scenarios = ilScenarios(DEFAULT_SCENARIO_RATIOS);
    expect(scenarios).toHaveLength(DEFAULT_SCENARIO_RATIOS.length);
    expect(scenarios.find((scenario) => scenario.priceRatio === 1)?.lossPercent).toBe(0);
    expect(scenarios.every((scenario) => scenario.lossPercent <= 0)).toBe(true);
    expect(scenarios.find((scenario) => scenario.priceRatio === 2)?.lossPercent).toBeCloseTo(
      -5.7191,
      3
    );
  });
});
