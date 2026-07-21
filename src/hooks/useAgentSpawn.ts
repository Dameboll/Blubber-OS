'use client';

/**
 * useAgentSpawn — the per-agent spawn / despawn choreography for the Agent
 * Control Center.
 *
 * The Control Center is no longer a fixed 5-slot grid: agents are a real,
 * persisted, dynamic list (GET/POST/DELETE /api/spawned). So this hook no
 * longer drives all-five-at-once. It drives ONE card at a time, keyed by the
 * agent's id:
 *   - playSpawnIn(id): a freshly-mounted card arcs out of the pool into its
 *     grid cell (drop-in + scale-up, a contained pop that can never land over a
 *     neighbouring panel), then its mini-Blubber flips to a working pose. The
 *     hero pulses as it "releases" the agent.
 *   - playDespawn(id, onDone): a card dissolves back toward the pool (shrink +
 *     fade), then onDone() removes it from the list.
 *
 * The flight is PURE 2D DOM transform on each card element (compositor only —
 * never touches WebGL). The shared FlubberHost keeps blitting each live mini's
 * scene into its canvas wherever the card currently sits.
 *
 * Battle-tested interruption-safety patterns kept from the 5-slot original:
 *   - clearProps 'all' on a card BEFORE building its next timeline, so a card
 *     interrupted mid-flight always restarts from a clean grid slot (never
 *     frozen at a half-applied transform).
 *   - immediateRender:false on every fromTo, so an interrupted "from" state is
 *     never applied to a card whose timeline got killed before it started — the
 *     card simply stays in its natural grid slot.
 *   - one timeline PER agent id (a Map), so spamming spawn/despawn on one card
 *     kills only that card's own timeline and never strands a neighbour.
 */

import { useCallback, useMemo, useRef } from 'react';
import { gsap } from 'gsap';
import type { FlubberSlotHandle } from '../lib/flubber3d/host';

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

export interface AgentSpawnControls {
  /** Forwarded to the hero stage — the pulse origin when an agent is released. */
  heroRef: (el: HTMLElement | null) => void;
  /** Ref callback factory: registers a card's DOM element by agent id. */
  registerCell: (id: string) => (el: HTMLElement | null) => void;
  /** Slot-handle callback factory: registers a mini-Blubber's live handle by id. */
  registerSlot: (id: string) => (h: FlubberSlotHandle | null) => void;
  /** Animate a freshly-mounted card arcing into its cell + flipping to work.
   *  Reduced motion: the card just appears (no transform), mini set to working. */
  playSpawnIn: (id: string) => void;
  /** Dissolve a card back toward the pool; onDone fires once it has fully left.
   *  Reduced motion: onDone fires immediately (instant removal). */
  playDespawn: (id: string, onDone: () => void) => void;
  /** Kill every in-flight timeline — call on unmount so nothing tweens a
   *  detached node. */
  cleanup: () => void;
}

export function useAgentSpawn(): AgentSpawnControls {
  const hero = useRef<HTMLElement | null>(null);
  const cells = useRef<Map<string, HTMLElement>>(new Map());
  const slots = useRef<Map<string, FlubberSlotHandle>>(new Map());
  const timelines = useRef<Map<string, gsap.core.Timeline>>(new Map());

  const killTimeline = useCallback((id: string) => {
    const tl = timelines.current.get(id);
    if (tl) {
      tl.kill();
      timelines.current.delete(id);
    }
  }, []);

  // The hero "releases" the agent: a quick squash-and-rebound on the stage.
  const heroPulse = useCallback(() => {
    const el = hero.current;
    if (!el || prefersReducedMotion()) return;
    gsap.fromTo(
      el,
      { scale: 1 },
      { scale: 1.045, duration: 0.15, yoyo: true, repeat: 1, ease: 'power2.out', transformOrigin: '50% 62%' },
    );
  }, []);

  const playSpawnIn = useCallback(
    (id: string) => {
      const cell = cells.current.get(id);
      // Wipe any transform a previously-interrupted run may have frozen this
      // card at BEFORE building the new timeline, so we start from a clean slot.
      killTimeline(id);
      if (!cell) return;
      gsap.set(cell, { clearProps: 'all' });
      const slot = slots.current.get(id);

      if (prefersReducedMotion()) {
        slot?.setExpression('working');
        return;
      }

      heroPulse();

      const tl = gsap.timeline({
        onComplete: () => {
          // Fully clear the card's animation transform so nothing is left parked
          // out of its grid slot — the card rests in natural flow.
          gsap.set(cell, { clearProps: 'all' });
          timelines.current.delete(id);
        },
      });

      // Contained arrival: drop-in from just above + scale-up. immediateRender
      // false → the "from" state is only applied when this tween actually starts.
      tl.fromTo(
        cell,
        { y: -26, scale: 0.42, opacity: 0 },
        { y: 0, scale: 1, opacity: 1, duration: 0.52, ease: 'back.out(1.7)', immediateRender: false },
      );

      // Flip the mini to a working pose + a small pop as it lands.
      tl.call(
        () => {
          slot?.setExpression('working');
          slot?.pulse();
        },
        undefined,
        0.3,
      );

      timelines.current.set(id, tl);
    },
    [heroPulse, killTimeline],
  );

  const playDespawn = useCallback(
    (id: string, onDone: () => void) => {
      const cell = cells.current.get(id);
      killTimeline(id);
      if (!cell || prefersReducedMotion()) {
        onDone();
        return;
      }
      const slot = slots.current.get(id);
      slot?.setExpression('sleeping');

      const tl = gsap.timeline({
        onComplete: () => {
          timelines.current.delete(id);
          onDone();
        },
      });
      // Sucked back toward the pool: shrink + fade + a touch of downward drift.
      tl.to(cell, {
        y: 14,
        scale: 0.55,
        opacity: 0,
        duration: 0.42,
        ease: 'power2.in',
        immediateRender: false,
      });

      timelines.current.set(id, tl);
    },
    [killTimeline],
  );

  const cleanup = useCallback(() => {
    timelines.current.forEach((tl) => tl.kill());
    timelines.current.clear();
  }, []);

  const registerCell = useCallback(
    (id: string) => (el: HTMLElement | null) => {
      if (el) cells.current.set(id, el);
      else cells.current.delete(id);
    },
    [],
  );

  const registerSlot = useCallback(
    (id: string) => (h: FlubberSlotHandle | null) => {
      if (h) slots.current.set(id, h);
      else slots.current.delete(id);
    },
    [],
  );

  const heroRef = useCallback((el: HTMLElement | null) => {
    hero.current = el;
  }, []);

  // Stable object identity — every member is a stable useCallback, so consumers
  // can safely list `spawn` in effect dependency arrays without thrashing.
  return useMemo(
    () => ({ heroRef, registerCell, registerSlot, playSpawnIn, playDespawn, cleanup }),
    [heroRef, registerCell, registerSlot, playSpawnIn, playDespawn, cleanup],
  );
}
