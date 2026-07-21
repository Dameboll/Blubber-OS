'use client';

/**
 * ActivityItem — small icon + text + right-aligned timestamp.
 * Used in Activity Feed lists.
 */

import type { ReactNode } from 'react';
import './ActivityItem.css';

export interface ActivityItemProps {
  /** Typically a lucide-react icon element, e.g. <Terminal size={13} />. */
  icon?: ReactNode;
  text: string;
  timestamp: string;
  className?: string;
}

export default function ActivityItem({ icon, text, timestamp, className }: ActivityItemProps) {
  const classes = ['activity-item', className ?? ''].filter(Boolean).join(' ');

  return (
    <div className={classes}>
      {icon && (
        <span className="activity-item__icon" aria-hidden="true">
          {icon}
        </span>
      )}
      <span className="activity-item__text">{text}</span>
      <span className="activity-item__time">{timestamp}</span>
    </div>
  );
}
