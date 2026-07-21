'use client';

/**
 * CarePayoffs — the screen-space "payoff" layer for the Virtual Pet care
 * actions. Every care button on VirtualPetScreen POSTs its state change AND
 * fires a matching visual burst here: the animation IS the reward.
 *
 * It is a single fixed, pointer-transparent overlay that owns a pool of
 * transient particle DOM nodes it creates and animates imperatively (one rAF
 * per particle, transform/opacity only — never layout). Going imperative keeps
 * it zero-React-churn and fully interruption-safe: spamming Feed just appends
 * more independent blobs, none of which can corrupt pet state or each other.
 *
 * Bursts:
 *   feed(from,to)  — a goo pellet arcs from the Feed button to the mouth, splats
 *   shower(over)   — a curtain of slime droplets pours down the viewport + a
 *                    brief sparkle-clean beat
 *   hearts(x,y)    — goo-hearts float up from a point (petting love)
 *   bubbles(x,y)   — goo bubbles rise + pop from a point (poking the vat)
 *
 * prefers-reduced-motion: every method is a no-op — the care action's stat
 * refill and the pet's expression swap carry the feedback instead.
 */

import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import './CarePayoffs.css';

export interface CarePayoffsHandle {
  feed(fromEl: HTMLElement | null, toEl: HTMLElement | null): void;
  shower(overEl: HTMLElement | null): void;
  hearts(clientX: number, clientY: number, count?: number): void;
  bubbles(clientX: number, clientY: number, count?: number): void;
}

interface CarePayoffsProps {
  reduceMotion: boolean;
}

interface Center {
  x: number;
  y: number;
}

function centerOf(el: HTMLElement): Center {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

const CarePayoffs = forwardRef<CarePayoffsHandle, CarePayoffsProps>(function CarePayoffs(
  { reduceMotion },
  ref,
) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const disposedRef = useRef(false);

  useEffect(() => {
    disposedRef.current = false;
    const root = rootRef.current;
    return () => {
      disposedRef.current = true;
      if (root) root.replaceChildren();
    };
  }, []);

  useImperativeHandle(
    ref,
    () => {
      // One rAF loop per particle. Guards against unmount + detached nodes so
      // stray timers can never touch a dead overlay.
      const animate = (
        el: HTMLElement,
        durationMs: number,
        tick: (p: number) => void,
        onDone?: () => void,
      ): void => {
        const start = performance.now();
        const step = (now: number): void => {
          if (disposedRef.current || !el.isConnected) {
            el.remove();
            return;
          }
          const p = Math.min((now - start) / durationMs, 1);
          tick(p);
          if (p < 1) {
            requestAnimationFrame(step);
          } else if (onDone) {
            onDone();
          } else {
            el.remove();
          }
        };
        requestAnimationFrame(step);
      };

      const make = (className: string): HTMLElement | null => {
        const root = rootRef.current;
        if (!root) return null;
        const el = document.createElement('span');
        el.className = className;
        root.appendChild(el);
        return el;
      };

      // Defer a spawn without holding a timer array: the guard inside animate
      // (disposed + isConnected) makes late fires harmless.
      const later = (delayMs: number, fn: () => void): void => {
        window.setTimeout(() => {
          if (disposedRef.current) return;
          fn();
        }, delayMs);
      };

      return {
        feed(fromEl, toEl) {
          if (reduceMotion || !fromEl || !toEl) return;
          const a = centerOf(fromEl);
          const b = centerOf(toEl);
          const el = make('care-payoffs__blob');
          if (!el) return;
          // Quadratic arc with an apex above the higher endpoint so the pellet
          // lobs up to the mouth rather than sliding flat.
          const apexY = Math.min(a.y, b.y) - 90;
          const cx = (a.x + b.x) / 2;
          animate(
            el,
            640,
            (p) => {
              const mt = 1 - p;
              const x = mt * mt * a.x + 2 * mt * p * cx + p * p * b.x;
              const y = mt * mt * a.y + 2 * mt * p * apexY + p * p * b.y;
              const scale = 0.55 + 0.45 * p;
              el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%) scale(${scale})`;
              el.style.opacity = p > 0.9 ? String(1 - (p - 0.9) / 0.1) : '1';
            },
            () => {
              // gulp splat at the mouth
              const splat = make('care-payoffs__splat');
              if (splat) {
                animate(splat, 260, (q) => {
                  splat.style.transform = `translate(${b.x}px, ${b.y}px) translate(-50%, -50%) scale(${0.3 + q * 1.5})`;
                  splat.style.opacity = String(1 - q);
                });
              }
              el.remove();
            },
          );
        },

        shower(overEl) {
          if (reduceMotion || !overEl) return;
          const r = overEl.getBoundingClientRect();
          const drops = 16;
          for (let i = 0; i < drops; i += 1) {
            const startX = r.left + (0.1 + 0.8 * Math.random()) * r.width;
            const startY = r.top - 14 - Math.random() * 30;
            const fall = r.height * (0.55 + Math.random() * 0.2);
            const sway = (Math.random() * 2 - 1) * 10;
            const dur = 620 + Math.random() * 360;
            later(Math.random() * 520, () => {
              const el = make('care-payoffs__drop');
              if (!el) return;
              animate(el, dur, (p) => {
                const y = startY + fall * p;
                const x = startX + sway * p;
                el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%) scaleY(${1 + p * 0.5})`;
                el.style.opacity = p > 0.7 ? String(1 - (p - 0.7) / 0.3) : '1';
              });
            });
          }
          // sparkle-clean beat once the curtain has mostly landed
          later(780, () => {
            for (let i = 0; i < 5; i += 1) {
              const el = make('care-payoffs__sparkle');
              if (!el) continue;
              const sx = r.left + (0.25 + 0.5 * Math.random()) * r.width;
              const sy = r.top + (0.35 + 0.3 * Math.random()) * r.height;
              animate(el, 520, (p) => {
                el.style.transform = `translate(${sx}px, ${sy}px) translate(-50%, -50%) scale(${0.4 + p}) rotate(${p * 90}deg)`;
                el.style.opacity = String(Math.sin(Math.PI * p));
              });
            }
          });
        },

        hearts(clientX, clientY, count = 3) {
          if (reduceMotion) return;
          for (let i = 0; i < count; i += 1) {
            const ox = (Math.random() * 2 - 1) * 26;
            const rise = 54 + Math.random() * 34;
            const dur = 780 + Math.random() * 380;
            later(i * 90, () => {
              const el = make('care-payoffs__heart');
              if (!el) return;
              animate(el, dur, (p) => {
                const y = clientY - rise * p;
                const x = clientX + ox * Math.sin(p * Math.PI);
                const scale = p < 0.3 ? p / 0.3 : 1;
                el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%) scale(${scale})`;
                el.style.opacity = p > 0.6 ? String(1 - (p - 0.6) / 0.4) : '1';
              });
            });
          }
        },

        bubbles(clientX, clientY, count = 7) {
          if (reduceMotion) return;
          for (let i = 0; i < count; i += 1) {
            const ox = (Math.random() * 2 - 1) * 30;
            const rise = 46 + Math.random() * 40;
            const size = 6 + Math.random() * 10;
            const dur = 700 + Math.random() * 420;
            later(i * 55, () => {
              const el = make('care-payoffs__bubble');
              if (!el) return;
              el.style.width = `${size}px`;
              el.style.height = `${size}px`;
              animate(el, dur, (p) => {
                const y = clientY - rise * p;
                const x = clientX + ox * p;
                el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%) scale(${0.5 + p * 0.7})`;
                el.style.opacity = p > 0.75 ? String(1 - (p - 0.75) / 0.25) : String(0.5 + p * 0.5);
              });
            });
          }
        },
      };
    },
    [reduceMotion],
  );

  return <div ref={rootRef} className="care-payoffs" aria-hidden="true" />;
});

export default CarePayoffs;
