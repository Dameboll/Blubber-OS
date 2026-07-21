'use client';

/**
 * AmbientGlow — the cheap "living green" mote layer.
 *
 * A single fixed 2D-canvas (NOT WebGL — the flubber3d host owns the one shared
 * GL context by design; this must never allocate another) painting <=80 soft
 * green glow motes that drift on a slight curl field. It replaces the retired
 * BackgroundField (a second WebGLRenderer + fullscreen FBM shader + 14k
 * particles = the old lag) with a GPU-light DOM canvas.
 *
 * Cheapness levers:
 *   - motes are drawn from ONE pre-rendered sprite via drawImage (no
 *     per-frame createRadialGradient), so a full frame is a handful of cheap
 *     composited blits — comfortably inside the <1.5ms/frame budget.
 *   - devicePixelRatio capped at 1.5.
 *   - rAF paused on document.hidden AND when the canvas leaves the viewport
 *     (IntersectionObserver), so it costs nothing in a background tab.
 *   - prefers-reduced-motion => render nothing; the breathing gradient in
 *     globals.css carries the look statically.
 *   - the manual `reduce-effects` toggle (src/lib/reduce-effects.ts, flipped
 *     from Settings) does the exact same thing. AmbientGlow is mounted once
 *     at the page root and stays alive while Settings is opened elsewhere in
 *     the tree, so this listens live via onReduceEffectsChange() rather than
 *     a one-off read — the mote layer disappears the instant the toggle
 *     flips, same as it already does for the OS-level preference.
 *
 * Living-system input: subscribes the existing useLiveUsage hook. When real
 * tokens burn, `intensity` rises and the motes glow brighter and drift faster
 * — the ambient field literally reacts to the Blubber doing real work. No
 * burn => it settles to a calm baseline. Read via a ref so the 400ms decay
 * ticks never tear down or restart the animation loop.
 */

import { useEffect, useRef, useState } from 'react';
import { useLiveUsage } from '../hooks/useLiveUsage';
import { onReduceEffectsChange } from '../lib/reduce-effects';
import './AmbientGlow.css';

const MAX_MOTES = 80;
const MAX_DPR = 1.5;
// Green core for the mote sprite (the accent-bright #39FF14 family).
const MOTE_RGB = '57, 255, 20';

interface Mote {
  x: number;
  y: number;
  radius: number;
  phase: number;
  pulse: number;
  drift: number;
}

/** Paint the single reusable mote sprite once (soft green radial falloff). */
function buildSprite(): HTMLCanvasElement {
  const size = 64;
  const sprite = document.createElement('canvas');
  sprite.width = size;
  sprite.height = size;
  const sctx = sprite.getContext('2d');
  if (sctx) {
    const g = sctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, `rgba(${MOTE_RGB}, 0.9)`);
    g.addColorStop(0.35, `rgba(${MOTE_RGB}, 0.35)`);
    g.addColorStop(1, `rgba(${MOTE_RGB}, 0)`);
    sctx.fillStyle = g;
    sctx.fillRect(0, 0, size, size);
  }
  return sprite;
}

export default function AmbientGlow() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const intensityRef = useRef(0);
  const { intensity } = useLiveUsage();

  // Start false so SSR and the first client render agree (canvas present),
  // then resolve the real preference on the client to avoid a hydration
  // mismatch. When it flips true (OS-level OR the manual toggle) the canvas
  // unmounts and the loop tears down. Two independent sources feed one flag:
  // the OS media query (its own `change` event) and the manual reduce-effects
  // class (via onReduceEffectsChange's MutationObserver) — either one being
  // true wins.
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    let manualReduced = false;
    const recompute = () => setReduced(mq.matches || manualReduced);
    mq.addEventListener('change', recompute);
    // Fires immediately with the current value, then on every future change —
    // this alone covers the initial read, no separate recompute() call needed.
    const unsubscribeManual = onReduceEffectsChange((enabled) => {
      manualReduced = enabled;
      recompute();
    });
    return () => {
      mq.removeEventListener('change', recompute);
      unsubscribeManual();
    };
  }, []);

  // Keep the live intensity in a ref so the SSE/decay re-renders never restart
  // the animation effect below.
  useEffect(() => {
    intensityRef.current = intensity;
  }, [intensity]);

  useEffect(() => {
    if (reduced) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const sprite = buildSprite();
    let dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    let width = 0;
    let height = 0;
    let motes: Mote[] = [];

    const seedMotes = () => {
      // Fewer motes on small screens; hard cap at MAX_MOTES.
      const areaBudget = Math.round((width * height) / 22000);
      const count = Math.max(20, Math.min(width < 720 ? 34 : MAX_MOTES, areaBudget));
      motes = Array.from({ length: count }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        radius: 26 + Math.random() * 64,
        phase: Math.random() * Math.PI * 2,
        pulse: 0.6 + Math.random() * 0.9,
        drift: 0.5 + Math.random() * 0.9,
      }));
    };

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      seedMotes();
    };
    resize();

    let rafId = 0;
    let running = false;
    let last = performance.now();

    const frame = (now: number) => {
      // Clamp dt so a resumed tab doesn't teleport every mote across the field.
      const dt = Math.min(48, now - last);
      last = now;

      const intensityNow = intensityRef.current; // 0..1
      const t = now * 0.00012;
      // Real work speeds up drift and lifts brightness; idle => calm baseline.
      const speedScale = (0.5 + intensityNow * 1.6) * (dt / 16.67);
      const baseAlpha = 0.1 + intensityNow * 0.22;

      ctx.clearRect(0, 0, width, height);
      ctx.globalCompositeOperation = 'lighter';

      for (let i = 0; i < motes.length; i++) {
        const m = motes[i];
        // Cheap pseudo-curl: layered sines of position + time give a swirling
        // flow field without any noise library.
        const angle =
          Math.sin(m.x * 0.0016 + t) + Math.cos(m.y * 0.0018 - t * 0.85) + m.phase;
        m.x += Math.cos(angle) * m.drift * speedScale;
        m.y += Math.sin(angle) * m.drift * speedScale;

        // Wrap around the padded edges so motes never pop at the boundary.
        const pad = m.radius;
        if (m.x < -pad) m.x = width + pad;
        else if (m.x > width + pad) m.x = -pad;
        if (m.y < -pad) m.y = height + pad;
        else if (m.y > height + pad) m.y = -pad;

        m.phase += 0.002 * m.pulse * (dt / 16.67);
        const pulse = 0.75 + 0.25 * Math.sin(m.phase);
        ctx.globalAlpha = Math.min(0.55, baseAlpha * pulse);
        const d = m.radius * 2 * pulse;
        ctx.drawImage(sprite, m.x - d / 2, m.y - d / 2, d, d);
      }

      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      rafId = requestAnimationFrame(frame);
    };

    const start = () => {
      if (running) return;
      running = true;
      last = performance.now();
      rafId = requestAnimationFrame(frame);
    };
    const stop = () => {
      if (!running) return;
      running = false;
      cancelAnimationFrame(rafId);
    };

    // Pause when the tab is hidden.
    const onVisibility = () => {
      if (document.hidden) stop();
      else start();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('resize', resize);

    // Pause when the canvas leaves the viewport (belt-and-suspenders for a
    // fixed layer; also covers the canvas being display:none'd upstream).
    let observer: IntersectionObserver | null = null;
    if (typeof IntersectionObserver !== 'undefined') {
      observer = new IntersectionObserver(
        (entries) => {
          const visible = entries.some((e) => e.isIntersecting);
          if (visible && !document.hidden) start();
          else stop();
        },
        { threshold: 0 },
      );
      observer.observe(canvas);
    } else {
      start();
    }

    // If we never got an observer (or it fires async), ensure motion begins.
    if (!document.hidden) start();

    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('resize', resize);
      if (observer) observer.disconnect();
    };
  }, [reduced]);

  if (reduced) return null;

  return <canvas ref={canvasRef} className="ambient-glow" aria-hidden="true" />;
}
