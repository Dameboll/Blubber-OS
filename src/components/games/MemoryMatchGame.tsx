'use client';

/**
 * Memory Match -- flip pairs of slime-iconography cards on a canvas grid.
 * Keyboard moves a cursor with the arrow keys and flips with Enter/Space;
 * pointer/touch taps a card directly. Fewer total flips (closer to the
 * theoretical minimum for the deck size) earns more XP.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import GameChrome from './GameChrome';
import { useAnimationFrame, useHiDPICanvas, clampXp } from './hooks';
import { PALETTE, drawGooBlob, roundedRect } from './palette';
import type { GameComponentProps, GameStatus } from './types';

const COLS = 4;
const ROWS = 3;
const PAIR_COUNT = (COLS * ROWS) / 2; // 6 pairs, 12 cards
const CELL = 84;
const GAP = 8;
const W = COLS * CELL + (COLS + 1) * GAP;
const H = ROWS * CELL + (ROWS + 1) * GAP;
const REVEAL_MS = 750;
const MIN_FLIPS = PAIR_COUNT; // best-possible: every flip finds its pair immediately

// Each icon is a small canvas doodle keyed by index -- all drawn with the
// same goo-blob primitive at different arrangements so the "iconography"
// stays inside the shared slime visual language rather than importing an
// unrelated icon set.
type IconDrawer = (ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number) => void;

const ICONS: IconDrawer[] = [
  (ctx, cx, cy, r) => drawGooBlob(ctx, cx, cy, r, PALETTE.accentBright),
  (ctx, cx, cy, r) => drawGooBlob(ctx, cx, cy, r, PALETTE.warning),
  (ctx, cx, cy, r) => {
    drawGooBlob(ctx, cx - r * 0.4, cy, r * 0.55, PALETTE.accent);
    drawGooBlob(ctx, cx + r * 0.4, cy, r * 0.55, PALETTE.accent);
  },
  (ctx, cx, cy, r) => {
    drawGooBlob(ctx, cx, cy - r * 0.4, r * 0.55, PALETTE.accentBright);
    drawGooBlob(ctx, cx, cy + r * 0.4, r * 0.55, PALETTE.accentBright);
  },
  (ctx, cx, cy, r) => {
    drawGooBlob(ctx, cx, cy, r * 0.8, PALETTE.accent);
    ctx.fillStyle = PALETTE.bgPrimary;
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.32, 0, Math.PI * 2);
    ctx.fill();
  },
  (ctx, cx, cy, r) => {
    drawGooBlob(ctx, cx - r * 0.35, cy - r * 0.3, r * 0.4, PALETTE.warning);
    drawGooBlob(ctx, cx + r * 0.35, cy - r * 0.3, r * 0.4, PALETTE.warning);
    drawGooBlob(ctx, cx, cy + r * 0.35, r * 0.4, PALETTE.warning);
  },
];

interface Card {
  iconIndex: number;
  revealed: boolean;
  matched: boolean;
}

function buildDeck(): Card[] {
  const iconIndices = Array.from({ length: PAIR_COUNT }, (_, i) => i);
  const deck = [...iconIndices, ...iconIndices].map((iconIndex) => ({
    iconIndex,
    revealed: false,
    matched: false,
  }));
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function cardRect(index: number) {
  const col = index % COLS;
  const row = Math.floor(index / COLS);
  const x = GAP + col * (CELL + GAP);
  const y = GAP + row * (CELL + GAP);
  return { x, y };
}

export default function MemoryMatchGame({ best, onExit, onFinish }: GameComponentProps) {
  const { canvasRef, ctxRef } = useHiDPICanvas(W, H);

  const deckRef = useRef<Card[]>(buildDeck());
  const pendingRef = useRef<number[]>([]); // indices currently face-up, awaiting match check
  const lockRef = useRef(false); // true while showing a non-matching pair before flipping back
  const resolveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const finishedRef = useRef(false);
  // Source of truth for the flip count, updated synchronously alongside
  // setFlips so finish() (invoked from inside a setMatchedCount updater,
  // where the `flips` state closure may be stale) always reads the
  // truly-final count rather than racing a setTimeout/effect for it.
  const flipsRef = useRef(0);

  const [flips, setFlips] = useState(0);
  const [matchedCount, setMatchedCount] = useState(0);
  const [cursor, setCursor] = useState(0);
  const [status, setStatus] = useState<GameStatus>('playing');
  const [xpEarned, setXpEarned] = useState<number | undefined>(undefined);

  const finish = useCallback(
    (finalFlips: number) => {
      if (finishedRef.current) return;
      finishedRef.current = true;
      const extraFlips = Math.max(0, finalFlips - MIN_FLIPS);
      const xp = clampXp(15 - extraFlips);
      setXpEarned(xp);
      setStatus('over');
      onFinish(finalFlips, xp);
    },
    [onFinish],
  );

  const draw = useCallback(() => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    ctx.fillStyle = PALETTE.bgSurface;
    ctx.fillRect(0, 0, W, H);

    deckRef.current.forEach((card, i) => {
      const { x, y } = cardRect(i);
      const faceUp = card.revealed || card.matched;

      ctx.fillStyle = PALETTE.bgElevated;
      roundedRect(ctx, x, y, CELL, CELL, 12);
      ctx.fill();

      if (i === cursor && status === 'playing' && !card.matched) {
        ctx.strokeStyle = PALETTE.accentBright;
        ctx.lineWidth = 2;
        roundedRect(ctx, x + 1, y + 1, CELL - 2, CELL - 2, 12);
        ctx.stroke();
      }

      if (faceUp) {
        ICONS[card.iconIndex](ctx, x + CELL / 2, y + CELL / 2, CELL * 0.32);
        if (card.matched) {
          ctx.globalAlpha = 0.35;
          ctx.fillStyle = PALETTE.bgPrimary;
          roundedRect(ctx, x, y, CELL, CELL, 12);
          ctx.fill();
          ctx.globalAlpha = 1;
        }
      } else {
        ctx.strokeStyle = 'rgba(255,255,255,0.08)';
        roundedRect(ctx, x + 10, y + 10, CELL - 20, CELL - 20, 8);
        ctx.stroke();
      }
    });
  }, [ctxRef, cursor, status]);

  useAnimationFrame(() => draw(), status === 'playing');
  useEffect(() => {
    draw();
  }, [draw, flips, matchedCount, status]);

  useEffect(() => () => {
    if (resolveTimeoutRef.current) clearTimeout(resolveTimeoutRef.current);
  }, []);

  const flipCard = useCallback(
    (index: number) => {
      if (status !== 'playing' || lockRef.current || finishedRef.current) return;
      const card = deckRef.current[index];
      if (!card || card.matched || card.revealed) return;
      if (pendingRef.current.length >= 2) return;

      card.revealed = true;
      pendingRef.current = [...pendingRef.current, index];
      flipsRef.current += 1;
      setFlips(flipsRef.current);
      draw();

      if (pendingRef.current.length === 2) {
        const [a, b] = pendingRef.current;
        const cardA = deckRef.current[a];
        const cardB = deckRef.current[b];
        if (cardA.iconIndex === cardB.iconIndex) {
          cardA.matched = true;
          cardB.matched = true;
          pendingRef.current = [];
          setMatchedCount((m) => {
            const next = m + 1;
            if (next >= PAIR_COUNT) finish(flipsRef.current);
            return next;
          });
        } else {
          lockRef.current = true;
          resolveTimeoutRef.current = setTimeout(() => {
            cardA.revealed = false;
            cardB.revealed = false;
            pendingRef.current = [];
            lockRef.current = false;
            draw();
          }, REVEAL_MS);
        }
      }
    },
    [status, draw, finish],
  );

  // Pausing must stop the pending "flip back" timeout, not just cover it
  // with an overlay -- otherwise a mismatched pair would silently flip back
  // face-down while the board looks frozen. Resuming re-schedules it.
  useEffect(() => {
    if (status === 'paused') {
      if (resolveTimeoutRef.current) clearTimeout(resolveTimeoutRef.current);
    } else if (status === 'playing' && lockRef.current && pendingRef.current.length === 2) {
      const [a, b] = pendingRef.current;
      resolveTimeoutRef.current = setTimeout(() => {
        deckRef.current[a].revealed = false;
        deckRef.current[b].revealed = false;
        pendingRef.current = [];
        lockRef.current = false;
        draw();
      }, REVEAL_MS);
    }
  }, [status, draw]);

  const reset = useCallback(() => {
    if (resolveTimeoutRef.current) clearTimeout(resolveTimeoutRef.current);
    deckRef.current = buildDeck();
    pendingRef.current = [];
    lockRef.current = false;
    finishedRef.current = false;
    flipsRef.current = 0;
    setFlips(0);
    setMatchedCount(0);
    setCursor(0);
    setXpEarned(undefined);
    setStatus('playing');
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (status !== 'playing') return;
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        setCursor((c) => Math.min(COLS * ROWS - 1, c + 1));
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setCursor((c) => Math.max(0, c - 1));
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setCursor((c) => Math.min(COLS * ROWS - 1, c + COLS));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setCursor((c) => Math.max(0, c - COLS));
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        flipCard(cursor);
      } else if (e.key === 'p' || e.key === 'P') {
        setStatus((s) => (s === 'playing' ? 'paused' : s === 'paused' ? 'playing' : s));
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [status, cursor, flipCard]);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * W;
      const y = ((e.clientY - rect.top) / rect.height) * H;
      const col = Math.floor(x / (CELL + GAP));
      const row = Math.floor(y / (CELL + GAP));
      if (col < 0 || col >= COLS || row < 0 || row >= ROWS) return;
      const index = row * COLS + col;
      setCursor(index);
      flipCard(index);
    },
    [flipCard],
  );

  return (
    <GameChrome
      title="Memory Match"
      score={flips}
      best={best}
      status={status}
      xpEarned={xpEarned}
      hint="Arrow keys + Enter to flip, or tap a card. Fewer flips = more XP."
      onPauseToggle={() => setStatus((s) => (s === 'playing' ? 'paused' : s === 'paused' ? 'playing' : s))}
      onExit={onExit}
      onRestart={reset}
    >
      <canvas ref={canvasRef} onPointerDown={handlePointerDown} />
    </GameChrome>
  );
}
