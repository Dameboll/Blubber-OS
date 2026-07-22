'use client';

/**
 * AcademyScreen — the locked "Blubber Academy" nav destination (Lane B3).
 *
 * Product context: Academy will only ever ship bundled inside a future paid
 * "All Access" tier — it is never sold standalone. This screen ships
 * visible-but-locked in v1 purely to capture waitlist interest ahead of that
 * launch. There is no real course content or payment flow yet, and nothing
 * here pretends otherwise: every module is rendered as an honest locked
 * teaser, never a fake "preview".
 *
 * Layout: fixed header row, then the key art (public/bg/academy-hero.webp)
 * takes over the ENTIRE rest of the tab — full-bleed, no side panels, no
 * module outline. A compact "Coming soon" + waitlist strip floats over the
 * bottom of the art. The waitlist form is wired to the one real endpoint
 * behind this screen, POST /api/waitlist (src/app/api/waitlist/route.ts ->
 * src/server/waitlist-store.ts). Success/duplicate/invalid states are all
 * real server responses, never simulated.
 *
 * LAW 2 (one window): height:100% inside AppShell's bounded content area; the
 * header stays fixed and the art fills the rest via flex-grow, so the page
 * itself never scrolls.
 */

import { useState, type FormEvent } from 'react';
import { GraduationCap, Mail, CheckCircle2 } from 'lucide-react';
import FlubberCharacter from '../FlubberCharacter';
import './AcademyScreen.css';

type SubmitState = 'idle' | 'submitting' | 'success' | 'error';

export default function AcademyScreen() {
  const [email, setEmail] = useState('');
  const [state, setState] = useState<SubmitState>('idle');
  const [message, setMessage] = useState<string | null>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = email.trim();
    if (!trimmed) return;

    setState('submitting');
    setMessage(null);

    try {
      const res = await fetch('/api/waitlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: trimmed }),
      });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };

      if (!res.ok || !json.ok) {
        setState('error');
        setMessage(json.error ?? 'Something went wrong. Try again.');
        return;
      }

      setState('success');
      setMessage("You're on the list — we'll email you the moment Academy opens.");
    } catch {
      setState('error');
      setMessage("Couldn't reach the server. Check your connection and try again.");
    }
  };

  return (
    <div className="academy-screen">
      <header className="academy-screen__header">
        <GraduationCap size={18} aria-hidden="true" />
        <div>
          <h1>Blubber Academy</h1>
          <p>The course on building with Claude Code, taught the way we actually build.</p>
        </div>
        <div className="academy-screen__mascot">
          <FlubberCharacter expression="focused" size={92} mode="character" showToggle={false} />
        </div>
      </header>

      {/* The Academy key art — "ACADEMY ACCESS SOON" is in the art itself, so
          it doubles as the coming-soon statement. It's the entire rest of the
          tab now (flex-grow fills down to the bottom of the screen); the
          waitlist strip floats over its bottom edge. */}
      <div className="academy-hero">
        {/* eslint-disable-next-line @next/next/no-img-element -- static /public asset, app-wide convention */}
        <img
          className="academy-hero__img"
          src="/bg/academy-hero.webp"
          alt="Blubber Academy — access coming soon"
          width={1672}
          height={941}
        />

        <div className="academy-overlay">
          <span className="academy-overlay__badge">
            <GraduationCap size={13} aria-hidden="true" />
            Coming soon
          </span>

          <form className="academy-waitlist" onSubmit={handleSubmit}>
            <label htmlFor="academy-email" className="academy-waitlist__label-hidden">
              Email address
            </label>
            <div className="academy-waitlist__input-wrap">
              <Mail size={15} className="academy-waitlist__input-icon" aria-hidden="true" />
              <input
                id="academy-email"
                type="email"
                className="academy-waitlist__input"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={state === 'submitting' || state === 'success'}
                autoComplete="email"
                required
              />
            </div>
            <button
              type="submit"
              className="academy-waitlist__submit"
              disabled={state === 'submitting' || state === 'success' || email.trim().length === 0}
            >
              {state === 'submitting' ? 'Joining…' : state === 'success' ? 'Joined' : 'Join waitlist'}
            </button>
          </form>
          {message && (
            <p
              className={
                state === 'success' ? 'academy-waitlist__status academy-waitlist__status--ok' : 'academy-waitlist__status academy-waitlist__status--error'
              }
            >
              {state === 'success' && <CheckCircle2 size={14} aria-hidden="true" />}
              {message}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
