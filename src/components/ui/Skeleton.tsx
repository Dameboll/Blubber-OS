'use client';

/**
 * Skeleton — the one shared loading-placeholder primitive for the app (Lane
 * B6, perf/loading-state sweep). Before this, every screen either rolled its
 * own shimmer block (AgentsScreen's `.acc-skel`, AnalyticsScreen's
 * `.analytics-skel`) or fell back to a bare "Loading…" string with no shape
 * at all (MemoryScreen, MusicPlayerScreen, VirtualPetScreen). This gives every
 * screen the same shimmer treatment so a loading state always reads as "real
 * content is coming, here's its shape" rather than a generic spinner.
 *
 * Three shapes, composed from one shimmer block:
 *   - `Skeleton`      a single rect/circle — a thumbnail, a stat number, a bar.
 *   - `SkeletonText`  stacked text-line bars (last line intentionally shorter,
 *                     like real prose trailing off) — for paragraph/bubble content.
 *   - `SkeletonRow`   a leading circle (avatar/icon) + stacked lines — for any
 *                     list row shape (track row, quest row, agent row, project row).
 *
 * Reduced motion: the shimmer sweep is purely decorative, so it's fully
 * disabled under prefers-reduced-motion (see Skeleton.css) — the shapes still
 * render, they just sit static instead of animating.
 */

import type { CSSProperties } from 'react';
import './Skeleton.css';

export interface SkeletonProps {
  /** CSS width — number is treated as px. Defaults to 100%. */
  width?: number | string;
  /** CSS height — number is treated as px. Defaults to 1rem (one text line). */
  height?: number | string;
  /** Corner radius — number is treated as px. Ignored when `circle` is set. */
  radius?: number | string;
  /** Renders a perfect circle (avatar/icon placeholder) — width/height default to equal. */
  circle?: boolean;
  className?: string;
  style?: CSSProperties;
}

function toCssSize(value: number | string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === 'number' ? `${value}px` : value;
}

export function Skeleton({ width, height, radius, circle, className, style }: SkeletonProps) {
  const size = circle ? (toCssSize(width ?? height) ?? '2.5rem') : undefined;
  const mergedStyle: CSSProperties = {
    width: circle ? size : (toCssSize(width) ?? '100%'),
    height: circle ? size : (toCssSize(height) ?? '1rem'),
    borderRadius: circle ? '50%' : (toCssSize(radius) ?? '6px'),
    ...style,
  };
  const classes = ['skeleton', className ?? ''].filter(Boolean).join(' ');
  return <span className={classes} style={mergedStyle} aria-hidden="true" />;
}

export interface SkeletonTextProps {
  /** Number of stacked line bars. Default 3. */
  lines?: number;
  /** Width of the final line (real prose trails off short). Default '60%'. */
  lastLineWidth?: string | number;
  /** Height of each line bar. Default '0.85rem'. */
  lineHeight?: string | number;
  className?: string;
}

export function SkeletonText({ lines = 3, lastLineWidth = '60%', lineHeight = '0.85rem', className }: SkeletonTextProps) {
  const classes = ['skeleton-text', className ?? ''].filter(Boolean).join(' ');
  return (
    <div className={classes} aria-hidden="true">
      {Array.from({ length: Math.max(1, lines) }).map((_, i) => (
        <Skeleton
          key={i}
          height={lineHeight}
          width={i === lines - 1 ? lastLineWidth : '100%'}
          radius={4}
        />
      ))}
    </div>
  );
}

export interface SkeletonRowProps {
  /** Shows a leading circular placeholder (avatar/icon). Default true. */
  avatar?: boolean;
  /** Size of the leading circle. Default 32. */
  avatarSize?: number;
  /** Number of stacked line bars alongside the avatar. Default 2. */
  lines?: number;
  className?: string;
}

export function SkeletonRow({ avatar = true, avatarSize = 32, lines = 2, className }: SkeletonRowProps) {
  const classes = ['skeleton-row', className ?? ''].filter(Boolean).join(' ');
  return (
    <div className={classes} aria-hidden="true">
      {avatar && <Skeleton circle width={avatarSize} height={avatarSize} />}
      <div className="skeleton-row__lines">
        {Array.from({ length: Math.max(1, lines) }).map((_, i) => (
          <Skeleton key={i} height="0.75rem" width={i === 0 ? '70%' : '40%'} radius={4} />
        ))}
      </div>
    </div>
  );
}

export default Skeleton;
