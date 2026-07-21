'use client';

/**
 * ProgressBar — horizontal bar with a label plus percentage, e.g. "Hunger 78%".
 */

import './ProgressBar.css';

export interface ProgressBarProps {
  label: string;
  /** 0-100. Clamped. */
  value: number;
  color?: string;
  className?: string;
}

export default function ProgressBar({ label, value, color = 'var(--core-accent-bright)', className }: ProgressBarProps) {
  const clamped = Math.min(100, Math.max(0, value));
  const classes = ['progress-bar', className ?? ''].filter(Boolean).join(' ');

  return (
    <div className={classes}>
      <div className="progress-bar__row">
        <span className="progress-bar__label">{label}</span>
        <span className="progress-bar__percent">{Math.round(clamped)}%</span>
      </div>
      <div
        className="progress-bar__track"
        role="progressbar"
        aria-valuenow={Math.round(clamped)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
      >
        <div
          className="progress-bar__fill"
          style={{ transform: `scaleX(${clamped / 100})`, backgroundColor: color }}
        />
      </div>
    </div>
  );
}
