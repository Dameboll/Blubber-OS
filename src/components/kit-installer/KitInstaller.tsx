'use client';

/**
 * KitInstaller — the Starter Kit importer's install mechanism (Lane B8).
 *
 * A customer who already bought + downloaded + extracted their Starter Kit
 * (real payment/entitlement verification via Shopify + Supabase is a LATER
 * stage, not built here) types the path to that extracted folder and hits
 * "Install Kit". POSTs { kitPath } to POST /api/kit/install, which reads
 * that folder's own kit-manifest.json and does the real filesystem work:
 * CLAUDE.md + agents/ + skills/ into ~/.claude/, and the manifest's
 * projectStructure folders under a portable Development root.
 *
 * PROGRESS COPY: every step line and the final "you're set up" line comes
 * from the manifest's own `narration` object, echoed back in the API
 * response — never hardcoded English here, since Dame may revise the
 * wording later without touching this component. The only text owned by
 * this file is UI chrome (button/input labels, the generic "Installing…"
 * spinner state before a response exists, and real error messages on
 * failure, which are the server's own diagnostic text, not narration).
 *
 * HONESTY: the step list only ever shows narration for steps the server
 * reports as genuinely completed (`stepsCompleted`) — a failed install past
 * step 2 still shows real checkmarks for steps 1 and 2, then the real
 * failure reason for the step that broke. Nothing here is faked or
 * optimistic.
 *
 * SELF-CONTAINED: renders its own <Panel> (see ../ui), so dropping
 * `<KitInstaller />` anywhere in a screen is a single-line integration — see
 * the INTEGRATION REPORT for exactly where this build recommends that line
 * go in SettingsScreen.tsx (integrator-owned file, not touched here).
 *
 * OWNERSHIP: this file + KitInstaller.css only.
 */

import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, FolderInput, Loader2, Package, Sparkles, XCircle } from 'lucide-react';
import { Panel } from '../ui';
import { requestTour } from '../../lib/tour';
import './KitInstaller.css';

type KitStep = 'manifest' | 'claudeMd' | 'agents' | 'skills' | 'commands' | 'structure';
type CompletedStep = Exclude<KitStep, 'manifest'>;

interface KitNarration {
  onInstallStart: string;
  onClaudeMdInstalled: string;
  onAgentsInstalled: string;
  onSkillsInstalled: string;
  onCommandsInstalled: string;
  onStructureCreated: string;
  onComplete: string;
}

/** Mirrors POST /api/kit/install's real response shape exactly (see that
 * route's KitManifest/KitStep types) — duplicated locally rather than
 * imported so this client component never pulls in a Next.js route module
 * (which also exports `runtime`/`dynamic` route config, not meant for
 * client bundles). */
interface KitInstallResponse {
  ok: boolean;
  step?: KitStep;
  stepsCompleted: CompletedStep[];
  error?: string;
  narration: KitNarration | null;
  installedTo?: { claudeMd: string; agents: string; skills: string; commands: string; projectStructure: string };
}

interface InstalledProbe {
  installed: boolean;
  installedAt: string | null;
}

type Phase = 'idle' | 'installing' | 'done';

const STEP_NARRATION_KEY: Record<CompletedStep, keyof KitNarration> = {
  claudeMd: 'onClaudeMdInstalled',
  agents: 'onAgentsInstalled',
  skills: 'onSkillsInstalled',
  commands: 'onCommandsInstalled',
  structure: 'onStructureCreated',
};

const STEP_LABEL: Record<KitStep, string> = {
  manifest: 'Reading kit-manifest.json',
  claudeMd: 'CLAUDE.md',
  agents: 'Agents',
  skills: 'Skills',
  commands: 'Commands',
  structure: 'Project folders',
};

export default function KitInstaller() {
  const [kitPath, setKitPath] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [result, setResult] = useState<KitInstallResponse | null>(null);
  const [probe, setProbe] = useState<InstalledProbe | null>(null);

  // Real check on mount — an honest "already installed on <date>" banner
  // instead of always presenting a bare empty form. Non-fatal if it fails;
  // the install form still works either way.
  useEffect(() => {
    let cancelled = false;
    fetch('/api/kit/install')
      .then((res) => (res.ok ? (res.json() as Promise<InstalledProbe>) : null))
      .then((data) => {
        if (!cancelled && data) setProbe(data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const handleInstall = useCallback(() => {
    const trimmed = kitPath.trim();
    if (!trimmed || phase === 'installing') return;
    setPhase('installing');
    setResult(null);
    fetch('/api/kit/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kitPath: trimmed }),
    })
      .then((res) => res.json() as Promise<KitInstallResponse>)
      .then((data) => {
        setResult(data);
        setPhase('done');
        if (data.ok) {
          setProbe({ installed: true, installedAt: new Date().toISOString() });
          // Injecting the kit triggers the guided walkthrough — the same beat a
          // kit buyer gets when detection finds the kit on boot. Fires the live
          // tour event so page.tsx starts the tour without a reload.
          requestTour();
        }
      })
      .catch((err) => {
        setResult({
          ok: false,
          step: 'manifest',
          stepsCompleted: [],
          error: `Could not reach the install endpoint: ${err instanceof Error ? err.message : String(err)}`,
          narration: null,
        });
        setPhase('done');
      });
  }, [kitPath, phase]);

  const isInstalling = phase === 'installing';
  const narration = result?.narration ?? null;
  const stepsCompleted = result?.stepsCompleted ?? [];

  return (
    <Panel title="Starter Kit" className="kit-installer-panel">
      <div className="kit-installer">
        <p className="kit-installer__intro">
          <Package size={14} aria-hidden="true" />
          Point this at your extracted Starter Kit folder to install your CLAUDE.md, agents, skills, and
          project structure onto this machine.
        </p>

        {probe?.installed && phase !== 'installing' && (
          <p className="kit-installer__already">
            <CheckCircle2 size={14} aria-hidden="true" />
            Already installed{probe.installedAt ? ` — ${new Date(probe.installedAt).toLocaleString()}` : ''}.
            Installing again will overwrite the files below.
          </p>
        )}

        <div className="kit-installer__form">
          <div className="kit-installer__input-wrap">
            <FolderInput size={15} className="kit-installer__input-icon" aria-hidden="true" />
            <input
              type="text"
              value={kitPath}
              onChange={(e) => setKitPath(e.target.value)}
              placeholder="Path to your extracted Starter Kit folder"
              aria-label="Starter Kit folder path"
              className="kit-installer__input"
              disabled={isInstalling}
              spellCheck={false}
            />
          </div>
          <button
            type="button"
            className="kit-installer__btn"
            onClick={handleInstall}
            disabled={isInstalling || !kitPath.trim()}
          >
            {isInstalling ? (
              <>
                <Loader2 size={14} className="kit-installer__spinner" aria-hidden="true" />
                Installing…
              </>
            ) : (
              'Install Kit'
            )}
          </button>
        </div>

        {phase === 'done' && result && (
          <ul className="kit-installer__steps" aria-live="polite">
            {stepsCompleted.map((step, i) => (
              <li
                key={step}
                className="kit-installer__step kit-installer__step--ok"
                style={{ animationDelay: `${i * 90}ms` }}
              >
                <CheckCircle2 size={14} aria-hidden="true" />
                <span>{narration ? narration[STEP_NARRATION_KEY[step]] : STEP_LABEL[step]}</span>
              </li>
            ))}

            {result.ok ? (
              <li
                className="kit-installer__step kit-installer__step--complete"
                style={{ animationDelay: `${stepsCompleted.length * 90}ms` }}
              >
                <Sparkles size={14} aria-hidden="true" />
                <span>{narration?.onComplete ?? 'Install complete.'}</span>
              </li>
            ) : (
              <li
                className="kit-installer__step kit-installer__step--fail"
                style={{ animationDelay: `${stepsCompleted.length * 90}ms` }}
              >
                <XCircle size={14} aria-hidden="true" />
                <span>
                  {STEP_LABEL[result.step ?? 'manifest']} failed: {result.error}
                </span>
              </li>
            )}
          </ul>
        )}
      </div>
    </Panel>
  );
}
