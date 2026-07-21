/**
 * Canvas color constants mirroring the CSS custom properties in
 * src/app/globals.css (:root). Canvas 2D fillStyle/strokeStyle needs concrete
 * color strings rather than var(--x), so these are hand-kept literals of the
 * exact same swatch -- there is only one theme in this app (dark green goo,
 * no light-mode toggle in globals.css), so a static mirror is safe.
 */

export const PALETTE = {
  bgPrimary: '#0a0a0a', // oklch(7% 0 0)
  bgSurface: '#0b1a0f', // --bg-surface
  bgElevated: '#1a1f1c', // --bg-elevated
  accent: '#00cc66', // --core-accent
  accentBright: '#39ff14', // --core-accent-bright
  warning: '#7cff4d', // --accent-warning (lime, no orange in this world)
  danger: '#e6493f', // --accent-danger family, muted for canvas use
  textPrimary: '#f2f2f2',
  textSecondary: '#a6a6a6',
} as const;

/** Slime-goo radial blob -- the shared visual motif for pickups/pieces/icons
 * across every game (food blobs, connect-four chips, memory cards, etc). */
export function drawGooBlob(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  color: string = PALETTE.accentBright,
): void {
  const grad = ctx.createRadialGradient(x - r * 0.3, y - r * 0.35, r * 0.15, x, y, r);
  grad.addColorStop(0, '#ffffff');
  grad.addColorStop(0.35, color);
  grad.addColorStop(1, PALETTE.accent);
  ctx.save();
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** Rounded-rect helper (canvas has no native primitive with a fallback for
 * older engines, so this stays hand-rolled rather than depending on
 * roundRect support). */
export function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
