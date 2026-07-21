'use client';

/**
 * Panel — the base rounded dark card every screen in the dashboard is built
 * from. Optional title, optional green-underline accent under the title, and
 * an optional right-aligned header action (button, link, small control).
 */

import type { ReactNode } from 'react';
import './Panel.css';

export interface PanelProps {
  /** Header title text, e.g. "SYSTEM STATUS". Omit to render a bare card. */
  title?: string;
  /** Renders a glowing green underline beneath the title + a subtle panel-wide glow. */
  accent?: boolean;
  /** Right-aligned control in the header row, e.g. a refresh button or link. */
  action?: ReactNode;
  /** Marks this whole panel (header + body) as a live-readout region the
   * roaming Blubber sprite's autonomous wander must never park on top of —
   * see useFlubberRoam's readAvoidRects(). Opt-in, not the Panel default:
   * most panels are fine to roam near/over (e.g. Quick Actions, empty
   * states), and defaulting every Panel to excluded would leave the sprite
   * almost nowhere left to wander on a dense screen. Set true on panels
   * whose content is a real or simulated readout someone would want to
   * actually read (stat grids, activity lists, charts, queues). */
  avoidRoam?: boolean;
  children: ReactNode;
  className?: string;
}

export default function Panel({ title, accent = false, action, avoidRoam = false, children, className }: PanelProps) {
  const classes = ['panel', accent ? 'panel--accent' : '', className ?? ''].filter(Boolean).join(' ');
  const hasHeader = Boolean(title) || Boolean(action);

  return (
    <section className={classes} data-flubber-avoid={avoidRoam ? 'true' : undefined}>
      {hasHeader && (
        <header className="panel__header">
          {title && (
            <h3 className="panel__title">
              {title}
              {accent && <span className="panel__accent-bar" aria-hidden="true" />}
            </h3>
          )}
          {action && <div className="panel__action">{action}</div>}
        </header>
      )}
      <div className="panel__body">{children}</div>
    </section>
  );
}
