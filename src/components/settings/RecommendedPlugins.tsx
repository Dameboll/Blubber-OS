'use client';

/**
 * RecommendedPlugins — the always-available "install the recommended Claude
 * Code plugin stack" surface (Lane 4). The onboarding overlay offers this once
 * on first run; this panel is the permanent home for it in Settings, so the
 * option Dame described ("Blubber will always have that option, let me know if
 * you want me to install the recommended plugins") is a real button that never
 * goes away.
 *
 * Pick any subset (all on by default), hit Install, watch real `claude plugin`
 * CLI output stream in. Cancel aborts the run and kills the child (see
 * useInstallStream / stream-command.ts). Requires the `claude` CLI on PATH — if
 * it isn't there yet, the install simply fails with the CLI's own error in the
 * console, nothing is faked.
 *
 * STARTER-KIT ONLY: this is a paid-tier feature, not part of the free
 * Community Edition. It self-gates on GET /api/kit/install — if the Starter Kit
 * hasn't been injected on this machine (hasInstalledKit() === false), it
 * renders nothing at all. Community Edition stays 100% barebones: no
 * recommended plugins, no MD/skills/agents, no tour.
 *
 * OWNERSHIP: this file + RecommendedPlugins.css only. Reuses Panel from ../ui,
 * mirroring KitInstaller's self-contained-panel pattern so it drops into
 * SettingsScreen in one line.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Blocks, Check, Loader2, Puzzle, X } from 'lucide-react';
import { Panel } from '../ui';
import { RECOMMENDED_PLUGINS } from '../../lib/recommended-plugins';
import { useInstallStream } from '../../lib/use-install-stream';
import './RecommendedPlugins.css';

export default function RecommendedPlugins() {
  const install = useInstallStream();
  // null = still checking; false = no kit (render nothing); true = kit present.
  const [kitInstalled, setKitInstalled] = useState<boolean | null>(null);
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(RECOMMENDED_PLUGINS.map((p) => p.id)),
  );

  useEffect(() => {
    let cancelled = false;
    fetch('/api/kit/install')
      .then((res) => res.json() as Promise<{ installed?: boolean }>)
      .then((data) => {
        if (!cancelled) setKitInstalled(Boolean(data?.installed));
      })
      .catch(() => {
        // Can't confirm kit state — stay hidden rather than leaking a paid-tier
        // surface into the free build on a failed check.
        if (!cancelled) setKitInstalled(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const chosen = useMemo(() => RECOMMENDED_PLUGINS.filter((p) => selected.has(p.id)), [selected]);
  const running = install.status === 'running';

  const handleInstall = useCallback(() => {
    if (chosen.length === 0) return;
    install.start('/api/onboarding/install-plugins', { plugins: chosen.map((p) => p.id) });
  }, [chosen, install]);

  // Free build (or unconfirmed kit state): render nothing. Starter-kit only.
  if (!kitInstalled) return null;

  return (
    <Panel>
      <div className="rp">
        <div className="rp__head">
          <Puzzle className="rp__head-icon" aria-hidden="true" />
          <div>
            <h3 className="rp__title">Recommended plugins</h3>
            <p className="rp__subtitle">
              A curated Claude Code loadout. Optional — pick what you want, install any time. Needs the Claude Code
              CLI installed.
            </p>
          </div>
        </div>

        <ul className="rp__list">
          {RECOMMENDED_PLUGINS.map((p) => {
            const on = selected.has(p.id);
            return (
              <li key={p.id}>
                <button
                  type="button"
                  className={`rp__item ${on ? 'rp__item--on' : ''}`}
                  onClick={() => toggle(p.id)}
                  disabled={running}
                  aria-pressed={on}
                >
                  <span className={`rp__check ${on ? 'rp__check--on' : ''}`} aria-hidden="true">
                    {on ? <Check size={14} /> : null}
                  </span>
                  <span className="rp__item-text">
                    <span className="rp__item-name">{p.name}</span>
                    <span className="rp__item-desc">{p.description}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>

        {install.output && (
          <pre className="rp__console" aria-label="installer output">
            {install.output.slice(-6000)}
          </pre>
        )}

        <div className="rp__actions">
          {running ? (
            <button type="button" className="rp__btn rp__btn--ghost" onClick={install.cancel}>
              <X size={16} /> Cancel
            </button>
          ) : (
            <button
              type="button"
              className="rp__btn rp__btn--primary"
              onClick={handleInstall}
              disabled={chosen.length === 0}
            >
              {install.status === 'running' ? (
                <>
                  <Loader2 size={16} className="rp__spin" /> Installing…
                </>
              ) : (
                <>
                  <Blocks size={16} /> Install {chosen.length} plugin{chosen.length === 1 ? '' : 's'}
                </>
              )}
            </button>
          )}
          {install.status === 'done' && <span className="rp__status rp__status--ok">Done</span>}
          {install.status === 'error' && <span className="rp__status rp__status--err">Some failed — see log</span>}
        </div>
      </div>
    </Panel>
  );
}
