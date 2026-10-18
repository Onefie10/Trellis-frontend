'use client';

import * as React from 'react';
import { useMemo } from 'react';
import { useBonusStore } from '@/store/useBonusStore';
import { positionMetrics } from '../lib/impermanentLoss';

export const LiquidityPositions: React.FC = () => {
  const { liquidityPositions, ilThresholdPercent } = useBonusStore();

  const rows = useMemo(
    () =>
      liquidityPositions.map((position) => ({
        position,
        metrics: positionMetrics(position, ilThresholdPercent),
      })),
    [liquidityPositions, ilThresholdPercent]
  );

  const totals = useMemo(
    () =>
      rows.reduce(
        (acc, row) => ({
          deposited: acc.deposited + row.position.depositedValue,
          valueLoss: acc.valueLoss + row.metrics.valueLoss,
          fees: acc.fees + row.metrics.feesEarned,
          atRisk: acc.atRisk + (row.metrics.needsRebalance ? 1 : 0),
        }),
        { deposited: 0, valueLoss: 0, fees: 0, atRisk: 0 }
      ),
    [rows]
  );

  return (
    <section className="mt-8 p-6 rounded-xl border border-white/10 bg-trellis-deep/30 backdrop-blur-sm">
      <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
        <h3 className="text-xl font-bold text-white flex items-center gap-2">
          <span className="w-1 h-6 bg-trellis-vine rounded-full" />
          Liquidity Position Impermanent Loss
        </h3>
        <p className="text-xs text-gray-500">
          {rows.length} active position{rows.length === 1 ? '' : 's'} &middot;{' '}
          {totals.deposited.toFixed(2)} XLM deposited
          {totals.atRisk > 0 && (
            <span className="text-trellis-amber"> &middot; {totals.atRisk} need rebalancing</span>
          )}
        </p>
      </div>

      {rows.length === 0 ? (
        <p className="text-gray-500 text-center py-8">No active liquidity positions.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left">
            <thead>
              <tr className="text-xs uppercase tracking-wider text-gray-500 border-b border-white/10">
                <th className="py-3 pr-4 font-medium">Pool</th>
                <th className="py-3 pr-4 font-medium">Entry &rarr; Current</th>
                <th className="py-3 pr-4 font-medium">Ratio</th>
                <th className="py-3 pr-4 font-medium">IL</th>
                <th className="py-3 pr-4 font-medium">Value Lost</th>
                <th className="py-3 pr-4 font-medium">Fees</th>
                <th className="py-3 pr-4 font-medium">Net</th>
                <th className="py-3 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ position, metrics }) => (
                <tr key={position.id} className="border-b border-white/5 last:border-0">
                  <td className="py-3 pr-4">
                    <p className="font-semibold text-white">{position.pair}</p>
                    <p className="text-xs text-gray-500">{position.pool}</p>
                  </td>
                  <td className="py-3 pr-4 text-gray-300">
                    {position.entryPrice} &rarr; {position.currentPrice}
                  </td>
                  <td className="py-3 pr-4 text-gray-300">{metrics.priceRatio.toFixed(3)}x</td>
                  <td
                    data-testid={`position-il-${position.id}`}
                    className={metrics.isImpermanentLoss ? 'py-3 pr-4 text-trellis-amber' : 'py-3 pr-4 text-gray-400'}
                  >
                    {metrics.lossPercent.toFixed(2)}%
                    <span className="block text-xs text-gray-500">
                      {metrics.divergencePercent.toFixed(2)}% divergence
                    </span>
                  </td>
                  <td className="py-3 pr-4 text-gray-300">{metrics.valueLoss.toFixed(2)} XLM</td>
                  <td className="py-3 pr-4 text-trellis-leaf">{metrics.feesEarned.toFixed(2)} XLM</td>
                  <td
                    className={`py-3 pr-4 font-semibold ${metrics.netValueLoss > 0 ? 'text-trellis-amber' : 'text-trellis-leaf'}`}
                  >
                    {metrics.netValueLoss > 0 ? '-' : '+'}
                    {Math.abs(metrics.netValueLoss).toFixed(2)} XLM
                  </td>
                  <td className="py-3">
                    {metrics.needsRebalance ? (
                      <span className="inline-flex items-center gap-1 rounded-full border border-trellis-amber/40 bg-trellis-amber/15 px-2 py-0.5 text-xs font-semibold text-trellis-amber">
                        Rebalance
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 rounded-full border border-trellis-vine/40 bg-trellis-vine/15 px-2 py-0.5 text-xs font-semibold text-trellis-vine">
                        Healthy
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
};
