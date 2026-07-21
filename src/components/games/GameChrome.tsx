'use client';

/**
 * GameChrome -- the shared chrome every game in this folder renders inside:
 * a back-to-hub + title + pause bar, a live score / best-this-session row,
 * a stage that hosts the game's own canvas (passed as children) plus the
 * Paused/Game-Over overlays, and a one-line controls hint. Individual games
 * own all real gameplay state; this component is purely presentational.
 */

import type { ReactNode } from 'react';
import { ArrowLeft, Pause, Play, RotateCcw } from 'lucide-react';
import type { GameStatus } from './types';
import './GameChrome.css';

export interface GameChromeProps {
  title: string;
  score: number;
  best: number;
  status: GameStatus;
  hint: string;
  xpEarned?: number;
  onPauseToggle: () => void;
  onExit: () => void;
  onRestart: () => void;
  children: ReactNode;
}

export default function GameChrome({
  title,
  score,
  best,
  status,
  hint,
  xpEarned,
  onPauseToggle,
  onExit,
  onRestart,
  children,
}: GameChromeProps) {
  return (
    <div className="game-chrome">
      <div className="game-chrome__bar">
        <button type="button" className="game-chrome__icon-btn" onClick={onExit} aria-label="Back to hub">
          <ArrowLeft size={16} aria-hidden="true" />
        </button>
        <span className="game-chrome__title">{title}</span>
        <button
          type="button"
          className="game-chrome__icon-btn"
          onClick={onPauseToggle}
          disabled={status === 'over'}
          aria-label={status === 'paused' ? 'Resume' : 'Pause'}
        >
          {status === 'paused' ? <Play size={16} aria-hidden="true" /> : <Pause size={16} aria-hidden="true" />}
        </button>
      </div>

      <div className="game-chrome__scores">
        <span className="game-chrome__score">
          Score <strong>{score}</strong>
        </span>
        <span className="game-chrome__best">
          Best this session <strong>{best}</strong>
        </span>
      </div>

      <div className="game-chrome__stage">
        {children}

        {status === 'paused' && (
          <div className="game-chrome__overlay" role="status">
            <span className="game-chrome__overlay-title">Paused</span>
            <button type="button" className="game-chrome__overlay-btn" onClick={onPauseToggle}>
              Resume
            </button>
          </div>
        )}

        {status === 'over' && (
          <div className="game-chrome__overlay" role="status">
            <span className="game-chrome__overlay-title">Game Over</span>
            <span className="game-chrome__overlay-score">Score: {score}</span>
            {typeof xpEarned === 'number' && (
              <span className="game-chrome__overlay-xp">+{xpEarned} XP</span>
            )}
            <div className="game-chrome__overlay-actions">
              <button type="button" className="game-chrome__overlay-btn" onClick={onRestart}>
                <RotateCcw size={14} aria-hidden="true" />
                Play Again
              </button>
              <button type="button" className="game-chrome__overlay-btn game-chrome__overlay-btn--ghost" onClick={onExit}>
                Back to Hub
              </button>
            </div>
          </div>
        )}
      </div>

      <p className="game-chrome__hint">{hint}</p>
    </div>
  );
}
