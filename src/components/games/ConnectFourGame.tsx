'use client';

/**
 * Connect Four vs a simple AI -- slime chips dropped into a 7x6 punch board.
 * AI heuristic (in priority order): take an immediate win, block the
 * player's immediate win, otherwise a center-weighted random legal column.
 * That is enough to be a real opponent without needing full minimax.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import GameChrome from './GameChrome';
import { useAnimationFrame, useHiDPICanvas, clampXp } from './hooks';
import { PALETTE, drawGooBlob } from './palette';
import type { GameComponentProps, GameStatus } from './types';

const COLS = 7;
const ROWS = 6;
const CELL = 52;
const TOP_MARGIN = 40;
const BOARD_W = COLS * CELL;
const BOARD_H = TOP_MARGIN + ROWS * CELL;
const AI_MOVE_DELAY_MS = 550;

type Slot = null | 'player' | 'ai';
type Board = Slot[][]; // board[col][row], row 0 = bottom

function emptyBoard(): Board {
  return Array.from({ length: COLS }, () => Array<Slot>(ROWS).fill(null));
}

function lowestEmptyRow(board: Board, col: number): number {
  for (let row = 0; row < ROWS; row++) {
    if (board[col][row] === null) return row;
  }
  return -1;
}

const DIRECTIONS = [
  [1, 0],
  [0, 1],
  [1, 1],
  [1, -1],
];

function checkWin(board: Board, col: number, row: number, who: 'player' | 'ai'): boolean {
  for (const [dx, dy] of DIRECTIONS) {
    let count = 1;
    for (const sign of [1, -1]) {
      let c = col + dx * sign;
      let r = row + dy * sign;
      while (c >= 0 && c < COLS && r >= 0 && r < ROWS && board[c][r] === who) {
        count++;
        c += dx * sign;
        r += dy * sign;
      }
    }
    if (count >= 4) return true;
  }
  return false;
}

function findWinningColumn(board: Board, who: 'player' | 'ai'): number | null {
  for (let col = 0; col < COLS; col++) {
    const row = lowestEmptyRow(board, col);
    if (row === -1) continue;
    board[col][row] = who;
    const wins = checkWin(board, col, row, who);
    board[col][row] = null;
    if (wins) return col;
  }
  return null;
}

const CENTER_WEIGHTS = [1, 2, 3, 4, 3, 2, 1];

function pickAiColumn(board: Board): number {
  const win = findWinningColumn(board, 'ai');
  if (win !== null) return win;
  const block = findWinningColumn(board, 'player');
  if (block !== null) return block;

  const weighted: number[] = [];
  for (let col = 0; col < COLS; col++) {
    if (lowestEmptyRow(board, col) === -1) continue;
    for (let i = 0; i < CENTER_WEIGHTS[col]; i++) weighted.push(col);
  }
  return weighted[Math.floor(Math.random() * weighted.length)];
}

type Turn = 'player' | 'ai';
type Outcome = 'win' | 'loss' | 'draw';

export default function ConnectFourGame({ reduceMotion, best, onExit, onFinish }: GameComponentProps) {
  const { canvasRef, ctxRef } = useHiDPICanvas(BOARD_W, BOARD_H);

  const boardRef = useRef<Board>(emptyBoard());
  const turnRef = useRef<Turn>('player');
  const finishedRef = useRef(false);
  const aiTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const aiPendingRef = useRef(false);

  const [selectedCol, setSelectedCol] = useState(3);
  const [movesPlayed, setMovesPlayed] = useState(0);
  const [status, setStatus] = useState<GameStatus>('playing');
  const [xpEarned, setXpEarned] = useState<number | undefined>(undefined);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const draw = useCallback(() => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    ctx.fillStyle = PALETTE.bgSurface;
    ctx.fillRect(0, 0, BOARD_W, BOARD_H);

    if (status === 'playing' && turnRef.current === 'player') {
      const cx = (selectedCol + 0.5) * CELL;
      ctx.fillStyle = PALETTE.accentBright;
      ctx.beginPath();
      ctx.moveTo(cx - 9, TOP_MARGIN - 14);
      ctx.lineTo(cx + 9, TOP_MARGIN - 14);
      ctx.lineTo(cx, TOP_MARGIN - 2);
      ctx.closePath();
      ctx.fill();
    }

    const board = boardRef.current;
    for (let col = 0; col < COLS; col++) {
      for (let row = 0; row < ROWS; row++) {
        const cx = (col + 0.5) * CELL;
        const cy = TOP_MARGIN + (ROWS - row - 0.5) * CELL;
        const slot = board[col][row];
        if (!slot) {
          ctx.fillStyle = PALETTE.bgPrimary;
          ctx.beginPath();
          ctx.arc(cx, cy, CELL * 0.4, 0, Math.PI * 2);
          ctx.fill();
        } else {
          drawGooBlob(ctx, cx, cy, CELL * 0.4, slot === 'player' ? PALETTE.accentBright : PALETTE.textPrimary);
        }
      }
    }
  }, [ctxRef, selectedCol, status]);

  const finish = useCallback(
    (result: Outcome) => {
      if (finishedRef.current) return;
      finishedRef.current = true;
      const xp = result === 'win' ? 14 : result === 'draw' ? 9 : 6;
      const score = result === 'win' ? 3 : result === 'draw' ? 1 : 0;
      setOutcome(result);
      setXpEarned(xp);
      setStatus('over');
      onFinish(score, xp);
    },
    [onFinish],
  );

  const dropPiece = useCallback(
    (col: number, who: Turn) => {
      const board = boardRef.current;
      const row = lowestEmptyRow(board, col);
      if (row === -1) return false;
      board[col][row] = who;
      setMovesPlayed((m) => m + 1);

      if (checkWin(board, col, row, who)) {
        finish(who === 'player' ? 'win' : 'loss');
        return true;
      }
      const isFull = board.every((column) => column.every((cell) => cell !== null));
      if (isFull) {
        finish('draw');
        return true;
      }
      turnRef.current = who === 'player' ? 'ai' : 'player';
      return true;
    },
    [finish],
  );

  const playerDrop = useCallback(
    (col: number) => {
      if (status !== 'playing' || turnRef.current !== 'player' || finishedRef.current) return;
      const placed = dropPiece(col, 'player');
      if (!placed || finishedRef.current) return;
      aiPendingRef.current = true;
      aiTimeoutRef.current = setTimeout(() => {
        aiPendingRef.current = false;
        if (finishedRef.current) return;
        const aiCol = pickAiColumn(boardRef.current);
        dropPiece(aiCol, 'ai');
      }, AI_MOVE_DELAY_MS);
    },
    [status, dropPiece],
  );

  useEffect(() => () => {
    if (aiTimeoutRef.current) clearTimeout(aiTimeoutRef.current);
  }, []);

  // Pausing must actually stop the pending AI move, not just show an
  // overlay on top of it -- otherwise the AI would silently drop a piece
  // while the board looks frozen. Resuming re-schedules it.
  useEffect(() => {
    if (status === 'paused') {
      if (aiTimeoutRef.current) clearTimeout(aiTimeoutRef.current);
    } else if (status === 'playing' && aiPendingRef.current && turnRef.current === 'ai') {
      aiTimeoutRef.current = setTimeout(() => {
        aiPendingRef.current = false;
        if (finishedRef.current) return;
        const aiCol = pickAiColumn(boardRef.current);
        dropPiece(aiCol, 'ai');
      }, AI_MOVE_DELAY_MS);
    }
  }, [status, dropPiece]);

  // Redraw whenever the board actually changes (movesPlayed bump) or the
  // status/selection changes -- this game has no continuous physics, so a
  // light rAF-driven redraw (rather than a heavy fixed simulation) is all
  // that's needed, and it still satisfies "canvas 2D + requestAnimationFrame".
  useAnimationFrame(() => draw(), status === 'playing');
  useEffect(() => {
    draw();
  }, [draw, movesPlayed, status, outcome]);

  const reset = useCallback(() => {
    if (aiTimeoutRef.current) clearTimeout(aiTimeoutRef.current);
    boardRef.current = emptyBoard();
    turnRef.current = 'player';
    finishedRef.current = false;
    setMovesPlayed(0);
    setOutcome(null);
    setXpEarned(undefined);
    setSelectedCol(3);
    setStatus('playing');
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setSelectedCol((c) => Math.max(0, c - 1));
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        setSelectedCol((c) => Math.min(COLS - 1, c + 1));
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        playerDrop(selectedCol);
      } else if (e.key === 'p' || e.key === 'P') {
        setStatus((s) => (s === 'playing' ? 'paused' : s === 'paused' ? 'playing' : s));
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectedCol, playerDrop]);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * BOARD_W;
      const col = Math.min(COLS - 1, Math.max(0, Math.floor(x / CELL)));
      setSelectedCol(col);
      playerDrop(col);
    },
    [playerDrop],
  );

  void reduceMotion;
  const outcomeLabel =
    outcome === 'win' ? 'You won!' : outcome === 'loss' ? 'The AI won this one.' : outcome === 'draw' ? "It's a draw." : '';

  return (
    <div className="connect-four-game">
      <GameChrome
        title="Connect Four"
        score={outcome ? (outcome === 'win' ? 3 : outcome === 'draw' ? 1 : 0) : movesPlayed}
        best={best}
        status={status}
        xpEarned={xpEarned}
        hint={outcomeLabel || 'Left/Right + Enter to drop, or tap/click a column. P to pause.'}
        onPauseToggle={() => setStatus((s) => (s === 'playing' ? 'paused' : s === 'paused' ? 'playing' : s))}
        onExit={onExit}
        onRestart={reset}
      >
        <canvas ref={canvasRef} onPointerDown={handlePointerDown} />
      </GameChrome>
    </div>
  );
}
