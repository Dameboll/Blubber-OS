'use client';

/**
 * FlubberBrainProvider — the one brain, wired to real events, feeding every
 * mood-synced Blubber (dashboard hero, roamer, pet CRT). Phase 4 of
 * docs/plans/flubber-3d-everywhere.md.
 *
 * Re-render discipline:
 *   - Two contexts. The *state* context (resolved expression/pulse/speech) is
 *     memoized by value, so consumers only re-render when the resolved mood
 *     actually changes — not on every internal event. The *api* context holds
 *     stable dispatchers and never changes identity.
 *   - Live-token intensity is quantized to 4 buckets before it can move the
 *     mood, so per-token SSE frames don't thrash state.
 *   - A wrapper div carries data-flubber-mood={expression} — the cross-screen
 *     assertion hook the verify scripts read.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useLiveUsage } from '../hooks/useLiveUsage';
import { terminalWatcher } from '../lib/flubber-brain/terminal-watcher';
import { brainReducer, initialBrainState, selectRenderState } from '../lib/flubber-brain/reducer';
import { PRIORITY, type BrainRenderState, type EventSource, type FlubberExpression, type PetSnapshot } from '../lib/flubber-brain/types';
import { setFlubberRuntime, type FlubberPersonality } from '../lib/flubber3d/runtime';
import { narrate } from '../lib/flubber3d/narration';

interface BrainApi {
  /** Fire a reaction expression at USER priority (default), optionally pulsing. */
  react: (expression: FlubberExpression, opts?: { priority?: number; holdMs?: number; source?: EventSource; pulse?: boolean }) => void;
  pulse: () => void;
  setMusic: (playing: boolean) => void;
  setPet: (snapshot: PetSnapshot) => void;
  speak: (text: string, source?: EventSource) => void;
}

const INERT_RENDER: BrainRenderState = { expression: 'happy', pulseKey: 0, speech: null };
const INERT_API: BrainApi = {
  react: () => {}, pulse: () => {}, setMusic: () => {}, setPet: () => {}, speak: () => {},
};

const BrainStateContext = createContext<BrainRenderState>(INERT_RENDER);
const BrainApiContext = createContext<BrainApi>(INERT_API);

/** The persisted personality config (GET /api/brain), exposed additively so
 * settings UIs and any consumer can read the live brain config without
 * disturbing the existing state/api hooks. */
export interface FlubberBrainConfig {
  personalityMode: FlubberPersonality;
  /** 0-100 — global animation energy. */
  energyLevel: number;
  /** 0-100 — how much idle Flubbers roam. */
  movementAmount: number;
  /** 0-100 — idle roam/gesture cadence fed to the 3D runtime. (No longer drives
   * any narration text — speech comes only from real events. See LANE G note.) */
  talkativeness: number;
}

const DEFAULT_BRAIN_CONFIG: FlubberBrainConfig = {
  personalityMode: 'playful',
  energyLevel: 75,
  movementAmount: 70,
  talkativeness: 60,
};

const BrainConfigContext = createContext<FlubberBrainConfig>(DEFAULT_BRAIN_CONFIG);

const INTENSITY_BUCKETS = [0.05, 0.35, 0.7]; // thresholds → buckets 0,1,2,3
const SPEECH_COOLDOWN_MS = 60_000;
const BASELINE_DRIFT_TICK_MS = 20_000;
const PET_REFRESH_MS = 10 * 60 * 1000;
const BRAIN_CONFIG_REFRESH_MS = 60_000;

const PERSONALITY_MODES: readonly FlubberPersonality[] = [
  'playful', 'professional', 'chill', 'hype', 'sarcastic',
];

/** Defensive parse of the /api/brain payload → a full config (defaults fill any
 * missing / malformed field so a half-built route never breaks the brain). */
function sanitizeBrainConfig(raw: unknown): FlubberBrainConfig {
  const root = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const c =
    root.config && typeof root.config === 'object'
      ? (root.config as Record<string, unknown>)
      : root;
  const mode = c.personalityMode;
  return {
    personalityMode: PERSONALITY_MODES.includes(mode as FlubberPersonality)
      ? (mode as FlubberPersonality)
      : DEFAULT_BRAIN_CONFIG.personalityMode,
    energyLevel: clamp0to100(c.energyLevel, DEFAULT_BRAIN_CONFIG.energyLevel),
    movementAmount: clamp0to100(c.movementAmount, DEFAULT_BRAIN_CONFIG.movementAmount),
    talkativeness: clamp0to100(c.talkativeness, DEFAULT_BRAIN_CONFIG.talkativeness),
  };
}

function clamp0to100(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return value < 0 ? 0 : value > 100 ? 100 : value;
}

function quantizeIntensity(intensity: number): number {
  let bucket = 0;
  for (const threshold of INTENSITY_BUCKETS) {
    if (intensity >= threshold) bucket += 1;
  }
  return bucket;
}

export function FlubberBrainProvider({ activeNavId, children }: { activeNavId: string; children: ReactNode }) {
  const [state, dispatch] = useReducer(brainReducer, undefined, () => initialBrainState(Date.now()));
  // nowTick forces a re-selection when time passes (overlay expiry, idle/
  // time-of-day baseline drift) with no event to trigger it.
  const [nowTick, setNowTick] = useState(0);
  const bumpTick = useCallback(() => setNowTick((t) => t + 1), []);
  const speechCooldownRef = useRef<Map<EventSource, number>>(new Map());

  // Config-driven brain — the persisted personality/energy/movement/talkativeness
  // from GET /api/brain. Starts at defaults so the very first frame animates.
  const [brainConfig, setBrainConfig] = useState<FlubberBrainConfig>(DEFAULT_BRAIN_CONFIG);

  const liveUsage = useLiveUsage();

  // --- feeders ---------------------------------------------------------------

  // Config fetch (mount + every 60s). Defensive: a half-built /api/brain route
  // leaves the defaults in place instead of throwing.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch('/api/brain');
        if (!res.ok || cancelled) return;
        const data: unknown = await res.json();
        if (cancelled) return;
        setBrainConfig(sanitizeBrainConfig(data));
      } catch {
        /* route not up yet — keep current config */
      }
    };
    load();
    const timer = setInterval(load, BRAIN_CONFIG_REFRESH_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  // Push the resolved config into the global 3D runtime so every live Blubber
  // (energy/movement/personality) updates at once. 0-100 → 0..1.
  useEffect(() => {
    setFlubberRuntime({
      energy: brainConfig.energyLevel / 100,
      movement: brainConfig.movementAmount / 100,
      personality: brainConfig.personalityMode,
      talkativeness: brainConfig.talkativeness / 100,
    });
  }, [brainConfig]);

  // NOTE (LANE G / LAW 1): there is deliberately NO ambient narration or
  // ambient expression-flash timer here. A blind timer must never emit a word
  // or a mood that fakes work. Speech comes ONLY from real events (real
  // terminal reactions below; real session/usage events in SessionProvider);
  // personality now only flavours those REAL events, never generates one.
  // `talkativeness` still feeds the 3D runtime (idle roam/gesture cadence)
  // via setFlubberRuntime above — it just no longer produces narration text.

  // Live token intensity → quantized bucket.
  const intensityBucket = quantizeIntensity(liveUsage.intensity);
  useEffect(() => {
    dispatch({ type: 'SET_INTENSITY', bucket: intensityBucket, now: Date.now() });
  }, [intensityBucket]);

  // Navigation → a brief surprised flash, and reset the idle clock.
  useEffect(() => {
    const now = Date.now();
    dispatch({ type: 'SET_NAV', navId: activeNavId, now });
    dispatch({ type: 'REACT', expression: 'surprised', priority: PRIORITY.AMBIENT, holdMs: 700, source: 'nav', now });
  }, [activeNavId]);

  const speak = useCallback((text: string, source: EventSource = 'user') => {
    const now = Date.now();
    const last = speechCooldownRef.current.get(source) ?? 0;
    if (now - last < SPEECH_COOLDOWN_MS) return;
    speechCooldownRef.current.set(source, now);
    dispatch({ type: 'SPEAK', text, source, now });
  }, []);

  // Cross-screen terminal reactions.
  useEffect(() => {
    return terminalWatcher.subscribe((reaction) => {
      const now = Date.now();
      if (reaction.kind === 'success') {
        dispatch({ type: 'REACT', expression: 'celebrating', priority: PRIORITY.TERMINAL, holdMs: 4000, source: 'terminal', pulse: true, now });
        speak('Build passed! 🎉', 'terminal');
        narrate('Build passed! 🎉', { mood: 'hype' });
      } else if (reaction.kind === 'error') {
        dispatch({ type: 'REACT', expression: 'worried', priority: PRIORITY.TERMINAL, holdMs: 4000, source: 'terminal', now });
        speak('Uh oh, something errored.', 'terminal');
        narrate('Uh oh, something errored.', { mood: 'focused' });
      } else {
        dispatch({ type: 'REACT', expression: 'disappointed', priority: PRIORITY.TERMINAL, holdMs: 4000, source: 'terminal', now });
        narrate('That command exited.', { mood: 'chill' });
      }
    });
  }, [speak]);

  // Pet snapshot (mount + periodic). /api/pet may not exist until Phase 5 —
  // a failed fetch simply leaves petSnapshot null (no baseline pet influence).
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch('/api/pet');
        if (!res.ok || cancelled) return;
        const data = await res.json();
        const needs = data?.needs ?? data;
        if (!needs || typeof needs.hunger !== 'number') return;
        const avg = (needs.hunger + needs.hygiene + needs.fun + needs.energy + needs.love) / 5;
        dispatch({ type: 'SET_PET', snapshot: { ...needs, avg }, now: Date.now() });
      } catch {
        /* pet backend not up yet — ignore */
      }
    };
    load();
    const timer = setInterval(load, PET_REFRESH_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  // --- arbiter: overlay expiry + baseline drift -----------------------------

  // Arm an exact timeout at the current overlay's expiry so its fall-back to
  // baseline lands on time (nav overlay is only 700ms).
  useEffect(() => {
    if (!state.overlay) return;
    const delay = state.overlay.expiresAt - Date.now();
    if (delay <= 0) { bumpTick(); return; }
    const timer = setTimeout(bumpTick, delay + 16);
    return () => clearTimeout(timer);
  }, [state.overlay, bumpTick]);

  // Slow drift tick so idle→tired/sleeping baseline transitions actually fire.
  useEffect(() => {
    const timer = setInterval(bumpTick, BASELINE_DRIFT_TICK_MS);
    return () => clearInterval(timer);
  }, [bumpTick]);

  // Auto-clear a shown speech bubble after its lifetime (roamer displays it;
  // this keeps the brain's speech field from lingering).
  useEffect(() => {
    if (!state.speech) return;
    const timer = setTimeout(() => dispatch({ type: 'CLEAR_SPEECH' }), 5200);
    return () => clearTimeout(timer);
  }, [state.speech]);

  // --- resolved render state (memoized by value) ----------------------------

  const resolved = selectRenderState(state, Date.now());
  const speechId = resolved.speech?.id ?? -1;
  const renderValue = useMemo<BrainRenderState>(
    () => ({ expression: resolved.expression, pulseKey: resolved.pulseKey, speech: resolved.speech }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [resolved.expression, resolved.pulseKey, speechId, nowTick],
  );

  const api = useMemo<BrainApi>(() => ({
    react: (expression, opts) => dispatch({
      type: 'REACT',
      expression,
      priority: opts?.priority ?? PRIORITY.USER,
      holdMs: opts?.holdMs ?? 3000,
      source: opts?.source ?? 'user',
      pulse: opts?.pulse,
      now: Date.now(),
    }),
    pulse: () => dispatch({ type: 'PULSE', now: Date.now() }),
    setMusic: (playing) => dispatch({ type: 'SET_MUSIC', playing, now: Date.now() }),
    setPet: (snapshot) => dispatch({ type: 'SET_PET', snapshot, now: Date.now() }),
    speak,
  }), [speak]);

  return (
    <BrainConfigContext.Provider value={brainConfig}>
      <BrainApiContext.Provider value={api}>
        <BrainStateContext.Provider value={renderValue}>
          <div data-flubber-mood={renderValue.expression} style={{ display: 'contents' }}>
            {children}
          </div>
        </BrainStateContext.Provider>
      </BrainApiContext.Provider>
    </BrainConfigContext.Provider>
  );
}

export function useFlubberBrainState(): BrainRenderState {
  return useContext(BrainStateContext);
}

export function useFlubberBrainApi(): BrainApi {
  return useContext(BrainApiContext);
}

/** The live personality/energy/movement/talkativeness config (GET /api/brain).
 * Additive — existing consumers of the state/api hooks are unaffected. */
export function useFlubberBrainConfig(): FlubberBrainConfig {
  return useContext(BrainConfigContext);
}
