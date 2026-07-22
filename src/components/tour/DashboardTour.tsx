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
 * The spotlight is a full-screen blurred veil (.tour__veil — backdrop-filter
 * blur + a dark translucent fill) with a hole punched through it via an
 * inline clip-path "keyhole" polygon: the outer viewport rect plus the
 * target's rect (traced as an inner loop, bridged back to the outer path via
 * a zero-width seam) under the evenodd fill rule. That leaves the app behind
 * — including the 3D mascot — heavily obscured (dark AND blurred, not flat
 * black) while only the spotlighted nav button stays crisp. A separate
 * .tour__ring div draws the crisp border on top of the hole. It always lines
 * up with the real element because the rect is read live from the DOM
 * ([data-nav-id] on AppShell's nav buttons). Position is set per-step from
 * that live rect and snaps — no transition/animation on clip-path or
 * position anywhere in this file.
 *
 * NOT part of the free Community Edition — this only ever mounts when the
 * Starter Kit is present (page.tsx gates it behind the kit-detected tour
 * request). Community onboarding never reaches here.
 *
 * OWNERSHIP: this file + DashboardTour.css only.
 */

import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import type { NavId } from '../AppShell';
import { requestSoulInterview } from '../../lib/soul';
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

  // Every live 3D Blubber on the page (Flubber3D canvases, tagged
  // data-flubber-3d) shares ONE offscreen WebGL host (see
  // src/lib/flubber3d/host.ts) — there's no single overlay element to hide,
  // the canvases are ordinary DOM nodes scattered through whatever screen is
  // mounted behind the veil. Tagging <body> instead lets one global CSS rule
  // (globals.css, `body.tour-active [data-flubber-3d]`) hide every one of
  // them at once, however many are on screen. visibility:hidden (not
  // display:none) so layout never shifts and the host's IntersectionObserver
  // keeps the slot "visible" — the instance still advances off-camera, which
  // is fine since it's invisible either way and resumes exactly in step the
  // moment the tour ends, instead of jump-cutting from a stale frame. Cleanup
  // always runs, including an unmount mid-tour (Esc, nav away, etc.), so the
  // mascot can never get stuck hidden.
  useEffect(() => {
    document.body.classList.add('tour-active');
    return () => {
      document.body.classList.remove('tour-active');
    };
  }, []);

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

  // Clicking through the LAST step's bubble is a real completion, not a
  // skip — that's the one moment this component offers the Soul Interview
  // (see src/lib/soul.ts's header for the full launch-path list). Esc and
  // the explicit "Skip tour" button below both call onClose directly, never
  // this path, so bailing early never chains into another overlay.
  const next = useCallback(() => {
    if (isLast) {
      requestSoulInterview();
      onClose();
    } else {
      setIndex((i) => Math.min(i + 1, STEPS.length - 1));
    }
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

  // Viewport dims, read fresh on every render (the resize listener in the
  // measure effect above triggers a re-render via setRect on resize).
  const viewportW = typeof window !== 'undefined' ? window.innerWidth : 1600;
  const viewportH = typeof window !== 'undefined' ? window.innerHeight : 900;

  // Keyhole clip-path for the veil: outer viewport rect + the target's rect
  // (same PAD as the ring) traced as an inner loop, joined back to the outer
  // path by a zero-width seam so the whole thing is one continuous polygon.
  // Under fill-rule evenodd that inner loop reads as a hole — the target
  // button sits outside the clipped (and therefore outside the blurred/
  // dimmed) region entirely. No hole at all when rect is null.
  const veilStyle = rect
    ? {
        clipPath: `polygon(evenodd, 0px 0px, ${viewportW}px 0px, ${viewportW}px ${viewportH}px, 0px ${viewportH}px, 0px 0px, ${rect.left - PAD}px ${rect.top - PAD}px, ${rect.left - PAD}px ${rect.top + rect.height + PAD}px, ${rect.left + rect.width + PAD}px ${rect.top + rect.height + PAD}px, ${rect.left + rect.width + PAD}px ${rect.top - PAD}px, ${rect.left - PAD}px ${rect.top - PAD}px, 0px 0px)`,
      }
    : undefined;

  // Blubber + his bubble sit to the right of the nav button (left sidebar),
  // vertically centered on it, clamped so the pair never runs off-screen.
  const escortStyle = rect
    ? {
        top: Math.max(16, Math.min(rect.top + rect.height / 2 - 60, viewportH - 240)),
        left: rect.left + rect.width + 22,
      }
    : undefined;

  return (
    <div className="tour" role="dialog" aria-modal="true" aria-label="Dashboard tour">
      {/* Full-screen blurred dimmer. Its clip-path (see veilStyle above)
          punches a hole around the target so only that button stays crisp;
          with no target found, it renders with no hole — a plain dimmer so
          the bubble still reads and the tour never gets stuck on a blank
          screen. pointer-events stay on so background clicks are swallowed;
          the hole itself is clipped out of the hit-test region too, so the
          real button underneath stays clickable. */}
      <div className="tour__veil" style={veilStyle} aria-hidden="true" />

      {/* Spotlight ring — crisp border marking the target; the veil above
          now owns all the dimming/blurring. */}
      {rect && <div className="tour__ring" style={ringStyle} aria-hidden="true" />}

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
