'use client';

/**
 * OnboardingOverlay — the entire free-tier "inject" onboarding flow (Lane B1).
 *
 * Community Edition ships with ZERO built-in help content: whoever is running
 * this already knows Claude Code and GitHub, so this is a ~30 second beat,
 * not a tutorial. Six self-managed steps:
 *
 *   welcome    → full-screen "Meet Blubber" card. Continue (runs detect) OR
 *                "Explore in demo mode" — demo is offered up front here so it's
 *                reachable regardless of whether a Claude setup is detected,
 *                not only on the notfound branch.
 *   detecting  → fires GET /api/onboarding/detect (real filesystem check on
 *                ~/.claude — see that route for exactly what it looks at).
 *   found      → ~/.claude has real project history. One confirm button
 *                ("Inject my setup") → POST /api/onboarding/inject (which
 *                calls the existing background indexer, see that route) →
 *                fetches GET /api/system for real, live machine stats →
 *                advances to `summary`.
 *   empty      → ~/.claude exists but is untouched. "Clean slate" message,
 *                one button straight through to the dashboard.
 *   notfound   → no ~/.claude at all. Two buttons: a plain link out to
 *                install Claude Code, or "Try Demo Mode" (appends ?demo=1
 *                and reloads — a separate lane wires the actual demo data).
 *   summary    → one card of real machine stats confirming the inject
 *                actually did something, then a final continue.
 *
 * Self-contained: manages its own step state, does its own fetching, and
 * only reaches into the shared `db` indirectly via its own API routes (see
 * src/server/onboarding-store.ts + src/app/api/onboarding/**). Marks
 * onboarding seen (POST /api/onboarding) itself right before calling
 * onComplete(), so nothing else has to remember to do that — see this file's
 * `finish()`.
 *
 * Visuals are intentionally restrained (dark card, single green accent,
 * GSAP fade/rise between steps) — no WebGL/3D reuse here, that's explicitly
 * out of scope for a first-run overlay that has to feel instant. The one GSAP
 * beat (card fade/rise on step change) is skipped under prefers-reduced-motion
 * AND the manual reduce-effects toggle — see shouldSkipMotion() below.
 */

import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { gsap } from 'gsap';
import { isReduceEffectsActive } from '../../lib/reduce-effects';
import { useInstallStream } from '../../lib/use-install-stream';
import { requestTour } from '../../lib/tour';
import './OnboardingOverlay.css';

// Community Edition onboarding is barebones by design: welcome, detect,
// (optionally help install Claude Code / demo), done. The ONE thing detection
// adds for paying users is the Starter Kit: the same ~/.claude scan also looks
// for the kit marker (detect returns { kit }), and if it's found we offer the
// guided dashboard tour on the way in ('starterKit' step → requestTour()). No
// kit detected = none of this ever shows.
type Step =
  | 'welcome'
  | 'detecting'
  | 'found'
  | 'empty'
  | 'notfound'
  | 'installingClaude'
  | 'starterKit'
  | 'summary';
type DetectStatus = 'found' | 'empty' | 'not-found';

interface SystemStats {
  cpu: number;
  mem: number;
  proc: number;
}

export interface OnboardingOverlayProps {
  /** Fires once the flow is fully done (any branch) and onboarding has been
   * marked seen server-side. Caller hides the overlay and mounts the real app. */
  onComplete: () => void;
}

const MIN_DETECT_DISPLAY_MS = 550;

// Checked once per step transition (see the useLayoutEffect below, which
// reruns on every `step` change) — so this doubles as a live-enough read of
// the manual reduce-effects toggle without needing a subscription: honors
// both the OS-level preference and the Settings-driven flag, same as
// IntroCinematic and AmbientGlow.
function shouldSkipMotion(): boolean {
  return (
    (typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) ||
    isReduceEffectsActive()
  );
}

export default function OnboardingOverlay({ onComplete }: OnboardingOverlayProps) {
  const [step, setStep] = useState<Step>('welcome');
  const [busy, setBusy] = useState(false);
  const [kitDetected, setKitDetected] = useState(false);
  const [systemStats, setSystemStats] = useState<SystemStats | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  // Shared streamed-installer state, reused for both the "install Claude Code"
  // and "install recommended plugins" beats (see useInstallStream).
  const install = useInstallStream();

  // Fade/rise the card in on every step change — the one animation beat this
  // overlay uses. Skipped entirely under prefers-reduced-motion.
  useLayoutEffect(() => {
    const node = cardRef.current;
    if (!node || shouldSkipMotion()) return;
    gsap.fromTo(node, { opacity: 0, y: 16 }, { opacity: 1, y: 0, duration: 0.45, ease: 'power2.out' });
  }, [step]);

  const runDetect = useCallback(async () => {
    setStep('detecting');
    const startedAt = Date.now();
    let status: DetectStatus = 'not-found';
    try {
      const res = await fetch('/api/onboarding/detect');
      const data = (await res.json()) as { status?: DetectStatus; kit?: boolean };
      if (data.status === 'found' || data.status === 'empty' || data.status === 'not-found') {
        status = data.status;
      }
      // The scan also reports whether the Starter Kit is installed — this is
      // what unlocks the guided tour at the end of onboarding.
      setKitDetected(Boolean(data.kit));
    } catch (err) {
      console.error('[onboarding] detect failed:', err);
      // Falls back to 'not-found' — the safest branch when we can't even
      // confirm the filesystem check ran (never claim "found" on a guess).
    }

    // Keep the "detecting" beat visible for a beat even on a near-instant
    // filesystem check — an instant flash reads as broken, not fast.
    const elapsed = Date.now() - startedAt;
    if (elapsed < MIN_DETECT_DISPLAY_MS) {
      await new Promise((resolve) => setTimeout(resolve, MIN_DETECT_DISPLAY_MS - elapsed));
    }

    setStep(status === 'found' ? 'found' : status === 'empty' ? 'empty' : 'notfound');
  }, []);

  const handleInject = useCallback(async () => {
    setBusy(true);
    try {
      await fetch('/api/onboarding/inject', { method: 'POST' });
    } catch (err) {
      console.error('[onboarding] inject failed:', err);
    }
    try {
      const res = await fetch('/api/system');
      setSystemStats((await res.json()) as SystemStats);
    } catch (err) {
      console.error('[onboarding] system fetch failed:', err);
      setSystemStats(null);
    }
    setBusy(false);
    setStep('summary');
  }, []);

  const finish = useCallback(() => {
    // Mark seen server-side, but never let a failed write block the user
    // from actually entering the app they just onboarded into.
    fetch('/api/onboarding', { method: 'POST' }).catch((err) => {
      console.error('[onboarding] mark-seen failed:', err);
    });
    onComplete();
  }, [onComplete]);

  const handleTryDemo = useCallback(() => {
    const url = new URL(window.location.href);
    url.searchParams.set('demo', '1');
    window.location.assign(url.toString());
  }, []);

  // Lane 3 — install Claude Code itself, in-app, streamed. Never forced: the
  // notfound branch keeps the manual link + demo mode, and this step has a
  // Cancel that aborts the run (killing the child server-side) and drops back
  // to the notfound choices.
  const handleInstallClaude = useCallback(() => {
    setStep('installingClaude');
    install.start('/api/onboarding/install-claude');
  }, [install]);

  const cancelInstallClaude = useCallback(() => {
    install.cancel();
    setStep('notfound');
  }, [install]);

  // Kit buyer opted into the walkthrough: flag the tour to run once the app
  // mounts (page.tsx consumes it), then finish onboarding normally.
  const handleTakeTour = useCallback(() => {
    requestTour();
    finish();
  }, [finish]);

  // The completion CTA on the found/empty branches routes to the Starter-Kit
  // tour offer when the kit was detected, and straight out otherwise.
  const finishOrOfferTour = useCallback(() => {
    if (kitDetected) setStep('starterKit');
    else finish();
  }, [kitDetected, finish]);

  return (
    <div className="onb" role="dialog" aria-modal="true" aria-label="Welcome to Blubber">
      {/* Dame's animated "main room booting up" loop. Muted + inline, purely
          decorative, hardware-decoded (no WebGL/JS cost) — so it's gated only
          on the OS-level prefers-reduced-motion, NOT the manual reduce-effects
          toggle (that flag exists to shed WebGL/GSAP load, which this isn't).
          Reduced-motion users get the static blurred reactor still instead
          (see .onb__backdrop's media query). */}
      {!(typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) && (
        <video
          className="onb__video"
          src="/bg/startup-loop.mp4"
          autoPlay
          muted
          loop
          playsInline
          aria-hidden="true"
        />
      )}
      <div className="onb__backdrop" aria-hidden="true" />
      <div className="onb__card" ref={cardRef}>
        {step === 'welcome' && (
          <>
            {/* Static reference-photo Blubber (the render, NOT the live 3D). The
                3D Blubber is deliberately held back until the user is booted
                inside the app — see IntroCinematic + page.tsx. */}
            {/* eslint-disable-next-line @next/next/no-img-element -- static /public asset, app-wide convention */}
            <img className="onb__badge" src="/blubber-hero.png" alt="Blubber" width={96} height={96} />
            <h1 className="onb__title">Meet Blubber</h1>
            <p className="onb__body">
              This is your local command deck — a live shell over the Claude Code sessions already running on
              this machine. No account, no setup wizard. Just your real work, given a face.
            </p>
            <div className="onb__actions onb__actions--pair">
              <button
                type="button"
                className="onb__btn onb__btn--ghost"
                onClick={handleTryDemo}
              >
                Explore in demo mode
              </button>
              <button type="button" className="onb__btn onb__btn--primary" onClick={runDetect}>
                Continue
              </button>
            </div>
          </>
        )}

        {step === 'detecting' && (
          <>
            <div className="onb__pulse" aria-hidden="true" />
            <p className="onb__narration">Looking for Claude Code on this machine…</p>
          </>
        )}

        {step === 'found' && (
          <>
            <h2 className="onb__title onb__title--sm">Found your setup</h2>
            <p className="onb__body">
              There's real Claude Code history on this machine already. Blubber can index it right now — sessions,
              agents, token usage — so the dashboard opens with your actual work instead of an empty room.
            </p>
            <div className="onb__actions">
              <button
                type="button"
                className="onb__btn onb__btn--primary"
                onClick={handleInject}
                disabled={busy}
              >
                {busy ? 'Injecting…' : 'Inject my setup'}
              </button>
            </div>
          </>
        )}

        {step === 'empty' && (
          <>
            <h2 className="onb__title onb__title--sm">Clean slate</h2>
            <p className="onb__body">
              Claude Code is here, but there's nothing indexed yet. That's fine — the dashboard starts at zero and
              fills in the moment you start working.
            </p>
            <div className="onb__actions">
              <button type="button" className="onb__btn onb__btn--primary" onClick={finishOrOfferTour}>
                Enter Blubber OS
              </button>
            </div>
          </>
        )}

        {step === 'notfound' && (
          <>
            <h2 className="onb__title onb__title--sm">No Claude Code detected</h2>
            <p className="onb__body">
              Blubber is a shell over Claude Code — it needs it installed to show anything real. I can install it
              for you right here, or you can do it yourself. No pressure either way — you can also just poke around
              in demo mode.
            </p>
            <div className="onb__actions">
              <button type="button" className="onb__btn onb__btn--primary" onClick={handleInstallClaude}>
                Install it for me
              </button>
            </div>
            <div className="onb__actions onb__actions--pair">
              <a
                className="onb__btn onb__btn--ghost"
                href="https://claude.com/claude-code"
                target="_blank"
                rel="noopener noreferrer"
              >
                I'll do it myself
              </a>
              <button type="button" className="onb__btn onb__btn--ghost" onClick={handleTryDemo}>
                Try demo mode
              </button>
            </div>
          </>
        )}

        {step === 'installingClaude' && (
          <>
            <h2 className="onb__title onb__title--sm">
              {install.status === 'done'
                ? 'Claude Code installed'
                : install.status === 'error'
                  ? "That didn't finish"
                  : 'Installing Claude Code…'}
            </h2>
            <p className="onb__narration">
              {install.status === 'running'
                ? install.currentLabel || 'Starting the installer…'
                : install.status === 'done'
                  ? 'Got it. Let me look for your setup again.'
                  : install.status === 'error'
                    ? 'You can retry, install it yourself, or jump into demo mode instead.'
                    : ''}
            </p>
            {install.output && (
              <pre className="onb__console" aria-label="installer output">
                {install.output.slice(-4000)}
              </pre>
            )}
            {install.status === 'running' && (
              <div className="onb__actions">
                <button type="button" className="onb__btn onb__btn--ghost" onClick={cancelInstallClaude}>
                  Cancel
                </button>
              </div>
            )}
            {install.status === 'done' && (
              <div className="onb__actions">
                <button type="button" className="onb__btn onb__btn--primary" onClick={runDetect}>
                  Continue
                </button>
              </div>
            )}
            {install.status === 'error' && (
              <div className="onb__actions onb__actions--pair">
                <button type="button" className="onb__btn onb__btn--ghost" onClick={handleTryDemo}>
                  Try demo mode
                </button>
                <button type="button" className="onb__btn onb__btn--primary" onClick={handleInstallClaude}>
                  Retry
                </button>
              </div>
            )}
          </>
        )}


        {step === 'summary' && (
          <>
            <h2 className="onb__title onb__title--sm">You're live</h2>
            <p className="onb__body">Real numbers, off this machine, right now:</p>
            <div className="onb__stats">
              <div className="onb__stat">
                <span className="onb__stat-value">{systemStats ? `${systemStats.cpu}%` : '—'}</span>
                <span className="onb__stat-label">CPU</span>
              </div>
              <div className="onb__stat">
                <span className="onb__stat-value">{systemStats ? `${systemStats.mem}%` : '—'}</span>
                <span className="onb__stat-label">Memory</span>
              </div>
              <div className="onb__stat">
                <span className="onb__stat-value">{systemStats ? `${systemStats.proc}%` : '—'}</span>
                <span className="onb__stat-label">Footprint</span>
              </div>
            </div>
            <div className="onb__actions">
              <button type="button" className="onb__btn onb__btn--primary" onClick={finishOrOfferTour}>
                Let's go
              </button>
            </div>
          </>
        )}

        {step === 'starterKit' && (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element -- static /public asset, app-wide convention */}
            <img className="onb__badge" src="/blubber-hero.png" alt="Blubber" width={96} height={96} />
            <h2 className="onb__title onb__title--sm">Starter Kit detected</h2>
            <p className="onb__body">
              Nice — your Starter Kit is installed. Your CLAUDE.md, agents, skills, and commands are all in place.
              First time in? Let me give you the quick tour and show you around the deck. Takes about 30 seconds.
            </p>
            <div className="onb__actions onb__actions--pair">
              <button type="button" className="onb__btn onb__btn--ghost" onClick={finish}>
                No thanks, I'll explore
              </button>
              <button type="button" className="onb__btn onb__btn--primary" onClick={handleTakeTour}>
                Take the tour
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
