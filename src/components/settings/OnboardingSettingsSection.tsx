'use client';

/**
 * OnboardingSettingsSection — a self-contained Settings panel (Lane B7)
 * covering two unrelated-but-small preferences that didn't have a home yet:
 *
 * 1. "Replay Setup" — resets the persisted onboarding + intro flow state so
 *    both re-show from the start on next load, then reloads the page. The
 *    actual state reset lives in two OTHER lanes' store modules
 *    (src/server/onboarding-store.ts's resetOnboardingState() and
 *    src/server/intro-store.ts's resetIntroState()) — this component never
 *    touches them directly, it only calls the two small routes this same
 *    lane owns (POST /api/onboarding/reset, POST /api/intro/reset), which do
 *    the importing. If either underlying store module isn't wired up yet,
 *    the corresponding POST 500s and this button surfaces that as an inline
 *    error rather than pretending it worked.
 *
 * 2. "Reduce Motion & Effects" — a plain on/off toggle backed by
 *    src/lib/reduce-effects.ts's useReduceEffects() hook (localStorage +
 *    a `reduce-effects` class on <html>, mirroring how the app already keys
 *    off `prefers-reduced-motion`). This component only renders the toggle;
 *    it does NOT chase down every animated component elsewhere in the app
 *    to make it consume the class — see reduce-effects.ts's header for the
 *    current scope of that flag and what's still follow-up work.
 *
 * SELF-CONTAINED BY DESIGN: deliberately does not reach for SettingsScreen's
 * local `Toggle` / `SettingRow` components (they're private to that file,
 * not exported) or its `.settings-panel` / `.setting-row` / `.toggle-switch`
 * CSS classes (scoped-by-convention to SettingsScreen.css, not guaranteed to
 * be loaded wherever this renders). Only the shared `Panel` from
 * `components/ui` (which ships its own CSS) plus this file's own
 * OnboardingSettingsSection.css are used, so this component looks right
 * regardless of import order or where it's mounted.
 *
 * NOT OWNED BY THIS FILE: wiring `<OnboardingSettingsSection />` into
 * SettingsScreen.tsx — see this lane's integration report for the exact
 * import + JSX line and which tab/column it belongs in.
 */

import { useCallback, useState } from 'react';
import { RotateCcw, Sparkles } from 'lucide-react';
import { Panel } from '../ui';
import { useReduceEffects } from '../../lib/reduce-effects';
import './OnboardingSettingsSection.css';

type ReplayState = 'idle' | 'working' | 'error';

export default function OnboardingSettingsSection() {
  const [replayState, setReplayState] = useState<ReplayState>('idle');
  const { reduceEffects, toggleReduceEffects } = useReduceEffects();

  const handleReplaySetup = useCallback(async () => {
    setReplayState('working');
    try {
      const [onboardingRes, introRes] = await Promise.all([
        fetch('/api/onboarding/reset', { method: 'POST' }),
        fetch('/api/intro/reset', { method: 'POST' }),
      ]);
      if (!onboardingRes.ok || !introRes.ok) {
        throw new Error(`replay setup failed: onboarding=${onboardingRes.status} intro=${introRes.status}`);
      }
      if (typeof window !== 'undefined') window.location.reload();
    } catch (err) {
      console.error('[onboarding-settings] replay setup failed:', err);
      setReplayState('error');
    }
  }, []);

  return (
    <Panel title="Onboarding & Accessibility" className="onboarding-settings">
      <div className="onboarding-settings__rows">
        <div className="onboarding-settings__row">
          <div className="onboarding-settings__row-top">
            <span className="onboarding-settings__id">
              <RotateCcw size={15} className="onboarding-settings__icon" aria-hidden="true" />
              <span className="onboarding-settings__label">Replay Setup</span>
            </span>
            <button
              type="button"
              className="onboarding-settings__btn"
              onClick={handleReplaySetup}
              disabled={replayState === 'working'}
            >
              {replayState === 'working' ? 'Replaying…' : 'Replay Setup'}
            </button>
          </div>
          <p className="onboarding-settings__description">
            Re-show the intro and onboarding walkthrough from the start next time the app loads.
          </p>
          {replayState === 'error' && (
            <p className="onboarding-settings__error" role="alert">
              Couldn&rsquo;t reset setup — is the dev server running? Check its logs and try again.
            </p>
          )}
        </div>

        <div className="onboarding-settings__row">
          <div className="onboarding-settings__row-top">
            <span className="onboarding-settings__id">
              <Sparkles size={15} className="onboarding-settings__icon" aria-hidden="true" />
              <span className="onboarding-settings__label">Reduce Motion & Effects</span>
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={reduceEffects}
              aria-label="Reduce motion & effects"
              className={`onboarding-settings__toggle${reduceEffects ? ' onboarding-settings__toggle--on' : ''}`}
              onClick={toggleReduceEffects}
            >
              <span className="onboarding-settings__toggle-thumb" />
            </button>
          </div>
          <p className="onboarding-settings__description">
            Tone down glow, blur, and background motion across the dashboard for a calmer, lighter feel.
          </p>
        </div>
      </div>
    </Panel>
  );
}
