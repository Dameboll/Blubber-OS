'use client';

/**
 * FlubberCharacter — Phase 2 of docs/plans/flubber-3d-everywhere.md: now a
 * thin alias of Flubber3D. Every Blubber in the app is the live 3D model
 * (V3.8 GLB) rendered through the shared FlubberHost — the PNG sprite
 * pipeline and the Core3D orb toggle are retired.
 *
 * Their assets were DELETED on 2026-07-19 (public/flubber/*.png + manifest,
 * scripts/alpha-key-flubber-sprites.js, and the superseded flubber-v1/v2/v3
 * GLBs). scripts/verify-assets.mjs now fails the build if any of them return.
 *
 * PROP CONTRACT (unchanged for the ~30 existing call sites):
 *   expression — same 20-expression vocabulary
 *   size       — CSS px, square stage
 *   pulseKey   — increment → one-shot squash/rebound on the 3D body
 *   mode       — legacy. "mesh" renders the dedicated-renderer FlubberMesh
 *                (the dashboard hero panel keeps its own cinematic stage);
 *                everything else renders a shared-host Flubber3D slot with
 *                the tier auto-picked from size (≥160 hero · 64–159 mid ·
 *                <64 micro).
 *   showToggle / onModeChange / pulseStrength / intensity / audioEnergy /
 *   onBootEvent — legacy orb-era props, accepted and ignored so call sites
 *                 don't have to churn.
 */

import dynamic from 'next/dynamic';
import type { Core3DProps } from './Core3D';
import Flubber3D from './Flubber3D';
import type { FlubberTier } from '../lib/flubber3d/instance';
import './FlubberCharacter.css';

const FlubberMesh = dynamic(() => import('./FlubberMesh'), {
  ssr: false,
  loading: () => <div className="flubber-character__mesh-loading" aria-hidden="true" />,
});

export type FlubberExpression =
  | 'waving'
  | 'working'
  | 'worried'
  | 'happy'
  | 'excited'
  | 'focused'
  | 'thinking'
  | 'confused'
  | 'tired'
  | 'surprised'
  | 'celebrating'
  | 'sleeping'
  | 'mischievous'
  | 'determined'
  | 'overjoyed'
  | 'plotting'
  | 'heart-eyes'
  | 'disappointed'
  | 'dj-mode'
  | 'idle';

export type FlubberMode = 'character' | 'orb' | 'mesh';

export interface FlubberCharacterProps {
  /** Which expression the 3D model plays. Default "waving". */
  expression?: FlubberExpression;
  /** Render size in px — a square stage. Default 96. */
  size?: number;
  /** Legacy. "mesh" = dedicated-renderer FlubberMesh; anything else = shared-host 3D slot. */
  mode?: FlubberMode;
  /** Legacy orb-era prop — ignored (there is no mode toggle anymore). */
  onModeChange?: (mode: FlubberMode) => void;
  /** Increment to fire a one-shot squash-then-overshoot-rebound pulse. */
  pulseKey?: number;
  /** Legacy orb-era prop — ignored. */
  pulseStrength?: number;
  /** Legacy orb-era prop — ignored. */
  intensity?: number;
  /** Legacy orb-era prop — ignored. */
  audioEnergy?: number;
  /** Legacy orb-era prop — ignored. */
  onBootEvent?: Core3DProps['onBootEvent'];
  /** Legacy orb-era prop — ignored. */
  showToggle?: boolean;
  /** Worn accessory forwarded to the shared-host 3D slot (e.g. DJ headphones). */
  accessory?: 'dj-headphones';
  /** Optional tier override forwarded to the shared-host 3D slot — pass "mid"
   * on a small stage to render the glossy jelly instead of the flat micro
   * matcap the size logic would otherwise pick. */
  tier?: FlubberTier;
  className?: string;
}

export default function FlubberCharacter({
  expression = 'waving',
  size = 96,
  mode = 'character',
  pulseKey,
  accessory,
  tier,
  className,
}: FlubberCharacterProps) {
  return (
    <div
      className={['flubber-character', className].filter(Boolean).join(' ')}
      style={{ width: size, height: size }}
    >
      {mode === 'mesh' ? (
        <FlubberMesh className="flubber-character__mesh" expression={expression} pulseKey={pulseKey} />
      ) : (
        <Flubber3D expression={expression} size={size} pulseKey={pulseKey} accessory={accessory} tier={tier} />
      )}
    </div>
  );
}
