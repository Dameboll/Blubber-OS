'use client';

/**
 * Pong vs a simple AI -- goo paddles, first to WIN_SCORE takes the match.
 * Player paddle is controlled by held Up/Down (or W/S) keys AND by
 * press-and-drag on the canvas itself (pointer capture makes this work
 * identically for mouse and touch). The AI paddle chases the ball's Y with a
 * capped speed so it is beatable, not psychic.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import GameChrome from './GameChrome';
import { useAnimationFrame, useHiDPICanvas, clampXp } from './hooks';
import { PALETTE, drawGooBlob, roundedRect } from './palette';
import type { GameComponentProps, GameStatus } from './types';

const W = 480;
const H = 300;
const PADDLE_W = 12;
const PADDLE_H = 64;
const BALL_R = 7;
const PLAYER_SPEED = 320; // px/s while a key is held
const AI_SPEED = 220; // px/s cap, deliberately slower than the player's max
const WIN_SCORE = 5;

function resetBall(direction: 1 | -1) {
  const angle = (Math.random() * 0.5 - 0.25) * Math.PI; // +/- 45deg off horizontal
  const speed = 240;
  return {
    x: W / 2,
    y: H / 2,
    vx: Math.cos(angle) * speed * direction,
    vy: Math.sin(angle) * speed,
  };
}

export default function PongGame({ reduceMotion, best, onExit, onFinish }: GameComponentProps) {
  const { canvasRef, ctxRef } = useHiDPICanvas(W, H);

  const playerYRef = useRef(H / 2 - PADDLE_H / 2);
  const aiYRef = useRef(H / 2 - PADDLE_H / 2);
  const ballRef = useRef(resetBall(1));
  const heldRef = useRef({ up: false, down: false });
  const draggingRef = useRef(false);
  const aiScoreRef = useRef(0);
  const finishedRef = useRef(false);

  const [playerScore, setPlayerScore] = useState(0);
  const [status, setStatus] = useState<GameStatus>('playing');
  const [xpEarned, setXpEarned] = useState<number | undefined>(undefined);

  const reset = useCallback(() => {
    playerYRef.current = H / 2 - PADDLE_H / 2;
    aiYRef.current = H / 2 - PADDLE_H / 2;
    ballRef.current = resetBall(1);
    aiScoreRef.current = 0;
    finishedRef.current = false;
    setPlayerScore(0);
    setXpEarned(undefined);
    setStatus('playing');
  }, []);

  const finish = useCallback(
    (won: boolean, finalPlayerScore: number) => {
      if (finishedRef.current) return;
      finishedRef.current = true;
      const xp = won
        ? clampXp(10 + (WIN_SCORE - aiScoreRef.current))
        : clampXp(5 + finalPlayerScore);
      setXpEarned(xp);
      setStatus('over');
      onFinish(finalPlayerScore, xp);
    },
    [onFinish],
  );

  const draw = useCallback(() => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    ctx.fillStyle = PALETTE.bgSurface;
    ctx.fillRect(0, 0, W, H);

    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.setLineDash([6, 8]);
    ctx.beginPath();
    ctx.moveTo(W / 2, 0);
    ctx.lineTo(W / 2, H);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = PALETTE.accentBright;
    roundedRect(ctx, 8, playerYRef.current, PADDLE_W, PADDLE_H, 5);
    ctx.fill();
    ctx.fillStyle = PALETTE.accent;
    roundedRect(ctx, W - 8 - PADDLE_W, aiYRef.current, PADDLE_W, PADDLE_H, 5);
    ctx.fill();

    const ball = ballRef.current;
    drawGooBlob(ctx, ball.x, ball.y, BALL_R);
  }, [ctxRef]);

  const tick = useCallback(
    (dtMs: number) => {
      const dt = dtMs / 1000;
      const held = heldRef.current;
      if (held.up) playerYRef.current -= PLAYER_SPEED * dt;
      if (held.down) playerYRef.current += PLAYER_SPEED * dt;
      playerYRef.current = Math.min(H - PADDLE_H, Math.max(0, playerYRef.current));

      const ball = ballRef.current;
      const aiCenter = aiYRef.current + PADDLE_H / 2;
      const aiTarget = ball.y;
      const aiDelta = Math.max(-AI_SPEED * dt, Math.min(AI_SPEED * dt, aiTarget - aiCenter));
      aiYRef.current = Math.min(H - PADDLE_H, Math.max(0, aiYRef.current + aiDelta));

      ball.x += ball.vx * dt;
      ball.y += ball.vy * dt;

      if (ball.y - BALL_R < 0) {
        ball.y = BALL_R;
        ball.vy *= -1;
      } else if (ball.y + BALL_R > H) {
        ball.y = H - BALL_R;
        ball.vy *= -1;
      }

      // Player paddle collision (left side).
      if (
        ball.vx < 0 &&
        ball.x - BALL_R < 8 + PADDLE_W &&
        ball.x - BALL_R > 8 &&
        ball.y > playerYRef.current &&
        ball.y < playerYRef.current + PADDLE_H
      ) {
        ball.x = 8 + PADDLE_W + BALL_R;
        ball.vx *= -1.05;
        const offset = (ball.y - (playerYRef.current + PADDLE_H / 2)) / (PADDLE_H / 2);
        ball.vy = offset * 260;
      }

      // AI paddle collision (right side).
      if (
        ball.vx > 0 &&
        ball.x + BALL_R > W - 8 - PADDLE_W &&
        ball.x + BALL_R < W - 8 &&
        ball.y > aiYRef.current &&
        ball.y < aiYRef.current + PADDLE_H
      ) {
        ball.x = W - 8 - PADDLE_W - BALL_R;
        ball.vx *= -1.05;
        const offset = (ball.y - (aiYRef.current + PADDLE_H / 2)) / (PADDLE_H / 2);
        ball.vy = offset * 260;
      }

      if (ball.x < -BALL_R) {
        aiScoreRef.current += 1;
        if (aiScoreRef.current >= WIN_SCORE) {
          finish(false, playerScore);
        } else {
          ballRef.current = resetBall(1);
        }
      } else if (ball.x > W + BALL_R) {
        const next = playerScore + 1;
        setPlayerScore(next);
        if (next >= WIN_SCORE) {
          finish(true, next);
        } else {
          ballRef.current = resetBall(-1);
        }
      }

      draw();
    },
    [draw, finish, playerScore],
  );

  useAnimationFrame(tick, status === 'playing');

  useEffect(() => {
    if (status !== 'playing') draw();
  }, [status, draw]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowUp' || e.key === 'w' || e.key === 'W') {
        e.preventDefault();
        heldRef.current.up = true;
      } else if (e.key === 'ArrowDown' || e.key === 's' || e.key === 'S') {
        e.preventDefault();
        heldRef.current.down = true;
      } else if (e.key === ' ') {
        e.preventDefault();
        setStatus((s) => (s === 'playing' ? 'paused' : s === 'paused' ? 'playing' : s));
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'ArrowUp' || e.key === 'w' || e.key === 'W') heldRef.current.up = false;
      if (e.key === 'ArrowDown' || e.key === 's' || e.key === 'S') heldRef.current.down = false;
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, []);

  const movePaddleTo = useCallback((clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const y = ((clientY - rect.top) / rect.height) * H;
    playerYRef.current = Math.min(H - PADDLE_H, Math.max(0, y - PADDLE_H / 2));
  }, [canvasRef]);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      draggingRef.current = true;
      e.currentTarget.setPointerCapture(e.pointerId);
      movePaddleTo(e.clientY);
    },
    [movePaddleTo],
  );
  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!draggingRef.current) return;
      movePaddleTo(e.clientY);
    },
    [movePaddleTo],
  );
  const handlePointerUp = useCallback(() => {
    draggingRef.current = false;
  }, []);

  void reduceMotion;

  return (
    <GameChrome
      title="Pong"
      score={playerScore}
      best={best}
      status={status}
      xpEarned={xpEarned}
      hint="Hold Up/Down or W/S -- or drag on the table. First to 5 wins."
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
