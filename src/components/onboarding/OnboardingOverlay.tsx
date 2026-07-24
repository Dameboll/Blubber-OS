'use client';

/**
 * OnboardingOverlay — the entire free-tier onboarding flow (Lane B1, raw-shell
 * pass Lane C).
 *
 * PHILOSOPHY: Community Edition is a raw shell for builders who already know
 * Claude Code. This overlay is not a tutorial — it's one screen, one action,
 * one tip. No demo mode, no "let me walk you through it," no coddling. The
 * dashboard's stats/activity panels show a bundled placeholder dataset (see
 * src/server/demo-dataset.ts) until the user actually scans and connects a
 * real ~/.claude workspace (src/server/connected-store.ts flips on a
 * successful inject) — that's the DEFAULT state, not a separate "mode" the
 * user has to opt into or escape from.
 *
 * Anything guided beyond that one tip — the streamed in-app Claude Code
 * installer, the dashboard walkthrough — is Starter-Kit-gated. Free never
 * sees it. Five self-managed steps:
 *
 *   welcome    → full-screen "Meet Blubber" card. ONE primary action, "Scan my
 *                workspace" (runs detect against ~/.claude), plus Blubber's
 *                single tip in a drop-zone: drag your ~/.claude folder onto
 *                the window, or just hit scan if it lives in the default spot.
 *   detecting  → fires GET /api/onboarding/detect (real filesystem check on
 *                ~/.claude — see that route for exactly what it looks at).
 *   found      → ~/.claude has real project history. One confirm button
 *                ("Inject my setup") → POST /api/onboarding/inject (which
 *                calls the existing background indexer AND marks the
 *                workspace connected, see that route) → fetches GET
 *                /api/system for real, live machine stats → advances to
 *                `summary`.
 *   empty      → ~/.claude exists but is untouched. "Clean slate" message,
 *                one button straight through to the dashboard.
 *   notfound   → no ~/.claude at all. Terse: what's missing, a "Scan again"
 *                button, a quiet text link out to install Claude Code
 *                manually, and — critically — a ghost "Look around first"
 *                that walks straight into the dashboard on the placeholder
 *                dataset, exactly like `empty` does. This branch used to be a
 *                hard dead end (scan-or-leave, no third option); a fresh-box
 *                smoke test proved that ships a modal cage to every new user
 *                who hasn't set up Claude Code yet, which is most of them.
 *                Still no install-for-you flow here — that one is
 *                Starter-Kit-gated (see
 *                src/app/api/onboarding/install-claude/route.ts, left intact
 *                but unhooked from this overlay).
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

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type DragEvent } from 'react';
import { gsap } from 'gsap';
import { isReduceEffectsActive } from '../../lib/reduce-effects';
import { requestTour } from '../../lib/tour';
import { requestSoulInterview } from '../../lib/soul';
import { speak } from '../../lib/blubber-voice';
import FloatingBlubber from '../FloatingBlubber';
import './OnboardingOverlay.css';

// Community Edition onboarding is barebones by design: welcome, detect, done.
// The ONE thing detection adds for paying users is the Starter Kit: the same
// ~/.claude scan also looks for the kit marker (detect returns { kit }), and
// if it's found we offer the guided dashboard tour on the way in
// ('starterKit' step → requestTour()). No kit detected = none of this ever shows.
type Step = 'welcome' | 'detecting' | 'found' | 'empty' | 'notfound' | 'starterKit' | 'summary';
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

// Blubber "narrates" a handful of steps out loud in blubber-speak (see
// src/lib/blubber-voice.ts) — the same body copy shown on screen, chopped
// into blips rather than read as TTS. Only the steps with real narration
// copy get an entry; 'detecting' and 'starterKit' are intentionally left out
// (detecting is a transient beat, starterKit already has its own two-button
// decision to make and doesn't need Blubber talking over it).
const STEP_NARRATION: Partial<Record<Step, string>> = {
  welcome:
    "A live shell over the Claude Code sessions already running on this machine — sessions, agents, token burn, real. No account, no setup wizard, no tutorial. You already know how this works.",
  found:
    "There's real Claude Code history on this machine already. Blubber can index it right now — sessions, agents, token usage — so the dashboard opens with your actual work instead of an empty room.",
  notfound:
    "Blubber is a shell over Claude Code — you'll want it installed to get the real numbers. Look around in the meantime, and scan again once it's set up.",
  summary: 'Real numbers, off this machine, right now.',
};

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

  // Fade/rise the card in on every step change — the one animation beat this
  // overlay uses. Skipped entirely under prefers-reduced-motion.
  useLayoutEffect(() => {
    const node = cardRef.current;
    if (!node || shouldSkipMotion()) return;
    gsap.fromTo(node, { opacity: 0, y: 16 }, { opacity: 1, y: 0, duration: 0.45, ease: 'power2.out' });
  }, [step]);

  // Narrate the steps that have narration copy (see STEP_NARRATION above),
  // once per step change. Fire-and-forget — speak() never throws.
  useEffect(() => {
    const line = STEP_NARRATION[step];
    if (line) speak(line);
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

  // The drop-zone doesn't (and can't, without Electron preload work — out of
  // scope here) resolve an actual dropped path. A drop is read as "the user
  // pointed at their workspace" and just re-runs the same default-location
  // scan runDetect() already does — honest behavior, not a fake file-path read.
  const handleDropzoneDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
  }, []);

  const handleDropzoneDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      runDetect();
    },
    [runDetect],
  );

  // Kit buyer opted into the walkthrough: flag the tour to run once the app
  // mounts (page.tsx consumes it), then finish onboarding normally. The Soul
  // Interview offer is chained off the TOUR's own completion instead (see
  // DashboardTour.tsx's `next()`) — not here — so a kit buyer who takes the
  // tour only ever gets one guided overlay at a time, never both stacked.
  const handleTakeTour = useCallback(() => {
    requestTour();
    finish();
  }, [finish]);

  // Kit buyer declined the walkthrough at this same offer: flag the Soul
  // Interview to run instead once the app mounts, then finish onboarding
  // normally. This is the other of the two mutually-exclusive branches off
  // the starterKit step (see src/lib/soul.ts's header, launch path 2).
  const handleDeclineTour = useCallback(() => {
    requestSoulInterview();
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
            {/* Glossy static Blubber, floating (NOT the live 3D — that's held
                back until the user is booted inside the app; see IntroCinematic
                + page.tsx). */}
            <FloatingBlubber size={188} className="onb__badge" alt="Blubber" />
            <h1 className="onb__title">Meet Blubber</h1>
            <p className="onb__body">
              A live shell over the Claude Code sessions already running on this machine — sessions, agents, token
              burn, real. No account, no setup wizard, no tutorial. You already know how this works.
            </p>
            <div className="onb__actions">
              <button type="button" className="onb__btn onb__btn--primary" onClick={runDetect}>
                Scan my workspace
              </button>
            </div>
            <div
              className="onb__dropzone"
              onDragOver={handleDropzoneDragOver}
              onDrop={handleDropzoneDrop}
            >
              <p className="onb__dropzone-text">
                Point me at your Claude Code workspace — drop your <code>~/.claude</code> folder onto this window,
                or just hit scan if it lives in the default spot.
              </p>
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
            <h2 className="onb__title onb__title--sm">No Claude Code workspace found at ~/.claude.</h2>
            <p className="onb__body">
              Blubber is a shell over Claude Code — you'll want it installed to get the real numbers. Look around in the
              meantime, and scan again once it's set up.
            </p>
            <div className="onb__actions onb__actions--pair">
              <button type="button" className="onb__btn onb__btn--ghost" onClick={finishOrOfferTour}>
                Look around first
              </button>
              <button type="button" className="onb__btn onb__btn--primary" onClick={runDetect}>
                Scan again
              </button>
            </div>
            <a
              className="onb__link"
              href="https://claude.com/claude-code"
              target="_blank"
              rel="noopener noreferrer"
            >
              claude.com/claude-code
            </a>
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
            <FloatingBlubber size={188} className="onb__badge" alt="Blubber" />
            <h2 className="onb__title onb__title--sm">Starter Kit detected</h2>
            <p className="onb__body">
              Nice — your Starter Kit is installed. Your CLAUDE.md, agents, skills, and commands are all in place.
              First time in? Let me give you the quick tour and show you around the deck. Takes about 30 seconds.
            </p>
            <div className="onb__actions onb__actions--pair">
              <button type="button" className="onb__btn onb__btn--ghost" onClick={handleDeclineTour}>
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
