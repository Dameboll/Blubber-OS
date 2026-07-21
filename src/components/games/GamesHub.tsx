'use client';

/**
 * GamesHub -- the mini-game arcade for the Virtual Pet screen. Owns the grid
 * of game cards (each with a tiny static canvas-drawn icon and a real,
 * session-only "best" score) and which single game is currently mounted.
 * Score/XP flow: a game reports a finished round via onFinish(score, xp);
 * this hub turns that into a per-game best-this-session number (kept only in
 * React state, never persisted) and forwards the XP straight to the caller's
 * onXp -- there is no fake leaderboard or fabricated history anywhere here.
 */

import { useCallback, useEffect, useState } from 'react';
import { Panel } from '../ui';
import SnakeGame from './SnakeGame';
import PongGame from './PongGame';
import ConnectFourGame from './ConnectFourGame';
import FlubberTossGame from './FlubberTossGame';
import ReactionTapGame from './ReactionTapGame';
import MemoryMatchGame from './MemoryMatchGame';
import { useHiDPICanvas } from './hooks';
import { PALETTE, drawGooBlob, roundedRect } from './palette';
import type { GameDef, GameId } from './types';
import './GamesHub.css';

const GAMES: GameDef[] = [
  {
    id: 'snake',
    name: 'Snake',
    tagline: 'Slime trail, classic rules.',
    higherIsBetter: true,
    formatScore: (s) => `${s} eaten`,
    drawIcon: (ctx, w, h) => {
      ctx.fillStyle = PALETTE.bgElevated;
      roundedRect(ctx, 2, 2, w - 4, h - 4, 10);
      ctx.fill();
      const cx = w / 2;
      const cy = h / 2;
      [-10, 0, 10].forEach((dx, i) => drawGooBlob(ctx, cx + dx, cy + (i === 1 ? -2 : 4), 6));
      drawGooBlob(ctx, cx + 20, cy - 8, 4, PALETTE.warning);
    },
  },
  {
    id: 'pong',
    name: 'Pong',
    tagline: 'Goo paddles vs the AI.',
    higherIsBetter: true,
    formatScore: (s) => `${s} pts`,
    drawIcon: (ctx, w, h) => {
      ctx.fillStyle = PALETTE.bgElevated;
      roundedRect(ctx, 2, 2, w - 4, h - 4, 10);
      ctx.fill();
      ctx.fillStyle = PALETTE.accentBright;
      roundedRect(ctx, 10, h / 2 - 10, 5, 20, 2);
      ctx.fill();
      ctx.fillStyle = PALETTE.accent;
      roundedRect(ctx, w - 15, h / 2 - 10, 5, 20, 2);
      ctx.fill();
      drawGooBlob(ctx, w / 2, h / 2, 5);
    },
  },
  {
    id: 'connect-four',
    name: 'Connect Four',
    tagline: 'Drop slime chips, get four.',
    higherIsBetter: true,
    formatScore: (s) => (s === 3 ? 'Last: Win' : s === 1 ? 'Last: Draw' : s === 0 ? 'Last: Loss' : `${s} pts`),
    drawIcon: (ctx, w, h) => {
      ctx.fillStyle = PALETTE.bgElevated;
      roundedRect(ctx, 2, 2, w - 4, h - 4, 10);
      ctx.fill();
      const spots: [number, number, string][] = [
        [-12, 6, PALETTE.accentBright],
        [0, 6, PALETTE.textPrimary],
        [12, 6, PALETTE.accentBright],
        [-12, -6, PALETTE.textPrimary],
        [0, -6, PALETTE.accentBright],
      ];
      spots.forEach(([dx, dy, color]) => drawGooBlob(ctx, w / 2 + dx, h / 2 + dy, 5, color));
    },
  },
  {
    id: 'flubber-toss',
    name: 'Blubber Toss',
    tagline: 'Arc a mini flubber into vats.',
    higherIsBetter: true,
    formatScore: (s) => `${s}/6 hits`,
    drawIcon: (ctx, w, h) => {
      ctx.fillStyle = PALETTE.bgElevated;
      roundedRect(ctx, 2, 2, w - 4, h - 4, 10);
      ctx.fill();
      ctx.strokeStyle = PALETTE.accent;
      ctx.lineWidth = 2;
      roundedRect(ctx, w - 22, 8, 14, 12, 4);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.3)';
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(10, h - 10);
      ctx.quadraticCurveTo(w / 2, 6, w - 16, 14);
      ctx.stroke();
      ctx.setLineDash([]);
      drawGooBlob(ctx, 10, h - 10, 5);
    },
  },
  {
    id: 'reaction-tap',
    name: 'Reaction Tap',
    tagline: 'Tap the blob the instant it flashes.',
    higherIsBetter: false,
    formatScore: (s) => `${s}ms avg`,
    drawIcon: (ctx, w, h) => {
      ctx.fillStyle = PALETTE.bgElevated;
      roundedRect(ctx, 2, 2, w - 4, h - 4, 10);
      ctx.fill();
      drawGooBlob(ctx, w / 2, h / 2, 12, PALETTE.accentBright);
    },
  },
  {
    id: 'memory-match',
    name: 'Memory Match',
    tagline: 'Flip pairs of slime icons.',
    higherIsBetter: false,
    formatScore: (s) => `${s} flips`,
    drawIcon: (ctx, w, h) => {
      ctx.fillStyle = PALETTE.bgElevated;
      roundedRect(ctx, 2, 2, w - 4, h - 4, 10);
      ctx.fill();
      const cellW = (w - 12) / 2;
      const cellH = (h - 12) / 2;
      for (let r = 0; r < 2; r++) {
        for (let c = 0; c < 2; c++) {
          const x = 6 + c * (cellW + 0);
          const y = 6 + r * (cellH + 0);
          ctx.fillStyle = PALETTE.bgPrimary;
          roundedRect(ctx, x, y, cellW - 4, cellH - 4, 4);
          ctx.fill();
        }
      }
      drawGooBlob(ctx, 6 + cellW / 2 - 2, 6 + cellH / 2 - 2, 6, PALETTE.warning);
      drawGooBlob(ctx, w - 6 - cellW / 2 + 2, h - 6 - cellH / 2 + 2, 6, PALETTE.warning);
    },
  },
];

const ICON_SIZE = 64;

function HubCardIcon({ drawIcon }: { drawIcon: GameDef['drawIcon'] }) {
  const { canvasRef, ctxRef } = useHiDPICanvas(ICON_SIZE, ICON_SIZE);
  useEffect(() => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    ctx.clearRect(0, 0, ICON_SIZE, ICON_SIZE);
    drawIcon(ctx, ICON_SIZE, ICON_SIZE);
    // Static icon -- intentionally drawn once, not on a loop, so a hub full
    // of cards never runs six-plus idle rAF loops for pure decoration.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctxRef]);
  return <canvas ref={canvasRef} className="games-hub__card-icon" aria-hidden="true" />;
}

export interface GamesHubProps {
  onXp: (amount: number, game: string) => void;
}

export function GamesHub({ onXp }: GamesHubProps) {
  const [activeGame, setActiveGame] = useState<GameId | null>(null);
  const [bestScores, setBestScores] = useState<Partial<Record<GameId, number>>>({});
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduceMotion(query.matches);
    const onChange = () => setReduceMotion(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  const handleFinish = useCallback((id: GameId, score: number, xp: number) => {
    const def = GAMES.find((g) => g.id === id);
    setBestScores((prev) => {
      const prevBest = prev[id];
      const better = prevBest === undefined || (def?.higherIsBetter ? score > prevBest : score < prevBest);
      return better ? { ...prev, [id]: score } : prev;
    });
    onXp(xp, id);
  }, [onXp]);

  const handleExit = useCallback(() => setActiveGame(null), []);

  if (activeGame) {
    const best = bestScores[activeGame] ?? 0;
    const commonProps = {
      reduceMotion,
      best,
      onExit: handleExit,
      onFinish: (score: number, xp: number) => handleFinish(activeGame, score, xp),
    };
    return (
      <div className="games-hub games-hub--playing">
        {activeGame === 'snake' && <SnakeGame {...commonProps} />}
        {activeGame === 'pong' && <PongGame {...commonProps} />}
        {activeGame === 'connect-four' && <ConnectFourGame {...commonProps} />}
        {activeGame === 'flubber-toss' && <FlubberTossGame {...commonProps} />}
        {activeGame === 'reaction-tap' && <ReactionTapGame {...commonProps} />}
        {activeGame === 'memory-match' && <MemoryMatchGame {...commonProps} />}
      </div>
    );
  }

  return (
    <Panel accent title="Mini-Games" className="games-hub__panel">
      <div className="games-hub__grid">
        {GAMES.map((game) => {
          const best = bestScores[game.id];
          return (
            <button
              key={game.id}
              type="button"
              className="games-hub__card"
              onClick={() => setActiveGame(game.id)}
            >
              <HubCardIcon drawIcon={game.drawIcon} />
              <span className="games-hub__card-name">{game.name}</span>
              <span className="games-hub__card-tagline">{game.tagline}</span>
              <span className="games-hub__card-best">
                {best === undefined ? 'Not played yet' : `Best: ${game.formatScore(best)}`}
              </span>
            </button>
          );
        })}
      </div>
    </Panel>
  );
}

export default GamesHub;
