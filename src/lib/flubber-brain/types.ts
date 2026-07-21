/**
 * flubber-brain/types — the one shared brain that drives every mood-synced
 * Blubber (dashboard hero, roamer, pet CRT). Phase 4 of
 * docs/plans/flubber-3d-everywhere.md.
 *
 * The brain is a pure reducer over real events (terminal PTY signals, live
 * token SSE intensity, music playback, pet care, navigation) plus a priority
 * ladder that decides which expression wins at any instant.
 */

export type FlubberExpression =
  | 'waving' | 'working' | 'worried' | 'happy' | 'excited' | 'focused'
  | 'thinking' | 'confused' | 'tired' | 'surprised' | 'celebrating'
  | 'sleeping' | 'mischievous' | 'determined' | 'overjoyed' | 'plotting'
  | 'heart-eyes' | 'disappointed' | 'dj-mode' | 'idle';

/**
 * Priority ladder. A higher-priority overlay cannot be interrupted by a
 * lower one until it expires.
 *   4 USER   — direct user action (pet action, sprite click, quick action)
 *   3 TERMINAL — PTY success/error/exit
 *   2 AMBIENT  — navigation, beat pulse
 *   0 BASELINE — derived resting mood (pet neglect, music, work intensity, idle)
 */
export const PRIORITY = {
  USER: 4,
  TERMINAL: 3,
  AMBIENT: 2,
  BASELINE: 0,
} as const;

export type Priority = (typeof PRIORITY)[keyof typeof PRIORITY];

export type EventSource =
  | 'user' | 'terminal' | 'nav' | 'music' | 'pet' | 'intensity' | 'tick';

export interface Overlay {
  expression: FlubberExpression;
  /** Numeric ladder rung — see PRIORITY. Kept as a plain number so callers
   * can pass PRIORITY.* without a cast. */
  priority: number;
  expiresAt: number;
  source: EventSource;
}

export interface Speech {
  id: number;
  text: string;
  source: EventSource;
}

/** Normalized pet care snapshot (0..100 per need) plus its average. */
export interface PetSnapshot {
  hunger: number;
  hygiene: number;
  fun: number;
  energy: number;
  love: number;
  avg: number;
}

/** The brain's full internal state — the reducer's domain. */
export interface BrainState {
  overlay: Overlay | null;
  pulseKey: number;
  speech: Speech | null;
  petSnapshot: PetSnapshot | null;
  /** Quantized live-token intensity (0 idle .. 3 heavy). */
  intensityBucket: number;
  musicPlaying: boolean;
  lastEventAt: number;
  activeNavId: string | null;
  /** Monotonic id source for speech de-dupe. */
  speechSeq: number;
}

/** What consumers render — the resolved expression + pulse + speech. */
export interface BrainRenderState {
  expression: FlubberExpression;
  pulseKey: number;
  speech: Speech | null;
}

export type BrainEvent =
  | { type: 'REACT'; expression: FlubberExpression; priority: number; holdMs: number; source: EventSource; pulse?: boolean; now: number }
  | { type: 'SET_MUSIC'; playing: boolean; now: number }
  | { type: 'SET_INTENSITY'; bucket: number; now: number }
  | { type: 'SET_PET'; snapshot: PetSnapshot; now: number }
  | { type: 'SET_NAV'; navId: string; now: number }
  | { type: 'PULSE'; now: number }
  | { type: 'SPEAK'; text: string; source: EventSource; now: number }
  | { type: 'CLEAR_SPEECH' }
  | { type: 'TICK'; now: number };
