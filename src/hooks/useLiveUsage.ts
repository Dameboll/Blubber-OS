'use client';

/**
 * useLiveUsage — subscribes once to the /api/live SSE channel (see
 * src/app/api/live/route.ts) and derives:
 *   - totalToday / tokensInDelta / tokensOutDelta straight off the wire, for LiveBar
 *   - a smoothed 0..1 `intensity` value for Core3D, computed client-side since
 *     the SSE payload itself only carries raw deltas, not a normalized score
 *
 * Intensity model: each incoming delta bumps an internal "activity" score
 * (clamped to 1), which decays on a fixed interval when nothing new arrives —
 * so the orb flares up on real token bursts and settles back to idle a few
 * seconds after activity stops, rather than snapping instantly.
 */

import { useEffect, useRef, useState } from 'react';

// ONE shared EventSource for the whole app, refcounted across hook mounts.
// Before this, every mounted useLiveUsage() (SessionProvider + LiveUsageMeter
// etc.) opened its OWN /api/live stream — two-plus permanently-open connections against
// the browser's hard 6-per-origin HTTP/1.1 limit, permanently starving the
// pool the app's dozen pollers also share. One stream carries the exact same
// events to every listener; N streams was pure waste.
let sharedSource: EventSource | null = null;
let sharedRefCount = 0;

function acquireLiveSource(): EventSource {
  if (!sharedSource) sharedSource = new EventSource('/api/live');
  sharedRefCount += 1;
  return sharedSource;
}

function releaseLiveSource(): void {
  sharedRefCount = Math.max(0, sharedRefCount - 1);
  if (sharedRefCount === 0 && sharedSource) {
    sharedSource.close();
    sharedSource = null;
  }
}

export interface LiveUsageState {
  totalToday: number;
  tokensInDelta: number;
  tokensOutDelta: number;
  intensity: number;
  connected: boolean;
}

interface UsagePayload {
  tokensInDelta: number;
  tokensOutDelta: number;
  totalToday: number;
}

// Tokens-per-delta-event that fully saturates intensity to 1.0 — tuned for a
// normal single-turn response; large bursts (e.g. big file reads) will hit
// the clamp rather than overshoot.
const ACTIVITY_SCALE = 4000;
const DECAY_INTERVAL_MS = 400;
const DECAY_FACTOR = 0.9;

export function useLiveUsage(): LiveUsageState {
  const [state, setState] = useState<LiveUsageState>({
    totalToday: 0,
    tokensInDelta: 0,
    tokensOutDelta: 0,
    intensity: 0,
    connected: false,
  });

  const activityRef = useRef(0);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof EventSource === 'undefined') return;

    const source = acquireLiveSource();

    const handleOpen = () => setState((prev) => ({ ...prev, connected: true }));
    const handleErrorEvt = () => setState((prev) => ({ ...prev, connected: false }));

    const handleUsage = (event: MessageEvent) => {
      let payload: UsagePayload;
      try {
        payload = JSON.parse(event.data as string) as UsagePayload;
      } catch {
        return;
      }

      const bump = (payload.tokensInDelta + payload.tokensOutDelta) / ACTIVITY_SCALE;
      activityRef.current = Math.min(1, activityRef.current + bump);

      setState((prev) => ({
        ...prev,
        totalToday: payload.totalToday,
        tokensInDelta: payload.tokensInDelta,
        tokensOutDelta: payload.tokensOutDelta,
        intensity: activityRef.current,
        connected: true,
      }));
    };

    source.addEventListener('open', handleOpen);
    source.addEventListener('error', handleErrorEvt);
    source.addEventListener('usage', handleUsage as EventListener);

    // A late subscriber to the SHARED stream missed the original 'open'
    // event — reflect the live connection state it joined into.
    if (source.readyState === EventSource.OPEN) {
      setState((prev) => ({ ...prev, connected: true }));
    }

    const decayTimer = setInterval(() => {
      if (activityRef.current <= 0.001) return;
      activityRef.current *= DECAY_FACTOR;
      setState((prev) => ({ ...prev, intensity: activityRef.current }));
    }, DECAY_INTERVAL_MS);

    return () => {
      clearInterval(decayTimer);
      source.removeEventListener('open', handleOpen);
      source.removeEventListener('error', handleErrorEvt);
      source.removeEventListener('usage', handleUsage as EventListener);
      // Refcounted: the underlying stream only actually closes when the LAST
      // subscribed hook unmounts (see acquireLiveSource/releaseLiveSource).
      releaseLiveSource();
    };
  }, []);

  return state;
}
