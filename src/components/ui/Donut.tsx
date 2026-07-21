'use client';

/**
 * Donut — SVG ring chart with a center label, e.g. "68% Used".
 * `value` is 0-100. The progress arc animates on value change via CSS
 * transition on stroke-dashoffset.
 */

import './Donut.css';

export interface DonutProps {
  /** 0-100. Clamped. */
  value: number;
  /** Outer diameter in px. */
  size?: number;
  strokeColor?: string;
  trackColor?: string;
  strokeWidth?: number;
  /** Secondary text under the percentage, e.g. "Used". */
  label?: string;
  className?: string;
}

export default function Donut({
  value,
  size = 96,
  strokeColor = 'var(--core-accent-bright)',
  trackColor = 'oklch(65% 0 0 / 15%)',
  strokeWidth = 10,
  label,
  className,
}: DonutProps) {
  const clamped = Math.min(100, Math.max(0, value));
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - clamped / 100);
  const center = size / 2;
  const classes = ['donut', className ?? ''].filter(Boolean).join(' ');

  return (
    <div className={classes} style={{ width: size, height: size }}>
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        role="img"
        aria-label={label ? `${Math.round(clamped)}% ${label}` : `${Math.round(clamped)}%`}
      >
        <circle
          className="donut__track"
          cx={center}
          cy={center}
          r={radius}
          stroke={trackColor}
          strokeWidth={strokeWidth}
          fill="none"
        />
        <circle
          className="donut__progress"
          cx={center}
          cy={center}
          r={radius}
          stroke={strokeColor}
          strokeWidth={strokeWidth}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          transform={`rotate(-90 ${center} ${center})`}
        />
      </svg>
      <div className="donut__center">
        <span className="donut__value">{Math.round(clamped)}%</span>
        {label && <span className="donut__label">{label}</span>}
      </div>
    </div>
  );
}
