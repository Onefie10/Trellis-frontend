'use client';

import React from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import Card from '@/components/Card';
import { ReferralClickMetrics } from '../types';

interface ReferralPerformanceChartProps {
  data: ReferralClickMetrics | null;
  isLoading: boolean;
}

/**
 * CTR and conversion chart for referral links (issue #128).
 *
 * Mirrors the EarningsChart layout and palette: a CTR trend line beside a
 * clicks-vs-conversions bar chart, plus the headline totals. Rates are
 * derived from recorded link events, never estimated.
 */
export const ReferralPerformanceChart: React.FC<ReferralPerformanceChartProps> = ({
  data,
  isLoading,
}) => {
  if (isLoading) {
    return (
      <Card className="animate-pulse">
        <div className="h-80 bg-trellis-vine/20 rounded" />
      </Card>
    );
  }

  const series = data?.series ?? [];

  if (series.length === 0) {
    return (
      <Card className="text-center py-12">
        <p className="text-trellis-vine/60">No referral click data available</p>
      </Card>
    );
  }

  const chartData = series.map((point) => ({
    date: new Date(point.date).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
    }),
    impressions: point.impressions,
    clicks: point.clicks,
    conversions: point.conversions,
    ctr: Math.round(point.ctr * 10000) / 100,
  }));

  const ctr = Math.round((data?.clickThroughRate ?? 0) * 10000) / 100;
  const conversionRate = Math.round((data?.conversionRate ?? 0) * 10000) / 100;

  return (
    <div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
        <Card>
          <p className="text-sm text-trellis-vine/60 mb-1">Link Impressions</p>
          <p className="text-2xl font-bold text-white">{data?.totalImpressions ?? 0}</p>
        </Card>
        <Card>
          <p className="text-sm text-trellis-vine/60 mb-1">Click-through Rate</p>
          <p className="text-2xl font-bold text-white">{ctr}%</p>
        </Card>
        <Card>
          <p className="text-sm text-trellis-vine/60 mb-1">Conversion Rate</p>
          <p className="text-2xl font-bold text-white">{conversionRate}%</p>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Line Chart - CTR trend */}
        <Card>
          <h3 className="text-lg font-semibold mb-4 text-white">Click-through Rate</h3>
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(79, 191, 155, 0.2)" />
              <XAxis dataKey="date" stroke="rgba(79, 191, 155, 0.6)" />
              <YAxis stroke="rgba(79, 191, 155, 0.6)" unit="%" />
              <Tooltip
                contentStyle={{
                  backgroundColor: 'rgba(10, 14, 39, 0.9)',
                  border: '1px solid rgba(79, 191, 155, 0.5)',
                  borderRadius: '8px',
                }}
                labelStyle={{ color: 'rgb(139, 92, 246)' }}
              />
              <Legend />
              <Line
                type="monotone"
                dataKey="ctr"
                stroke="rgb(79, 191, 155)"
                strokeWidth={2}
                dot={{ fill: 'rgb(79, 191, 155)', r: 4 }}
                activeDot={{ r: 6 }}
                name="CTR %"
              />
            </LineChart>
          </ResponsiveContainer>
        </Card>

        {/* Bar Chart - clicks vs conversions */}
        <Card>
          <h3 className="text-lg font-semibold mb-4 text-white">Clicks &amp; Conversions</h3>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(79, 191, 155, 0.2)" />
              <XAxis dataKey="date" stroke="rgba(79, 191, 155, 0.6)" />
              <YAxis stroke="rgba(79, 191, 155, 0.6)" allowDecimals={false} />
              <Tooltip
                contentStyle={{
                  backgroundColor: 'rgba(10, 14, 39, 0.9)',
                  border: '1px solid rgba(79, 191, 155, 0.5)',
                  borderRadius: '8px',
                }}
                labelStyle={{ color: 'rgb(139, 92, 246)' }}
              />
              <Legend />
              <Bar dataKey="clicks" fill="rgb(59, 130, 246)" name="Clicks" />
              <Bar dataKey="conversions" fill="rgb(139, 92, 246)" name="Conversions" />
            </BarChart>
          </ResponsiveContainer>
        </Card>
      </div>
    </div>
  );
};

export default ReferralPerformanceChart;
