/**
 * Shared canvas + loop plumbing for every game in this folder. Keeping this
 * in one place means every game cancels its rAF and cleans up its listeners
 * the same, verified way instead of six slightly-different copies.
 */

import { useEffect, useRef } from 'react';

/**
 * Allocates a HiDPI-correct canvas: the backing buffer is sized in real
 * device pixels (capped at 3x to avoid pointless memory use on very dense
 * displays) while the element is laid out at `logicalWidth x logicalHeight`
 * CSS pixels via aspect-ratio, so all drawing code below can keep working in
 * plain logical coordinates.
 */
export function useHiDPICanvas(logicalWidth: number, logicalHeight: number) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    canvas.width = Math.round(logicalWidth * dpr);
    canvas.height = Math.round(logicalHeight * dpr);
    canvas.style.aspectRatio = `${logicalWidth} / ${logicalHeight}`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctxRef.current = ctx;
  }, [logicalWidth, logicalHeight]);

  return { canvasRef, ctxRef };
}

/**
 * requestAnimationFrame loop with a clamped delta-time (guards against a
 * huge jump if the tab was backgrounded) that fully cancels on unmount AND
 * whenever `isRunning` flips to false (pause). Resuming restarts the delta
 * clock so the first frame after unpausing never reports paused-time as
 * elapsed game time.
 */
export function useAnimationFrame(callback: (deltaMs: number) => void, isRunning: boolean): void {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    if (!isRunning) return;
    let rafId = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(now - last, 50);
      last = now;
      callbackRef.current(dt);
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [isRunning]);
}

/** Reads a canvas's own pointer/touch position in logical (unscaled) pixels. */
export function getCanvasPoint(
  canvas: HTMLCanvasElement,
  clientX: number,
  clientY: number,
  logicalWidth: number,
  logicalHeight: number,
): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  const x = ((clientX - rect.left) / rect.width) * logicalWidth;
  const y = ((clientY - rect.top) / rect.height) * logicalHeight;
  return { x, y };
}

/** Clamp + round an XP award into the 5-15 contract every game reports. */
export function clampXp(value: number): number {
  return Math.round(Math.min(15, Math.max(5, value)));
}
