'use client';

/**
 * Sparkline — SVG line chart for a live-usage trend graph. Smooths the path
 * through quadratic-bezier midpoints (same trick as WeeklyRecap's TrendChart,
 * generalized to accept a plain number[]) and fills the area under the curve
 * with a soft glow gradient.
 */

import { useId } from 'react';
import './Sparkline.css';

export interface SparklineProps {
  data: number[];
  /** ViewBox width in svg units. The element itself scales to its container. */
  width?: number;
  /** ViewBox height in svg units. */
  height?: number;
  strokeColor?: string;
  className?: string;
}

interface Point {
  x: number;
  y: number;
}

function buildSmoothPath(points: Point[]): string {
  if (points.length === 0) return '';
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;

  let d = `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;
  for (let i = 0; i < points.length - 1; i += 1) {
    const curr = points[i];
    const next = points[i + 1];
    const midX = (curr.x + next.x) / 2;
    const midY = (curr.y + next.y) / 2;
    d += ` Q ${curr.x.toFixed(2)} ${curr.y.toFixed(2)} ${midX.toFixed(2)} ${midY.toFixed(2)}`;
  }
  const last = points[points.length - 1];
  d += ` T ${last.x.toFixed(2)} ${last.y.toFixed(2)}`;
  return d;
}

export default function Sparkline({
  data,
  width = 200,
  height = 48,
  strokeColor = 'var(--core-accent-bright)',
  className,
}: SparklineProps) {
  const gradientId = `sparkline-fill-${useId()}`;
  const padding = 4;
  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const range = max - min || 1;
  const usableW = width - padding * 2;
  const usableH = height - padding * 2;
  const step = data.length > 1 ? usableW / (data.length - 1) : 0;

  const points: Point[] = data.map((v, i) => ({
    x: padding + step * i,
    y: padding + usableH - ((v - min) / range) * usableH,
  }));

  const linePath = buildSmoothPath(points);
  const first = points[0];
  const last = points[points.length - 1];
  const areaPath =
    linePath && first && last
      ? `${linePath} L ${last.x.toFixed(2)} ${height - padding} L ${first.x.toFixed(2)} ${height - padding} Z`
      : '';

  const classes = ['sparkline', className ?? ''].filter(Boolean).join(' ');

  return (
    <svg
      className={classes}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label="Usage trend"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={strokeColor} stopOpacity="0.35" />
          <stop offset="100%" stopColor={strokeColor} stopOpacity="0" />
        </linearGradient>
      </defs>
      {areaPath && <path className="sparkline__area" d={areaPath} fill={`url(#${gradientId})`} stroke="none" />}
      {linePath && (
        <path
          className="sparkline__line"
          d={linePath}
          fill="none"
          stroke={strokeColor}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}
