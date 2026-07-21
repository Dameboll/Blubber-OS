'use client';

/**
 * Reaction Tap -- a blob sits dim and waits, then flashes bright at a random
 * delay; tap/click/Space as fast as possible. Five rounds, average reaction
 * time decides the XP. Tapping before the flash ("false start") counts as
 * the worst-case penalty time for that round rather than being ignored, so
 * impatient mashing is punished instead of free.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import GameChrome from './GameChrome';
import { BigTapButton } from './Controls';
import { useHiDPICanvas, clampXp } from './hooks';
import { PALETTE, drawGooBlob } from './palette';
import type { GameComponentProps, GameStatus } from './types';

const W = 360;
const H = 240;
const ROUNDS = 5;
const FALSE_START_PENALTY_MS = 900;
const MIN_DELAY_MS = 800;
const MAX_DELAY_MS = 2200;
const ADVANCE_DELAY_MS = 700;

type Phase = 'waiting' | 'active' | 'result';

export default function ReactionTapGame({ best, onExit, onFinish }: GameComponentProps) {
  const { canvasRef, ctxRef } = useHiDPICanvas(W, H);

  const phaseRef = useRef<Phase>('waiting');
  const activatedAtRef = useRef(0);
  const timesRef = useRef<number[]>([]);
  const scheduleTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const advanceTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const finishedRef = useRef(false);
  const pausedAtRef = useRef<number | null>(null);

  const [round, setRound] = useState(1);
  const [phase, setPhase] = useState<Phase>('waiting');
  const [lastResultMs, setLastResultMs] = useState<number | null>(null);
  const [status, setStatus] = useState<GameStatus>('playing');
  const [xpEarned, setXpEarned] = useState<number | undefined>(undefined);
  const [avgScore, setAvgScore] = useState(0);

  const clearTimers = useCallback(() => {
    if (scheduleTimeoutRef.current) clearTimeout(scheduleTimeoutRef.current);
    if (advanceTimeoutRef.current) clearTimeout(advanceTimeoutRef.current);
  }, []);

  const draw = useCallback(() => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    ctx.fillStyle = PALETTE.bgSurface;
    ctx.fillRect(0, 0, W, H);

    const cx = W / 2;
    const cy = H / 2 - 10;
    const active = phaseRef.current === 'active';
    drawGooBlob(ctx, cx, cy, active ? 46 : 34, active ? PALETTE.accentBright : PALETTE.accent);

    ctx.fillStyle = PALETTE.textSecondary;
    ctx.font = "13px 'DM Sans', sans-serif";
    ctx.textAlign = 'center';
    const label =
      phaseRef.current === 'waiting'
        ? 'Wait for it...'
        : phaseRef.current === 'active'
          ? 'TAP NOW!'
          : lastResultMs === null
            ? 'Too soon!'
            : `${lastResultMs}ms`;
    ctx.fillText(label, cx, H - 24);
    ctx.textAlign = 'left';
  }, [ctxRef, lastResultMs]);

  useEffect(() => {
    draw();
  }, [draw, phase]);

  const scheduleActivate = useCallback(() => {
    phaseRef.current = 'waiting';
    setPhase('waiting');
    const delay = MIN_DELAY_MS + Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS);
    scheduleTimeoutRef.current = setTimeout(() => {
      phaseRef.current = 'active';
      activatedAtRef.current = performance.now();
      setPhase('active');
      draw();
    }, delay);
  }, [draw]);

  const finish = useCallback(
    (times: number[]) => {
      if (finishedRef.current) return;
      finishedRef.current = true;
      const avg = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
      const xp = clampXp(15 - Math.floor(avg / 70));
      setAvgScore(avg);
      setXpEarned(xp);
      setStatus('over');
      onFinish(avg, xp);
    },
    [onFinish],
  );

  const advanceRound = useCallback(() => {
    advanceTimeoutRef.current = setTimeout(() => {
      if (timesRef.current.length >= ROUNDS) {
        finish(timesRef.current);
        return;
      }
      setRound(timesRef.current.length + 1);
      scheduleActivate();
    }, ADVANCE_DELAY_MS);
  }, [finish, scheduleActivate]);

  const handleTap = useCallback(() => {
    if (status !== 'playing' || finishedRef.current) return;
    if (phaseRef.current === 'result') return;

    if (scheduleTimeoutRef.current) clearTimeout(scheduleTimeoutRef.current);

    if (phaseRef.current === 'waiting') {
      timesRef.current = [...timesRef.current, FALSE_START_PENALTY_MS];
      setLastResultMs(null);
    } else {
      const reaction = Math.round(performance.now() - activatedAtRef.current);
      timesRef.current = [...timesRef.current, reaction];
      setLastResultMs(reaction);
    }
    phaseRef.current = 'result';
    setPhase('result');
    draw();
    advanceRound();
  }, [status, draw, advanceRound]);

  useEffect(() => {
    scheduleActivate();
    return () => {
      clearTimers();
    };
    // Runs once on mount to kick off round 1; reset() below re-triggers it explicitly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        handleTap();
      } else if (e.key === 'p' || e.key === 'P') {
        setStatus((s) => (s === 'playing' ? 'paused' : s === 'paused' ? 'playing' : s));
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleTap]);

  // Pausing must actually freeze the round timers -- otherwise the flash or
  // the next-round advance would fire silently behind the Paused overlay.
  // Resuming reschedules a waiting round, or shifts the activation timestamp
  // forward by the paused duration so an already-active round's reaction
  // time doesn't include time spent paused.
  useEffect(() => {
    if (status === 'paused') {
      pausedAtRef.current = performance.now();
      if (scheduleTimeoutRef.current) clearTimeout(scheduleTimeoutRef.current);
      if (advanceTimeoutRef.current) clearTimeout(advanceTimeoutRef.current);
    } else if (status === 'playing' && pausedAtRef.current !== null) {
      const pausedMs = performance.now() - pausedAtRef.current;
      pausedAtRef.current = null;
      if (phaseRef.current === 'waiting') {
        scheduleActivate();
      } else if (phaseRef.current === 'active') {
        activatedAtRef.current += pausedMs;
      } else if (phaseRef.current === 'result') {
        advanceRound();
      }
    }
  }, [status, scheduleActivate, advanceRound]);

  const reset = useCallback(() => {
    clearTimers();
    finishedRef.current = false;
    timesRef.current = [];
    phaseRef.current = 'waiting';
    setLastResultMs(null);
    setXpEarned(undefined);
    setAvgScore(0);
    setStatus('playing');
    setRound(1);
    scheduleActivate();
  }, [clearTimers, scheduleActivate]);

  return (
    <div className="reaction-tap-game">
      <GameChrome
        title="Reaction Tap"
        score={status === 'over' ? avgScore : round}
        best={best}
        status={status}
        xpEarned={xpEarned}
        hint={`Round ${Math.min(round, ROUNDS)} of ${ROUNDS} -- tap the blob, press Space, or hit the button below.`}
        onPauseToggle={() => setStatus((s) => (s === 'playing' ? 'paused' : s === 'paused' ? 'playing' : s))}
        onExit={onExit}
        onRestart={reset}
      >
        <canvas ref={canvasRef} onPointerDown={handleTap} />
      </GameChrome>
      <div className="game-controls-row">
        <BigTapButton onTap={handleTap}>TAP!</BigTapButton>
      </div>
    </div>
  );
}
