/**
 * flubber-brain/reducer — pure event → state, plus the selector that resolves
 * the render expression from the overlay/baseline priority ladder. No React,
 * no timers, no Date.now (callers pass `now`) so it's fully unit-testable.
 * Phase 4 of docs/plans/flubber-3d-everywhere.md.
 */

import { computeBaseline } from './baseline';
import type { BrainEvent, BrainRenderState, BrainState, Overlay } from './types';

export function initialBrainState(now: number): BrainState {
  return {
    overlay: null,
    pulseKey: 0,
    speech: null,
    petSnapshot: null,
    intensityBucket: 0,
    musicPlaying: false,
    lastEventAt: now,
    activeNavId: null,
    speechSeq: 0,
  };
}

function activeOverlay(state: BrainState, now: number): Overlay | null {
  return state.overlay && state.overlay.expiresAt > now ? state.overlay : null;
}

export function brainReducer(state: BrainState, event: BrainEvent): BrainState {
  switch (event.type) {
    case 'REACT': {
      const current = activeOverlay(state, event.now);
      // A new overlay wins only if nothing higher-priority is still holding.
      const next: BrainState = {
        ...state,
        lastEventAt: event.now,
        pulseKey: state.pulseKey + (event.pulse ? 1 : 0),
      };
      if (!current || event.priority >= current.priority) {
        next.overlay = {
          expression: event.expression,
          priority: event.priority,
          expiresAt: event.now + event.holdMs,
          source: event.source,
        };
      }
      return next;
    }
    case 'SET_MUSIC':
      if (state.musicPlaying === event.playing) return state;
      return { ...state, musicPlaying: event.playing, lastEventAt: event.now };
    case 'SET_INTENSITY':
      if (state.intensityBucket === event.bucket) return state;
      return {
        ...state,
        intensityBucket: event.bucket,
        // Real token throughput counts as activity — resets the idle clock.
        lastEventAt: event.bucket > 0 ? event.now : state.lastEventAt,
      };
    case 'SET_PET':
      return { ...state, petSnapshot: event.snapshot };
    case 'SET_NAV':
      if (state.activeNavId === event.navId) return state;
      return { ...state, activeNavId: event.navId, lastEventAt: event.now };
    case 'PULSE':
      return { ...state, pulseKey: state.pulseKey + 1, lastEventAt: event.now };
    case 'SPEAK': {
      const id = state.speechSeq + 1;
      return {
        ...state,
        speechSeq: id,
        speech: { id, text: event.text, source: event.source },
        lastEventAt: event.now,
      };
    }
    case 'CLEAR_SPEECH':
      return state.speech ? { ...state, speech: null } : state;
    case 'TICK':
      // Nothing to mutate — TICK exists so the provider re-selects the render
      // state as idle/time-of-day cross their thresholds. Returning the same
      // reference is fine; the provider selects on every dispatch.
      return state;
    default:
      return state;
  }
}

/** Resolve what consumers should render right now. */
export function selectRenderState(state: BrainState, now: number): BrainRenderState {
  const overlay = activeOverlay(state, now);
  const expression = overlay ? overlay.expression : computeBaseline(state, now);
  return { expression, pulseKey: state.pulseKey, speech: state.speech };
}
