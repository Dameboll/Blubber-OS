'use client';

/**
 * StatChip — small label + big value + optional trend arrow.
 * e.g. label="CPU" value="24%" trend="up" trendValue="+3%"
 */

import { ArrowDown, ArrowUp, Minus } from 'lucide-react';
import './StatChip.css';

export type StatChipTrend = 'up' | 'down' | 'neutral';

export interface StatChipProps {
  label: string;
  value: string | number;
  trend?: StatChipTrend;
  /** Small secondary text next to the trend arrow, e.g. "+3%" or "12 today". */
  trendValue?: string;
  className?: string;
  /**
   * 0-100 reading that drives the ambient "living" glow (System Status vitals).
   * Omit for chips that shouldn't glow (e.g. plain counts). Values >= WARNING_THRESHOLD
   * shift the chip from a healthy green glow to an amber warning glow.
   */
  percent?: number;
}

const WARNING_THRESHOLD = 85;

export default function StatChip({ label, value, trend, trendValue, className, percent }: StatChipProps) {
  const hasVital = typeof percent === 'number' && Number.isFinite(percent);
  const isWarning = hasVital && (percent as number) >= WARNING_THRESHOLD;
  const classes = [
    'stat-chip',
    hasVital ? 'stat-chip--vital' : '',
    hasVital ? (isWarning ? 'stat-chip--warning' : 'stat-chip--healthy') : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={classes}>
      {hasVital && (
        <span className="stat-chip__specks" aria-hidden="true">
          <span className="stat-chip__speck stat-chip__speck--1" />
          <span className="stat-chip__speck stat-chip__speck--2" />
          <span className="stat-chip__speck stat-chip__speck--3" />
        </span>
      )}
      <span className="stat-chip__label">{label}</span>
      <span className="stat-chip__row">
        <span className="stat-chip__value">{value}</span>
        {trend && (
          <span className={`stat-chip__trend stat-chip__trend--${trend}`}>
            {trend === 'up' && <ArrowUp size={12} aria-hidden="true" />}
            {trend === 'down' && <ArrowDown size={12} aria-hidden="true" />}
            {trend === 'neutral' && <Minus size={12} aria-hidden="true" />}
            {trendValue && <span className="stat-chip__trend-value">{trendValue}</span>}
          </span>
        )}
      </span>
    </div>
  );
}
