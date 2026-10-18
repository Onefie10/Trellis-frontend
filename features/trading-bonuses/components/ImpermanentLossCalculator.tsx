'use client';

import * as React from 'react';
import { useMemo } from 'react';
import { useBonusStore } from '@/store/useBonusStore';
import {
  DEFAULT_SCENARIO_RATIOS,
  evaluateRebalance,
  ilScenarios,
  impermanentLossPercent,
  positionImpermanentLoss,
} from '../lib/impermanentLoss';

const PRESET_RATIOS = [0.5, 1, 1.5, 2, 4];

/** 1,000 XLM reference position used to translate the IL fraction into value. */
const REFERENCE_POSITION_VALUE = 1000;

export const ImpermanentLossCalculator: React.FC = () => {
  const {
    ilPriceRatio,
    ilThresholdPercent,
    setIlPriceRatio,
    setIlThresholdPercent,
  } = useBonusStore();

  const projected = useMemo(() => {
    const lossPercent = impermanentLossPercent(ilPriceRatio);
    const { holdValue, lpValue, valueLoss } = positionImpermanentLoss(
      1,
      ilPriceRatio,
      REFERENCE_POSITION_VALUE
    );
    return { lossPercent, holdValue, lpValue, valueLoss };
  }, [ilPriceRatio]);

  const scenarios = useMemo(() => ilScenarios(DEFAULT_SCENARIO_RATIOS), []);
  const alert = useMemo(
    () => evaluateRebalance(1, ilPriceRatio, ilThresholdPercent),
    [ilPriceRatio, ilThresholdPercent]
  );

  return (
    <section className="mt-8 p-6 rounded-xl border border-trellis-amber/30 bg-trellis-deep/30 backdrop-blur-sm">
      <div className="flex flex-wrap items-start justify-between gap-4 mb-6">
        <div>
          <h3 className="text-xl font-bold text-white flex items-center gap-2">
            <span className="w-1 h-6 bg-trellis-amber rounded-full" />
            Impermanent Loss Calculator
          </h3>
          <p className="text-sm text-gray-400 mt-2 max-w-xl">
            Model projected impermanent loss for a 50/50 constant-product pool as the volatile
            asset price diverges from your entry price.
          </p>
        </div>
        <div className="text-right">
          <p className="text-xs uppercase tracking-wider text-gray-500">Projected IL</p>
          <p data-testid="projected-il" className="text-4xl font-bold text-trellis-amber">
            {projected.lossPercent.toFixed(2)}%
          </p>
          <p className="text-xs text-gray-500">at {ilPriceRatio.toFixed(2)}x price ratio</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <div>
          <label
            htmlFor="il-price-ratio"
            className="block text-sm font-medium text-gray-300 mb-2"
          >
            Price ratio (current price / entry price)
          </label>
          <input
            id="il-price-ratio"
            data-testid="il-price-ratio-slider"
            type="range"
            min={0.25}
            max={4}
            step={0.05}
            value={ilPriceRatio}
            onChange={(event) => setIlPriceRatio(Number(event.target.value))}
            aria-valuetext={`${ilPriceRatio.toFixed(2)} times the entry price`}
            className="w-full accent-trellis-amber"
          />
          <div className="flex justify-between text-xs text-gray-500 mt-1">
            <span>0.25x</span>
            <span>1x</span>
            <span>2x</span>
            <span>4x</span>
          </div>

          <div className="flex flex-wrap gap-2 mt-4">
            {PRESET_RATIOS.map((ratio) => (
              <button
                key={ratio}
                type="button"
                onClick={() => setIlPriceRatio(ratio)}
                className={`px-3 py-1 rounded-lg border text-sm transition-all ${
                  Math.abs(ilPriceRatio - ratio) < 0.001
                    ? 'border-trellis-amber bg-trellis-amber/20 text-trellis-amber'
                    : 'border-white/10 bg-white/5 text-gray-300 hover:bg-white/10'
                }`}
              >
                {ratio}x
              </button>
            ))}
          </div>

          <dl className="grid grid-cols-2 gap-4 mt-6 text-sm">
            <div className="p-3 rounded-lg bg-white/5 border border-white/10">
              <dt className="text-gray-500">HODL value</dt>
              <dd className="text-white font-semibold">{projected.holdValue.toFixed(2)} XLM</dd>
            </div>
            <div className="p-3 rounded-lg bg-white/5 border border-white/10">
              <dt className="text-gray-500">LP value</dt>
              <dd className="text-white font-semibold">{projected.lpValue.toFixed(2)} XLM</dd>
            </div>
            <div className="p-3 rounded-lg bg-white/5 border border-white/10 col-span-2">
              <dt className="text-gray-500">
                Value lost vs HODL on a {REFERENCE_POSITION_VALUE.toLocaleString()} XLM position
              </dt>
              <dd className="text-trellis-amber font-semibold">
                {projected.valueLoss.toFixed(2)} XLM
              </dd>
            </div>
          </dl>
        </div>

        <div>
          <p className="text-sm font-medium text-gray-300 mb-3">Projected IL by price scenario</p>
          <div className="space-y-2">
            {scenarios.map((scenario) => {
              const isActive = Math.abs(scenario.priceRatio - ilPriceRatio) < 0.001;
              return (
                <div
                  key={scenario.priceRatio}
                  className={`flex items-center justify-between rounded-lg px-3 py-2 text-sm ${
                    isActive
                      ? 'bg-trellis-amber/15 border border-trellis-amber/40'
                      : 'bg-white/5 border border-white/10'
                  }`}
                >
                  <span className="text-gray-300">{scenario.priceRatio}x</span>
                  <span className={scenario.lossPercent === 0 ? 'text-gray-400' : 'text-trellis-amber'}>
                    {scenario.lossPercent.toFixed(2)}%
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="mt-8 pt-6 border-t border-white/10">
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <label
              htmlFor="il-threshold"
              className="block text-sm font-medium text-gray-300 mb-2"
            >
              Rebalancing alert threshold (% divergence)
            </label>
            <input
              id="il-threshold"
              data-testid="il-threshold-input"
              type="number"
              min={0}
              max={100}
              step={1}
              value={ilThresholdPercent}
              onChange={(event) => setIlThresholdPercent(Number(event.target.value))}
              className="w-32 px-3 py-2 bg-trellis-deep border border-white/20 rounded-lg text-sm text-white"
            />
          </div>
          <p
            data-testid="il-threshold-status"
            className={`text-sm ${alert.shouldAlert ? 'text-trellis-amber font-semibold' : 'text-gray-400'}`}
          >
            {alert.shouldAlert
              ? `${alert.divergencePercent.toFixed(2)}% divergence at ${ilPriceRatio.toFixed(2)}x would trigger a rebalancing alert`
              : `${alert.divergencePercent.toFixed(2)}% divergence at ${ilPriceRatio.toFixed(2)}x is within the ${ilThresholdPercent}% threshold`}
          </p>
        </div>
      </div>
    </section>
  );
};
