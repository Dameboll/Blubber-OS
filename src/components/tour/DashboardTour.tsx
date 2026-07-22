'use client';

/**
 * DashboardTour — the Starter-Kit-only guided walkthrough (the "hand-holding").
 *
 * Fires after the kit is detected (see src/lib/tour.ts + page.tsx). Blubber
 * himself (the official static render, public/blubber-hero.png) floats next to
 * each spotlighted nav tab with a CHAT BUBBLE doing the talking — the bubble
 * IS the advance control: the user clicks the bubble to step through, exactly
 * like clicking through dialogue in a game. Back / Skip stay available, Esc
 * bails, arrows step. Fully opt-out at any point.
 *
 * The spotlight is the classic coach-mark trick: a ring element with a huge
 * dark box-shadow dims the whole screen EXCEPT the target button's rect — no
 * separate backdrop, and it always lines up with the real element because the
 * rect is read live from the DOM ([data-nav-id] on AppShell's nav buttons).
 *
 * NOT part of the free Community Edition — this only ever mounts when the
 * Starter Kit is present (page.tsx gates it behind the kit-detected tour
 * request). Community onboarding never reaches here.
 *
 * OWNERSHIP: this file + DashboardTour.css only.
 */

import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import type { NavId } from '../AppShell';
import './DashboardTour.css';

interface TourStep {
  navId: NavId;
  label: string;
  caption: string;
}

// Walks the nav top-to-bottom. Captions are Blubber talking — short, warm, no
// corporate filler.
const STEPS: TourStep[] = [
  { navId: 'dashboard', label: 'Dashboard', caption: "Home base. Everything running on this machine, live, at a glance." },
  { navId: 'terminal', label: 'Terminal', caption: "A real terminal, right here. Run Claude Code without ever leaving me." },
  { navId: 'agents', label: 'Agents', caption: "Your specialist agents — who's on call and exactly what each one's for." },
  { navId: 'projects', label: 'Projects', caption: "Every project, sorted into ACTIVE, SANDBOX, and ARCHIVE. No more flat pile." },
  { navId: 'memory', label: 'Memory', caption: "What Claude actually remembers across sessions. Your context, kept." },
  { navId: 'analytics', label: 'Analytics', caption: "Token burn, usage, trends — where your time and spend really go." },
  { navId: 'music', label: 'Music', caption: "Yeah, a music player. Set the vibe while you build. (Bring your own tracks though, I'm a blob, not a record label.)" },
  { navId: 'pet', label: 'Virtual Pet', caption: "That's me. Keep me fed and happy while you work and I'll keep you company." },
  { navId: 'academy', label: 'Academy', caption: "Lessons and walkthroughs to level up your Claude Code game." },
  { navId: 'settings', label: 'Settings', caption: "Tune everything — look, model, notifications, and your Starter Kit tools." },
];

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface DashboardTourProps {
  onNavChange: (id: NavId) => void;
  onClose: () => void;
}

export default function DashboardTour({ onNavChange, onClose }: DashboardTourProps) {
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);

  const step = STEPS[index];
  const isLast = index === STEPS.length - 1;

  // Switch to this step's screen so the user sees it behind the spotlight.
  useEffect(() => {
    onNavChange(step.navId);
  }, [step.navId, onNavChange]);

  // Read the live position of the target nav button. Runs after the nav change
  // paints, and re-runs on resize so the spotlight never drifts off the button.
  useLayoutEffect(() => {
    const measure = () => {
      const el = document.querySelector<HTMLElement>(`[data-nav-id="${step.navId}"]`);
      if (!el) {
        setRect(null);
        return;
      }
      const r = el.getBoundingClientRect();
      setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
    };
    // rAF so the just-switched screen has laid out before we measure.
    const id = requestAnimationFrame(measure);
    window.addEventListener('resize', measure);
    return () => {
      cancelAnimationFrame(id);
      window.removeEventListener('resize', measure);
    };
  }, [step.navId]);

  const next = useCallback(() => {
    if (isLast) onClose();
    else setIndex((i) => Math.min(i + 1, STEPS.length - 1));
  }, [isLast, onClose]);

  const back = useCallback(() => setIndex((i) => Math.max(i - 1, 0)), []);

  // Esc skips the whole thing; arrow keys / Enter step through.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowRight' || e.key === 'Enter') next();
      else if (e.key === 'ArrowLeft') back();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [next, back, onClose]);

  const PAD = 6;
  const ringStyle = rect
    ? {
        top: rect.top - PAD,
        left: rect.left - PAD,
        width: rect.width + PAD * 2,
        height: rect.height + PAD * 2,
      }
    : undefined;

  // Blubber + his bubble sit to the right of the nav button (left sidebar),
  // vertically centered on it, clamped so the pair never runs off-screen.
  const viewportH = typeof window !== 'undefined' ? window.innerHeight : 900;
  const escortStyle = rect
    ? {
        top: Math.max(16, Math.min(rect.top + rect.height / 2 - 60, viewportH - 240)),
        left: rect.left + rect.width + 22,
      }
    : undefined;

  return (
    <div className="tour" role="dialog" aria-modal="true" aria-label="Dashboard tour">
      {/* Spotlight ring — its huge box-shadow dims everything but the target. */}
      {rect ? (
        <div className="tour__ring" style={ringStyle} aria-hidden="true" />
      ) : (
        // Fallback if the target button can't be found: a plain dimmer so the
        // bubble still reads and the tour never gets stuck on a blank screen.
        <div className="tour__scrim" aria-hidden="true" />
      )}

      {/* Blubber + chat bubble. The bubble is the click-through control. */}
      <div className="tour__escort" style={escortStyle}>
        {/* eslint-disable-next-line @next/next/no-img-element -- static /public asset, app-wide convention */}
        <img className="tour__blubber" src="/blubber-hero.png" alt="" aria-hidden="true" />
        <button
          type="button"
          className="tour__bubble"
          onClick={next}
          aria-label={`${step.label}: ${step.caption} Click to ${isLast ? 'finish' : 'continue'}.`}
        >
          <span className="tour__step-count">
            {index + 1} / {STEPS.length} · {step.label}
          </span>
          <span className="tour__caption">{step.caption}</span>
          <span className="tour__hint">{isLast ? 'click to finish' : 'click to continue'}</span>
        </button>
      </div>

      <div className="tour__controls">
        {index > 0 && (
          <button type="button" className="tour__btn" onClick={back}>
            Back
          </button>
        )}
        <button type="button" className="tour__btn" onClick={onClose}>
          Skip tour
        </button>
      </div>
    </div>
  );
}
