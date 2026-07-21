'use client';

/**
 * Flubber3D — the universal live-3D Blubber slot (Phase 1 of
 * docs/plans/flubber-3d-everywhere.md). Renders a plain 2D <canvas> that the
 * shared FlubberHost blits into every frame — one WebGL context total no
 * matter how many of these mount (Agents grid shows 10–20 at once).
 *
 * PROP CONTRACT (drop-in for the old FlubberCharacter character mode):
 *   <Flubber3D
 *     expression="waving"   // same 20-expression vocabulary
 *     size={96}             // CSS px, square stage
 *     pulseKey={n}          // increment → one-shot squash/rebound
 *     tier="mid"            // optional override; auto from size otherwise:
 *                           //   ≥160 hero · 64–159 mid · <64 micro
 *     seed={i}              // optional — desyncs blinks/clips across a grid
 *   />
 *
 * REQUESTING SHINY MINIS (LANE M): pass tier="mid" on a SMALL slot (<64px) to
 * render the shiny clearcoat-goo jelly the size logic would otherwise flatten
 * to micro. e.g. <Flubber3D tier="mid" size={44} expression="happy" />. The
 * shared host enforces a global MID budget (MAX_MID_BODIES) and silently grants
 * micro past it — density degrades gracefully, no caller breaks. HERO (full
 * transmission) stays reserved for ≥160px; minis get MID, never HERO.
 */

import { useEffect, useRef } from 'react';
import { getFlubberHost, type FlubberSlotHandle } from '../lib/flubber3d/host';
import type { FlubberAccessory, FlubberScene, FlubberTier } from '../lib/flubber3d/instance';

export interface Flubber3DProps {
  expression?: string;
  size?: number;
  pulseKey?: number;
  tier?: FlubberTier;
  seed?: number;
  /** Scene variant — 'workstation' gives the agent a desk/laptop/holo (mid tier). */
  scene?: FlubberScene;
  /** Worn accessory attached to the Head bone (e.g. 'dj-headphones'). */
  accessory?: FlubberAccessory;
  /** Wire pointer hover/click reactions on the slot canvas (opt-in — the
   * Blubber turns/hops/reacts when poked; see host.ts `interactive`). */
  interactive?: boolean;
  /** Receives the live slot handle once registered (null on unmount) — lets a
   * parent drive setWorkstation()/pulse() imperatively (spawn choreography). */
  onSlotReady?: (handle: FlubberSlotHandle | null) => void;
  className?: string;
}

export function tierForSize(size: number): FlubberTier {
  if (size >= 160) return 'hero';
  if (size >= 64) return 'mid';
  return 'micro';
}

export default function Flubber3D({
  expression = 'idle',
  size = 96,
  pulseKey,
  tier,
  seed,
  scene,
  accessory,
  interactive,
  onSlotReady,
  className,
}: Flubber3DProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const handleRef = useRef<FlubberSlotHandle | null>(null);
  const onSlotReadyRef = useRef(onSlotReady);
  onSlotReadyRef.current = onSlotReady;
  const prevPulseKeyRef = useRef(pulseKey);
  const resolvedTier = tier ?? tierForSize(size);

  // Register the slot once per tier/scene change (rebuilds the instance;
  // expression/size/pulse are cheap live updates on the existing handle).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const handle = getFlubberHost().register(canvas, {
      tier: resolvedTier,
      expression,
      size,
      seed,
      scene,
      accessory,
      interactive,
    });
    handleRef.current = handle;
    onSlotReadyRef.current?.(handle);
    return () => {
      onSlotReadyRef.current?.(null);
      handleRef.current = null;
      handle.dispose();
    };
    // expression/size intentionally not deps — updated via the handle below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolvedTier, seed, scene, accessory, interactive]);

  useEffect(() => {
    handleRef.current?.setExpression(expression);
  }, [expression]);

  useEffect(() => {
    handleRef.current?.setSize(size);
  }, [size]);

  useEffect(() => {
    if (pulseKey !== undefined && pulseKey !== prevPulseKeyRef.current) {
      handleRef.current?.pulse();
    }
    prevPulseKeyRef.current = pulseKey;
  }, [pulseKey]);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      data-flubber-3d={resolvedTier}
      aria-hidden="true"
      style={{ width: size, height: size, display: 'block' }}
    />
  );
}
