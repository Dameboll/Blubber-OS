'use client';

/**
 * Small on-screen pointer/touch control widgets shared by games whose
 * primary input doesn't map naturally onto dragging the canvas itself
 * (Snake needs discrete direction taps, Reaction Tap needs one big target).
 * Both fire on pointerdown so touch, pen, and mouse all work identically
 * with zero extra event wiring per game.
 */

import type { ReactNode } from 'react';
import { ChevronUp, ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';
import './Controls.css';

export type DPadDirection = 'up' | 'down' | 'left' | 'right';

export function DPad({ onDirection, disabled }: { onDirection: (dir: DPadDirection) => void; disabled?: boolean }) {
  const press = (dir: DPadDirection) => () => {
    if (!disabled) onDirection(dir);
  };
  return (
    <div className="game-dpad" role="group" aria-label="Direction controls">
      <span />
      <button type="button" className="game-dpad__btn" onPointerDown={press('up')} aria-label="Up">
        <ChevronUp size={18} aria-hidden="true" />
      </button>
      <span />
      <button type="button" className="game-dpad__btn" onPointerDown={press('left')} aria-label="Left">
        <ChevronLeft size={18} aria-hidden="true" />
      </button>
      <span className="game-dpad__center" aria-hidden="true" />
      <button type="button" className="game-dpad__btn" onPointerDown={press('right')} aria-label="Right">
        <ChevronRight size={18} aria-hidden="true" />
      </button>
      <span />
      <button type="button" className="game-dpad__btn" onPointerDown={press('down')} aria-label="Down">
        <ChevronDown size={18} aria-hidden="true" />
      </button>
      <span />
    </div>
  );
}

export function BigTapButton({ onTap, children }: { onTap: () => void; children: ReactNode }) {
  return (
    <button type="button" className="game-big-tap" onPointerDown={onTap}>
      {children}
    </button>
  );
}
