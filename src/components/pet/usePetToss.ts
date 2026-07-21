'use client';

/**
 * usePetToss — the LIVE hero physics for the free-roam Virtual Blubber (LANE 3
 * of docs/plans/idle-life-and-wiring.md). The hero is never pinned centre: it
 * has four real behaviours, all driven off one rAF loop that mutates a single
 * element's inline transform (translate + rotate + squash scale — compositor
 * only, zero React churn, zero per-frame allocation beyond scalars):
 *
 *   - WANDER  — the always-on idle life. When nothing is grabbing or chasing it,
 *               the hero drifts to random points inside its play field, leaning
 *               into the direction of travel, so it reads alive and roaming.
 *   - CHASE   — when the parent hands over a playmate target (getChaseTarget),
 *               the hero makes a beeline for it, bumps it (squash + onBump +
 *               a playful recoil), backs off, and comes straight back — it
 *               "messes around" with the wrestling minis instead of ignoring
 *               them.
 *   - FLIGHT  — grab and fling it and it flies with the release velocity,
 *               bounces off the field walls/floor with real gravity, SQUASHES on
 *               each impact, and pulls an indignant face (onLand).
 *   - HOME    — after a throw settles it lingers, then eases back and resumes
 *               WANDER (it never gets stranded in a corner, and never freezes
 *               dead-centre either).
 *
 * A quick press that never moves is a pet (onTap), not a throw. Every frame the
 * hero's offset is reported up (reportPos) so the playmate layer can detect
 * contact for the two-way tussle.
 *
 * prefers-reduced-motion: no autonomous wander/chase and no flight simulation —
 * the hero rests centred and still. Dragging still works (the toy follows the
 * finger); releasing snaps it straight home. onGrab/onLand/onTap still fire so
 * the face reactions read.
 */

import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';

interface Vec {
  x: number;
  y: number;
}

interface UsePetTossOptions {
  /** The play field the pet is bounded to. */
  fieldRef: RefObject<HTMLElement | null>;
  /** The element whose transform is driven (the character wrapper). */
  charRef: RefObject<HTMLElement | null>;
  enabled: boolean;
  reduceMotion: boolean;
  /** Vertical "resting" offset as a fraction of the field's height, added to
   *  every reference position (wander home, settle-after-toss, tap-reset) so
   *  the hero's rest state sits low in the tube — feet on the pedestal graphic
   *  in the backdrop photo — instead of the field's bare geometric centre.
   *  0 = old behaviour (centred). Positive = downward. */
  groundBiasFrac?: number;
  /** Fired once when a press turns into a real drag (surprised face). */
  onGrab?: () => void;
  /** Fired on a throw impact / landing (indignant face). */
  onLand?: () => void;
  /** Fired when a press is released without dragging (a pet, not a throw). */
  onTap?: () => void;
  /** Reports the hero's live offset (px from field centre) every frame so the
   *  playmate layer can detect hero↔mini contact for the tussle interplay. */
  reportPos?: (x: number, y: number) => void;
  /** The nearest playmate offset the idle hero should chase, or null to freely
   *  wander. Coordinates are px offsets from the field centre (same space as
   *  reportPos), so the two layers line up. */
  getChaseTarget?: () => Vec | null;
  /** Fired (throttled) each time the wandering hero bumps its chase target. */
  onBump?: () => void;
}

export interface PetTossHandlers {
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
}

type TossMode = 'idle' | 'wander' | 'flight' | 'home';

const DRAG_THRESHOLD_PX = 6;
const GRAVITY = 2600; // px/s²
const RESTITUTION = 0.56; // energy kept per wall bounce
const AIR_DRAG = 0.4; // /s velocity bleed in flight
const MAX_LAUNCH = 2800; // px/s clamp so a whip-fast fling stays contained
const REST_SPEED = 40; // px/s below which a grounded body is "settled"
const HOME_EASE = 7; // ease-home rate once settled
const SQUASH_IMPACT = 0.42; // splat depth on a hard landing
const SQUASH_DECAY = 9; // squash spring recovery rate
const REST_HOLD_MS = 900; // linger where it landed before easing home

// Idle-life tuning.
const WANDER_EASE = 1.7; // slow, floaty drift toward the current wander target
const CHASE_EASE = 4.6; // faster, eager pursuit of a playmate
const WANDER_HOLD_MIN = 1100; // ms a wander target is held before re-picking
const WANDER_HOLD_SPAN = 1700; // ms of extra random hold on top of the minimum
const ROT_EASE = 5; // how quickly the lean settles
const MAX_LEAN_DEG = 7; // cap on the travel lean
const BUMP_DIST = 72; // px centre-distance that counts as bumping a playmate
const BUMP_KICK = 26; // px playful recoil away from the mini on contact
const BUMP_COOLDOWN_MS = 460; // min gap between two registered bumps

export function usePetToss(options: UsePetTossOptions): PetTossHandlers {
  const {
    fieldRef,
    charRef,
    enabled,
    reduceMotion,
    groundBiasFrac = 0,
    onGrab,
    onLand,
    onTap,
    reportPos,
    getChaseTarget,
    onBump,
  } = options;

  // Keep the latest callbacks without re-subscribing the pointer handlers.
  const cbRef = useRef({ onGrab, onLand, onTap, reportPos, getChaseTarget, onBump });
  cbRef.current = { onGrab, onLand, onTap, reportPos, getChaseTarget, onBump };

  // Read-only mirrors so the rAF loop never needs to be rebuilt when these flip.
  const reduceMotionRef = useRef(reduceMotion);
  reduceMotionRef.current = reduceMotion;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const groundBiasFracRef = useRef(groundBiasFrac);
  groundBiasFracRef.current = groundBiasFrac;

  // Live physics state (never triggers a React render).
  const posRef = useRef<Vec>({ x: 0, y: 0 });
  const velRef = useRef<Vec>({ x: 0, y: 0 });
  const rotRef = useRef(0);
  const squashRef = useRef(0);
  const boundsRef = useRef({ maxX: 0, maxY: 0 });
  // Px equivalent of groundBiasFrac against the field's last-measured height —
  // recomputed alongside boundsRef every measureBounds() call.
  const groundBiasRef = useRef(0);

  const wanderTargetRef = useRef<Vec>({ x: 0, y: 0 });
  const wanderNextAtRef = useRef(0);
  const bumpCooldownRef = useRef(0);

  const draggingRef = useRef(false);
  const movedRef = useRef(false);
  const pointerIdRef = useRef<number | null>(null);
  const lastPtRef = useRef({ x: 0, y: 0, t: 0 });
  const grabOffsetRef = useRef({ x: 0, y: 0 });

  const rafRef = useRef(0);
  const lastFrameRef = useRef(0);
  const settleAtRef = useRef(0);
  const modeRef = useRef<TossMode>('idle');

  const applyTransform = useCallback(() => {
    const el = charRef.current;
    if (!el) return;
    const sq = squashRef.current;
    const sx = 1 + sq * 0.4;
    const sy = 1 - sq * 0.4;
    el.style.transform = `translate(${posRef.current.x.toFixed(1)}px, ${posRef.current.y.toFixed(1)}px) rotate(${rotRef.current.toFixed(2)}deg) scale(${sx.toFixed(3)}, ${sy.toFixed(3)})`;
    cbRef.current.reportPos?.(posRef.current.x, posRef.current.y);
  }, [charRef]);

  const measureBounds = useCallback(() => {
    const field = fieldRef.current;
    const char = charRef.current;
    if (!field || !char) return;
    const f = field.getBoundingClientRect();
    const c = char.getBoundingClientRect();
    // Home is centred; the body may travel half the free space minus a margin.
    const margin = 10;
    boundsRef.current = {
      maxX: Math.max(0, (f.width - c.width) / 2 - margin),
      maxY: Math.max(0, (f.height - c.height) / 2 - margin),
    };
    groundBiasRef.current = f.height * groundBiasFracRef.current;
  }, [fieldRef, charRef]);

  const pickWanderTarget = useCallback(
    (now: number) => {
      measureBounds();
      const { maxX, maxY } = boundsRef.current;
      wanderTargetRef.current = {
        x: (Math.random() * 2 - 1) * maxX * 0.82,
        // Slight upward bias off the resting anchor so it floats around the
        // pedestal rather than sinking into the floor.
        y: (Math.random() * 2 - 1) * maxY * 0.7 - maxY * 0.1 + groundBiasRef.current,
      };
      wanderNextAtRef.current = now + WANDER_HOLD_MIN + Math.random() * WANDER_HOLD_SPAN;
    },
    [measureBounds],
  );

  const stopLoop = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
  }, []);

  const step = useCallback(
    (now: number) => {
      const dt = Math.min((now - lastFrameRef.current) / 1000, 0.05);
      lastFrameRef.current = now;

      const pos = posRef.current;
      const vel = velRef.current;
      const { maxX, maxY } = boundsRef.current;

      if (modeRef.current === 'wander') {
        if (boundsRef.current.maxX === 0 && boundsRef.current.maxY === 0) measureBounds();

        const chase = cbRef.current.getChaseTarget?.() ?? null;
        let tx: number;
        let ty: number;
        const chasing = chase !== null;
        if (chase) {
          tx = Math.max(-maxX, Math.min(maxX, chase.x));
          ty = Math.max(-maxY, Math.min(maxY, chase.y));
        } else {
          if (now >= wanderNextAtRef.current) pickWanderTarget(now);
          tx = wanderTargetRef.current.x;
          ty = wanderTargetRef.current.y;
        }

        const k = 1 - Math.exp(-(chasing ? CHASE_EASE : WANDER_EASE) * dt);
        pos.x += (tx - pos.x) * k;
        pos.y += (ty - pos.y) * k;

        // Lean into the direction of travel.
        const targetRot = Math.max(-MAX_LEAN_DEG, Math.min(MAX_LEAN_DEG, (tx - pos.x) * 0.05));
        rotRef.current += (targetRot - rotRef.current) * (1 - Math.exp(-ROT_EASE * dt));

        // Bump the playmate it's chasing: squash, notify, recoil, come back.
        if (chasing && now >= bumpCooldownRef.current) {
          const d = Math.hypot(tx - pos.x, ty - pos.y);
          if (d < BUMP_DIST) {
            squashRef.current = Math.max(squashRef.current, SQUASH_IMPACT * 0.8);
            bumpCooldownRef.current = now + BUMP_COOLDOWN_MS;
            cbRef.current.onBump?.();
            const away = d > 0.01 ? BUMP_KICK / d : 0;
            pos.x -= (tx - pos.x) * away;
            pos.y -= (ty - pos.y) * away;
          }
        }

        pos.x = Math.max(-maxX, Math.min(maxX, pos.x));
        pos.y = Math.max(-maxY, Math.min(maxY, pos.y));
      } else if (modeRef.current === 'flight') {
        vel.y += GRAVITY * dt;
        const bleed = Math.exp(-AIR_DRAG * dt);
        vel.x *= bleed;
        pos.x += vel.x * dt;
        pos.y += vel.y * dt;

        let impact = false;
        if (pos.x > maxX) { pos.x = maxX; vel.x = -vel.x * RESTITUTION; impact = true; }
        else if (pos.x < -maxX) { pos.x = -maxX; vel.x = -vel.x * RESTITUTION; impact = true; }
        if (pos.y > maxY) { pos.y = maxY; vel.y = -vel.y * RESTITUTION; vel.x *= 0.7; impact = true; }
        else if (pos.y < -maxY) { pos.y = -maxY; vel.y = -vel.y * RESTITUTION; impact = true; }

        if (impact) {
          const force = Math.min(1, Math.hypot(vel.x, vel.y) / 1200 + 0.35);
          squashRef.current = Math.max(squashRef.current, SQUASH_IMPACT * force);
          cbRef.current.onLand?.();
        }

        rotRef.current += vel.x * dt * 0.35;

        // Settled: grounded (at/near floor) and slow → hold, then ease home.
        const grounded = maxY - pos.y < 2;
        if (grounded && Math.hypot(vel.x, vel.y) < REST_SPEED) {
          vel.x = 0;
          vel.y = 0;
          modeRef.current = 'home';
          settleAtRef.current = now + REST_HOLD_MS;
        }
      } else if (modeRef.current === 'home') {
        if (now >= settleAtRef.current) {
          const k = 1 - Math.exp(-HOME_EASE * dt);
          pos.x += (0 - pos.x) * k;
          pos.y += (groundBiasRef.current - pos.y) * k;
          rotRef.current += (0 - rotRef.current) * k;
        }
      }

      // Squash spring recovery (shared across modes).
      squashRef.current += (0 - squashRef.current) * (1 - Math.exp(-SQUASH_DECAY * dt));

      applyTransform();

      // A throw that has eased home is done — but resume the idle wander instead
      // of freezing dead-centre (unless motion is reduced / free-roam is off).
      const homeAtRest =
        modeRef.current === 'home' &&
        now >= settleAtRef.current &&
        Math.abs(pos.x) < 0.4 &&
        Math.abs(pos.y - groundBiasRef.current) < 0.4 &&
        Math.abs(rotRef.current) < 0.2 &&
        squashRef.current < 0.01;

      if (homeAtRest) {
        pos.x = 0; pos.y = groundBiasRef.current; rotRef.current = 0; squashRef.current = 0;
        if (enabledRef.current && !reduceMotionRef.current) {
          modeRef.current = 'wander';
          pickWanderTarget(now);
          applyTransform();
          rafRef.current = requestAnimationFrame(step);
          return;
        }
        modeRef.current = 'idle';
        applyTransform();
        stopLoop();
        return;
      }

      rafRef.current = requestAnimationFrame(step);
    },
    [applyTransform, measureBounds, pickWanderTarget, stopLoop],
  );

  const startLoop = useCallback(() => {
    if (rafRef.current) return;
    lastFrameRef.current = performance.now();
    rafRef.current = requestAnimationFrame(step);
  }, [step]);

  const handlePointerMove = useCallback(
    (e: PointerEvent) => {
      if (!draggingRef.current || e.pointerId !== pointerIdRef.current) return;
      const field = fieldRef.current;
      if (!field) return;
      const f = field.getBoundingClientRect();
      // Desired offset from the field centre, following the grab point.
      const cx = f.left + f.width / 2;
      const cy = f.top + f.height / 2;
      let nx = e.clientX - cx - grabOffsetRef.current.x;
      let ny = e.clientY - cy - grabOffsetRef.current.y;
      const { maxX, maxY } = boundsRef.current;
      nx = Math.max(-maxX, Math.min(maxX, nx));
      ny = Math.max(-maxY, Math.min(maxY, ny));

      const now = performance.now();
      const dt = Math.max(0.001, (now - lastPtRef.current.t) / 1000);
      velRef.current.x = (nx - posRef.current.x) / dt;
      velRef.current.y = (ny - posRef.current.y) / dt;
      lastPtRef.current = { x: e.clientX, y: e.clientY, t: now };

      posRef.current.x = nx;
      posRef.current.y = ny;

      if (!movedRef.current && Math.hypot(nx, ny) > DRAG_THRESHOLD_PX) {
        movedRef.current = true;
        cbRef.current.onGrab?.();
      }
      applyTransform();
    },
    [fieldRef, applyTransform],
  );

  const endDrag = useCallback(
    (e: PointerEvent) => {
      if (e.pointerId !== pointerIdRef.current) return;
      draggingRef.current = false;
      pointerIdRef.current = null;
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', endDrag);
      window.removeEventListener('pointercancel', endDrag);

      const resumeIdle = enabledRef.current && !reduceMotionRef.current;

      if (!movedRef.current) {
        // A tap — treat as a pet, then resume roaming (or rest on the pedestal).
        posRef.current.x = 0; posRef.current.y = groundBiasRef.current; rotRef.current = 0;
        applyTransform();
        cbRef.current.onTap?.();
        if (resumeIdle) {
          modeRef.current = 'wander';
          pickWanderTarget(performance.now());
          startLoop();
        } else {
          modeRef.current = 'idle';
        }
        return;
      }

      if (reduceMotion) {
        // No flight — settle straight home with a tiny landing beat.
        squashRef.current = SQUASH_IMPACT * 0.5;
        cbRef.current.onLand?.();
        modeRef.current = 'home';
        settleAtRef.current = performance.now();
        startLoop();
        return;
      }

      // Launch with the tracked release velocity, clamped so it stays contained.
      const speed = Math.hypot(velRef.current.x, velRef.current.y);
      if (speed > MAX_LAUNCH) {
        const s = MAX_LAUNCH / speed;
        velRef.current.x *= s;
        velRef.current.y *= s;
      }
      cbRef.current.onLand?.();
      modeRef.current = 'flight';
      startLoop();
    },
    [handlePointerMove, reduceMotion, applyTransform, pickWanderTarget, startLoop],
  );

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      if (!enabled) return;
      e.preventDefault();
      stopLoop();
      measureBounds();
      draggingRef.current = true;
      movedRef.current = false;
      pointerIdRef.current = e.pointerId;
      modeRef.current = 'idle';

      const field = fieldRef.current;
      if (field) {
        const f = field.getBoundingClientRect();
        const cx = f.left + f.width / 2;
        const cy = f.top + f.height / 2;
        // Where inside the body was grabbed, relative to its current offset.
        grabOffsetRef.current = {
          x: e.clientX - cx - posRef.current.x,
          y: e.clientY - cy - posRef.current.y,
        };
      }
      lastPtRef.current = { x: e.clientX, y: e.clientY, t: performance.now() };
      velRef.current = { x: 0, y: 0 };

      window.addEventListener('pointermove', handlePointerMove);
      window.addEventListener('pointerup', endDrag);
      window.addEventListener('pointercancel', endDrag);
    },
    [enabled, stopLoop, measureBounds, fieldRef, handlePointerMove, endDrag],
  );

  // Start / stop the autonomous idle life. Free-roam + full motion → the hero
  // wanders (and chases playmates); reduced motion or free-roam off → it rests
  // centred and still, but dragging still works.
  useEffect(() => {
    // Measure first in both branches — the reduced-motion/disabled rest state
    // below needs groundBiasRef populated too, so it plants the hero on the
    // pedestal instead of the field's bare geometric centre.
    measureBounds();
    if (enabled && !reduceMotion) {
      pickWanderTarget(performance.now());
      modeRef.current = 'wander';
      startLoop();
    } else {
      stopLoop();
      const el = charRef.current;
      const bias = groundBiasRef.current;
      if (el) el.style.transform = bias ? `translate(0px, ${bias.toFixed(1)}px)` : '';
      posRef.current = { x: 0, y: bias };
      velRef.current = { x: 0, y: 0 };
      rotRef.current = 0;
      squashRef.current = 0;
      modeRef.current = 'idle';
    }
    return () => {
      stopLoop();
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', endDrag);
      window.removeEventListener('pointercancel', endDrag);
    };
  }, [enabled, reduceMotion, charRef, measureBounds, pickWanderTarget, startLoop, stopLoop, handlePointerMove, endDrag]);

  return { onPointerDown };
}
