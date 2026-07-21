'use client';

/**
 * LiveBar — numeric readout next to the orb (PLAN.md). All SSE plumbing lives
 * in src/hooks/useLiveUsage.ts so the same live state can also drive Core3D's
 * `intensity` prop from one shared subscription.
 *
 * Aliveness pass: this shows REAL streaming numbers but used to look frozen.
 * Now it visibly reacts to live data:
 *  - the total count-up ANIMATES from its previous value to the new one (rAF
 *    ease-out) instead of snapping, so the digits roll;
 *  - every incoming delta fires a brief green bloom on the whole pill + a
 *    scale-pop on the dot;
 *  - the connected dot breathes continuously (CSS) so "connected" reads as a
 *    heartbeat, not a static LED.
 */

import { useEffect, useRef, useState } from 'react';
import './LiveBar.css';

export interface LiveBarProps {
  totalToday: number;
  tokensInDelta: number;
  tokensOutDelta: number;
  connected: boolean;
}

/** rAF count-up: eases a displayed number toward `target` whenever it changes. */
function useAnimatedNumber(target: number, durationMs = 700): number {
  const [display, setDisplay] = useState(target);
  const fromRef = useRef(target);
  const rafRef = useRef<number | null>(null);
  const startRef = useRef(0);

  useEffect(() => {
    // Snap (no animation) on the very first real value or huge jumps so the
    // odometer doesn't spend a second spinning up from 0 on load.
    if (fromRef.current === target) return;
    const from = fromRef.current;
    const delta = target - from;
    if (Math.abs(delta) > 5_000_000 || from === 0) {
      fromRef.current = target;
      setDisplay(target);
      return;
    }

    startRef.current = performance.now();
    const tick = (now: number) => {
      const p = Math.min((now - startRef.current) / durationMs, 1);
      const eased = 1 - Math.pow(1 - p, 3);
      setDisplay(Math.round(from + delta * eased));
      if (p < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        fromRef.current = target;
      }
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [target, durationMs]);

  return display;
}

export default function LiveBar({ totalToday, tokensInDelta, tokensOutDelta, connected }: LiveBarProps) {
  const hasActivity = tokensInDelta > 0 || tokensOutDelta > 0;
  const animatedTotal = useAnimatedNumber(totalToday);

  // Toggle a one-shot "pulse" class each time a new delta arrives. We key off
  // a monotonic counter so re-applying the class retriggers the CSS animation.
  const [pulseKey, setPulseKey] = useState(0);
  const lastDeltaRef = useRef(0);
  useEffect(() => {
    const combined = tokensInDelta + tokensOutDelta;
    if (combined > 0 && combined !== lastDeltaRef.current) {
      lastDeltaRef.current = combined;
      setPulseKey((k) => k + 1);
    }
  }, [tokensInDelta, tokensOutDelta]);

  return (
    <div className={`live-bar${connected ? '' : ' live-bar--offline'}`} role="status" aria-live="polite">
      {/* Remounts on every new delta (key change) so its one-shot bloom
          animation replays cleanly each time live data moves. */}
      {pulseKey > 0 && <span key={pulseKey} className="live-bar__bloom" aria-hidden="true" />}
      <span className={`live-bar__dot${connected ? '' : ' live-bar__dot--offline'}`} aria-hidden="true" />
      <span className="live-bar__value">{animatedTotal.toLocaleString()}</span>
      <span className="live-bar__label">tokens today</span>
      {hasActivity && (
        <span className="live-bar__delta">+{(tokensInDelta + tokensOutDelta).toLocaleString()}</span>
      )}
    </div>
  );
}
