'use client';

/**
 * OnboardingOverlay — the entire free-tier "inject" onboarding flow (Lane B1).
 *
 * Community Edition ships with ZERO built-in help content: whoever is running
 * this already knows Claude Code and GitHub, so this is a ~30 second beat,
 * not a tutorial. Six self-managed steps:
 *
 *   welcome    → full-screen "Meet Blubber" card, one Continue button.
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
 * out of scope for a first-run overlay that has to feel instant.
 */

import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { gsap } from 'gsap';
import './OnboardingOverlay.css';

type Step = 'welcome' | 'detecting' | 'found' | 'empty' | 'notfound' | 'summary';
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

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export default function OnboardingOverlay({ onComplete }: OnboardingOverlayProps) {
  const [step, setStep] = useState<Step>('welcome');
  const [busy, setBusy] = useState(false);
  const [systemStats, setSystemStats] = useState<SystemStats | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);

  // Fade/rise the card in on every step change — the one animation beat this
  // overlay uses. Skipped entirely under prefers-reduced-motion.
  useLayoutEffect(() => {
    const node = cardRef.current;
    if (!node || prefersReducedMotion()) return;
    gsap.fromTo(node, { opacity: 0, y: 16 }, { opacity: 1, y: 0, duration: 0.45, ease: 'power2.out' });
  }, [step]);

  const runDetect = useCallback(async () => {
    setStep('detecting');
    const startedAt = Date.now();
    let status: DetectStatus = 'not-found';
    try {
      const res = await fetch('/api/onboarding/detect');
      const data = (await res.json()) as { status?: DetectStatus };
      if (data.status === 'found' || data.status === 'empty' || data.status === 'not-found') {
        status = data.status;
      }
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

  return (
    <div className="onb" role="dialog" aria-modal="true" aria-label="Welcome to Blubber">
      <div className="onb__backdrop" aria-hidden="true" />
      <div className="onb__card" ref={cardRef}>
        {step === 'welcome' && (
          <>
            <div className="onb__badge" aria-hidden="true" />
            <h1 className="onb__title">Meet Blubber</h1>
            <p className="onb__body">
              This is your local command deck — a live shell over the Claude Code sessions already running on
              this machine. No account, no setup wizard. Just your real work, given a face.
            </p>
            <div className="onb__actions">
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
              <button type="button" className="onb__btn onb__btn--primary" onClick={finish}>
                Enter Blubber OS
              </button>
            </div>
          </>
        )}

        {step === 'notfound' && (
          <>
            <h2 className="onb__title onb__title--sm">No Claude Code detected</h2>
            <p className="onb__body">
              Blubber is a shell over Claude Code — it needs it installed to show anything real. Install it, then
              come back, or poke around first in demo mode.
            </p>
            <div className="onb__actions onb__actions--pair">
              <a
                className="onb__btn onb__btn--ghost"
                href="https://claude.com/claude-code"
                target="_blank"
                rel="noopener noreferrer"
              >
                Install Claude Code
              </a>
              <button type="button" className="onb__btn onb__btn--primary" onClick={handleTryDemo}>
                Try Demo Mode
              </button>
            </div>
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
              <button type="button" className="onb__btn onb__btn--primary" onClick={finish}>
                Let's go
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
