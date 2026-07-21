'use client';

/**
 * MusicVisualizerFlubbers — LANE C. The music screen's visualizer IS the
 * Flubbers, not a bar strip. A small autonomous swarm of shiny MID-tier mini
 * Flubbers self-spawns around the hero DJ and reacts to the REAL Web Audio
 * frequency energy piped down from MusicPlayer (through MusicPlayerScreen's
 * onAudioEnergy / onBeat): they bounce / sway / spin scaled by the loudness
 * envelope, and every detected bass beat launches them harder AND squashes
 * their bodies (pulseKey). The hero DJ's own stage lifts + scales with the
 * same energy via two CSS custom properties written on heroStageRef.
 *
 * SEPARATE SURFACE (LAW 1): this is driven ONLY by whether music is PLAYING.
 * It never clocks in and imports nothing from SessionProvider — it does not
 * read isWorking at all. It goofs whenever a track plays, work or break.
 *
 * DATA SOURCES (all real, zero faking):
 *   - energyRef.current — smoothed 0-1 loudness envelope from MusicPlayer's
 *     AnalyserNode (measured AFTER the EQ chain), read every animation frame.
 *   - beatKey / beatStrength — a real detected bass-drum onset and how hard it
 *     hit relative to the running baseline (~0.5-2.4). beatKey increments per
 *     beat; a launch impulse + body squash fire on each change.
 *   - playing / enabled — engine.isPlaying and the Blubber-Sync toggle. When
 *     either is false the swarm settles and dismisses; nothing is invented.
 *
 * PERF: minis are MID tier (shiny clearcoat goo — wave-1 lane M contract) via
 * Flubber3D tier="mid"; the shared host enforces a global MID budget and
 * overflows extras to MICRO on its own, so this stays safe however many other
 * MID surfaces are co-mounted. Per-frame motion is written straight to DOM
 * refs inside ONE rAF loop (no per-frame React re-render); the component is
 * wrapped in React.memo so it only re-renders on beat / spawn / play-state
 * change (energy arrives via a stable ref, not a prop that ticks each frame).
 * Respects prefers-reduced-motion — no continuous motion, minis stay at rest.
 */

import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
  type RefObject,
} from 'react';
import Flubber3D from '../Flubber3D';
import './MusicVisualizerFlubbers.css';

type Formation = 'bars' | 'wave' | 'radial' | 'pulse';

export interface MusicVisualizerFlubbersProps {
  /** Live smoothed 0-1 loudness envelope. Stable ref so the swarm animates without re-rendering each frame. */
  energyRef: MutableRefObject<number>;
  /** Increments on each detected bass beat — triggers a launch impulse + body squash. */
  beatKey: number;
  /** ~0.5-2.4 strength of the most recent beat, relative to the running bass baseline. */
  beatStrength: number;
  /** engine.isPlaying — the swarm only grows while a track is actually playing. */
  playing: boolean;
  /** Blubber-Sync toggle. Off freezes/dismisses the swarm even mid-track. */
  enabled: boolean;
  /** Which motion the swarm dances in (mirrors the Visualizer Mode selector). */
  formation: Formation;
  /** The hero DJ's stage element — gets energy-driven --mf-hero-lift / --mf-hero-scale. */
  heroStageRef: RefObject<HTMLDivElement>;
}

// Fixed anchor points across the hero floor (left %, bottom %) so minis fan out
// around the DJ without overlapping. Spawn fills a free slot; dismiss frees it.
const SLOTS: { x: number; y: number }[] = [
  { x: 20, y: 15 },
  { x: 80, y: 15 },
  { x: 33, y: 9 },
  { x: 67, y: 9 },
  { x: 9, y: 25 },
  { x: 91, y: 25 },
  { x: 50, y: 6 },
];

const MAX_MINIS = 9; // LANE 5: increased for more life
const MINI_SIZE = 46;
const SPAWN_TICK_MS = 780;
const EXIT_ANIM_MS = 360;

// Energetic vocabulary the minis spawn into (real FlubberExpression values).
const MINI_EXPRESSIONS = ['excited', 'overjoyed', 'celebrating', 'dj-mode', 'happy', 'determined'];

type Phase = 'in' | 'out';

interface Mini {
  id: string;
  seed: number;
  slot: number;
  phase: Phase;
  expr: string;
}

function MusicVisualizerFlubbersImpl({
  energyRef,
  beatKey,
  beatStrength,
  playing,
  enabled,
  formation,
  heroStageRef,
}: MusicVisualizerFlubbersProps) {
  const [minis, setMinis] = useState<Mini[]>([]);

  // Live prop mirrors so the rAF loop + spawn interval always read fresh values
  // without being torn down and rebuilt on every render.
  const playingRef = useRef(playing);
  const enabledRef = useRef(enabled);
  const formationRef = useRef<Formation>(formation);
  playingRef.current = playing;
  enabledRef.current = enabled;
  formationRef.current = formation;

  const motionRefs = useRef<Map<string, { el: HTMLDivElement; phase: number }>>(new Map());
  const rafRef = useRef<number | null>(null);
  const counterRef = useRef(0);
  const energyAvgRef = useRef(0);
  const beatImpulseRef = useRef(0);
  const prevBeatRef = useRef(beatKey);
  const reducedRef = useRef(false);
  const miniClickImpulses = useRef<Map<string, number>>(new Map()); // LANE 5: track click impulses per mini

  useEffect(() => {
    reducedRef.current = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }, []);

  // A real beat lands → fire a decaying launch impulse (bass hits them harder).
  useEffect(() => {
    if (beatKey !== prevBeatRef.current) {
      prevBeatRef.current = beatKey;
      beatImpulseRef.current = Math.min(beatStrength, 2.4);
    }
  }, [beatKey, beatStrength]);

  // ---- one rAF loop drives ALL motion (hero stage + every mini) ----
  useEffect(() => {
    if (reducedRef.current) return;

    const loop = (nowMs: number) => {
      const t = nowMs / 1000;
      const raw = playingRef.current && enabledRef.current ? energyRef.current : 0;
      const e = raw < 0 ? 0 : raw > 1 ? 1 : raw;
      energyAvgRef.current += (e - energyAvgRef.current) * 0.04;

      beatImpulseRef.current *= 0.9;
      if (beatImpulseRef.current < 0.001) beatImpulseRef.current = 0;
      const beat = beatImpulseRef.current;
      const form = formationRef.current;

      const stage = heroStageRef.current;
      if (stage) {
        stage.style.setProperty('--mf-hero-lift', `${(e * 14 + beat * 7).toFixed(1)}px`);
        stage.style.setProperty('--mf-hero-scale', `${(1 + e * 0.05).toFixed(3)}`);
      }

      const jump = e * 26 + beat * 10;
      motionRefs.current.forEach(({ el, phase }, miniId) => {
        const bob = Math.sin(t * 3.1 + phase) * (3 + e * 9);
        let ty = 0;
        let tx = 0;
        let rot = 0;
        let sc = 1 + e * 0.12;

        // LANE 5: apply per-mini click impulse (squash + bounce)
        const clickImp = miniClickImpulses.current.get(miniId as string) || 0;
        if (clickImp > 0) {
          miniClickImpulses.current.set(miniId as string, clickImp * 0.92); // decay
          if (clickImp < 0.001) miniClickImpulses.current.delete(miniId as string);
        }

        switch (form) {
          case 'bars':
            ty = -(jump + Math.abs(bob) + clickImp * 12);
            sc = 1 + e * 0.18 + beat * 0.04 + clickImp * 0.08;
            break;
          case 'wave':
            ty = -(bob + beat * 8 + clickImp * 12);
            tx = Math.sin(t * 1.6 + phase) * (5 + e * 16);
            break;
          case 'radial':
            ty = -(bob + jump * 0.4 + clickImp * 12);
            rot = Math.sin(t * 1.2 + phase) * 18 + ((t * 40 * e) % 360);
            break;
          case 'pulse':
            ty = -(bob * 0.6 + clickImp * 10);
            sc = 1 + e * 0.28 + beat * 0.06 + clickImp * 0.06;
            break;
        }

        el.style.transform = `translateY(${ty.toFixed(1)}px) translateX(${tx.toFixed(1)}px) rotate(${rot.toFixed(1)}deg) scale(${sc.toFixed(3)})`;
      });

      rafRef.current = requestAnimationFrame(loop);
    };

    rafRef.current = requestAnimationFrame(loop);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
    // energyRef / heroStageRef are stable ref objects — intentionally not deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- autonomous spawn / dismiss brain: count scales with the music ----
  useEffect(() => {
    const tick = () => {
      setMinis((prev) => {
        const active = prev.filter((m) => m.phase !== 'out');
        const wantOn = playingRef.current && enabledRef.current;
        const target = wantOn
          ? Math.max(2, Math.min(MAX_MINIS, Math.round(2 + energyAvgRef.current * (MAX_MINIS - 2) * 1.6)))
          : 0;

        if (active.length < target) {
          const used = new Set(active.map((m) => m.slot));
          const freeSlot = SLOTS.findIndex((_, i) => !used.has(i));
          if (freeSlot === -1) return prev;
          const n = counterRef.current++;
          const seed = (n * 131 + 7) % 997;
          const mini: Mini = {
            id: `mvf-${n}`,
            seed,
            slot: freeSlot,
            phase: 'in',
            expr: MINI_EXPRESSIONS[n % MINI_EXPRESSIONS.length],
          };
          return [...prev, mini];
        }

        if (active.length > target) {
          const victim = active[active.length - 1];
          return prev.map((m) => (m.id === victim.id ? { ...m, phase: 'out' } : m));
        }

        return prev;
      });
    };

    const iv = window.setInterval(tick, SPAWN_TICK_MS);
    return () => window.clearInterval(iv);
  }, []);

  // Remove minis once their melt-out animation has had time to play.
  useEffect(() => {
    const timers: number[] = [];
    for (const m of minis) {
      if (m.phase === 'out') {
        const id = window.setTimeout(() => {
          setMinis((prev) => prev.filter((x) => x.id !== m.id));
        }, EXIT_ANIM_MS);
        timers.push(id);
      }
    }
    return () => timers.forEach((id) => window.clearTimeout(id));
  }, [minis]);

  // Reset the hero stage's motion vars if this unmounts mid-lift (nav away).
  useEffect(() => {
    const stage = heroStageRef.current;
    return () => {
      if (stage) {
        stage.style.removeProperty('--mf-hero-lift');
        stage.style.removeProperty('--mf-hero-scale');
      }
    };
  }, [heroStageRef]);

  const registerBody = useCallback(
    (id: string, seed: number) => (el: HTMLDivElement | null) => {
      if (el) {
        motionRefs.current.set(id, { el, phase: (seed % 628) / 100 });
        // LANE 5: attach click handler for bounce/squash
        el.style.cursor = 'pointer';
        el.onclick = (e) => {
          e.stopPropagation();
          miniClickImpulses.current.set(id, 1.8);
        };
      } else {
        motionRefs.current.delete(id);
        miniClickImpulses.current.delete(id);
      }
    },
    []
  );

  // LANE 5: handle click impulses that decay over time
  const handleMiniClick = useCallback((id: string) => {
    if (!reducedRef.current) {
      miniClickImpulses.current.set(id, 1.8);
    }
  }, []);

  return (
    <div className="mvf" aria-hidden="true">
      {/* LANE 5: slime dripping from ceiling */}
      <div className="mvf-slime-drips">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={`drip-${i}`} className="mvf-slime-drop" />
        ))}
      </div>

      {minis.map((m) => (
        <div
          key={m.id}
          className={`mvf-mini mvf-mini--${m.phase}`}
          style={{ left: `${SLOTS[m.slot].x}%`, bottom: `${SLOTS[m.slot].y}%` }}
        >
          <div className="mvf-mini__body" ref={registerBody(m.id, m.seed)}>
            <Flubber3D tier="mid" size={MINI_SIZE} expression={m.expr} seed={m.seed} pulseKey={beatKey} />
          </div>
        </div>
      ))}
    </div>
  );
}

const MusicVisualizerFlubbers = memo(MusicVisualizerFlubbersImpl);
export default MusicVisualizerFlubbers;
