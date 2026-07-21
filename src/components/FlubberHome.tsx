'use client';

/**
 * FlubberHome — the room Blubber actually lives in, and his dynamic workspace.
 *
 * Dame's vision: Blubber is the Claude Code agent with a skin on, so his home
 * should visibly DO whatever the agent is doing. This composes:
 *   1. a photographic server-lab backdrop (public/bg/lab.png — it already has a
 *      central glowing dais the hero stands on),
 *   2. a mood grade + glowing dais ring that recolour/energise with the current
 *      activity (--fh-hue / --fh-energy, interpolated via @property),
 *   3. a cheap 2D-canvas layer of rising goo bubbles (no extra WebGL context —
 *      the shared FlubberHost owns the only one),
 *   4. the hero Blubber (shared-WebGL, transparent) standing on the dais,
 *   5. floating holographic work-panels (HoloPanel) that materialise around him
 *      and MORPH when the activity changes — code, terminal, web search, plan
 *      graph, doc, tests, design, files, gears. This is the visual narration of
 *      "what Claude is doing right now."
 *
 * Activity source (LAW 1 — real signals only): an explicit `activity` prop when
 * the caller knows, else FlubberHome's OWN real-event read — the latest genuine
 * tool invocation from /api/recent (mapped via activityFromRealEvent), polled
 * only while the real work clock is running. A brain expression / mood is NEVER
 * routed into activity: it drives the mascot's face alone. So a stray mood flash
 * can never open a work panel — only real work does.
 *
 * `children` render in an overlay above the dais — that's where a spawn's mini
 * "crew" flubbers fly out to. `stageRef` forwards the stage node so the Agents
 * spawn choreography can originate from the hero.
 *
 * IDLE LIFE (opt-in via `idleLife`, dashboard-life lane): while the resolved
 * activity is 'idle', an autonomous scheduler (pickIdleLifeStep, pure data in
 * flubber-activity.ts) cycles the hero through vibe/eat/shower/nap beats with
 * randomized natural pauses — never a fixed loop. Eat/shower reuse the Virtual
 * Pet's CarePayoffs burst visuals (imported, not modified); nap holds a
 * 'sleeping' expression override on top of whatever the brain would otherwise
 * show, then hands control back. The instant real activity arrives (active
 * !== 'idle'), the scheduler's effect tears down and the existing work
 * choreography (holo panels, above) takes over — idle life never fights it.
 * Off by default so AgentsScreen's FlubberHome usage is unaffected.
 *
 * WORK CLOCK GATE (LANE W / LAW 1): the holo panels are the "work-screens" and
 * they now render ONLY while the real work clock is running. `isWorking` is the
 * SessionProvider's ONE formal work/break latch (true only while a real task runs
 * — live tokens / active PTY / spawned agents). Off the clock (app open / idle)
 * there are ZERO panels — the hero just does its idle life — which kills the old
 * mount 'surprised'→'thinking' mockup flash at the source (panels no longer gate
 * on brain activity, they gate on the clock). On the clock the panels map to the
 * REAL activity; on the clock with no specific brain read yet the room resolves to
 * a SINGLE honest 'terminal' work-screen (never a fabricated "writing code"/graph
 * task) so the owner can SEE him working. While the clock is on the idle-life
 * scheduler also halts and the room grade + face hold the sustained WORK_AMBIENT
 * working read. Off/undefined = the exact prior AgentsScreen behavior.
 *
 * INTERACTIVE (opt-in via `interactive`, dashboard hero only): the hero stops
 * being pinned to the dais and becomes a grab/drag/throw toy that free-roams its
 * stage, reusing the Virtual Pet's physics hook (usePetToss) verbatim — wander,
 * fling with gravity + wall bounce + squash, ease-home. Grab/land/tap flash a
 * short face reaction. Reduced-motion → rests centred, no roam. Off by default so
 * AgentsScreen (interactive=false) is byte-for-byte unchanged.
 *
 * PLAYMATE (opt-in via `onPlaymateReady`, LANE 5 — real pool→hero playtime,
 * docs/plans/pill-worlds-mini-dash.md): hands the caller an imperative
 * `enter(seed)` that spawns a temporary mid-tier mini on THIS stage — it wanders
 * near the dais and lands a couple of playful bounce beats (the hero pulses a
 * heart-eyes/celebrating reaction each time, reusing the same `flashTossReaction`
 * the interactive toy uses) for a real ~15s visit, then hops down and reports
 * back via `onPlaymateExit(seed)` so the caller (AgentsScreen) can arc the same
 * clone back to the pool via HandoffOverlay and restore it there. If the real
 * work clock (`isWorking`) starts mid-visit, the visit ends immediately (LAW 1 —
 * pool play is break-only). AgentsScreen-only; the handle is never handed a
 * seed anywhere else, so this is fully inert by default.
 *
 * HERO PRESENCE + HERO ENERGY LAYER (Lane D, 2026-07-19, dashboard hero only):
 * the compact/dashboard hero stage-share is bumped (see the HERO_STAGE_*
 * constants below) and the HERO material's env/rim lighting is brightened in
 * flubber3d/materials.ts (createGooMaterial only — MID/MICRO untouched) so the
 * focal mascot reads bigger/brighter. Separately, an OPTIONAL `energy` prop
 * (0..1) is meant to carry the REAL live token-burn-rate (tok/min) — never a
 * fabricated driver (LAW 1) — and modulates three purely additive, `compact`-
 * gated effects layered on top of the existing idleLife/CSS-breathe baseline:
 * a sparse (<=HERO_ENERGY_MOTE_COUNT) set of hero-stage motes, one slow
 * ambient "lighting drift" glow, and extra breathing depth/speed applied to
 * the `.fh__dais` WRAPPER (the CSS keyframes already own the core/ring
 * CHILDREN, so this composes instead of fighting them). All three live inside
 * the existing goo-bubbles canvas effect below and are pinned static the
 * instant reduced-motion is live. The actual live energy number is wired in by
 * the Integration phase (DashboardScreen owns that one-line hookup) — this
 * component only needs to react correctly to whatever arrives.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
  type Ref,
} from 'react';
import { gsap } from 'gsap';
import Flubber3D from './Flubber3D';
import HoloPanel from './HoloPanel';
import CarePayoffs, { type CarePayoffsHandle } from './pet/CarePayoffs';
import { usePetToss } from './pet/usePetToss';
import type { FlubberSlotHandle } from '../lib/flubber3d/host';
import {
  activityFromRealEvent,
  pickIdleLifeStep,
  specFor,
  WORK_AMBIENT,
  type FlubberActivity,
} from '../lib/flubber-activity';
import './FlubberHome.css';

/** LANE 5 playtime capability — see the PLAYMATE header comment above. */
export interface FlubberPlaymateHandle {
  /** Start the temporary mini's ~15s stage visit. No-ops if one is already
   *  active (one playmate at a time). */
  enter(seed: number): void;
}

export interface FlubberHomeProps {
  /** Explicit REAL activity (from a real agent/tool event). When omitted,
   * FlubberHome derives the activity from its OWN real-event read (/api/recent
   * while the work clock is on) — NEVER from `expression`/mood (LAW 1: a mood
   * flash must never open a work panel). */
  activity?: FlubberActivity;
  /** Brain expression — drives ONLY the mascot's face, never the activity or
   * work-panels. */
  expression?: string;
  /** Optional speech line — shown near the hero's head ONLY when it's real
   * (real brain speech / a real UI hint). Null/undefined ⇒ no bubble at all. */
  speech?: string | null;
  /** Backdrop plate. 'lab' has the built-in dais (default). */
  backdrop?:
    | 'lab'
    | 'serverlab'
    | 'home'
    | 'agents'
    | 'terminal'
    | 'projects'
    | 'memory'
    | 'analytics'
    | 'studio'
    | 'pet'
    | 'engine';
  /** One-shot hero squash pulse passthrough. */
  pulseKey?: number;
  /** Hero slot handle (spawn choreography origin). */
  onHeroSlotReady?: (handle: FlubberSlotHandle | null) => void;
  /** Forwarded to the stage element (spawn choreography attaches here). */
  stageRef?: Ref<HTMLDivElement>;
  /** Overlay content above the dais — the spawn crew flies out here. */
  children?: ReactNode;
  /** Compact variant (dashboard hero): smaller mascot, panels may hide on narrow. */
  compact?: boolean;
  /** Opt-in autonomous idle life (dashboard only — see file header). Runs only
   * while the resolved activity is 'idle'; yields immediately to real work. */
  idleLife?: boolean;
  /** SessionProvider's latched work/break clock (LAW 1). When true, idle life
   * halts and the room holds a sustained "working" read even if the brain has
   * momentarily gone idle. Undefined/false = prior behavior (AgentsScreen). */
  isWorking?: boolean;
  /** Opt-in free-roam (dashboard hero only). When true the hero unpins from the
   * dais and becomes a grab/drag/throw toy roaming its stage (reuses the Virtual
   * Pet's usePetToss physics). Default false = pinned, non-interactive (Agents). */
  interactive?: boolean;
  /** Opt-in pool→hero playtime (LANE 5, AgentsScreen only). Hands the caller an
   * imperative `enter(seed)` — see the PLAYMATE header comment above. Null on
   * unmount, matching the onHeroSlotReady/onControlsReady callback-ref pattern
   * used elsewhere in this codebase. */
  onPlaymateReady?: (handle: FlubberPlaymateHandle | null) => void;
  /** Fired once the playmate's own visit timer ends and its hop-down beat has
   * played — echoes the seed passed to enter() so the caller arcs the SAME
   * clone back out. */
  onPlaymateExit?: (seed: number) => void;
  /** LANE D — real live token-burn-rate signal (tok/min), normalized 0..1.
   * Optional; defaults to 0 (idle) when the caller doesn't supply one. This is
   * NOT a mood/activity read — it's meant to be derived from the same real
   * live-usage stream AmbientGlow already subscribes to (useLiveUsage), so the
   * room's extra "aliveness" traces to genuine work, never a fabricated
   * animation driver (LAW 1). Drives the hero energy layer: dais breathing
   * depth/speed, a touch of ambient lighting drift, and a sparse set of
   * hero-stage-only motes — see the HERO ENERGY LAYER header comment above.
   * The Integration phase wires the real value in from DashboardScreen; this
   * prop just needs to exist and react correctly to whatever number arrives. */
  energy?: number;
  /** Opt-in: hides the bottom-left activity status chip (.fh__status). Default
   * false = prior behaviour (Dashboard hero, Virtual Pet). AgentsScreen sets
   * this true so the hero has exactly ONE bubble on screen — the top-anchored
   * .fh__speech — instead of a second, always-on bottom-left chip that read
   * as a competing "canned" bubble (see docs/plans/booger-eradication). */
  hideStatusChip?: boolean;
  className?: string;
}

const HERO_MIN = 150;
const HERO_MAX = 300;
/** Lane D — hero presence: the dashboard's compact hero stage-share, bumped
 * off its prior 0.34 (width) / 0.62 (height) fractions. The dashboard-hero
 * band is genuinely short — DashboardScreen.css clamps `.dashboard-hero` to
 * ~9.5-11rem (~152-176px) tall — so the OLD 0.62 height fraction always lost
 * to the HERO_MIN floor (152-176 * 0.62 = 94-109px, always < 150) and the
 * mascot rendered at a flat 150px no matter the viewport. A flat "+15-20%"
 * bump to a fixed ~172-180px would risk clipping the mascot's head against
 * the room's `overflow:hidden` edge at the narrow end of that clamp. These
 * fractions instead stay RESPONSIVE to the real measured stage box: at the
 * clamp's narrow ~152px end they still land under HERO_MIN (no change, no
 * clipping risk — identical to today), and at its common ~176px ceiling (most
 * real desktop widths, since the vw-term maxes out above ~1200px) they land
 * around ~167px, roughly +11% over the old flat 150px — the largest safe,
 * responsive gain this specific container can take. AgentsScreen's non-compact
 * 0.4/0.72 fractions are untouched.
 */
const HERO_STAGE_WIDTH_FRACTION_COMPACT = 0.4;
const HERO_STAGE_HEIGHT_FRACTION_COMPACT = 0.95;
/** Lane D — hero energy layer tuning (dashboard hero / `compact` only). See
 * the HERO ENERGY LAYER header comment above and the goo-bubbles effect below. */
const HERO_ENERGY_MOTE_COUNT = 12;
const HERO_ENERGY_BREATH_PERIOD_S = 5; // matches the CSS fh-breathe baseline period
const HERO_ENERGY_BREATH_SPEEDUP_S = 1.6; // breathing can run up to this much faster at energy=1
const HERO_ENERGY_BREATH_DEPTH_BASE = 0.012; // non-zero at energy=0 — layers on, never dead-still
const HERO_ENERGY_BREATH_DEPTH_MAX = 0.05; // additional depth at energy=1
/** Real-event activity poll (see the real-activity effect below) — how often
 * /api/recent is checked while the work clock is on, and how recent a tool event
 * must be to still count as "what he's doing right now" (older than this and the
 * room falls back to the honest generic work-screen instead of a stale claim). */
const REAL_EVENT_POLL_MS = 6000;
const REAL_EVENT_FRESH_MS = 5 * 60 * 1000;
/** LANE 5 playmate — how long a stage visit lasts under full motion, and how
 * big the temporary mini renders (mid tier, same as a pool resident's tier). */
const PLAYMATE_DURATION_MS = 15_000;
const PLAYMATE_REDUCED_DURATION_MS = 6000;
const PLAYMATE_SIZE = 64;
/** Item 2 — how long work-panels linger after `isWorking` dips, so a single
 * debounce-tick blip never unmounts them mid-work. */
const PANEL_HYSTERESIS_MS = 4000;

/** Inclusive-ish random ms in [min, max) — used to space out idle life's first
 * beat so it never fires the instant idleness starts. */
function randomBetween(min: number, max: number): number {
  return Math.round(min + Math.random() * (max - min));
}

interface HeroPlaymateProps {
  seed: number;
  stageRef: MutableRefObject<HTMLDivElement | null>;
  isWorking: boolean;
  reducedMotion: boolean;
  flashHeroReaction: (expr: string, ms: number) => void;
  onExit: (seed: number) => void;
}

/** One pool→hero playmate: a temporary mid-tier mini that hops onto the shared
 * stage, wanders + trades a couple of playful beats with the hero, then hops
 * back out and reports via onExit(seed). Extracted from FlubberHome so N can run
 * concurrently (Item 5), each with its own element + refs + choreography effect.
 * LAW 1: real work starting mid-visit fades it out immediately. */
function HeroPlaymate({ seed, stageRef, isWorking, reducedMotion, flashHeroReaction, onExit }: HeroPlaymateProps) {
  const elRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<FlubberSlotHandle | null>(null);
  const exitingRef = useRef(false);
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;
  const flashRef = useRef(flashHeroReaction);
  flashRef.current = flashHeroReaction;

  useEffect(() => {
    // LAW 1: real work starting mid-visit ends it immediately — quick fade.
    if (isWorking) {
      const node = elRef.current;
      if (!node) {
        onExitRef.current(seed);
        return;
      }
      const fadeTween = gsap.to(node, {
        opacity: 0,
        duration: 0.22,
        ease: 'power1.in',
        onComplete: () => onExitRef.current(seed),
      });
      return () => {
        fadeTween.kill();
      };
    }

    const stage = stageRef.current;
    const node = elRef.current;
    if (!stage || !node) return;

    const rect = stage.getBoundingClientRect();
    const anchorX = rect.width * 0.64;
    const anchorY = rect.height * 0.82;
    const boundX = Math.max(28, rect.width * 0.2);
    const boundY = Math.max(20, rect.height * 0.12);
    const half = PLAYMATE_SIZE / 2;
    // Spread concurrent playmates so several don't stack on the same anchor.
    const spread = (Math.random() * 2 - 1) * boundX;

    const proxy = { ox: spread, oy: 0, scale: 1 };
    const paint = () => {
      node.style.transform = `translate3d(${(anchorX + proxy.ox - half).toFixed(1)}px, ${(anchorY + proxy.oy - half).toFixed(1)}px, 0) scale(${proxy.scale.toFixed(3)})`;
    };
    paint();
    node.style.opacity = '0';
    const enterTween = gsap.to(node, { opacity: 1, duration: 0.28, ease: 'power1.out' });

    handleRef.current?.setExpression('happy');
    flashRef.current('heart-eyes', 1400);

    let cancelled = false;
    let activeTween: gsap.core.Tween | null = null;
    const timers: ReturnType<typeof setTimeout>[] = [];

    const finishExit = () => {
      if (cancelled) return;
      cancelled = true;
      onExitRef.current(seed);
    };

    const runExit = () => {
      if (exitingRef.current) return;
      exitingRef.current = true;
      activeTween?.kill();
      handleRef.current?.playGesture('hop');
      if (reducedMotion) {
        finishExit();
        return;
      }
      gsap.to(proxy, {
        oy: proxy.oy + 16,
        scale: 0.6,
        duration: 0.3,
        ease: 'power2.in',
        onUpdate: paint,
        onComplete: finishExit,
      });
    };

    if (reducedMotion) {
      timers.push(setTimeout(runExit, PLAYMATE_REDUCED_DURATION_MS));
    } else {
      const pickOffset = () => ({
        ox: (Math.random() * 2 - 1) * boundX,
        oy: (Math.random() * 2 - 1) * boundY,
      });

      const wanderStep = () => {
        if (cancelled || exitingRef.current) return;
        const t = pickOffset();
        activeTween = gsap.to(proxy, {
          ox: t.ox,
          oy: t.oy,
          duration: 1 + Math.random() * 0.7,
          ease: 'sine.inOut',
          onUpdate: paint,
          onComplete: () => {
            if (cancelled || exitingRef.current) return;
            timers.push(setTimeout(wanderStep, 300 + Math.random() * 500));
          },
        });
      };
      wanderStep();

      // A couple of playful beats mid-visit: the mini bounces in near the hero
      // and the hero pulses a warm reaction back — "they mess around together".
      const playBeat = () => {
        if (cancelled || exitingRef.current) return;
        activeTween?.kill();
        handleRef.current?.playGesture('bounce');
        flashRef.current('celebrating', 1000);
        activeTween = gsap.to(proxy, {
          ox: 0,
          oy: -boundY * 0.3,
          scale: 1.1,
          duration: 0.38,
          ease: 'back.out(2)',
          onUpdate: paint,
          onComplete: () => {
            if (cancelled || exitingRef.current) return;
            gsap.to(proxy, { scale: 1, duration: 0.2, onUpdate: paint });
            wanderStep();
          },
        });
      };
      timers.push(setTimeout(playBeat, 4200 + Math.random() * 1400));
      timers.push(setTimeout(playBeat, 9000 + Math.random() * 1400));
      timers.push(setTimeout(runExit, PLAYMATE_DURATION_MS));
    }

    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
      activeTween?.kill();
      enterTween.kill();
      gsap.killTweensOf(proxy);
      gsap.killTweensOf(node);
    };
    // reducedMotion/flashHeroReaction read fresh via refs; isWorking IS a real
    // dep — it triggers the LAW 1 early-exit branch above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isWorking]);

  return (
    <div ref={elRef} className="fh__playmate" aria-hidden="true">
      <Flubber3D
        expression="happy"
        size={PLAYMATE_SIZE}
        tier="mid"
        seed={seed}
        onSlotReady={(handle) => {
          handleRef.current = handle;
        }}
      />
    </div>
  );
}

export default function FlubberHome({
  activity,
  expression = 'idle',
  speech,
  backdrop = 'lab',
  pulseKey,
  onHeroSlotReady,
  stageRef,
  children,
  compact,
  idleLife = false,
  isWorking = false,
  interactive = false,
  onPlaymateReady,
  onPlaymateExit,
  energy = 0,
  hideStatusChip = false,
  className,
}: FlubberHomeProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const localStageRef = useRef<HTMLDivElement | null>(null);
  const bubbleCanvasRef = useRef<HTMLCanvasElement | null>(null);
  // Idle life plumbing: the live slot handle (for playGesture), the hero/dais
  // DOM nodes (CarePayoffs needs real bounding rects to arc/rain from), the
  // payoff burst API, and a one-shot expression override for naps (layered on
  // top of whatever the brain would otherwise show, then released).
  const heroSlotHandleRef = useRef<FlubberSlotHandle | null>(null);
  const heroElRef = useRef<HTMLDivElement | null>(null);
  const daisElRef = useRef<HTMLDivElement | null>(null);
  const carePayoffsRef = useRef<CarePayoffsHandle | null>(null);
  const [idleOverrideExpression, setIdleOverrideExpression] = useState<string | null>(null);
  // Short-lived face reaction fired by interactive grab/land/tap — layers over
  // whatever the room would otherwise show (see displayExpression below).
  const [tossReaction, setTossReaction] = useState<string | null>(null);
  const [reducedMotion, setReducedMotion] = useState(false);
  // Lane D — hero energy layer: the real `energy` prop (LAW 1) and the live
  // reducedMotion state, mirrored into refs so the goo-bubbles rAF loop below
  // can read the latest values every frame without restarting the effect.
  const energyRef = useRef(0);
  useEffect(() => {
    energyRef.current = Number.isFinite(energy) ? Math.max(0, Math.min(1, energy)) : 0;
  }, [energy]);
  const reducedMotionRef = useRef(false);
  useEffect(() => {
    reducedMotionRef.current = reducedMotion;
  }, [reducedMotion]);
  // First-paint gate: false on the very first render, flipped true after mount.
  // Holo work-panels never render until this is true, so navigating INTO the
  // dashboard/agents can't flash a panel before real state settles — a genuine
  // work panel simply appears a frame later. Consumed by `showPanels` below.
  const [hasMounted, setHasMounted] = useState(false);
  // Real-event activity (LAW 1): the latest genuine tool invocation, mapped via
  // activityFromRealEvent — the ONLY derived source allowed to pick a work-
  // screen. Null when off the clock or no fresh real event. Populated by the
  // effect below; a brain expression/mood is deliberately never an input here.
  const [realActivity, setRealActivity] = useState<FlubberActivity | null>(null);

  // Resolve the activity: an explicit real `activity` prop wins, else this
  // component's own real-event read, else idle. Expression/mood is NEVER
  // consulted for activity (that would let a stray mood flash open a work
  // panel). Panels are keyed by activity so React remounts them on change; each
  // panel plays its own CSS enter animation — no shared-layer opacity tween that
  // could get stuck at 0 when interrupted.
  const resolvedActive = activity ?? realActivity ?? 'idle';
  // WORK CLOCK yield (LAW 1) — NEVER FAKE A SPECIFIC TASK: `isWorking` is a REAL
  // SessionProvider latch, but it is NOT a real *activity* read — it doesn't say
  // WHAT the task is. So the clock alone must never fabricate a "writing code"/
  // graph/"thinking it through" screen. When the clock is on but the resolved read
  // is idle (`forcedWork`), `active` STAYS 'idle' — that keeps the status chip
  // honest ("Working", not a claimed task) and the speech bubble quiet — while the
  // grade + face hold the sustained WORK_AMBIENT working read AND the panel block
  // (below) resolves a SINGLE honest 'terminal' work-screen so the owner can SEE
  // him working. A real non-idle read (an explicit `activity` prop, or a fresh
  // real tool event via realActivity) makes `active` that read and brings its
  // real panels — mood is never a source here.
  const forcedWork = isWorking && resolvedActive === 'idle';
  const active = resolvedActive;
  const spec = specFor(active);
  // Mascot face: while forced onto the clock, wear the neutral WORK_AMBIENT
  // working face (not a task-specific one). Otherwise the prior rule — an explicit
  // non-idle brain expression wins (a real 'celebrating' still shows even
  // mid-activity), and a bare 'idle' lets the activity's own face show.
  const heroExpression = forcedWork
    ? WORK_AMBIENT.expression
    : expression && expression !== 'idle'
      ? expression
      : spec.expression;
  // A nap beat layers a held 'sleeping' face on top of whatever the brain/
  // activity would otherwise render, without touching the real `expression`
  // prop — releasing it (setIdleOverrideExpression(null)) hands control
  // straight back to heroExpression. A momentary interactive grab/throw/pet
  // reaction (tossReaction) wins over everything for its short hold.
  const displayExpression = tossReaction ?? idleOverrideExpression ?? heroExpression;

  const [heroSize, setHeroSize] = useState(compact ? 190 : 240);

  // ── hero framing: size the mascot to the stage ──────────────────────────
  useEffect(() => {
    const stage = localStageRef.current;
    if (!stage || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (!box) return;
      const base = Math.min(
        box.width * (compact ? HERO_STAGE_WIDTH_FRACTION_COMPACT : 0.4),
        box.height * (compact ? HERO_STAGE_HEIGHT_FRACTION_COMPACT : 0.72),
      );
      setHeroSize(Math.round(Math.max(HERO_MIN, Math.min(HERO_MAX, base))));
    });
    ro.observe(stage);
    return () => ro.disconnect();
  }, [compact]);

  // ── goo bubbles + hero energy layer: cheap 2D-canvas atmosphere ──────────
  // Base goo bubbles (unchanged) scale with the room's ACTIVITY energy
  // (spec.energy/data-energy — the mood signal). The hero energy layer below
  // is a SEPARATE, additive set of effects gated to `compact` (dashboard hero
  // only) and keyed on the real `energy` PROP (live token-burn-rate, LAW 1) —
  // it never feeds into or replaces the activity-driven bubble density/hue.
  // See the HERO ENERGY LAYER header comment at the top of this file.
  useEffect(() => {
    const canvas = bubbleCanvasRef.current;
    if (!canvas) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let width = 0;
    let height = 0;
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
    ro?.observe(canvas);

    interface B { x: number; y: number; r: number; vy: number; drift: number; phase: number; alpha: number; }
    const bubbles: B[] = [];
    const spawn = (atBottom: boolean): B => ({
      x: Math.random() * width,
      y: atBottom ? height + Math.random() * 40 : Math.random() * height,
      r: 2 + Math.random() * 6,
      vy: 8 + Math.random() * 22,
      drift: (Math.random() - 0.5) * 14,
      phase: Math.random() * Math.PI * 2,
      alpha: 0.12 + Math.random() * 0.3,
    });

    // Hero energy motes (compact/dashboard-hero only) — sparse, soft, capped
    // at HERO_ENERGY_MOTE_COUNT. Lazily grown inside tick() the same way
    // `bubbles` grows to its target, so an empty array costs nothing when
    // `compact` is false (AgentsScreen never touches this branch).
    interface EnergyMote { x: number; y: number; r: number; phase: number; seed: number; }
    const energyMotes: EnergyMote[] = [];
    const spawnEnergyMote = (): EnergyMote => ({
      x: Math.random() * width,
      y: height * (0.15 + Math.random() * 0.7),
      r: 8 + Math.random() * 14,
      phase: Math.random() * Math.PI * 2,
      seed: Math.random() * Math.PI * 2,
    });
    const dais = daisElRef.current;

    let raf = 0;
    let last = performance.now();
    let hue = spec.hue;
    let energy = spec.energy;
    let burnEnergy = energyRef.current;
    // read the live target each frame from data-* so morphs are smooth
    const readTargets = () => {
      const root = rootRef.current;
      if (!root) return;
      const h = Number(root.dataset.hue);
      const e = Number(root.dataset.energy);
      if (!Number.isNaN(h)) hue += (h - hue) * 0.05;
      if (!Number.isNaN(e)) energy += (e - energy) * 0.05;
    };

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      readTargets();
      burnEnergy += (energyRef.current - burnEnergy) * 0.04;
      const target = Math.round(8 + energy * 34);
      while (bubbles.length < target) bubbles.push(spawn(bubbles.length > 0));
      if (bubbles.length > target) bubbles.length = target;

      ctx.clearRect(0, 0, width, height);
      for (const b of bubbles) {
        b.y -= b.vy * dt * (0.5 + energy);
        b.phase += dt * 1.6;
        const x = b.x + Math.sin(b.phase) * b.drift * dt * 6;
        if (b.y + b.r < 0) {
          Object.assign(b, spawn(true));
          continue;
        }
        const fade = b.y < height * 0.16 ? Math.max(0, b.y / (height * 0.16)) : 1;
        ctx.beginPath();
        ctx.arc(x, b.y, b.r, 0, Math.PI * 2);
        ctx.fillStyle = `hsla(${hue}, 90%, 62%, ${b.alpha * fade})`;
        ctx.fill();
        // wet highlight
        ctx.beginPath();
        ctx.arc(x - b.r * 0.3, b.y - b.r * 0.35, b.r * 0.32, 0, Math.PI * 2);
        ctx.fillStyle = `hsla(${hue}, 100%, 88%, ${b.alpha * fade * 1.3})`;
        ctx.fill();
      }

      // ── hero energy layer (dashboard hero / compact only) ────────────────
      if (compact) {
        const heroReduced = reducedMotionRef.current;

        if (!heroReduced) {
          // sparse motes — drift more, glow brighter, with real burn energy.
          while (energyMotes.length < HERO_ENERGY_MOTE_COUNT) energyMotes.push(spawnEnergyMote());
          const moteT = now * 0.00028;
          for (const m of energyMotes) {
            const dx = Math.sin(moteT * 1.3 + m.seed) * (5 + burnEnergy * 20);
            const dy = Math.cos(moteT * 1.05 + m.seed * 1.4) * (4 + burnEnergy * 14);
            const pulse = 0.6 + 0.4 * Math.sin(m.phase + now * 0.0012 + m.seed);
            const alpha = (0.035 + burnEnergy * 0.16) * pulse;
            if (alpha <= 0.002) continue;
            ctx.beginPath();
            ctx.arc(m.x + dx, m.y + dy, m.r * (0.85 + burnEnergy * 0.25), 0, Math.PI * 2);
            ctx.fillStyle = `hsla(${hue}, 92%, 74%, ${alpha.toFixed(3)})`;
            ctx.fill();
          }

          // one slow, soft ambient-lighting drift glow — brighter/faster with
          // real burn energy, never a hard-edged shape (transform+opacity only:
          // position and alpha are the sole things that move here).
          const driftT = now * 0.00009;
          const driftX = width * (0.5 + Math.sin(driftT) * 0.22);
          const driftY = height * (0.42 + Math.cos(driftT * 0.8) * 0.16);
          const driftR = Math.max(width, height) * (0.32 + burnEnergy * 0.1);
          const driftAlpha = 0.025 + burnEnergy * 0.05;
          const glow = ctx.createRadialGradient(driftX, driftY, 0, driftX, driftY, driftR);
          glow.addColorStop(0, `hsla(${hue}, 90%, 70%, ${driftAlpha.toFixed(3)})`);
          glow.addColorStop(1, `hsla(${hue}, 90%, 70%, 0)`);
          ctx.fillStyle = glow;
          ctx.fillRect(0, 0, width, height);
        }

        // dais breathing depth/speed — an ADDITIONAL scale on the `.fh__dais`
        // WRAPPER (the CSS keyframes already own the core/ring CHILDREN via
        // fh-breathe/fh-breathe-ring), so this composes instead of fighting
        // them. Non-zero base depth/period even at energy=0 (layers on top of
        // the existing baseline, never replaces it — LAW 1 ambient-life ask).
        // Pinned to the plain static CSS transform under reduced motion.
        if (dais) {
          if (heroReduced) {
            dais.style.transform = '';
          } else {
            const period = Math.max(
              HERO_ENERGY_BREATH_PERIOD_S - burnEnergy * HERO_ENERGY_BREATH_SPEEDUP_S,
              1.5,
            );
            const depth = HERO_ENERGY_BREATH_DEPTH_BASE + burnEnergy * HERO_ENERGY_BREATH_DEPTH_MAX;
            const s = 1 + Math.sin((now / 1000) * ((Math.PI * 2) / period)) * depth;
            dais.style.transform = `translateX(-50%) scale(${s.toFixed(4)})`;
          }
        }
      }
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      ro?.disconnect();
      if (dais) dais.style.transform = '';
    };
    // spec.hue/energy captured as initial only; live values tracked via data-*.
    // energyRef/reducedMotionRef are refs — read fresh every frame, no dep needed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compact]);

  // ── reduced motion: tracked as state (not a one-off read) because idle life
  // below needs to react if the OS-level preference flips mid-session ───────
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReducedMotion(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setReducedMotion(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // Mark mounted after the first paint — work-panels stay hidden until then so no
  // fake/transient panel can flash on mount or on nav into the screen.
  useEffect(() => {
    setHasMounted(true);
  }, []);

  // ── real-event activity: the ONLY derived work-screen source (LAW 1) ──────
  // Poll /api/recent for the latest genuine tool invocation ONLY while the real
  // work clock is on AND the caller isn't already supplying an explicit real
  // `activity` (AgentsScreen does; the dashboard hero doesn't) — off the clock,
  // or when the read would be unused, there is no fetch and no derived activity.
  // A tool event older than REAL_EVENT_FRESH_MS is ignored so an earlier run
  // can't drive the current panel; the room then falls back to the honest
  // generic 'terminal' work-screen (forcedWork below). Expression is never
  // consulted here.
  useEffect(() => {
    if (!isWorking || activity !== undefined) {
      setRealActivity(null);
      return;
    }
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch('/api/recent?limit=1');
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as {
          events?: Array<{ toolName?: string | null; category?: 'skill' | 'agent' | null; ts?: string }>;
        };
        if (cancelled) return;
        const evt = data.events?.[0];
        if (!evt) {
          setRealActivity(null);
          return;
        }
        const age = evt.ts ? Date.now() - Date.parse(evt.ts) : Number.POSITIVE_INFINITY;
        const fresh = Number.isFinite(age) && age <= REAL_EVENT_FRESH_MS;
        setRealActivity(
          fresh ? activityFromRealEvent({ toolName: evt.toolName ?? null, category: evt.category ?? null }) : null,
        );
      } catch {
        /* transient — keep the last real read */
      }
    };
    poll();
    const id = setInterval(poll, REAL_EVENT_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [isWorking, activity]);

  // Wraps the hero slot handle so idle life can drive gestures directly while
  // still forwarding the real handle to whatever the caller passed in
  // (spawn choreography's onHeroSlotReady on the Agents screen, etc).
  const onHeroSlotReadyRef = useRef(onHeroSlotReady);
  onHeroSlotReadyRef.current = onHeroSlotReady;
  const handleHeroSlotReady = useCallback((handle: FlubberSlotHandle | null) => {
    heroSlotHandleRef.current = handle;
    onHeroSlotReadyRef.current?.(handle);
  }, []);

  // ── idle life: autonomous vibe/eat/shower/nap scheduler (dashboard only) ──
  // Only runs while idleLife is on, the resolved activity is genuinely 'idle',
  // AND the work clock is NOT running (LAW 1) — the instant real work arrives
  // (active flips away from 'idle', or isWorking latches true) this effect's
  // cleanup fires and idle life stops touching the hero at all, so it can never
  // fight the real work choreography above.
  useEffect(() => {
    if (!idleLife || active !== 'idle' || isWorking) {
      setIdleOverrideExpression(null);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let napTimer: ReturnType<typeof setTimeout> | null = null;
    let lastAction: Parameters<typeof pickIdleLifeStep>[0] = null;

    const scheduleNext = (delayMs: number) => {
      timer = setTimeout(runStep, delayMs);
    };

    function runStep() {
      if (cancelled) return;
      const step = pickIdleLifeStep(lastAction);
      lastAction = step.action;

      // prefers-reduced-motion: calm expression changes only, no gestures and
      // no CarePayoffs particle bursts — matches the reduced-motion contract
      // the rest of this component already honours for bubbles/backdrop drift.
      if (reducedMotion) {
        if (step.action === 'nap') {
          setIdleOverrideExpression('sleeping');
          napTimer = setTimeout(() => {
            if (!cancelled) setIdleOverrideExpression(null);
          }, step.durationMs);
        } else if (step.action === 'eat' || step.action === 'shower') {
          setIdleOverrideExpression('happy');
          napTimer = setTimeout(() => {
            if (!cancelled) setIdleOverrideExpression(null);
          }, step.durationMs);
        }
        scheduleNext(step.durationMs + step.pauseMs);
        return;
      }

      switch (step.action) {
        case 'nap':
          setIdleOverrideExpression('sleeping');
          napTimer = setTimeout(() => {
            if (!cancelled) setIdleOverrideExpression(null);
          }, step.durationMs);
          break;
        case 'eat':
          heroSlotHandleRef.current?.playGesture('eat');
          carePayoffsRef.current?.feed(daisElRef.current, heroElRef.current);
          break;
        case 'shower':
          heroSlotHandleRef.current?.playGesture('shower');
          carePayoffsRef.current?.shower(heroElRef.current);
          break;
        case 'vibe':
        default:
          if (step.gesture) heroSlotHandleRef.current?.playGesture(step.gesture);
          break;
      }
      scheduleNext(step.durationMs + step.pauseMs);
    }

    // Let real entrance settle before the first idle beat fires.
    scheduleNext(randomBetween(5000, 11_000));

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      if (napTimer) clearTimeout(napTimer);
      setIdleOverrideExpression(null);
    };
  }, [idleLife, active, reducedMotion, isWorking]);

  // ── interactive free-roam (dashboard hero, opt-in) ────────────────────────
  // Reuse the Virtual Pet's physics hook verbatim so the dashboard hero behaves
  // like the pet toy — wander, grab, drag, fling (gravity + wall bounce + squash),
  // ease-home. Armed ONLY when `interactive` and motion isn't reduced; AgentsScreen
  // (interactive=false) never arms it, so its hero stays pinned exactly as before.
  // A grab/land/tap flashes a brief face reaction over the room's current face.
  const tossReactionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashTossReaction = useCallback((expr: string, ms: number) => {
    if (tossReactionTimerRef.current) clearTimeout(tossReactionTimerRef.current);
    setTossReaction(expr);
    tossReactionTimerRef.current = setTimeout(() => setTossReaction(null), ms);
  }, []);
  useEffect(
    () => () => {
      if (tossReactionTimerRef.current) clearTimeout(tossReactionTimerRef.current);
    },
    [],
  );
  const tossHandlers = usePetToss({
    fieldRef: localStageRef,
    charRef: heroElRef,
    enabled: interactive && !reducedMotion,
    reduceMotion: reducedMotion,
    // Grab → startled; a settled throw → startled; a quick pet-tap → smitten.
    onGrab: () => flashTossReaction('surprised', 1400),
    onLand: () => flashTossReaction('surprised', 900),
    onTap: () => flashTossReaction('heart-eyes', 1200),
  });

  // ── playmate: a temporary pool mini roaming this stage (LANE 5, opt-in) ────
  // See the PLAYMATE header comment above for the full contract. `enter(seed)`
  // just flips playmateSeed on; the choreography effect below owns everything
  // from there (wander, bounce beats, hero reactions, the exit hop) and reports
  // back via onPlaymateExit once it's done. playmateActiveRef gates re-entrancy
  // synchronously (state updates are async, so a second enter() before the
  // first render commits must still be rejected).
  // UNLIMITED playmates (Item 5): the pool hands up as many minis as the owner
  // throws — each is a HeroPlaymate child owning its OWN choreography + refs, so
  // N run independently on this one stage. `playmateSeedsRef` is the synchronous
  // dedupe (state is async — a second enter() of the same seed before commit
  // must still be rejected); the seeds array drives the render.
  const [playmateSeeds, setPlaymateSeeds] = useState<number[]>([]);
  const playmateSeedsRef = useRef<Set<number>>(new Set());
  const onPlaymateReadyRef = useRef(onPlaymateReady);
  onPlaymateReadyRef.current = onPlaymateReady;
  const onPlaymateExitRef = useRef(onPlaymateExit);
  onPlaymateExitRef.current = onPlaymateExit;

  const handlePlaymateExit = useCallback((seed: number) => {
    if (!playmateSeedsRef.current.has(seed)) return;
    playmateSeedsRef.current.delete(seed);
    setPlaymateSeeds((prev) => prev.filter((s) => s !== seed));
    onPlaymateExitRef.current?.(seed);
  }, []);

  useEffect(() => {
    const handle: FlubberPlaymateHandle = {
      enter(seed: number) {
        if (playmateSeedsRef.current.has(seed)) return; // dupe of a live mini
        playmateSeedsRef.current.add(seed);
        setPlaymateSeeds((prev) => [...prev, seed]);
      },
    };
    onPlaymateReadyRef.current?.(handle);
    return () => {
      onPlaymateReadyRef.current?.(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Holo work-panels are the "work-screens" and they render ONLY while the REAL
  // work clock is running (isWorking) — off the clock (app open / idle) there are
  // ZERO panels, ever, which kills the mount/idle mockup flash at the source.
  // On the clock they map to the real activity; on the clock with no specific
  // brain read yet (forcedWork) they collapse to a single HONEST 'terminal'
  // work-screen so the owner SEES him working, WITHOUT fabricating a specific task
  // (no "writing code"/graph screen). Never on the very first paint after (re)mount.
  const panelSpec = forcedWork ? specFor('terminal') : spec;
  const rawShowPanels = hasMounted && isWorking && panelSpec.activity !== 'idle';
  // HYSTERESIS (Item 2): don't unmount the work-panels the instant `isWorking`
  // dips for a single tick — the real work clock is now debounced (15s) so this
  // rarely fires, but if it ever blips the panels hold for PANEL_HYSTERESIS_MS
  // and freeze their last real panels instead of strobing. Truly stopping work
  // clears them after the grace. Still honest: only ever shows panels that were
  // genuinely up while working, never fabricates new ones.
  const [heldPanels, setHeldPanels] = useState<{ key: string; panels: typeof panelSpec.panels }>(() => ({
    key: 'idle',
    panels: [],
  }));
  useEffect(() => {
    if (rawShowPanels) {
      setHeldPanels({ key: panelSpec.activity, panels: panelSpec.panels });
      return;
    }
    const id = setTimeout(() => setHeldPanels({ key: 'idle', panels: [] }), PANEL_HYSTERESIS_MS);
    return () => clearTimeout(id);
    // panelSpec.panels is a stable lookup keyed by .activity — the string dep covers it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawShowPanels, panelSpec.activity]);
  const panels = heldPanels.panels;
  // Room grade: the real activity's hue/energy, or the sustained WORK_AMBIENT read
  // while forced onto the clock (a working glow, not the resting idle grade).
  const roomHue = forcedWork ? WORK_AMBIENT.hue : spec.hue;
  const roomEnergy = forcedWork ? WORK_AMBIENT.energy : spec.energy;
  const classes = ['fh', compact ? 'fh--compact' : '', className ?? ''].filter(Boolean).join(' ');

  // Speech bubble (LAW 1): ONLY real speech ever appears — a real brain line (a
  // terminal reaction) or a real UI hint the caller passes as `speech`. There is
  // NO canned per-activity blurb fallback anymore: no real speech ⇒ no bubble.
  // The activity's own blurb string still exists on the spec for label/aria use,
  // but it is never bubble copy.
  const bubble = speech ?? null;
  // Honest status chip: off the clock it ALWAYS reads the idle label, full stop —
  // `active` can go non-idle from a stray brain expression with no real task
  // behind it, and that must never leak into the chip. On the clock: forced work
  // says "Working" (no specific claim); a real resolved activity gets its label.
  const statusLabel = !isWorking ? specFor('idle').label : forcedWork ? 'Working' : spec.label;

  const setStageRef = useMemo(
    () => (node: HTMLDivElement | null) => {
      localStageRef.current = node;
      if (typeof stageRef === 'function') stageRef(node);
      else if (stageRef) (stageRef as MutableRefObject<HTMLDivElement | null>).current = node;
    },
    [stageRef],
  );

  return (
    <div
      ref={rootRef}
      className={classes}
      data-activity={active}
      data-hue={roomHue}
      data-energy={roomEnergy}
      style={{ ['--fh-hue' as string]: roomHue, ['--fh-energy' as string]: roomEnergy }}
    >
      {/* backdrop plate */}
      <div className={`fh__backdrop fh__backdrop--${backdrop}`} aria-hidden="true" />
      {/* mood grade — recolours the whole room by activity */}
      <div className="fh__grade" aria-hidden="true" />
      {/* rising goo bubbles */}
      <canvas ref={bubbleCanvasRef} className="fh__bubbles" aria-hidden="true" />
      {/* light shaft from the ceiling fixture onto the dais */}
      <div className="fh__shaft" aria-hidden="true" />

      <div ref={setStageRef} className="fh__stage">
        {/* floating workspace panels — remounted per activity (CSS enter anim) */}
        <div className="fh__panels" data-count={panels.length}>
          {panels.map((kind, i) => (
            <div key={`${heldPanels.key}-${i}`} className={`fh__panel fh__panel--${i}`}>
              {/* primary panel header matches the honest status chip ("Working"
                  during forced work), never a fabricated task claim */}
              <HoloPanel kind={kind} label={i === 0 ? statusLabel : undefined} seed={i} />
            </div>
          ))}
        </div>

        {/* the dais the hero stands on — also the idle-life feed's origin point */}
        <div ref={daisElRef} className="fh__dais" aria-hidden="true">
          <span className="fh__dais-ring" />
          <span className="fh__dais-core" />
        </div>

        {/* hero mascot — transparent, composites over the backdrop. When
            interactive it unpins from the dais and centres via margins (NOT a
            transform) so usePetToss can own the inline transform; the pointer
            handler makes it grabbable/throwable. */}
        <div
          ref={heroElRef}
          className={`fh__hero${interactive ? ' fh__hero--roam' : ''}`}
          style={
            interactive
              ? { width: heroSize, height: heroSize, marginLeft: -heroSize / 2, marginTop: -heroSize / 2 }
              : { width: heroSize, height: heroSize }
          }
          onPointerDown={interactive ? tossHandlers.onPointerDown : undefined}
        >
          <Flubber3D
            expression={displayExpression}
            size={heroSize}
            tier="hero"
            pulseKey={pulseKey}
            onSlotReady={handleHeroSlotReady}
            className="fh__hero-canvas"
          />
        </div>

        {/* temporary pool→hero playmates (LANE 5) — UNLIMITED (Item 5). Each
            HeroPlaymate owns its own wander/beat/exit choreography and manual
            transform, so several share this stage at once without fighting. */}
        {playmateSeeds.map((seed) => (
          <HeroPlaymate
            key={seed}
            seed={seed}
            stageRef={localStageRef}
            isWorking={isWorking}
            reducedMotion={reducedMotion}
            flashHeroReaction={flashTossReaction}
            onExit={handlePlaymateExit}
          />
        ))}

        {/* idle-life payoff bursts (feed/shower) — reuses the Virtual Pet's
            particle overlay; only mounted when idle life is actually on. */}
        {idleLife && <CarePayoffs ref={carePayoffsRef} reduceMotion={reducedMotion} />}

        {bubble && (
          <div className="fh__speech" role="status">
            {bubble}
          </div>
        )}

        {/* activity status line — suppressed when hideStatusChip is set (see
            prop doc) so the hero shows exactly one bubble, not a second
            always-on chip competing with the real .fh__speech above. */}
        {!hideStatusChip && (
          <div className="fh__status">
            <span className="fh__status-dot" aria-hidden="true" />
            <span className="fh__status-label">{statusLabel}</span>
          </div>
        )}

        {/* spawn crew / extra overlays */}
        {children}
      </div>

      <div className="fh__vignette" aria-hidden="true" />
    </div>
  );
}
