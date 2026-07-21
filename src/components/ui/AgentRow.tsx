'use client';

/**
 * AgentRow — avatar circle + name + status text + a right-aligned percentage
 * or mini progress bar. Used in Top Agents / Active Agents lists.
 */

import './AgentRow.css';

export type AgentRowVariant = 'percent' | 'bar' | 'none';

export interface AgentRowProps {
  name: string;
  status?: string;
  /** Avatar fill color. Defaults to the core accent green. */
  avatarColor?: string;
  /** 0-100. Rendered as a percentage or a mini bar depending on `variant`. */
  value?: number;
  variant?: AgentRowVariant;
  className?: string;
}

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

export default function AgentRow({
  name,
  status,
  avatarColor = 'var(--core-accent)',
  value,
  variant = 'percent',
  className,
}: AgentRowProps) {
  const showValue = typeof value === 'number' && variant !== 'none';
  const clamped = typeof value === 'number' ? Math.min(100, Math.max(0, value)) : 0;
  const classes = ['agent-row', className ?? ''].filter(Boolean).join(' ');

  return (
    <div className={classes}>
      <span className="agent-row__avatar" style={{ backgroundColor: avatarColor }} aria-hidden="true">
        {getInitials(name)}
      </span>
      <span className="agent-row__info">
        <span className="agent-row__name">{name}</span>
        {status && <span className="agent-row__status">{status}</span>}
      </span>
      {showValue && variant === 'percent' && (
        <span className="agent-row__percent">{Math.round(clamped)}%</span>
      )}
      {showValue && variant === 'bar' && (
        <span
          className="agent-row__bar-track"
          role="progressbar"
          aria-valuenow={Math.round(clamped)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`${name} usage`}
        >
          <span className="agent-row__bar-fill" style={{ transform: `scaleX(${clamped / 100})` }} />
        </span>
      )}
    </div>
  );
}
