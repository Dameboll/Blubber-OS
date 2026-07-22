'use client';

/**
 * FloatingBlubber — the glossy jelly Blubber (public/blubber-glossy.png,
 * transparent, with bubbles + glowing pool baked in) shown STRICTLY in the
 * pre-app / overlay contexts where the in-app 3D is absent: onboarding, the
 * intro cinematic's still, and the tour escort. It is NOT a replacement for
 * the 3D Flubber anywhere in-app — that system is untouched.
 *
 * "Alive" from three cheap GPU-only layers, no libraries:
 *   1. a slow vertical bob with a tiny tilt (the float),
 *   2. squash-and-stretch synced to the bob (stretches tall rising, squashes
 *      wide landing) pivoting near the base (transform-origin 50% 90%) so the
 *      weight reads as settling into the ground,
 *   3. a soft green glow puddle behind that breathes with the float.
 * Only transform/opacity are animated (compositor-friendly). Honors
 * prefers-reduced-motion — the image still shows, just holds still.
 */

import './FloatingBlubber.css';

interface FloatingBlubberProps {
  /** Rendered width in px (height follows the art's aspect ratio). */
  size?: number;
  /** Alt text; decorative by default. */
  alt?: string;
  className?: string;
}

export default function FloatingBlubber({ size = 160, alt = '', className }: FloatingBlubberProps) {
  return (
    <div
      className={['floaty', className].filter(Boolean).join(' ')}
      style={{ width: size }}
    >
      <span className="floaty__glow" aria-hidden="true" />
      {/* eslint-disable-next-line @next/next/no-img-element -- static /public asset, app-wide convention */}
      <img className="floaty__img" src="/blubber-glossy.png" alt={alt} aria-hidden={alt ? undefined : true} draggable={false} />
    </div>
  );
}
