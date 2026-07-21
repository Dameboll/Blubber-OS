'use client';

/**
 * HandoffOverlay — the fixed, full-viewport layer a real pool→hero handoff
 * travels through (LANE 5, docs/plans/pill-worlds-mini-dash.md). AgentPoolWorld's
 * pool pill and FlubberHome's hero pill are each their own clipped/rounded room
 * (`.pw`, `.acc-home`, `.fh` all set `overflow:hidden`), so a mini that visibly
 * arcs BETWEEN them has to travel on a layer that ignores both boundaries. This
 * component is that layer: mounted once at the Agents screen root as
 * `position:fixed; inset:0`, so it paints above every pill regardless of where
 * in the DOM tree it actually lives (AgentsScreen renders it as a sibling of
 * the two pills).
 *
 * It renders at most ONE traveling clone at a time — a real mid-tier Flubber3D
 * body (same shared-WebGL host as everything else) whose wrapper's transform is
 * driven every frame by a GSAP tween sampling a hand-rolled quadratic bezier
 * (no MotionPathPlugin dependency — keeps this self-contained). `arc()` returns
 * a promise that resolves once the clone has landed/faded, so the caller
 * (AgentsScreen) can chain the next real beat — FlubberHome's playmate taking
 * over, or the pool's `addOne()` restoring the resident — off a real completion
 * instead of a guessed timeout.
 *
 * direction semantics (the `reverse` flag):
 *   - false (pool → hero): the clone fades/grows IN from `from` and lands fully
 *     visible at `to` — FlubberHome's own playmate mini then takes over that
 *     same spot, so the handoff reads as one continuous body.
 *   - true (hero → pool): the clone starts fully visible at `from` and shrinks/
 *     fades OUT approaching `to`, as if diving back into the pool.
 *
 * reduceMotion: no bezier flight — the clone (if it renders at all) resolves
 * instantly with no visible travel, so the caller's next beat still fires.
 */

import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import { gsap } from 'gsap';
import Flubber3D from '../Flubber3D';
import type { FlubberSlotHandle } from '../../lib/flubber3d/host';
import './HandoffOverlay.css';

export interface HandoffArcOptions {
  /** Viewport px the clone starts from. */
  from: { x: number; y: number };
  /** Viewport px the clone travels to. */
  to: { x: number; y: number };
  /** Same id as the pool resident (or the same seed echoed back on the return
   *  trip) — keeps its blink/clip desync stable across the handoff. */
  seed: number;
  /** true = hero → pool (fade/shrink OUT at arrival). Default false = pool →
   *  hero (fade/grow IN at departure). */
  reverse?: boolean;
}

export interface HandoffOverlayHandle {
  /** Fly a mid-tier clone along the given arc; resolves once it's done
   *  (landed + fully visible for 'in', or faded + gone for 'out'). */
  arc(opts: HandoffArcOptions): Promise<void>;
}

export interface HandoffOverlayProps {
  /** Mirrors prefers-reduced-motion — skips the bezier flight entirely. */
  reduceMotion?: boolean;
}

const CLONE_SIZE = 52;
const FLIGHT_S = 0.64;
const ARC_HEIGHT_MIN = 90;
const ARC_HEIGHT_RATIO = 0.32;

interface Traveler {
  seed: number;
}

interface PendingArc extends HandoffArcOptions {
  resolve: () => void;
}

const HandoffOverlay = forwardRef<HandoffOverlayHandle, HandoffOverlayProps>(function HandoffOverlay(
  { reduceMotion },
  ref,
) {
  const [traveler, setTraveler] = useState<Traveler | null>(null);
  const nodeRef = useRef<HTMLDivElement | null>(null);
  const slotHandleRef = useRef<FlubberSlotHandle | null>(null);
  const tweenRef = useRef<gsap.core.Tween | null>(null);
  const pendingRef = useRef<PendingArc | null>(null);
  const reduceMotionRef = useRef(reduceMotion);
  reduceMotionRef.current = reduceMotion;

  // Kill any in-flight flight on unmount so a torn-down node never keeps a
  // tween ticking against it.
  useEffect(
    () => () => {
      tweenRef.current?.kill();
    },
    [],
  );

  const arc = useCallback((opts: HandoffArcOptions): Promise<void> => {
    tweenRef.current?.kill();
    return new Promise((resolve) => {
      pendingRef.current = { ...opts, resolve };
      setTraveler({ seed: opts.seed });
    });
  }, []);

  useImperativeHandle(ref, () => ({ arc }), [arc]);

  // Runs after the traveler's DOM node has actually committed — never guesses
  // via a raw rAF race against React's commit.
  useLayoutEffect(() => {
    const pending = pendingRef.current;
    if (!pending || !traveler) return;
    pendingRef.current = null;
    const node = nodeRef.current;
    if (!node) {
      setTraveler(null);
      pending.resolve();
      return;
    }

    const { from, to, reverse } = pending;
    const half = CLONE_SIZE / 2;
    const finish = () => {
      setTraveler(null);
      pending.resolve();
    };

    const paint = (x: number, y: number, scale: number, opacity: number) => {
      node.style.transform = `translate3d(${(x - half).toFixed(1)}px, ${(y - half).toFixed(1)}px, 0) scale(${scale.toFixed(3)})`;
      node.style.opacity = opacity.toFixed(3);
    };

    if (reduceMotionRef.current) {
      const settleAt = reverse ? from : to;
      paint(settleAt.x, settleAt.y, reverse ? 0.4 : 1, reverse ? 0 : 1);
      finish();
      return;
    }

    slotHandleRef.current?.setExpression('excited');
    slotHandleRef.current?.playGesture('celebrate');

    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const arcHeight = Math.max(ARC_HEIGHT_MIN, Math.hypot(dx, dy) * ARC_HEIGHT_RATIO);
    const ctrlX = from.x + dx / 2;
    const ctrlY = Math.min(from.y, to.y) - arcHeight;

    paint(from.x, from.y, reverse ? 1 : 0.5, reverse ? 1 : 0);

    const proxy = { t: 0 };
    tweenRef.current = gsap.to(proxy, {
      t: 1,
      duration: FLIGHT_S,
      ease: 'power2.inOut',
      onUpdate: () => {
        const t = proxy.t;
        const it = 1 - t;
        const x = it * it * from.x + 2 * it * t * ctrlX + t * t * to.x;
        const y = it * it * from.y + 2 * it * t * ctrlY + t * t * to.y;
        // fade/scale toward full presence over the first 30% (in) or the last
        // 30% (out) of the flight.
        const presence = reverse ? Math.min(1, it / 0.7) : Math.min(1, t / 0.3);
        const scale = reverse ? 1 - (1 - presence) * 0.55 : 0.5 + presence * 0.5;
        const opacity = reverse ? presence : Math.max(presence, 0.15);
        paint(x, y, scale, opacity);
      },
      onComplete: () => {
        tweenRef.current = null;
        finish();
      },
    });
  }, [traveler]);

  if (!traveler) return null;

  return (
    <div className="ho" aria-hidden="true">
      <div ref={nodeRef} className="ho__clone" style={{ width: CLONE_SIZE, height: CLONE_SIZE }}>
        <Flubber3D
          expression="excited"
          size={CLONE_SIZE}
          tier="mid"
          seed={traveler.seed}
          onSlotReady={(handle) => {
            slotHandleRef.current = handle;
          }}
        />
      </div>
    </div>
  );
});

export default HandoffOverlay;
