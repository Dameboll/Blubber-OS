'use client';

/**
 * Snake -- slime trail eating green goo blobs on an 18x18 grid. Movement is
 * a fixed-tick simulation (independent of display refresh rate) driven by
 * the shared rAF loop in hooks.ts; all snake/food state lives in refs so the
 * hot path never triggers a React re-render, only score/status do.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import GameChrome from './GameChrome';
import { DPad, type DPadDirection } from './Controls';
import { useAnimationFrame, useHiDPICanvas, clampXp } from './hooks';
import { PALETTE, drawGooBlob } from './palette';
import type { GameComponentProps, GameStatus } from './types';

const GRID = 18;
const CELL = 20;
const SIZE = GRID * CELL;
const START_TICK_MS = 150;
const MIN_TICK_MS = 85;

interface Cell {
  x: number;
  y: number;
}

const DIRS: Record<DPadDirection, Cell> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

function randomEmptyCell(occupied: Cell[]): Cell {
  let cell: Cell;
  do {
    cell = { x: Math.floor(Math.random() * GRID), y: Math.floor(Math.random() * GRID) };
  } while (occupied.some((c) => c.x === cell.x && c.y === cell.y));
  return cell;
}

export default function SnakeGame({ reduceMotion, best, onExit, onFinish }: GameComponentProps) {
  const { canvasRef, ctxRef } = useHiDPICanvas(SIZE, SIZE);

  const snakeRef = useRef<Cell[]>([{ x: 9, y: 9 }, { x: 8, y: 9 }, { x: 7, y: 9 }]);
  const dirRef = useRef<Cell>(DIRS.right);
  const queuedDirRef = useRef<Cell>(DIRS.right);
  const foodRef = useRef<Cell>(randomEmptyCell(snakeRef.current));
  const accumulatorRef = useRef(0);
  const tickMsRef = useRef(START_TICK_MS);
  const finishedRef = useRef(false);

  const [score, setScore] = useState(0);
  const [status, setStatus] = useState<GameStatus>('playing');
  const [xpEarned, setXpEarned] = useState<number | undefined>(undefined);

  const reset = useCallback(() => {
    snakeRef.current = [{ x: 9, y: 9 }, { x: 8, y: 9 }, { x: 7, y: 9 }];
    dirRef.current = DIRS.right;
    queuedDirRef.current = DIRS.right;
    foodRef.current = randomEmptyCell(snakeRef.current);
    accumulatorRef.current = 0;
    tickMsRef.current = START_TICK_MS;
    finishedRef.current = false;
    setScore(0);
    setXpEarned(undefined);
    setStatus('playing');
  }, []);

  const turn = useCallback((dir: DPadDirection) => {
    const next = DIRS[dir];
    const cur = dirRef.current;
    // Ignore direct 180-degree reversal (would instantly self-collide).
    if (next.x === -cur.x && next.y === -cur.y) return;
    queuedDirRef.current = next;
  }, []);

  const finish = useCallback(
    (finalScore: number) => {
      if (finishedRef.current) return;
      finishedRef.current = true;
      const xp = clampXp(5 + finalScore * 1.4);
      setXpEarned(xp);
      setStatus('over');
      onFinish(finalScore, xp);
    },
    [onFinish],
  );

  const draw = useCallback(() => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    ctx.fillStyle = PALETTE.bgSurface;
    ctx.fillRect(0, 0, SIZE, SIZE);

    ctx.strokeStyle = 'rgba(255,255,255,0.03)';
    for (let i = 1; i < GRID; i++) {
      ctx.beginPath();
      ctx.moveTo(i * CELL, 0);
      ctx.lineTo(i * CELL, SIZE);
      ctx.moveTo(0, i * CELL);
      ctx.lineTo(SIZE, i * CELL);
      ctx.stroke();
    }

    const food = foodRef.current;
    drawGooBlob(ctx, food.x * CELL + CELL / 2, food.y * CELL + CELL / 2, CELL * 0.38, PALETTE.warning);

    const snake = snakeRef.current;
    snake.forEach((seg, i) => {
      const t = i / Math.max(1, snake.length - 1);
      const r = CELL * 0.46 * (1 - t * 0.35);
      drawGooBlob(ctx, seg.x * CELL + CELL / 2, seg.y * CELL + CELL / 2, r);
    });
  }, [ctxRef]);

  const step = useCallback(() => {
    dirRef.current = queuedDirRef.current;
    const head = nextHead(snakeRef.current, dirRef.current);
    const ateFood = head.x === foodRef.current.x && head.y === foodRef.current.y;

    const hitWall = head.x < 0 || head.y < 0 || head.x >= GRID || head.y >= GRID;
    // The tail segment vacates this tick unless we just ate (in which case
    // it stays put and growing into it is a real collision) -- exclude it
    // from the check so a tight turn into the about-to-move-away tail isn't
    // a false game-over.
    const body = ateFood ? snakeRef.current : snakeRef.current.slice(0, -1);
    const hitSelf = body.some((s) => s.x === head.x && s.y === head.y);
    if (hitWall || hitSelf) {
      finish(score);
      return;
    }

    const nextSnake = [head, ...snakeRef.current];
    if (ateFood) {
      foodRef.current = randomEmptyCell(nextSnake);
      tickMsRef.current = Math.max(MIN_TICK_MS, tickMsRef.current - 4);
      setScore((s) => s + 1);
    } else {
      nextSnake.pop();
    }
    snakeRef.current = nextSnake;
  }, [finish, score]);

  useAnimationFrame(
    (dt) => {
      accumulatorRef.current += dt;
      while (accumulatorRef.current >= tickMsRef.current) {
        accumulatorRef.current -= tickMsRef.current;
        step();
        if (finishedRef.current) break;
      }
      draw();
    },
    status === 'playing',
  );

  // Draw the resting frame once whenever we're not actively looping (paused
  // or freshly mounted before the first rAF tick fires).
  useEffect(() => {
    if (status !== 'playing') draw();
  }, [status, draw]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const map: Record<string, DPadDirection | undefined> = {
        ArrowUp: 'up',
        ArrowDown: 'down',
        ArrowLeft: 'left',
        ArrowRight: 'right',
        w: 'up',
        s: 'down',
        a: 'left',
        d: 'right',
        W: 'up',
        S: 'down',
        A: 'left',
        D: 'right',
      };
      const dir = map[e.key];
      if (dir) {
        e.preventDefault();
        turn(dir);
        return;
      }
      if (e.key === ' ') {
        e.preventDefault();
        setStatus((s) => (s === 'playing' ? 'paused' : s === 'paused' ? 'playing' : s));
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [turn]);

  void reduceMotion; // no screen shake/flash in this game to begin with

  return (
    <div className="snake-game">
      <GameChrome
        title="Snake"
        score={score}
        best={best}
        status={status}
        xpEarned={xpEarned}
        hint="Arrow keys / WASD or the D-pad below. Space to pause."
        onPauseToggle={() => setStatus((s) => (s === 'playing' ? 'paused' : s === 'paused' ? 'playing' : s))}
        onExit={onExit}
        onRestart={reset}
      >
        <canvas ref={canvasRef} />
      </GameChrome>
      <div className="game-controls-row">
        <DPad onDirection={turn} disabled={status !== 'playing'} />
      </div>
    </div>
  );
}

function nextHead(snake: Cell[], dir: Cell): Cell {
  const head = snake[0];
  return { x: head.x + dir.x, y: head.y + dir.y };
}
