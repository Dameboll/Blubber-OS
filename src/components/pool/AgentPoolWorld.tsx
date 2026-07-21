'use client';

/**
 * AgentPoolWorld — the glass slime-ROOM where dormant Flubbers live. The Agents
 * screen must never read as dead: this is a big lit room full of real, living
 * mascots — they wander, nap with drifting "z" glyphs, and horse around with
 * each other (a slime-ball toss, a keep-away chase, a three-way pile-up that
 * topples, a bump). Every so often something reaches in from above (the tractor
 * beam, reused from the real spawn-pull) and lifts one out for a quick
 * juggle/inspect before setting it back — a "peek." When REAL work arrives
 * (`pulling` is set) one is lifted OUT for good and pops through the top — that
 * pull IS the activation moment, and it always takes priority over the cosmetic
 * vignettes above.
 *
 * THE WORK CLOCK (LAW 1 — this IS a work surface). `isWorking` is the app-wide
 * work/break latch from SessionProvider:
 *   - WORKING: the residents CLOCK IN — the scheduler's setWorkMode(true) halts
 *     all new horseplay (no vignettes/naps/peeks; in-flight ones finish) and
 *     the residents hold a calm on-the-clock roam with a 'focused' face. Pointer
 *     play is OFF — nothing is grabbable, and the +1 / EMPTY POOL controls (in
 *     AgentsScreen) are disabled. During work the pool shows the REAL dormant
 *     roster count, untouchable.
 *   - ON BREAK: horseplay resumes AND the pool becomes Dame's playground —
 *     grab + drag a mini (its brain freezes like the pull/peek paths already
 *     do), fling it OFF the room → it despawns, drag it UP past the top → hand
 *     it to the Agents hero (onHeroGrab), or use the +1 / EMPTY controls. These
 *     break-time edits are an explicit toy layer (`playing`) on top of the real
 *     count; the instant work resumes they're discarded and the pool snaps back
 *     to the honest dormant count. Real-vs-toy is resolved entirely by the clock
 *     — no fake agent identities are ever invented.
 *
 * Architecture:
 *   - The pure behavior brain (lib/flubber3d/pool-behaviors.ts) owns every
 *     resident's pool position, depth scale, nap/vignette state, the shared
 *     toss ball, and a queued peek + "something happened" event, advancing them
 *     allocation-free each frame. Every resident carries a STABLE id — this view
 *     keys its DOM node + WebGL slot to that id (nodeRefs/handleRefs are Maps by
 *     id), so a specific resident can be grabbed / flung / added with zero
 *     disturbance to the others.
 *   - Each resident is a MID (shiny clearcoat-goo) Blubber slot from the shared
 *     FlubberHost (one WebGL context for the whole app — the host enforces a
 *     global MID budget and silently grants micro past it, so density degrades
 *     gracefully). This layer writes transforms onto the wrappers in a single
 *     rAF loop and drains the brain's gesture/nap/peek/event commands.
 *   - The real pull, the cosmetic peek, and a pointer drag each own their
 *     resident's node while active (the brain freezes it via
 *     `pulled`/`peeking`/`held` and the rAF loop skips it via `frozenIds` /
 *     pulledId / peekingId), so nothing fights over the same transform. A real
 *     pull always wins.
 *   - `onVignette` fires once per real scheduler event so a caller (the Agents
 *     hero) can react — a real tie between "the hero notices the pool" and an
 *     actual thing that happened down there, never a canned loop.
 *
 * ZERO fake data: `dormantCount` is the real number of idle agents. At most
 * MAX_LIVE swim live; the rest are an honest "+N sleeping" tag. Ambient energy
 * subtly tracks real recent activity (GET /api/recent). An empty pool shows a
 * drained state, never fake residents — except while Dame has deliberately
 * emptied the toy pool on break, which shows a distinct "cleared" hint.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { gsap } from 'gsap';
import Flubber3D from '../Flubber3D';
import type { FlubberSlotHandle } from '../../lib/flubber3d/host';
import type { FlubberTier } from '../../lib/flubber3d/instance';
import { createPoolScheduler, type PoolEventKind } from '../../lib/flubber3d/pool-behaviors';
import './AgentPoolWorld.css';

/** Break-only pool controls, handed up to the caller (AgentsScreen owns the
 * +1 / EMPTY POOL buttons). No-ops while working — the caller also disables the
 * buttons, this is a second honest gate. */
export interface PoolControls {
  /** Add one resident to the playground (capped at MAX_LIVE). */
  addOne(): void;
  /** Clear every resident from the playground. */
  emptyAll(): void;
}

export interface AgentPoolWorldProps {
  /** How many dormant Flubbers live in the pool right now (real). */
  dormantCount: number;
  /** When set, the pool plays the REAL pull-out choreography for one Blubber. */
  pulling: string | null;
  /** Fired once the pulled Blubber has fully exited the pool. */
  onPullComplete: () => void;
  /** Mirror of prefers-reduced-motion so the pool can go static. */
  reduceMotion?: boolean;
  /** Fired once per real scheduler vignette (bump/toss/chase/pileup/peek) so
   *  a caller can react (e.g. the hero glances over + throws out a line). */
  onVignette?: (kind: PoolEventKind) => void;
  /** SessionProvider's work/break latch (LAW 1). true = residents clock in and
   *  pointer play + controls are OFF; false (break) = horseplay + playground. */
  isWorking?: boolean;
  /** Fired when Dame drags a mini UP out of the pool toward the Agents hero —
   *  the caller hands it to the hero (a gesture + a line) AND, real playtime
   *  (LANE 5): the release point (viewport px) and the resident's own id (used
   *  as a stable seed) so a HandoffOverlay can arc a clone from this exact spot
   *  into the hero stage. Break-only. */
  onHeroGrab?: (point: { x: number; y: number }, seed: number) => void;
  /** Receives the break-only +1 / EMPTY POOL controls so the caller can render
   *  the buttons (AgentsScreen owns them). Null on unmount. */
  onControlsReady?: (controls: PoolControls | null) => void;
}

// Pool holds a small calm cluster (Dame's call 2026-07-20: "lessen the pool,
// start with ~3"). Starts at INITIAL_LIVE and gently ramps to this cap; the
// honest "+N sleeping" overflow tag covers the real dormant remainder.
const MAX_LIVE = 5;
const RESIDENT_SIZE = 44;
const RESIDENT_TIER: FlubberTier = 'mid'; // shiny clearcoat-goo jelly (LANE M)
const BALL_SIZE = 11;
const RECENT_POLL_MS = 10_000;
const ENERGY_WINDOW_MS = 5 * 60_000; // events within 5 min count as "recent"

// PERF (load-time fix, docs/plans/booger-eradication-2026-07-20.md Phase 2):
// mounting all MAX_LIVE MID-tier WebGL bodies in one React commit was the
// real cost behind a slow Agents tab-switch — measured ~3.1s wall time to
// fully paint 14 residents on a cold pool (each live Flubber3D slot clones +
// rigs a fresh instance; see flubber3d/instance.ts). Reveal a small initial
// batch immediately — the room feels alive right away — then trickle the
// rest in over a few short ticks. The real dormantCount is never touched;
// the honest "+N sleeping" overflow tag (below) covers the gap the whole
// time it's ramping, so nothing looks fake or wrong mid-reveal.
const INITIAL_LIVE = 3;
const RAMP_STEP = 3;
const RAMP_START_DELAY_MS = 220;
const RAMP_STEP_INTERVAL_MS = 140;

interface DomeSize {
  w: number;
  h: number;
}

export function AgentPoolWorld({
  dormantCount,
  pulling,
  onPullComplete,
  reduceMotion,
  onVignette,
  isWorking = false,
  onHeroGrab,
  onControlsReady,
}: AgentPoolWorldProps) {
  const scheduler = useMemo(() => createPoolScheduler(), []);

  // reduced-motion: prop wins, else the media query at mount.
  const [mediaReduce] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  const reduce = reduceMotion || mediaReduce;

  // The render list: which resident ids currently have a DOM node/slot. Mirrors
  // the scheduler's live residents; updated after every structural change so
  // React keys nodes by STABLE id (grab/fling a specific one, no index shuffle).
  const [renderIds, setRenderIds] = useState<number[]>([]);
  // Break-time playground flag: once Dame adds/removes/empties, the count is his
  // toy layer and stops auto-syncing to the real dormant count until work
  // resumes (which discards it — see the sync effect).
  const [playing, setPlaying] = useState(false);

  const domeRef = useRef<HTMLDivElement | null>(null);
  const beamRef = useRef<HTMLDivElement | null>(null);
  const ballRef = useRef<HTMLDivElement | null>(null);
  const nodeRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const handleRefs = useRef<Map<number, FlubberSlotHandle>>(new Map());
  const lastNap = useRef<Map<number, boolean>>(new Map());
  const lastSplat = useRef<Map<number, boolean>>(new Map());
  const domeSize = useRef<DomeSize>({ w: 0, h: 0 });

  // View-owned node ids (the rAF loop leaves these alone): a real pull, a
  // cosmetic peek, and any pointer-held / animating-out resident.
  const pulledId = useRef(-1);
  const peekingId = useRef(-1);
  const grabbedId = useRef(-1);
  const frozenIds = useRef<Set<number>>(new Set());
  const peekTlRef = useRef<gsap.core.Timeline | null>(null);

  // Latest callbacks/flags without making them effect deps.
  const onPullCompleteRef = useRef(onPullComplete);
  onPullCompleteRef.current = onPullComplete;
  const onVignetteRef = useRef(onVignette);
  onVignetteRef.current = onVignette;
  const onHeroGrabRef = useRef(onHeroGrab);
  onHeroGrabRef.current = onHeroGrab;
  const onControlsReadyRef = useRef(onControlsReady);
  onControlsReadyRef.current = onControlsReady;
  const pullingRef = useRef(pulling);
  pullingRef.current = pulling;
  const isWorkingRef = useRef(isWorking);
  isWorkingRef.current = isWorking;

  const resync = useCallback(() => {
    setRenderIds(scheduler.residents.map((r) => r.id));
  }, [scheduler]);

  // ── perf ramp-up: reveal a few residents fast, trickle the rest in ────────
  // Mount-only, one-shot (see INITIAL_LIVE doc above). A nav away + back
  // remounts this component and re-ramps, which is exactly the "fast on
  // every tab switch" behaviour this fixes — it's not a one-time app thing.
  const [revealCap, setRevealCap] = useState(INITIAL_LIVE);
  const rampStartedRef = useRef(false);
  useEffect(() => {
    if (rampStartedRef.current) return;
    rampStartedRef.current = true;
    const remaining = Math.max(0, MAX_LIVE - INITIAL_LIVE);
    const steps = Math.ceil(remaining / RAMP_STEP);
    const timers: number[] = [];
    for (let i = 1; i <= steps; i += 1) {
      const delay = RAMP_START_DELAY_MS + (i - 1) * RAMP_STEP_INTERVAL_MS;
      timers.push(
        window.setTimeout(() => {
          setRevealCap((cap) => Math.min(MAX_LIVE, cap + RAMP_STEP));
        }, delay),
      );
    }
    return () => {
      timers.forEach((id) => window.clearTimeout(id));
    };
  }, []);

  // ── count sync: real dormant count, unless Dame is mid-play on break ───────
  useEffect(() => {
    // While working we always show the real count; break-time play (`playing`)
    // owns the count until work resumes.
    if (playing && !isWorking) return;
    const target = Math.min(Math.max(0, dormantCount), MAX_LIVE, revealCap);
    scheduler.setCount(target);
    resync();
  }, [scheduler, dormantCount, playing, isWorking, resync, revealCap]);

  // Work resuming discards the playground and re-reveals the real count.
  useEffect(() => {
    if (isWorking) setPlaying(false);
  }, [isWorking]);

  // ── work clock → scheduler mode + resident faces ───────────────────────────
  useEffect(() => {
    scheduler.setWorkMode(isWorking);
    for (const r of scheduler.residents) {
      const handle = handleRefs.current.get(r.id);
      if (!handle) continue;
      handle.setExpression(isWorking ? 'focused' : 'happy');
      if (!reduce) handle.setMovement(isWorking ? scheduler.workMovement : scheduler.roamMovement);
    }
  }, [scheduler, isWorking, reduce, renderIds]);

  // measure the dome (rAF reads this every frame — no per-frame layout).
  useEffect(() => {
    const dome = domeRef.current;
    if (!dome) return;
    const measure = () => {
      domeSize.current = { w: dome.clientWidth, h: dome.clientHeight };
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(dome);
    return () => ro.disconnect();
  }, []);

  // ── ambient energy: real recent activity → livelier pool ──────────────────
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetch(`/api/recent?limit=10`)
        .then((res) => (res.ok ? (res.json() as Promise<{ events?: { ts: string }[] }>) : null))
        .then((json) => {
          if (cancelled || !json) return;
          const now = Date.now();
          const recent = (json.events ?? []).filter((e) => {
            const t = new Date(e.ts).getTime();
            return !Number.isNaN(t) && now - t < ENERGY_WINDOW_MS;
          }).length;
          scheduler.setEnergy(recent === 0 ? 0.12 : Math.min(1, recent / 6));
        })
        .catch(() => {});
    };
    load();
    const id = window.setInterval(load, RECENT_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [scheduler]);

  // ── break-only controls handed up to the caller ───────────────────────────
  const addOne = useCallback(() => {
    if (isWorkingRef.current) return;
    if (scheduler.residents.length >= MAX_LIVE) return;
    scheduler.add();
    setPlaying(true);
    resync();
  }, [scheduler, resync]);

  const emptyAll = useCallback(() => {
    if (isWorkingRef.current) return;
    scheduler.setCount(0);
    nodeRefs.current.clear();
    handleRefs.current.clear();
    lastNap.current.clear();
    lastSplat.current.clear();
    frozenIds.current.clear();
    setPlaying(true);
    setRenderIds([]);
  }, [scheduler]);

  const controls = useMemo<PoolControls>(() => ({ addOne, emptyAll }), [addOne, emptyAll]);
  useEffect(() => {
    const cb = onControlsReadyRef.current;
    cb?.(controls);
    return () => cb?.(null);
  }, [controls]);

  // ── pointer play (break only) ──────────────────────────────────────────────
  const positionNodeAtPointer = useCallback((node: HTMLDivElement, clientX: number, clientY: number) => {
    const dome = domeRef.current;
    if (!dome) return;
    const rect = dome.getBoundingClientRect();
    gsap.set(node, {
      x: clientX - rect.left - RESIDENT_SIZE / 2,
      y: clientY - rect.top - RESIDENT_SIZE / 2,
      scale: 1.16,
      rotation: 0,
      transformOrigin: '50% 50%',
    });
  }, []);

  const despawnGrabbed = useCallback(
    (id: number) => {
      frozenIds.current.delete(id);
      scheduler.remove(id);
      nodeRefs.current.delete(id);
      handleRefs.current.delete(id);
      lastNap.current.delete(id);
      lastSplat.current.delete(id);
      setPlaying(true);
      resync();
    },
    [scheduler, resync],
  );

  const handleResidentPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>, id: number) => {
      if (isWorkingRef.current || reduce) return; // break-only
      if (!scheduler.isGrabbable(id)) return; // don't grab a resident mid-vignette
      const node = nodeRefs.current.get(id);
      if (!node) return;
      e.preventDefault();
      grabbedId.current = id;
      frozenIds.current.add(id);
      scheduler.grab(id);
      try {
        node.setPointerCapture(e.pointerId);
      } catch {
        // capture unsupported / element detached — drag still works via bubbling
      }
      node.classList.add('pw-resident--held');
      node.style.zIndex = '80';
      handleRefs.current.get(id)?.setExpression('surprised');
      positionNodeAtPointer(node, e.clientX, e.clientY);
    },
    [scheduler, reduce, positionNodeAtPointer],
  );

  const handleResidentPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>, id: number) => {
      if (grabbedId.current !== id) return;
      const node = nodeRefs.current.get(id);
      if (!node) return;
      positionNodeAtPointer(node, e.clientX, e.clientY);
      const dome = domeRef.current;
      if (dome) {
        const rect = dome.getBoundingClientRect();
        dome.classList.toggle('pw--handoff', e.clientY < rect.top);
      }
    },
    [positionNodeAtPointer],
  );

  const handleResidentPointerUp = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>, id: number) => {
      if (grabbedId.current !== id) return;
      grabbedId.current = -1;
      const node = nodeRefs.current.get(id);
      const dome = domeRef.current;
      dome?.classList.remove('pw--handoff');
      node?.classList.remove('pw-resident--held');
      try {
        node?.releasePointerCapture(e.pointerId);
      } catch {
        // no capture held — ignore
      }
      if (!node || !dome) {
        // node/dome vanished — fall back to a plain release so the brain resumes.
        frozenIds.current.delete(id);
        scheduler.release(id);
        return;
      }
      const rect = dome.getBoundingClientRect();
      const nx = (e.clientX - rect.left) / rect.width;
      const ny = (e.clientY - rect.top) / rect.height;
      const aboveTop = e.clientY < rect.top;
      const outside = nx < 0 || nx > 1 || ny < 0 || ny > 1;

      if (aboveTop || outside) {
        // Fling out → despawn. Above the top = handed up to the hero (real
        // playtime — the caller arcs a clone from this exact release point
        // into the hero stage; this resident's own id rides along as the
        // clone's seed so its blink/clip desync stays stable across the trip).
        handleRefs.current.get(id)?.playGesture('hop');
        const releasePoint = { x: e.clientX, y: e.clientY };
        const finish = () => {
          if (aboveTop) onHeroGrabRef.current?.(releasePoint, id);
          despawnGrabbed(id);
        };
        const ex = (nx - 0.5) * rect.width;
        gsap.to(node, {
          x: aboveTop ? nx * rect.width - RESIDENT_SIZE / 2 : `+=${ex}`,
          y: aboveTop ? -RESIDENT_SIZE * 2.2 : `+=${(ny - 0.5) * rect.height * 0.8}`,
          scale: 0.32,
          opacity: 0,
          duration: 0.42,
          ease: 'power2.in',
          onComplete: finish,
        });
        return;
      }

      // Dropped inside → back into the pool at the drop point.
      frozenIds.current.delete(id);
      node.style.zIndex = '';
      handleRefs.current.get(id)?.setExpression('happy');
      scheduler.release(id, nx, ny);
    },
    [scheduler, despawnGrabbed],
  );

  // ── the life loop: advance the brain, write transforms, drain commands ────
  useEffect(() => {
    if (renderIds.length === 0) return;

    const writeResident = (r: { id: number; x: number; y: number; scale: number; lift: number; tilt: number }) => {
      const node = nodeRefs.current.get(r.id);
      if (!node) return;
      const { w, h } = domeSize.current;
      const px = r.x * w - RESIDENT_SIZE / 2;
      const py = r.y * h - RESIDENT_SIZE - r.lift * h; // feet near the sampled y, + pile-up lift
      const tiltDeg = r.tilt * (180 / Math.PI);
      node.style.transform = `translate3d(${px}px, ${py}px, 0) scale(${r.scale}) rotate(${tiltDeg}deg)`;
      node.style.zIndex = String(Math.round(r.y * 100));
      if (node.style.opacity !== '1') node.style.opacity = '1';
    };

    const writeBall = () => {
      const el = ballRef.current;
      if (!el) return;
      const ball = scheduler.ball;
      if (ball.active) {
        const { w, h } = domeSize.current;
        el.style.transform = `translate3d(${ball.x * w - BALL_SIZE / 2}px, ${ball.y * h - BALL_SIZE / 2}px, 0)`;
        if (el.style.opacity !== '1') el.style.opacity = '1';
      } else if (el.style.opacity !== '0') {
        el.style.opacity = '0';
      }
    };

    // The "peek" vignette: the beam reaches in, lifts a resident for a quick
    // juggle/inspect, sets it back. Self-contained — resolves via
    // scheduler.endPeek(), never touches onPullComplete, always yields to a
    // real pull.
    const startPeek = (id: number) => {
      if (pullingRef.current || pulledId.current !== -1) {
        scheduler.endPeek(id);
        return;
      }
      const node = nodeRefs.current.get(id);
      const r = scheduler.residentById(id);
      const beam = beamRef.current;
      if (!node || !r) {
        scheduler.endPeek(id);
        return;
      }
      peekingId.current = id;
      const { w, h } = domeSize.current;
      const startX = r.x * w - RESIDENT_SIZE / 2;
      const startY = r.y * h - RESIDENT_SIZE;
      const base = r.scale;
      if (beam) beam.style.left = `${r.x * w}px`;
      node.style.zIndex = '55';
      const handle = handleRefs.current.get(id);
      handle?.setExpression('surprised');

      gsap.set(node, { x: startX, y: startY, scaleX: base, scaleY: base, rotation: 0, transformOrigin: '50% 100%' });
      const tl = gsap.timeline({
        onComplete: () => {
          peekingId.current = -1;
          node.style.zIndex = '';
          scheduler.endPeek(id);
        },
      });
      if (beam) tl.to(beam, { opacity: 0.8, duration: 0.22, ease: 'power2.out' }, 0);
      tl.to(node, { y: startY - RESIDENT_SIZE * 0.85, scaleX: base * 0.9, scaleY: base * 1.16, duration: 0.32, ease: 'power2.out' }, 0.02);
      tl.to(node, { rotation: 12, duration: 0.16, ease: 'sine.inOut', yoyo: true, repeat: 3 }, '>-0.04');
      tl.call(() => handle?.playGesture('wave'), undefined, '>-0.3');
      tl.to(node, { y: startY, scaleX: base, scaleY: base, rotation: 0, duration: 0.28, ease: 'power2.in' });
      tl.call(() => handle?.setExpression('happy'), undefined, '<');
      if (beam) tl.to(beam, { opacity: 0, duration: 0.25, ease: 'power2.in' }, '>-0.1');
      peekTlRef.current = tl;
    };

    if (reduce) {
      // static cute arrangement — lay everyone out once, no wander.
      const raf = requestAnimationFrame(() => {
        for (const r of scheduler.residents) writeResident(r);
      });
      return () => cancelAnimationFrame(raf);
    }

    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      scheduler.step(dt, now / 1000);

      for (const r of scheduler.residents) {
        // GSAP / pointer own these nodes.
        if (r.id === pulledId.current || r.id === peekingId.current || frozenIds.current.has(r.id)) continue;
        const node = nodeRefs.current.get(r.id);
        if (!node) continue;
        writeResident(r);

        // nap state → face + movement, applied only on the transition edge
        if (r.napping !== lastNap.current.get(r.id)) {
          lastNap.current.set(r.id, r.napping);
          node.classList.toggle('pw-resident--nap', r.napping);
          const handle = handleRefs.current.get(r.id);
          if (handle) {
            if (r.napping) {
              handle.setExpression('sleeping');
              handle.setMovement(scheduler.napMovement);
            } else {
              handle.setExpression('happy');
              handle.setMovement(scheduler.roamMovement);
            }
          }
        }

        // splat wobble (missed toss catch), applied only on the transition edge
        if (r.splatted !== lastSplat.current.get(r.id)) {
          lastSplat.current.set(r.id, r.splatted);
          node.classList.toggle('pw-resident--splat', r.splatted);
        }

        // one-shot gesture (wave / hop / bounce / celebrate / petted…)
        const gesture = scheduler.takeGesture(r.id);
        if (gesture) handleRefs.current.get(r.id)?.playGesture(gesture);
      }

      writeBall();

      // cosmetic peek: only start one when nothing real is pulling.
      if (peekingId.current === -1) {
        const peekId = scheduler.takePeekRequest();
        if (peekId !== null) startPeek(peekId);
      }

      // real scheduler events → let the caller react (hero glance + line).
      const ev = scheduler.takeEvent();
      if (ev) onVignetteRef.current?.(ev);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      // If a cosmetic peek was mid-flight when this effect tears down (renderIds
      // or reduce changed), `.kill()` won't fire the timeline's onComplete, so
      // settle its resident by hand — otherwise it'd stay stuck mid-air.
      peekTlRef.current?.kill();
      const stuckId = peekingId.current;
      if (stuckId !== -1) {
        peekingId.current = -1;
        const stuckNode = nodeRefs.current.get(stuckId);
        if (stuckNode) {
          gsap.killTweensOf(stuckNode);
          stuckNode.style.opacity = '1';
          stuckNode.style.zIndex = '';
        }
        handleRefs.current.get(stuckId)?.setExpression('happy');
        scheduler.endPeek(stuckId);
      }
    };
  }, [scheduler, reduce, renderIds]);

  // ── real pull choreography (unchanged shape, now also yields to a peek) ───
  useEffect(() => {
    if (!pulling) return;

    if (reduce) {
      onPullCompleteRef.current();
      return;
    }

    const id = scheduler.beginPull();
    if (id === -1) {
      onPullCompleteRef.current();
      return;
    }
    pulledId.current = id;

    const node = nodeRefs.current.get(id);
    const beam = beamRef.current;
    const r = scheduler.residentById(id);
    if (!node || !r) {
      scheduler.releasePull(id);
      pulledId.current = -1;
      onPullCompleteRef.current();
      return;
    }

    const { w, h } = domeSize.current;
    const startX = r.x * w - RESIDENT_SIZE / 2;
    const startY = r.y * h - RESIDENT_SIZE;
    const base = r.scale;
    if (beam) beam.style.left = `${r.x * w}px`;
    node.style.zIndex = '60';

    const handle = handleRefs.current.get(id);
    handle?.setExpression('excited');
    handle?.playGesture('celebrate');

    gsap.set(node, { x: startX, y: startY, scaleX: base, scaleY: base, transformOrigin: '50% 100%' });
    const tl = gsap.timeline({
      onComplete: () => {
        onPullCompleteRef.current();
      },
    });
    if (beam) tl.to(beam, { opacity: 1, duration: 0.25, ease: 'power2.out' }, 0);
    tl.to(node, { scaleX: base * 1.2, scaleY: base * 0.8, duration: 0.16, ease: 'power2.out' }, 0.02);
    tl.to(node, {
      y: -RESIDENT_SIZE * 1.6,
      scaleX: base * 0.82,
      scaleY: base * 1.28,
      opacity: 0,
      duration: 0.62,
      ease: 'power2.in',
    });
    if (beam) tl.to(beam, { opacity: 0, duration: 0.3, ease: 'power2.in' }, '>-0.15');

    return () => {
      tl.kill();
      const settleId = pulledId.current;
      pulledId.current = -1;
      if (settleId !== -1) {
        scheduler.releasePull(settleId);
        const settleNode = nodeRefs.current.get(settleId);
        if (settleNode) {
          gsap.killTweensOf(settleNode);
          settleNode.style.opacity = '1';
          settleNode.style.zIndex = '';
        }
        handleRefs.current.get(settleId)?.setExpression('happy');
      }
      if (beam) gsap.to(beam, { opacity: 0, duration: 0.2 });
    };
  }, [pulling, reduce, scheduler]);

  const liveCount = renderIds.length;
  // Real "+N sleeping" overflow only when showing the real count (not playing).
  const overflow = playing ? 0 : Math.max(0, dormantCount - liveCount);

  // ── empty pool: honest drained state, no fake residents ───────────────────
  // Only the REAL drained message (all agents deployed) when it's genuinely
  // real — never when Dame just cleared the toy pool on break.
  if (dormantCount === 0 && !playing) {
    return (
      <div className="pw pw--empty" ref={domeRef} aria-label="Agent pool: empty">
        <div className="pw__roomdrop" aria-hidden="true" />
        <div className="pw__glass" aria-hidden="true" />
        <div className="pw__drained">
          <span className="pw__drained-icon" aria-hidden="true" />
          <span className="pw__drained-text">Pool&rsquo;s drained — every agent is deployed and working.</span>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`pw${!isWorking && !reduce ? ' pw--interactive' : ''}`}
      ref={domeRef}
      aria-label={`Agent pool: ${playing ? liveCount : dormantCount} dormant`}
    >
      <div className="pw__roomdrop" aria-hidden="true" />
      <div className="pw__sheen" aria-hidden="true" />
      <div className="pw__floorline" aria-hidden="true" />

      <div className="pw__floor">
        {renderIds.map((id) => (
          <div
            key={id}
            className="pw-resident"
            style={{ width: RESIDENT_SIZE, height: RESIDENT_SIZE, opacity: 0 }}
            ref={(el) => {
              if (el) nodeRefs.current.set(id, el);
              else nodeRefs.current.delete(id);
            }}
            onPointerDown={(e) => handleResidentPointerDown(e, id)}
            onPointerMove={(e) => handleResidentPointerMove(e, id)}
            onPointerUp={(e) => handleResidentPointerUp(e, id)}
            onPointerCancel={(e) => handleResidentPointerUp(e, id)}
          >
            <span className="pw-resident__shadow" aria-hidden="true" />
            <Flubber3D
              expression="happy"
              size={RESIDENT_SIZE}
              tier={RESIDENT_TIER}
              seed={id}
              onSlotReady={(handle) => {
                if (handle) {
                  handleRefs.current.set(id, handle);
                  if (!reduce) handle.setMovement(isWorkingRef.current ? scheduler.workMovement : scheduler.roamMovement);
                  handle.setExpression(isWorkingRef.current ? 'focused' : 'happy');
                } else {
                  handleRefs.current.delete(id);
                }
              }}
            />
            <span className="pw-resident__z pw-resident__z--a" aria-hidden="true">z</span>
            <span className="pw-resident__z pw-resident__z--b" aria-hidden="true">z</span>
          </div>
        ))}
      </div>

      <div className="pw__ball" ref={ballRef} style={{ width: BALL_SIZE, height: BALL_SIZE }} aria-hidden="true" />
      <div className="pw__beam" ref={beamRef} aria-hidden="true" />
      <div className="pw__glass" aria-hidden="true" />

      {playing && liveCount === 0 && (
        <span className="pw__cleared">Pool cleared — add one back with +1.</span>
      )}
      {overflow > 0 && <span className="pw__overflow">+{overflow} more sleeping</span>}
      {!isWorking && !reduce && liveCount > 0 && (
        <span className="pw__hint" aria-hidden="true">Drag a mini out to release · up to the hero to play</span>
      )}
    </div>
  );
}
