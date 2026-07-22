'use client';

/**
 * ResumeSessionOffer — the dashboard "pick up your open Claude session here?"
 * offer (ALL builds, not kit-gated — a core dashboard feature). Self-fetches
 * GET /api/recent-session once; if the most-recent Claude transcript in ANOTHER
 * project was written within the freshness window, it shows a slim, dismissible
 * offer. Continue opens a terminal tab cd'd into that project running
 * `claude --continue` (SessionProvider.openTabWith → the resume seam threaded
 * down to pty-manager's launch args).
 *
 * HONEST FRAMING: a recent file mtime proves a recent WRITE, not that a live
 * external `claude` process is still attached. The copy says "resume where you
 * left off," never "take over a live session." If the external terminal is
 * still open, a dashboard --continue means two claude procs on one transcript
 * (interleave risk) — so this is offered as a resume, deliberately not a live
 * takeover.
 */

import { useEffect, useState } from 'react';
import { History, X } from 'lucide-react';
import { useSession } from '../../context/SessionProvider';
import './ResumeSessionOffer.css';

interface RecentSession {
  cwd: string;
  project: string;
  sessionId: string;
  ageMs: number;
}

// Only offer to resume a session touched within this window — old enough and
// it's not "where you left off" anymore, it's archaeology.
const FRESHNESS_MS = 5 * 60 * 1000;
// Remember a dismiss for the app launch so navigating back to the dashboard
// doesn't re-nag. Cleared when the tab/app is fully closed (sessionStorage).
const DISMISSED_KEY = 'blubber-resume-offer-dismissed';

function friendlyAge(ms: number): string {
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return 'moments ago';
  if (mins === 1) return '1 minute ago';
  return `${mins} minutes ago`;
}

export default function ResumeSessionOffer() {
  const { openTabWith } = useSession();
  const [session, setSession] = useState<RecentSession | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    // Respect an earlier dismiss this app launch — don't even fetch.
    let alreadyDismissed = false;
    try {
      alreadyDismissed = sessionStorage.getItem(DISMISSED_KEY) === '1';
    } catch {
      // sessionStorage unavailable — just proceed with the fetch.
    }
    if (alreadyDismissed) {
      setDismissed(true);
      return;
    }

    let cancelled = false;
    fetch('/api/recent-session')
      .then((res) => res.json() as Promise<{ session?: RecentSession | null }>)
      .then((data) => {
        if (cancelled) return;
        const s = data?.session;
        if (s && typeof s.cwd === 'string' && s.ageMs < FRESHNESS_MS) {
          setSession(s);
        }
      })
      .catch(() => {
        // No recent-session read — simply show nothing.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const dismiss = () => {
    setDismissed(true);
    try {
      sessionStorage.setItem(DISMISSED_KEY, '1');
    } catch {
      // Non-fatal — the local state hide is enough for this session.
    }
  };

  const handleContinue = () => {
    if (!session) return;
    openTabWith({
      title: session.project,
      cwd: session.cwd,
      resume: { mode: 'continue' },
    });
    dismiss();
  };

  if (dismissed || !session) return null;

  return (
    <div className="resume-offer" role="status">
      <span className="resume-offer__icon" aria-hidden="true">
        <History size={16} />
      </span>
      <span className="resume-offer__text">
        <span className="resume-offer__lead">
          Pick up your <strong>{session.project}</strong> session?
        </span>
        <span className="resume-offer__sub">Last active {friendlyAge(session.ageMs)}</span>
      </span>
      <button type="button" className="resume-offer__continue" onClick={handleContinue}>
        Continue
      </button>
      <button type="button" className="resume-offer__dismiss" aria-label="Dismiss" onClick={dismiss}>
        <X size={15} aria-hidden="true" />
      </button>
    </div>
  );
}
