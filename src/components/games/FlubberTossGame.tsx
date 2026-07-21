'use client';

/**
 * Blubber Toss -- drag-and-release angle+power arc toss of a mini goo blob
 * into moving vats. Aiming works two ways at once: press-drag from the
 * launcher (pointer/touch, "joystick" style -- the drag vector IS the aim)
 * or keyboard (Left/Right steps angle, Up/Down steps power, Space/Enter
 * throws at the currently-held angle/power). A fixed number of throws make
 * up one session.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import GameChrome from './GameChrome';
import { useAnimationFrame, useHiDPICanvas, clampXp } from './hooks';
import { PALETTE, drawGooBlob, roundedRect } from './palette';
import type { GameComponentProps, GameStatus } from './types';

const W = 420;
const H = 320;
const ANCHOR = { x: 55, y: H - 36 };
const GRAVITY = 950; // px/s^2
const MAX_SPEED = 560;
const MAX_DRAG = 90; // px of drag == full power
const MAX_THROWS = 6;
const BLOB_R = 10;

interface Vat {
  baseX: number;
  y: number;
  width: number;
  speed: number;
  phase: number;
  amplitude: number;
}

const VATS: Vat[] = [
  { baseX: 190, y: 46, width: 46, speed: 1.1, phase: 0, amplitude: 40 },
  { baseX: 300, y: 46, width: 40, speed: 1.6, phase: 2.1, amplitude: 30 },
  { baseX: 380, y: 46, width: 36, speed: 0.9, phase: 4.2, amplitude: 22 },
];

function vatX(vat: Vat, t: number): number {
  return vat.baseX + Math.sin(t * vat.speed + vat.phase) * vat.amplitude;
}

interface Flight {
  x: number;
  y: number;
  vx: number;
  vy: number;
  trail: { x: number; y: number }[];
}

export default function FlubberTossGame({ reduceMotion, best, onExit, onFinish }: GameComponentProps) {
  const { canvasRef, ctxRef } = useHiDPICanvas(W, H);

  const elapsedRef = useRef(0);
  const angleRef = useRef(42);
  const powerRef = useRef(0.7);
  const draggingRef = useRef(false);
  const flightRef = useRef<Flight | null>(null);
  const finishedRef = useRef(false);
  const hitsRef = useRef(0);
  const throwsTakenRef = useRef(0);

  const [throwsTaken, setThrowsTaken] = useState(0);
  const [hits, setHits] = useState(0);
  const [status, setStatus] = useState<GameStatus>('playing');
  const [xpEarned, setXpEarned] = useState<number | undefined>(undefined);

  const reset = useCallback(() => {
    elapsedRef.current = 0;
    angleRef.current = 42;
    powerRef.current = 0.7;
    draggingRef.current = false;
    flightRef.current = null;
    finishedRef.current = false;
    hitsRef.current = 0;
    throwsTakenRef.current = 0;
    setThrowsTaken(0);
    setHits(0);
    setXpEarned(undefined);
    setStatus('playing');
  }, []);

  const finish = useCallback(
    (finalHits: number) => {
      if (finishedRef.current) return;
      finishedRef.current = true;
      const xp = clampXp(5 + finalHits * 1.8);
      setXpEarned(xp);
      setStatus('over');
      onFinish(finalHits, xp);
    },
    [onFinish],
  );

  const throwBlubber = useCallback(() => {
    if (flightRef.current || finishedRef.current) return;
    const angleRad = (angleRef.current * Math.PI) / 180;
    const speed = MAX_SPEED * powerRef.current;
    flightRef.current = {
      x: ANCHOR.x,
      y: ANCHOR.y,
      vx: Math.cos(angleRad) * speed,
      vy: -Math.sin(angleRad) * speed,
      trail: [],
    };
  }, []);

  const resolveThrow = useCallback(
    (hit: boolean) => {
      flightRef.current = null;
      if (hit) hitsRef.current += 1;
      throwsTakenRef.current += 1;
      setHits(hitsRef.current);
      setThrowsTaken(throwsTakenRef.current);
      if (throwsTakenRef.current >= MAX_THROWS) finish(hitsRef.current);
    },
    [finish],
  );

  const draw = useCallback(() => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    ctx.fillStyle = PALETTE.bgSurface;
    ctx.fillRect(0, 0, W, H);

    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.beginPath();
    ctx.moveTo(0, H - 20);
    ctx.lineTo(W, H - 20);
    ctx.stroke();

    const t = elapsedRef.current;
    VATS.forEach((vat) => {
      const x = vatX(vat, t);
      ctx.fillStyle = PALETTE.bgElevated;
      roundedRect(ctx, x - vat.width / 2, vat.y - 14, vat.width, 28, 8);
      ctx.fill();
      ctx.strokeStyle = PALETTE.accent;
      ctx.lineWidth = 2;
      roundedRect(ctx, x - vat.width / 2, vat.y - 14, vat.width, 28, 8);
      ctx.stroke();
    });

    // Aim line (only while grounded and not mid-flight).
    if (!flightRef.current && status === 'playing') {
      const angleRad = (angleRef.current * Math.PI) / 180;
      const len = 30 + powerRef.current * 60;
      ctx.strokeStyle = PALETTE.accentBright;
      ctx.setLineDash([4, 5]);
      ctx.beginPath();
      ctx.moveTo(ANCHOR.x, ANCHOR.y);
      ctx.lineTo(ANCHOR.x + Math.cos(angleRad) * len, ANCHOR.y - Math.sin(angleRad) * len);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Launcher blob.
    if (!flightRef.current) {
      drawGooBlob(ctx, ANCHOR.x, ANCHOR.y, BLOB_R + 2);
    }

    const flight = flightRef.current;
    if (flight) {
      if (!reduceMotion) {
        flight.trail.forEach((p, i) => {
          const a = (i / flight.trail.length) * 0.35;
          ctx.fillStyle = `rgba(57,255,20,${a})`;
          ctx.beginPath();
          ctx.arc(p.x, p.y, BLOB_R * 0.6, 0, Math.PI * 2);
          ctx.fill();
        });
      }
      drawGooBlob(ctx, flight.x, flight.y, BLOB_R);
    }

    ctx.fillStyle = PALETTE.textSecondary;
    ctx.font = "12px 'DM Sans', sans-serif";
    ctx.fillText(`Throws left: ${MAX_THROWS - throwsTaken}`, 12, 20);
  }, [ctxRef, status, throwsTaken, reduceMotion]);

  const tick = useCallback(
    (dtMs: number) => {
      elapsedRef.current += dtMs / 1000;
      const flight = flightRef.current;
      if (flight) {
        const dt = dtMs / 1000;
        flight.trail.push({ x: flight.x, y: flight.y });
        if (flight.trail.length > 10) flight.trail.shift();
        flight.vy += GRAVITY * dt;
        flight.x += flight.vx * dt;
        flight.y += flight.vy * dt;

        let resolved = false;
        for (const vat of VATS) {
          const vx = vatX(vat, elapsedRef.current);
          if (
            flight.y - BLOB_R < vat.y + 14 &&
            flight.y + BLOB_R > vat.y - 14 &&
            flight.x > vx - vat.width / 2 &&
            flight.x < vx + vat.width / 2 &&
            flight.vy > 0
          ) {
            resolveThrow(true);
            resolved = true;
            break;
          }
        }
        if (!resolved && (flight.y > H + 20 || flight.x > W + 20 || flight.x < -20)) {
          resolveThrow(false);
        }
      }
      draw();
    },
    [draw, resolveThrow],
  );

  useAnimationFrame(tick, status === 'playing');
  useEffect(() => {
    if (status !== 'playing') draw();
  }, [status, draw]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (flightRef.current) return;
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        angleRef.current = Math.max(10, angleRef.current - 3);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        angleRef.current = Math.min(80, angleRef.current + 3);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        powerRef.current = Math.min(1, powerRef.current + 0.05);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        powerRef.current = Math.max(0.3, powerRef.current - 0.05);
      } else if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        throwBlubber();
      } else if (e.key === 'p' || e.key === 'P') {
        setStatus((s) => (s === 'playing' ? 'paused' : s === 'paused' ? 'playing' : s));
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [throwBlubber]);

  const updateAimFromPointer = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * W;
    const y = ((clientY - rect.top) / rect.height) * H;
    const dx = x - ANCHOR.x;
    const dy = ANCHOR.y - y;
    const dist = Math.hypot(dx, dy);
    if (dist < 4) return;
    const angleDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
    angleRef.current = Math.min(80, Math.max(10, angleDeg));
    powerRef.current = Math.min(1, Math.max(0.3, dist / MAX_DRAG));
  }, [canvasRef]);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (flightRef.current || status !== 'playing') return;
      draggingRef.current = true;
      e.currentTarget.setPointerCapture(e.pointerId);
      updateAimFromPointer(e.clientX, e.clientY);
    },
    [status, updateAimFromPointer],
  );
  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!draggingRef.current) return;
      updateAimFromPointer(e.clientX, e.clientY);
    },
    [updateAimFromPointer],
  );
  const handlePointerUp = useCallback(() => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    throwBlubber();
  }, [throwBlubber]);

  return (
    <GameChrome
      title="Blubber Toss"
      score={hits}
      best={best}
      status={status}
      xpEarned={xpEarned}
      hint="Drag from the launcher and release, or Arrows to aim + Space to throw."
      onPauseToggle={() => setStatus((s) => (s === 'playing' ? 'paused' : s === 'paused' ? 'playing' : s))}
      onExit={onExit}
      onRestart={reset}
    >
      <canvas
        ref={canvasRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      />
    </GameChrome>
  );
}
