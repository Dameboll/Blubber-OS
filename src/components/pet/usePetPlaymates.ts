'use client';

/**
 * usePetPlaymates — the interactive wrestling minis for the free-roam Virtual
 * Blubber (LANE 3). When "Play" pops a fresh cohort, each mini is a real toy in
 * the same play field the hero lives in:
 *
 *   - it ROAMS the tube on its own (drifts to random targets, leans into it);
 *   - it is CLICKABLE + DRAGGABLE with the same feel as the hero (grab, move,
 *     release → resumes roaming; a press that never moves is a poke that makes
 *     it bounce);
 *   - the hero CHASES it (getChaseTarget hands the nearest live mini to
 *     usePetToss) and the two BUMP each other — when the hero closes in, the
 *     mini gets shoved and bounces (a two-way tussle, not one-sided);
 *   - after its lifetime it WANDERS OFF — drifts to the nearest edge, fades, and
 *     is removed. When the cohort empties the layer unmounts itself.
 *
 * Every mini's motion is driven imperatively off one shared rAF loop that
 * mutates each wrapper's inline transform/opacity (compositor only, no React
 * churn on the hot path); only the cohort size lives in React state. Coordinates
 * are px offsets from the field centre, matching usePetToss so the hero and the
 * minis line up exactly.
 *
 * prefers-reduced-motion: the minis appear at their scattered spawn spots and
 * stay put (no drift, no hero chase), but remain clickable/draggable and still
 * fade out when their life ends.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';
import type { FlubberSlotHandle } from '../../lib/flubber3d/host';

interface Vec {
  x: number;
  y: number;
}

interface PlaymateBody {
  id: number;
  el: HTMLDivElement | null;
  slot: FlubberSlotHandle | null;
  x: number;
  y: number;
  tx: number;
  ty: number;
  rot: number;
  squash: number;
  nextAt: number;
  diesAt: number;
  exiting: boolean;
  exitAt: number;
  gone: boolean;
  dragging: boolean;
}

interface UsePetPlaymatesOptions {
  /** The play field the minis are bounded to (same rect the hero uses). */
  fieldRef: RefObject<HTMLElement | null>;
  /** The hero's live offset (px from field centre), for the tussle interplay. */
  heroPosRef: RefObject<Vec>;
  /** Whether the pet screen is in free-roam mode (the minis only live here). */
  enabled: boolean;
  reduceMotion: boolean;
  /** Bump to spawn a fresh cohort; the size is read from countRef at that moment. */
  spawnKey: number;
  /** Latest requested cohort size (2–4). Read only when spawnKey changes. */
  countRef: RefObject<number>;
  /** Square render size of each mini, in px. */
  bodySize: number;
  /** Fired when a mini is poked (clicked without dragging). */
  onPoke?: () => void;
  /** Fired (throttled inside the hook) when the hero bumps into a mini. */
  onHeroBump?: () => void;
}

interface UsePetPlaymatesResult {
  /** How many mini wrappers to render this frame. */
  renderCount: number;
  /** Stable key that changes per cohort so a fresh Play remounts the minis. */
  cohortKey: number;
  /** Wire a rendered wrapper element back to its body slot. */
  registerEl: (index: number, el: HTMLDivElement | null) => void;
  /** Wire a rendered mini's 3D handle back to its body slot. */
  registerSlot: (index: number, handle: FlubberSlotHandle | null) => void;
  /** Pointer-down handler for a mini wrapper (grab / drag / poke). */
  onBodyPointerDown: (index: number, e: ReactPointerEvent<HTMLDivElement>) => void;
  /** The nearest live mini offset for the hero to chase, or null. */
  getChaseTarget: () => Vec | null;
}

const SPAWN_FRACTIONS: Vec[] = [
  { x: 0.34, y: 0.28 },
  { x: -0.4, y: 0.4 },
  { x: 0.46, y: 0.12 },
  { x: -0.18, y: 0.16 },
];

const LIFE_MIN_MS = 3600;
const LIFE_SPAN_MS = 1600;
const RETARGET_MIN_MS = 1000;
const RETARGET_SPAN_MS = 1500;
const EXIT_FADE_MS = 620;
const DRAG_THRESHOLD_PX = 5;
const HERO_BUMP_DIST = 68; // px centre-distance for a hero↔mini bump
const HERO_BUMP_KICK = 0.55; // fraction of the overlap the mini is shoved by
const INTERACT_LIFE_EXTEND_MS = 1500; // touching a mini keeps it around a bit
const WANDER_EASE = 1.9;
const EXIT_EASE = 3.2;
const ROT_EASE = 4;
const SQUASH_DECAY = 8;
const MAX_LEAN_DEG = 6;

export function usePetPlaymates(options: UsePetPlaymatesOptions): UsePetPlaymatesResult {
  const { fieldRef, heroPosRef, enabled, reduceMotion, spawnKey, countRef, bodySize, onPoke, onHeroBump } = options;

  const cbRef = useRef({ onPoke, onHeroBump });
  cbRef.current = { onPoke, onHeroBump };
  const reduceMotionRef = useRef(reduceMotion);
  reduceMotionRef.current = reduceMotion;

  const bodiesRef = useRef<PlaymateBody[]>([]);
  const bodySizeRef = useRef(bodySize);
  bodySizeRef.current = bodySize;

  const rafRef = useRef(0);
  const lastFrameRef = useRef(0);
  const bumpCooldownRef = useRef(0);
  const idSeedRef = useRef(0);

  const [renderCount, setRenderCount] = useState(0);
  const [cohortKey, setCohortKey] = useState(0);

  // A single active drag (one pointer at a time).
  const dragRef = useRef<{ index: number; pointerId: number; grabX: number; grabY: number; moved: boolean } | null>(
    null,
  );

  const fieldMetrics = useCallback(() => {
    const field = fieldRef.current;
    if (!field) return null;
    const f = field.getBoundingClientRect();
    const bs = bodySizeRef.current;
    return {
      cx: f.left + f.width / 2,
      cy: f.top + f.height / 2,
      maxX: Math.max(0, f.width / 2 - bs / 2 - 8),
      maxY: Math.max(0, f.height / 2 - bs / 2 - 8),
    };
  }, [fieldRef]);

  const applyBody = useCallback((b: PlaymateBody, now: number) => {
    const el = b.el;
    if (!el) return;
    const sq = b.squash;
    const sx = 1 + sq * 0.4;
    const sy = 1 - sq * 0.4;
    el.style.transform = `translate(-50%, -50%) translate(${b.x.toFixed(1)}px, ${b.y.toFixed(1)}px) rotate(${b.rot.toFixed(2)}deg) scale(${sx.toFixed(3)}, ${sy.toFixed(3)})`;
    if (b.exiting) {
      const p = Math.max(0, 1 - (now - b.exitAt) / EXIT_FADE_MS);
      el.style.opacity = p.toFixed(3);
    } else {
      el.style.opacity = '1';
    }
  }, []);

  const stopLoop = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
  }, []);

  const step = useCallback(
    (now: number) => {
      const dt = Math.min((now - lastFrameRef.current) / 1000, 0.05);
      lastFrameRef.current = now;

      const metrics = fieldMetrics();
      const bodies = bodiesRef.current;
      const hero = heroPosRef.current ?? { x: 0, y: 0 };
      const still = reduceMotionRef.current;
      let anyAlive = false;

      for (const b of bodies) {
        if (b.gone) continue;
        anyAlive = true;

        if (!metrics) {
          applyBody(b, now);
          continue;
        }
        const { maxX, maxY } = metrics;

        // Lifetime → exit.
        if (!b.exiting && now > b.diesAt) {
          b.exiting = true;
          b.exitAt = now;
        }

        if (b.dragging) {
          // Position is set by the pointer-move handler; just render it.
          applyBody(b, now);
          continue;
        }

        if (b.exiting) {
          const dir = b.x >= 0 ? 1 : -1;
          b.tx = dir * (maxX + bodySizeRef.current);
          b.ty = b.y;
          const k = 1 - Math.exp(-EXIT_EASE * dt);
          b.x += (b.tx - b.x) * k;
          b.y += (b.ty - b.y) * k;
          b.squash += (0 - b.squash) * (1 - Math.exp(-SQUASH_DECAY * dt));
          applyBody(b, now);
          if (now - b.exitAt >= EXIT_FADE_MS) b.gone = true;
          continue;
        }

        if (still) {
          // Reduced motion: hold the spawn spot, only decay any poke squash.
          b.squash += (0 - b.squash) * (1 - Math.exp(-SQUASH_DECAY * dt));
          applyBody(b, now);
          continue;
        }

        // Roam toward the current wander target.
        if (now >= b.nextAt) {
          b.tx = (Math.random() * 2 - 1) * maxX * 0.85;
          b.ty = (Math.random() * 2 - 1) * maxY * 0.6 + maxY * 0.1;
          b.nextAt = now + RETARGET_MIN_MS + Math.random() * RETARGET_SPAN_MS;
        }
        const k = 1 - Math.exp(-WANDER_EASE * dt);
        b.x += (b.tx - b.x) * k;
        b.y += (b.ty - b.y) * k;

        // Two-way tussle: when the hero closes in, the mini is shoved + bounces.
        const dx = b.x - hero.x;
        const dy = b.y - hero.y;
        const dist = Math.hypot(dx, dy);
        if (dist < HERO_BUMP_DIST) {
          const overlap = HERO_BUMP_DIST - dist;
          const nx = dist > 0.01 ? dx / dist : 0;
          const ny = dist > 0.01 ? dy / dist : 1;
          b.x += nx * overlap * HERO_BUMP_KICK;
          b.y += ny * overlap * HERO_BUMP_KICK;
          if (b.squash < 0.24) {
            b.squash = 0.28;
            b.slot?.playGesture('bounce');
          }
          if (now >= bumpCooldownRef.current) {
            bumpCooldownRef.current = now + 260;
            cbRef.current.onHeroBump?.();
          }
        }

        b.x = Math.max(-maxX, Math.min(maxX, b.x));
        b.y = Math.max(-maxY, Math.min(maxY, b.y));

        const targetRot = Math.max(-MAX_LEAN_DEG, Math.min(MAX_LEAN_DEG, (b.tx - b.x) * 0.05));
        b.rot += (targetRot - b.rot) * (1 - Math.exp(-ROT_EASE * dt));
        b.squash += (0 - b.squash) * (1 - Math.exp(-SQUASH_DECAY * dt));
        applyBody(b, now);
      }

      if (!anyAlive) {
        stopLoop();
        bodiesRef.current = [];
        setRenderCount(0);
        return;
      }
      rafRef.current = requestAnimationFrame(step);
    },
    [applyBody, fieldMetrics, heroPosRef, stopLoop],
  );

  const startLoop = useCallback(() => {
    if (rafRef.current) return;
    lastFrameRef.current = performance.now();
    rafRef.current = requestAnimationFrame(step);
  }, [step]);

  // Spawn a fresh cohort whenever Play fires (spawnKey changes).
  useEffect(() => {
    if (!enabled) return;
    const count = Math.max(0, Math.min(4, Math.floor(countRef.current ?? 0)));
    if (count === 0) return;

    const metrics = fieldMetrics();
    const now = performance.now();
    const bodies: PlaymateBody[] = Array.from({ length: count }, (_, i) => {
      const frac = SPAWN_FRACTIONS[i] ?? { x: 0, y: 0 };
      const x = metrics ? frac.x * metrics.maxX : 0;
      const y = metrics ? frac.y * metrics.maxY : 0;
      return {
        id: idSeedRef.current + i,
        el: null,
        slot: null,
        x,
        y,
        tx: x,
        ty: y,
        rot: 0,
        squash: 0,
        nextAt: now + RETARGET_MIN_MS + Math.random() * RETARGET_SPAN_MS,
        diesAt: now + LIFE_MIN_MS + Math.random() * LIFE_SPAN_MS,
        exiting: false,
        exitAt: 0,
        gone: false,
        dragging: false,
      };
    });
    idSeedRef.current += count;
    bodiesRef.current = bodies;
    setRenderCount(count);
    setCohortKey((k) => k + 1);
    startLoop();
    // Intentionally keyed on spawnKey only — a later count→0 must NOT wipe a
    // live cohort mid-play; the minis self-retire on their own lifetimes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spawnKey]);

  const registerEl = useCallback((index: number, el: HTMLDivElement | null) => {
    const b = bodiesRef.current[index];
    if (b) b.el = el;
  }, []);

  const registerSlot = useCallback((index: number, handle: FlubberSlotHandle | null) => {
    const b = bodiesRef.current[index];
    if (b) b.slot = handle;
  }, []);

  const handleDragMove = useCallback(
    (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d || e.pointerId !== d.pointerId) return;
      const b = bodiesRef.current[d.index];
      const metrics = fieldMetrics();
      if (!b || !metrics) return;
      let nx = e.clientX - metrics.cx - d.grabX;
      let ny = e.clientY - metrics.cy - d.grabY;
      nx = Math.max(-metrics.maxX, Math.min(metrics.maxX, nx));
      ny = Math.max(-metrics.maxY, Math.min(metrics.maxY, ny));
      if (!d.moved && Math.hypot(nx - b.x, ny - b.y) > DRAG_THRESHOLD_PX) d.moved = true;
      b.x = nx;
      b.y = ny;
      applyBody(b, performance.now());
    },
    [applyBody, fieldMetrics],
  );

  const endDrag = useCallback(
    (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d || e.pointerId !== d.pointerId) return;
      window.removeEventListener('pointermove', handleDragMove);
      window.removeEventListener('pointerup', endDrag);
      window.removeEventListener('pointercancel', endDrag);
      const b = bodiesRef.current[d.index];
      if (b) {
        b.dragging = false;
        const now = performance.now();
        // Touching it buys it a little more time on screen.
        if (!b.exiting) b.diesAt = Math.max(b.diesAt, now + INTERACT_LIFE_EXTEND_MS);
        if (!d.moved) {
          // A poke — bounce + notify.
          b.squash = 0.3;
          b.slot?.playGesture('bounce');
          b.slot?.reactToPointer('click');
          cbRef.current.onPoke?.();
        }
        // Resume roaming from wherever it was let go.
        b.nextAt = now;
      }
      dragRef.current = null;
    },
    [handleDragMove],
  );

  const onBodyPointerDown = useCallback(
    (index: number, e: ReactPointerEvent<HTMLDivElement>) => {
      if (!enabled) return;
      const b = bodiesRef.current[index];
      if (!b || b.gone || b.exiting) return;
      e.preventDefault();
      e.stopPropagation();
      const metrics = fieldMetrics();
      if (!metrics) return;
      b.dragging = true;
      dragRef.current = {
        index,
        pointerId: e.pointerId,
        grabX: e.clientX - metrics.cx - b.x,
        grabY: e.clientY - metrics.cy - b.y,
        moved: false,
      };
      startLoop();
      window.addEventListener('pointermove', handleDragMove);
      window.addEventListener('pointerup', endDrag);
      window.addEventListener('pointercancel', endDrag);
    },
    [enabled, fieldMetrics, startLoop, handleDragMove, endDrag],
  );

  const getChaseTarget = useCallback((): Vec | null => {
    const bodies = bodiesRef.current;
    const hero = heroPosRef.current ?? { x: 0, y: 0 };
    let best: Vec | null = null;
    let bestDist = Infinity;
    for (const b of bodies) {
      if (b.gone || b.exiting || b.dragging) continue;
      const d = Math.hypot(b.x - hero.x, b.y - hero.y);
      if (d < bestDist) {
        bestDist = d;
        best = { x: b.x, y: b.y };
      }
    }
    return best;
  }, [heroPosRef]);

  // Tear down when free-roam turns off / unmounts.
  useEffect(() => {
    if (!enabled) {
      stopLoop();
      bodiesRef.current = [];
      setRenderCount(0);
    }
    return () => {
      stopLoop();
      window.removeEventListener('pointermove', handleDragMove);
      window.removeEventListener('pointerup', endDrag);
      window.removeEventListener('pointercancel', endDrag);
    };
  }, [enabled, stopLoop, handleDragMove, endDrag]);

  return { renderCount, cohortKey, registerEl, registerSlot, onBodyPointerDown, getChaseTarget };
}
