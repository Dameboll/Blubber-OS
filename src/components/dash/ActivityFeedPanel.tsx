'use client';

/**
 * ActivityFeedPanel — self-fetching "Activity Feed" panel (real GET
 * /api/recent, newest first, up to 20 rows). Extracted from
 * DashboardScreen.tsx's inline useRecentEvents hook + Activity Feed Panel JSX
 * so it can also be mounted in the Agents tab's right rail (see
 * AgentsScreen.tsx, which drops its own "System Message Log" panel — same
 * /api/recent data, one activity surface per screen). Same house style as
 * MiniProjects.tsx: 'use client', useEffect fetch, loading/error/empty states.
 */

import { useEffect, useMemo, useState } from 'react';
import { Sparkles } from 'lucide-react';
import AgentAvatar from '../AgentAvatar';
import { ActivityItem, Panel } from '../ui';
import { humanizeSlug } from '../../lib/humanize';

interface RecentEvent {
  ts: string;
  toolName: string | null;
  category: 'skill' | 'agent' | null;
  /** Real duration from a matched tool_runs row (Agent/Task/Workflow calls
   *  only — see db.ts's getRecentEvents). Null for Skill rows and any
   *  unmatched legacy row — an honest "duration unknown", never guessed. */
  elapsedMs: number | null;
  /** "running" / "done" wherever elapsedMs is real, else null. */
  status: 'running' | 'done' | null;
}

interface ActivityEvent {
  key: string;
  text: string;
  /** When set, the row shows this agent's role-Blubber avatar (else a skill icon). */
  agentName?: string;
  timestamp: string;
}

type FetchState = 'loading' | 'error' | 'ready';

const RECENT_POLL_MS = 10_000;
/** Completed runs shorter than this are pure noise (a stray Skill ping, not a
 *  meaningful unit of work) and get dropped — but only completed ones; a run
 *  still `running` is never dropped just because little time has passed. */
const NOISE_FLOOR_MS = 2000;

/** Real "time ago" for a real event timestamp (ISO). */
function formatRelTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const mins = Math.max(0, Math.floor((Date.now() - then) / 60_000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

/** Compact human duration for a real elapsedMs value: "48s", "2m 14s", "1h 5m". */
function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (totalMin < 60) return sec > 0 ? `${totalMin}m ${sec}s` : `${totalMin}m`;
  const hr = Math.floor(totalMin / 60);
  const min = totalMin % 60;
  return min > 0 ? `${hr}h ${min}m` : `${hr}h`;
}

/** Turns one real tool-invocation event into an Activity Feed row. Agent
 *  rows carry a real elapsedMs + done/running status (matched against
 *  tool_runs in getRecentEvents) so the line says what actually happened —
 *  which run, how long, whether it finished — instead of a generic "Ran X".
 *  A literal `toolName` of "workflow" (log-indexer's fallback when a
 *  Workflow tool_use carries no name) reads as "Ran workflow" rather than
 *  the odd-sounding "Agent Workflow". Skill invocations never open a
 *  tracked run (see db.ts), so they stay simple — no fabricated duration.
 *  The agent role-avatar shows only for real agent/workflow runs. */
function describeEvent(evt: RecentEvent): { text: string; agentName?: string } {
  const rawName = evt.toolName ?? 'task';
  const name = humanizeSlug(rawName);

  if (evt.category === 'agent') {
    const isWorkflow = rawName.toLowerCase() === 'workflow';
    const subject = isWorkflow ? 'Ran workflow' : `Agent ${name}`;
    if (evt.elapsedMs !== null && evt.status === 'running') {
      return { text: `${subject} · running ${formatDuration(evt.elapsedMs)}`, agentName: name };
    }
    if (evt.elapsedMs !== null && evt.status === 'done') {
      return { text: `${subject} · done in ${formatDuration(evt.elapsedMs)}`, agentName: name };
    }
    // No matched tool_runs row (legacy pre-tracking data) — honest fallback,
    // no invented duration.
    return { text: isWorkflow ? 'Ran workflow' : `Ran agent ${name}`, agentName: name };
  }
  if (evt.category === 'skill') return { text: `Used skill ${name}` };
  return { text: `Ran ${name}` };
}

/** Drops completed sub-noise-floor runs, then collapses consecutive rows for
 *  the same tool (same name + category, back to back in the newest-first
 *  list) into a single row with a "×N" suffix — so a burst of N near-
 *  identical sub-agent calls reads as one meaningful line instead of N
 *  duplicates. Always uses the most recent occurrence's real text/timestamp;
 *  never averages or invents a combined duration. */
function buildActivityEvents(events: RecentEvent[]): ActivityEvent[] {
  const kept = events.filter(
    (evt) => !(evt.status === 'done' && evt.elapsedMs !== null && evt.elapsedMs < NOISE_FLOOR_MS),
  );

  const groups: RecentEvent[][] = [];
  for (const evt of kept) {
    const lastGroup = groups[groups.length - 1];
    const lastEvt = lastGroup?.[0];
    if (lastEvt && lastEvt.toolName === evt.toolName && lastEvt.category === evt.category) {
      lastGroup.push(evt);
    } else {
      groups.push([evt]);
    }
  }

  return groups.map((group, i) => {
    const latest = group[0];
    const described = describeEvent(latest);
    const text = group.length > 1 ? `${described.text} ×${group.length}` : described.text;
    return { key: `ev-${i}-${latest.ts}`, text, agentName: described.agentName, timestamp: formatRelTime(latest.ts) };
  });
}

/** Fetches the real recent tool-invocation feed (skill/agent runs, newest
 *  first) from GET /api/recent and re-polls so the Activity Feed stays live.
 *  Empty until real activity is indexed. */
function useRecentEvents(pollMs: number): { events: RecentEvent[]; state: FetchState } {
  const [events, setEvents] = useState<RecentEvent[]>([]);
  const [state, setState] = useState<FetchState>('loading');

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetch('/api/recent?limit=20')
        .then((res) => {
          if (!res.ok) throw new Error(`recent fetch failed: ${res.status}`);
          return res.json() as Promise<{ events?: RecentEvent[] }>;
        })
        .then((json) => {
          if (cancelled) return;
          setEvents(Array.isArray(json?.events) ? json.events : []);
          setState('ready');
        })
        .catch(() => {
          if (!cancelled) setState('error');
        });
    };
    load();
    const id = setInterval(load, pollMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [pollMs]);

  return { events, state };
}

export interface ActivityFeedPanelProps {
  className?: string;
  /** Forwarded to Panel — set when this panel sits somewhere a roaming
   *  Blubber companion needs to avoid (e.g. the Agents tab rail). */
  avoidRoam?: boolean;
  /** Called when "View Full Activity" is clicked — the caller decides how to
   *  surface the hint (Dashboard shows a hero-bubble hint; other screens may
   *  omit this and the button no-ops). */
  onViewFull?: () => void;
}

export default function ActivityFeedPanel({ className, avoidRoam, onViewFull }: ActivityFeedPanelProps) {
  const recent = useRecentEvents(RECENT_POLL_MS);

  const activityEvents = useMemo<ActivityEvent[]>(() => buildActivityEvents(recent.events), [recent.events]);

  return (
    <Panel
      accent
      title="Activity Feed"
      className={['dashboard-panel', 'dashboard-panel--activity', className ?? ''].filter(Boolean).join(' ')}
      avoidRoam={avoidRoam}
    >
      {recent.state === 'loading' && <p className="dashboard-empty-note">Loading activity…</p>}
      {recent.state === 'error' && <p className="dashboard-empty-note">Couldn&rsquo;t load activity.</p>}
      {recent.state === 'ready' && activityEvents.length === 0 && (
        <p className="dashboard-empty-note">No activity yet — run agents or skills and it&rsquo;ll show up here.</p>
      )}
      {recent.state === 'ready' && activityEvents.length > 0 && (
        <>
          <div className="dashboard-activity-list" data-flubber-avoid="true">
            {activityEvents.map((event) => (
              <ActivityItem
                key={event.key}
                icon={
                  event.agentName ? (
                    // Flat: polled up-to-20-row feed. A 26px 3D micro-body reads as
                    // a green "booger" and eats app-wide MID budget (host.ts
                    // MAX_MID_BODIES), starving the pool residents that actually need
                    // the shiny clearcoat read. Ring + role icon only here.
                    // See docs/plans/booger-eradication-2026-07-20.md.
                    <AgentAvatar name={event.agentName} size={26} flat className="dashboard-activity-flubber" />
                  ) : (
                    <Sparkles size={13} aria-hidden="true" />
                  )
                }
                text={event.text}
                timestamp={event.timestamp}
              />
            ))}
          </div>
          {onViewFull && (
            <button type="button" className="dashboard-activity-more" onClick={onViewFull}>
              View Full Activity →
            </button>
          )}
        </>
      )}
    </Panel>
  );
}
