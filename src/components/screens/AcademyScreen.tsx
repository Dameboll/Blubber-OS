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
 * Layout: hero intro -> locked course outline (module teaser cards, each
 * blurred behind a lock) -> waitlist email capture, wired to the one real
 * endpoint behind this screen, POST /api/waitlist (src/app/api/waitlist/
 * route.ts -> src/server/waitlist-store.ts). Success/duplicate/invalid states
 * are all real server responses, never simulated.
 *
 * LAW 2 (one window): height:100% inside AppShell's bounded content area; the
 * header stays fixed and the module list + form scroll together in one inner
 * region, so the page itself never scrolls.
 */

import { useState, type FormEvent } from 'react';
import { GraduationCap, Lock, Mail, CheckCircle2 } from 'lucide-react';
import FlubberCharacter from '../FlubberCharacter';
import { Panel } from '../ui';
import './AcademyScreen.css';

interface AcademyModule {
  title: string;
  blurb: string;
}

// Teaser-only module outline. Titles + one-line blurbs describing what each
// module WILL cover once Academy opens — no lesson content exists yet, so
// every card renders locked/blurred, never clickable.
const MODULES: AcademyModule[] = [
  {
    title: 'Getting Started with Claude Code',
    blurb: 'Install, configure, and run your first real session end to end.',
  },
  {
    title: 'Building Your First Agent',
    blurb: 'Design an agent with a real job, real tools, and a real output.',
  },
  {
    title: 'Skills & Automations',
    blurb: 'Package repeatable work into skills that trigger themselves.',
  },
  {
    title: 'Advanced Workflows',
    blurb: 'Chain multiple agents together for work no single agent can do alone.',
  },
  {
    title: 'Shipping Your Own Tools',
    blurb: 'Turn a working prototype into something someone else can rely on.',
  },
];

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

      <div className="academy-screen__body">
        <Panel accent title="What Academy Is" className="academy-panel">
          <div className="academy-intro">
            <span className="academy-intro__badge">
              <GraduationCap size={13} aria-hidden="true" />
              Bundled with All Access &middot; not sold standalone
            </span>
            <p className="academy-intro__copy">
              Blubber Academy is a hands-on course for going from &ldquo;I have Claude Code
              installed&rdquo; to &ldquo;I ship real agents and tools with it.&rdquo; It&rsquo;s not open
              yet &mdash; when it is, it ships as part of a future All Access tier, never as a
              separate purchase. Join the waitlist below and you&rsquo;ll be first in when it does.
            </p>
          </div>
        </Panel>

        <Panel accent title="Course Outline" className="academy-panel">
          <div className="academy-modules">
            {MODULES.map((mod, i) => (
              <div className="academy-module academy-module--locked" key={mod.title}>
                <div className="academy-module__head">
                  <span className="academy-module__index">{String(i + 1).padStart(2, '0')}</span>
                  <Lock size={14} className="academy-module__lock" aria-hidden="true" />
                </div>
                <h4 className="academy-module__title">{mod.title}</h4>
                <p className="academy-module__blurb">{mod.blurb}</p>
                <span className="academy-module__tag">Locked</span>
              </div>
            ))}
          </div>
        </Panel>

        <Panel accent title="Join the Waitlist" className="academy-panel">
          <form className="academy-waitlist" onSubmit={handleSubmit}>
            <p className="academy-waitlist__copy">
              Be first when Academy opens &mdash; no spam, just one email the day it&rsquo;s live.
            </p>
            <div className="academy-waitlist__row">
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
            </div>
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
          </form>
        </Panel>
      </div>
    </div>
  );
}
