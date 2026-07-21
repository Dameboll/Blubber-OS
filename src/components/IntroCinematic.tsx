'use client';

/**
 * IntroCinematic — the one-time "Blubber forms up" cinematic that plays once,
 * ever, before the user sees anything else, then never again.
 *
 * Sequence (~4.6s, skippable any time):
 *   1. Dark bloom fade-in over the (already-mounted, hidden-behind) app.
 *   2. One live 3D Blubber "forms up" in a small stage — reuses the app's
 *      single shared WebGL host via the existing <Flubber3D> component
 *      (./Flubber3D.tsx -> lib/flubber3d/host.ts + instance.ts + motion.ts +
 *      materials.ts). No new 3D/shader code is written here — this just
 *      registers one more slot on the shared host, the same way every other
 *      live Blubber in the app does, and lets the instance's own built-in
 *      squash-spring physics (pulse()) sell the "forming up" beat.
 *   3. Wordmark (public/brand/flubber-wordmark-lg.webp) crossfades in (1s).
 *   4. A held beat, then the whole overlay crossfades/glides out, revealing
 *      the app that has been mounted underneath the entire time (children
 *      always render immediately — this component only ever adds an overlay
 *      ON TOP of them, never gates their mount).
 *
 * Gating: src/server/intro-store.ts (app_meta key 'intro_seen_v1') via
 * GET/POST /api/intro. Once seen, this component is a pure passthrough —
 * nothing is fetched-then-flashed because the overlay only ever renders
 * after the GET resolves and comes back unseen.
 *
 * prefers-reduced-motion: mirrors the app's existing convention for
 * decorative/animated layers (see AmbientGlow.tsx's own header comment:
 * "renders nothing under prefers-reduced-motion"). For a one-shot intro,
 * "jump straight to end state, no animation" means jumping straight to the
 * end state of the WHOLE FEATURE — the app — so reduced-motion visitors never
 * see the overlay at all: the intro is marked seen immediately and no WebGL
 * context is ever spun up for it. The manual reduce-effects toggle
 * (src/lib/reduce-effects.ts) takes the exact same branch — this only reads
 * it once, in the gate-check effect below, since the intro plays at most once
 * ever and the flag can't meaningfully change mid-check.
 *
 * Teardown: unmounting <Flubber3D> runs that component's own effect cleanup,
 * which calls slotHandle.dispose() exactly the way every other Flubber3D
 * consumer in the app already tears down (see Flubber3D.tsx). No bespoke
 * WebGL cleanup lives here, and nothing here creates a second renderer — this
 * uses the SAME shared host singleton as the rest of the app, so it can never
 * "compete" with a later Flubber3D mount; it just gives its slot back.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import gsap from 'gsap';
import Flubber3D from './Flubber3D';
import type { FlubberSlotHandle } from '../lib/flubber3d/host';
import { isReduceEffectsActive } from '../lib/reduce-effects';
import './IntroCinematic.css';

type Phase = 'checking' | 'playing' | 'done';

// Hero tier kicks in at >=160px (see Flubber3D.tierForSize) — this is well
// past that so the intro gets the full goo/transmission treatment, not MID.
const STAGE_SIZE = 240;

export default function IntroCinematic({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<Phase>('checking');

  const overlayRef = useRef<HTMLDivElement | null>(null);
  const bloomRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const wordmarkRef = useRef<HTMLImageElement | null>(null);
  const skipHintRef = useRef<HTMLButtonElement | null>(null);
  const slotHandleRef = useRef<FlubberSlotHandle | null>(null);
  const completedRef = useRef(false);
  const skipRef = useRef<(() => void) | null>(null);

  const completeIntro = () => {
    if (completedRef.current) return;
    completedRef.current = true;
    setPhase('done');
    fetch('/api/intro', { method: 'POST' }).catch(() => {
      // Best-effort. Worst case the cinematic plays once more on a future
      // load — never worth blocking or breaking the app over.
    });
  };

  // Gate check — runs once. The overlay JSX below only renders in the
  // 'playing' phase, so returning visitors (seen: true) never see so much as
  // a one-frame flash of it while this fetch is in flight.
  useEffect(() => {
    let cancelled = false;
    fetch('/api/intro')
      .then((res) => (res.ok ? res.json() : { seen: true }))
      .then((json: { seen?: boolean }) => {
        if (cancelled) return;
        if (json.seen) {
          completedRef.current = true;
          setPhase('done');
          return;
        }
        const reduced =
          (typeof window !== 'undefined' &&
            typeof window.matchMedia === 'function' &&
            window.matchMedia('(prefers-reduced-motion: reduce)').matches) ||
          isReduceEffectsActive();
        if (reduced) {
          completeIntro();
          return;
        }
        setPhase('playing');
      })
      .catch(() => {
        // Can't reach the store — fail open so a backend hiccup never
        // strands the whole app behind a stuck overlay.
        if (!cancelled) {
          completedRef.current = true;
          setPhase('done');
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The cinematic timeline — built once the overlay actually mounts.
  useEffect(() => {
    if (phase !== 'playing') return;

    const ctx = gsap.context(() => {
      gsap.set(bloomRef.current, { opacity: 0 });
      gsap.set(stageRef.current, { opacity: 0, scale: 0.72 });
      gsap.set(wordmarkRef.current, { opacity: 0, y: 10 });
      gsap.set(skipHintRef.current, { opacity: 0 });

      const tl = gsap.timeline({ onComplete: completeIntro });

      // 1. Dark bloom fade-in.
      tl.to(bloomRef.current, { opacity: 1, duration: 0.9, ease: 'power2.out' }, 0);

      // 2. Blubber "forms up" — scale/opacity in, then a real squash-spring
      //    kick from the instance itself (physical secondary motion, not a
      //    hand-rolled CSS bounce) right as it finishes materializing.
      tl.to(stageRef.current, { opacity: 1, scale: 1, duration: 1.0, ease: 'power3.out' }, 0.35);
      tl.call(() => slotHandleRef.current?.pulse(), [], 1.0);

      // Subtle skip hint — fades in once there's something worth skipping.
      tl.to(skipHintRef.current, { opacity: 0.55, duration: 0.6 }, 1.0);

      // 3. Wordmark crossfade (1s).
      tl.to(wordmarkRef.current, { opacity: 1, y: 0, duration: 1.0, ease: 'power2.out' }, 1.9);

      // Held beat happens naturally: nothing is scheduled between 2.9 (wordmark
      // finishing) and 3.7 (exit starting) below.

      // 4. Crossfade/glide out — reveals the app mounted underneath.
      tl.to(overlayRef.current, { opacity: 0, duration: 0.9, ease: 'power2.inOut' }, 3.7);
      tl.to(stageRef.current, { scale: 1.05, duration: 0.9, ease: 'power2.inOut' }, 3.7);
    });

    const skip = () => {
      if (completedRef.current) return;
      ctx.kill();
      gsap.to(overlayRef.current, {
        opacity: 0,
        duration: 0.25,
        ease: 'power2.out',
        onComplete: completeIntro,
      });
    };
    skipRef.current = skip;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'Enter') {
        e.preventDefault();
        skip();
      }
    };
    window.addEventListener('keydown', onKeyDown);

    return () => {
      window.removeEventListener('keydown', onKeyDown);
      skipRef.current = null;
      ctx.revert();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  return (
    <>
      {children}
      {phase === 'playing' && (
        <div
          ref={overlayRef}
          className="intro-cinematic"
          onClick={() => skipRef.current?.()}
        >
          <div ref={bloomRef} className="intro-cinematic__bloom" aria-hidden="true" />

          <div className="intro-cinematic__center">
            <div ref={stageRef} className="intro-cinematic__stage">
              <Flubber3D
                expression="happy"
                size={STAGE_SIZE}
                tier="hero"
                onSlotReady={(handle) => {
                  slotHandleRef.current = handle;
                }}
              />
            </div>

            {/* eslint-disable-next-line @next/next/no-img-element -- static /public asset, no next/image usage elsewhere in this app */}
            <img
              ref={wordmarkRef}
              src="/brand/flubber-wordmark-lg.webp"
              alt="Blubber"
              className="intro-cinematic__wordmark"
            />
          </div>

          <button
            ref={skipHintRef}
            type="button"
            className="intro-cinematic__skip"
            onClick={(e) => {
              e.stopPropagation();
              skipRef.current?.();
            }}
          >
            tap / esc to skip
          </button>
        </div>
      )}
    </>
  );
}
