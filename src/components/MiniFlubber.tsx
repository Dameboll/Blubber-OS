'use client';

/**
 * MiniBlubber — a single blob in the MiniFlubberField cluster. One instance == one real
 * open tab/session. All lifecycle bookkeeping (spawn/idle/exiting) lives in the parent field
 * component; this one is purely presentational plus the click handler.
 */

import type { CSSProperties, AnimationEvent } from 'react';
import Flubber3D from './Flubber3D';
import type { MiniFlubberSession } from './MiniFlubberField';
import type { FlubberTier } from '../lib/flubber3d/instance';
import './MiniFlubber.css';

const MINI_FLUBBER_SIZE_PX = 36; // matches --mf-size (2.25rem)

type Phase = 'entering' | 'idle' | 'exiting';

interface MiniFlubberProps {
  session: MiniFlubberSession;
  phase: Phase;
  /** Deterministic per-session hash, used only to spread idle-bounce timing so instances don't move in lockstep. */
  seed: number;
  /** Material tier requested from the shared host. The field passes 'mid' (shiny
   * clearcoat jelly); the host may overflow to 'micro' past its global MID cap. */
  tier: FlubberTier;
  isActive: boolean;
  onSelect: (sessionId: string) => void;
  /** Parent calls this when the spawn ("split off from core") animation finishes, to flip phase -> 'idle'. */
  onSpawnEnd: (sessionId: string) => void;
  /** Parent calls this when the reabsorb animation finishes, to actually unmount the entry. */
  onReabsorbEnd: (sessionId: string) => void;
}

export default function MiniBlubber({
  session,
  phase,
  seed,
  tier,
  isActive,
  onSelect,
  onSpawnEnd,
  onReabsorbEnd,
}: MiniFlubberProps) {
  const delay = (seed % 20) * 97; // spread across ~0-1900ms
  const duration = 2200 + (seed % 7) * 130; // 2200-3000ms, keeps bounces visibly out of sync
  const driftX = ((seed % 5) - 2) * 3; // -6..6px lateral drift so the loop doesn't read as pure vertical bobbing

  const style = {
    '--flubber-delay': `${delay}ms`,
    '--flubber-duration': `${duration}ms`,
    '--flubber-drift-x': `${driftX}px`,
  } as CSSProperties;

  const handleAnimationEnd = (e: AnimationEvent<HTMLButtonElement>) => {
    if (phase === 'entering' && e.animationName === 'flubber-spawn') onSpawnEnd(session.id);
    if (phase === 'exiting' && e.animationName === 'flubber-reabsorb') onReabsorbEnd(session.id);
  };

  return (
    <button
      type="button"
      className={[
        'mini-flubber',
        `mini-flubber--${phase}`,
        isActive ? 'mini-flubber--active' : '',
        session.accent === 'error' ? 'mini-flubber--error' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      style={style}
      onClick={() => onSelect(session.id)}
      onAnimationEnd={handleAnimationEnd}
      aria-pressed={isActive}
      aria-label={session.label}
      title={session.label}
    >
      <span className="mini-flubber__blob" aria-hidden="true">
        <Flubber3D
          expression={session.accent === 'error' ? 'worried' : isActive ? 'excited' : 'happy'}
          size={MINI_FLUBBER_SIZE_PX}
          tier={tier}
          seed={seed}
        />
      </span>
      <span className="mini-flubber__tooltip" aria-hidden="true">
        {session.label}
      </span>
    </button>
  );
}
