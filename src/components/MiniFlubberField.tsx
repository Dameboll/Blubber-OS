'use client';

/**
 * MiniFlubberField — replaces the old flat scrolling AgentCard row (PLAN-FLUBBER.md #2).
 * Renders one small flubber blob per REAL open terminal tab/session — one to one, not
 * decorative. `sessions` is the source of truth: this component diffs it against its own
 * internal render list every time it changes and drives spawn ("splits off from the core")
 * and reabsorb ("melts back into the core") lifecycle animations from that diff alone. The
 * component that owns TabBar's session list just needs to pass the current array in — no
 * separate open/close calls to make.
 *
 * RENDERING (LANE M): each blob is a live 3D Blubber slot (via MiniBlubber → Flubber3D),
 * not a flat div. The field renders its minis at the shiny MID (clearcoat-goo) tier by
 * default — MINI_FIELD_TIER below — so the terminal/dashboard minis read as wet jelly, not
 * dead matcap. The shared host still enforces a global MID budget and overflows extra minis
 * to MICRO on its own, so this stays perf-safe no matter how many tabs pile in. The SVG
 * goo-filter on the dish (below) only fuses the round wrappers where they touch — a cheap
 * raster filter, unrelated to the per-slot WebGL.
 */

import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import MiniBlubber from './MiniFlubber';
import type { FlubberTier } from '../lib/flubber3d/instance';
import './MiniFlubberField.css';

/** Tier the field asks the shared host to render each mini at. MID = the shiny
 * clearcoat jelly; the host silently overflows to MICRO past its global cap. */
const MINI_FIELD_TIER: FlubberTier = 'mid';

export interface MiniFlubberSession {
  /** Same id used as the WebSocket sessionId for this tab — the single source of truth. */
  id: string;
  /** Shown on hover/focus and as the accessible label. Agent name, folder basename, or a custom tab title. */
  label: string;
  /** Optional visual state. 'active' is also derived automatically from `activeSessionId`; pass 'error' when a session just exited non-zero, if you want that reflected. */
  accent?: 'default' | 'active' | 'error';
}

export interface MiniFlubberFieldProps {
  /** Current real open tabs/sessions. This is a live list, not an event stream — add/remove items in place and the component figures out what spawned or closed. */
  sessions: MiniFlubberSession[];
  /** Which session id is currently focused/selected, if any — gets a brighter highlight ring. */
  activeSessionId?: string | null;
  /** Fired on click — switch to (or refocus) that tab. Same action the old AgentCard click performed. */
  onSelect: (sessionId: string) => void;
  className?: string;
}

type Phase = 'entering' | 'idle' | 'exiting';

interface Entry {
  session: MiniFlubberSession;
  phase: Phase;
  /** Stable per-instance offset so idle bounces never fall into lockstep. Derived from the
   * session id itself (not array index) so it never shifts as siblings spawn/reabsorb. */
  seed: number;
}

function hashSeed(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  }
  return hash;
}

export default function MiniFlubberField({
  sessions,
  activeSessionId,
  onSelect,
  className,
}: MiniFlubberFieldProps) {
  const [entries, setEntries] = useState<Map<string, Entry>>(new Map());

  // Diff the real session list against what's currently rendered. New ids spawn in;
  // ids that disappeared from the real list get marked 'exiting' instead of being
  // removed immediately, so the reabsorb animation actually gets to play.
  useEffect(() => {
    setEntries((prev) => {
      const next = new Map(prev);
      const liveIds = new Set(sessions.map((s) => s.id));

      for (const session of sessions) {
        const existing = next.get(session.id);
        if (!existing) {
          next.set(session.id, { session, phase: 'entering', seed: hashSeed(session.id) });
        } else if (existing.phase !== 'exiting') {
          // Already on screen — keep label/accent in sync without restarting the spawn animation.
          next.set(session.id, { ...existing, session });
        }
      }

      for (const [id, entry] of prev) {
        if (!liveIds.has(id) && entry.phase !== 'exiting') {
          next.set(id, { ...entry, phase: 'exiting' });
        }
      }

      return next;
    });
  }, [sessions]);

  const handleSpawnEnd = (id: string) => {
    setEntries((prev) => {
      const entry = prev.get(id);
      if (!entry || entry.phase !== 'entering') return prev;
      const next = new Map(prev);
      next.set(id, { ...entry, phase: 'idle' });
      return next;
    });
  };

  const handleReabsorbEnd = (id: string) => {
    setEntries((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  };

  const list = useMemo(() => Array.from(entries.values()), [entries]);
  const isEmpty = list.length === 0;

  const dishStyle = { '--mf-count': list.length } as CSSProperties;

  return (
    <div
      className={['mini-flubber-field', isEmpty ? 'mini-flubber-field--empty' : '', className]
        .filter(Boolean)
        .join(' ')}
      aria-label={isEmpty ? undefined : 'Open agent sessions'}
      role={isEmpty ? undefined : 'group'}
    >
      {/* Zero-size, reused by every instance via filter: url(#mini-flubber-goo) — this is the
          one bit of "shader-like" work in the whole field, and it's a cheap raster filter, not WebGL. */}
      <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true" focusable="false">
        <filter id="mini-flubber-goo">
          <feGaussianBlur in="SourceGraphic" stdDeviation="6" result="blur" />
          <feColorMatrix
            in="blur"
            type="matrix"
            values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 20 -9"
            result="goo"
          />
          <feComposite in="SourceGraphic" in2="goo" operator="atop" />
        </filter>
      </svg>

      {!isEmpty && (
        <div className="mini-flubber-field__dish" style={dishStyle}>
          {list.map((entry) => (
            <MiniBlubber
              key={entry.session.id}
              session={entry.session}
              phase={entry.phase}
              seed={entry.seed}
              tier={MINI_FIELD_TIER}
              isActive={entry.session.id === activeSessionId}
              onSelect={onSelect}
              onSpawnEnd={handleSpawnEnd}
              onReabsorbEnd={handleReabsorbEnd}
            />
          ))}
        </div>
      )}
    </div>
  );
}
