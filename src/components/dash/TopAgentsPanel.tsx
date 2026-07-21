'use client';

/**
 * TopAgentsPanel — self-fetching "Top Agents" panel (real GET /api/top-agents,
 * Daily/Weekly/All-Time range toggle, up to 5 rows). Extracted from
 * DashboardScreen.tsx's inline useTopAgents hook + Top Agents Panel JSX so it
 * can also be mounted in the Agents tab's right rail (replacing that screen's
 * "Top Performer" 1-row subset — see AgentsScreen.tsx). Same house style as
 * MiniProjects.tsx: 'use client', useEffect fetch, loading/error/empty states.
 */

import { useEffect, useState } from 'react';
import AgentAvatar from '../AgentAvatar';
import { Panel } from '../ui';
import { humanizeSlug } from '../../lib/humanize';

interface NamedCount {
  name: string;
  count: number;
}

type FetchState = 'loading' | 'error' | 'ready';
type TopAgentsRange = 'daily' | 'weekly' | 'alltime';

const TOP_AGENTS_RANGES: { id: TopAgentsRange; label: string }[] = [
  { id: 'daily', label: 'Daily' },
  { id: 'weekly', label: 'Weekly' },
  { id: 'alltime', label: 'All Time' },
];

/** Fetches the real GET /api/top-agents rollup, re-fetching whenever the
 *  Daily/Weekly/All-Time range changes. */
function useTopAgents(range: TopAgentsRange): { agents: NamedCount[]; state: FetchState } {
  const [agents, setAgents] = useState<NamedCount[]>([]);
  const [state, setState] = useState<FetchState>('loading');

  useEffect(() => {
    let cancelled = false;
    setState('loading');
    fetch(`/api/top-agents?range=${range}`)
      .then((res) => {
        if (!res.ok) throw new Error(`top-agents fetch failed: ${res.status}`);
        return res.json() as Promise<{ agents?: NamedCount[] }>;
      })
      .then((json) => {
        if (cancelled) return;
        setAgents(Array.isArray(json?.agents) ? json.agents : []);
        setState('ready');
      })
      .catch(() => {
        if (!cancelled) setState('error');
      });
    return () => {
      cancelled = true;
    };
  }, [range]);

  return { agents, state };
}

export interface TopAgentsPanelProps {
  className?: string;
  /** Forwarded to Panel — set when this panel sits somewhere a roaming
   *  Blubber companion needs to avoid (e.g. the Agents tab rail). */
  avoidRoam?: boolean;
}

export default function TopAgentsPanel({ className, avoidRoam }: TopAgentsPanelProps) {
  const [topAgentsRange, setTopAgentsRange] = useState<TopAgentsRange>('daily');
  const { agents: topAgents, state: topAgentsState } = useTopAgents(topAgentsRange);

  const displayTopAgents = topAgents.slice(0, 5);
  const topAgentsMax = Math.max(...displayTopAgents.map((a) => a.count), 1);

  return (
    <Panel
      accent
      title="Top Agents"
      className={['dashboard-panel', 'dashboard-panel--topagents', className ?? ''].filter(Boolean).join(' ')}
      avoidRoam={avoidRoam}
      action={
        <div className="range-toggle">
          {TOP_AGENTS_RANGES.map((r) => (
            <button
              key={r.id}
              type="button"
              className={`range-toggle__btn${topAgentsRange === r.id ? ' range-toggle__btn--active' : ''}`}
              onClick={() => setTopAgentsRange(r.id)}
            >
              {r.label}
            </button>
          ))}
        </div>
      }
    >
      {topAgentsState === 'loading' && <p className="dashboard-empty-note">Loading top agents…</p>}
      {topAgentsState === 'error' && <p className="dashboard-empty-note">Couldn&rsquo;t load top agents.</p>}
      {topAgentsState === 'ready' && displayTopAgents.length === 0 && (
        <p className="dashboard-empty-note">No agent runs recorded yet.</p>
      )}
      {topAgentsState === 'ready' && displayTopAgents.length > 0 && (
        <div className="dashboard-agent-list" data-flubber-avoid="true">
          {displayTopAgents.map((agent, i) => {
            const label = humanizeSlug(agent.name);
            return (
              <div className="dashboard-agent-row" key={agent.name}>
                <span className="dashboard-agent-rank" aria-hidden="true">
                  {i + 1}.
                </span>
                {/* Flat: a 24px 3D micro-body reads as a green "booger" and burns
                    a WebGL slot for nothing in a dense pill. Ring + role icon only.
                    See docs/plans/booger-eradication-2026-07-20.md. */}
                <AgentAvatar name={label} size={24} flat className="dashboard-agent-flubber" />
                <span className="dashboard-agent-name">{label}</span>
                <span className="dashboard-agent-bar" aria-hidden="true">
                  <span
                    className="dashboard-agent-bar__fill"
                    style={{ transform: `scaleX(${Math.max(Math.round((agent.count / topAgentsMax) * 100), 4) / 100})` }}
                  />
                </span>
                <span className="dashboard-agent-count">{agent.count.toLocaleString()}</span>
              </div>
            );
          })}
        </div>
      )}
    </Panel>
  );
}
