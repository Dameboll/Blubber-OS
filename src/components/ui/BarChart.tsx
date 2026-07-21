'use client';

/**
 * BarChart — simple SVG vertical bar chart, e.g. weekly token usage.
 * Scales to its container width (viewBox + preserveAspectRatio="none"),
 * same pattern as WeeklyRecap's TrendChart.
 */

import './BarChart.css';

export interface BarChartDatum {
  label: string;
  value: number;
}

export interface BarChartProps {
  data: BarChartDatum[];
  /** Index of the bar to render in bright/glowing green. */
  highlightIndex?: number;
  /** Total chart height in px (includes the label row). */
  height?: number;
  className?: string;
}

const VIEW_WIDTH = 240;
const LABEL_AREA = 20;

export default function BarChart({ data, highlightIndex, height = 140, className }: BarChartProps) {
  const plotHeight = height - LABEL_AREA;
  const max = Math.max(...data.map((d) => d.value), 1);
  const slotWidth = VIEW_WIDTH / Math.max(data.length, 1);
  const barWidth = Math.min(slotWidth * 0.5, 18);
  const classes = ['bar-chart', className ?? ''].filter(Boolean).join(' ');

  return (
    <svg
      className={classes}
      viewBox={`0 0 ${VIEW_WIDTH} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label="Bar chart"
    >
      {data.map((d, i) => {
        const barHeight = max > 0 ? (d.value / max) * plotHeight : 0;
        const x = i * slotWidth + (slotWidth - barWidth) / 2;
        const y = plotHeight - barHeight;
        const isHighlighted = i === highlightIndex;

        return (
          <g key={`${d.label}-${i}`}>
            <rect
              className={`bar-chart__bar${isHighlighted ? ' bar-chart__bar--highlight' : ''}`}
              x={x}
              y={y}
              width={barWidth}
              height={Math.max(barHeight, 1)}
              rx={2}
            >
              <title>{`${d.label}: ${d.value.toLocaleString()}`}</title>
            </rect>
            <text className="bar-chart__label" x={x + barWidth / 2} y={height - 4} textAnchor="middle">
              {d.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
