'use client';

/**
 * AnalyticsScreen — the reference sidebar's "Analytics" destination
 * (flubber-3d-everywhere Phase 6/7). Wired straight to GET /api/insights,
 * the real usage-analytics rollup backed by src/server/db.ts's SQLite
 * aggregates (see src/app/api/insights/route.ts). Every number here is a
 * since-baseline real fact or an honest "not enough data yet" state —
 * nothing on this screen is fabricated or decorative filler.
 *
 * Layout (rebuilt, Lane D — dashboard overhaul):
 *   HERO ROW   Daily Token Usage (2-col span, y-axis rules, hover value
 *              labels, animated grow) + Live Pulse column (today tokens with
 *              count-up, runs, day streak, peak).
 *   BAND       Hour-of-day heat strip, full width — 24 flex-filled cells on a
 *              real color ramp (not opacity-over-dark), aligned hour labels,
 *              per-hour tooltip, ramp legend.
 *   TRIPTYCH   Top Burners (bars + skill/agent badges) | Suggestions | Projects.
 *   FOOTER     Recent Activity, full width, multi-column.
 *
 * Hierarchy is built through contrast: hero + heat + burners + recent carry
 * their own distinct cinematic plate; the pulse, suggestions, and projects
 * panels are clean glass so the eye lands on the data-dense panels first —
 * not six identical glowing boxes. Polls insights every 30s (the API route
 * caches for 60s, so this just keeps the screen fresh).
 */

import { useEffect, useRef, useState } from 'react';
import {
  Activity,
  BarChart3,
  CalendarDays,
  Clock,
  Flame,
  FolderKanban,
  Info,
  Lightbulb,
  ListChecks,
  Timer,
  TrendingUp,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { ActivityItem, Panel, StatChip } from '../ui';
import { humanizeSlug } from '../../lib/humanize';
import './AnalyticsScreen.css';

// ---------------------------------------------------------------------------
// API response shapes — mirror src/app/api/insights/route.ts exactly.
// ---------------------------------------------------------------------------

interface SinceBaselineTotals {
  totalTokens: number;
  totalRuns: number;
  days: number;
}

type BurnerCategory = 'skill' | 'agent';

interface Burner {
  name: string;
  category: BurnerCategory;
  tokens: number;
  runs: number;
  sharePct: number;
}

interface DailyTokensAndRuns {
  date: string;
  tokens: number;
  runs: number;
}

interface HourlyTotal {
  hour: number;
  tokens: number;
}

type SuggestionSeverity = 'info' | 'tip' | 'warn';

interface Suggestion {
  text: string;
  severity: SuggestionSeverity;
  basedOn: string;
}

interface InsightsPayload {
  sinceBaseline: SinceBaselineTotals;
  burners: Burner[];
  daily: DailyTokensAndRuns[];
  hourly: HourlyTotal[];
  suggestions: Suggestion[];
}

type FetchState = 'loading' | 'error' | 'ready';

const POLL_MS = 30_000;

// ---------------------------------------------------------------------------
// Session-summary shapes (folded in from the former BetaScreen) — mirror
// src/app/api/projects/summary/route.ts and /api/recent exactly.
// ---------------------------------------------------------------------------

type SummarySource = 'claude-md' | 'readme' | 'ai-context' | null;

interface ProjectSummary {
  root: string;
  name: string;
  summary: string | null;
  source: SummarySource;
  modifiedAt: string | null;
}

interface RecentEvent {
  ts: string;
  toolName: string | null;
  category: 'skill' | 'agent' | null;
}

const SOURCE_LABEL: Record<Exclude<SummarySource, null>, string> = {
  'ai-context': 'ai-context.md',
  'claude-md': 'CLAUDE.md',
  readme: 'README.md',
};

// ---------------------------------------------------------------------------
// Data hooks
// ---------------------------------------------------------------------------

function useInsights(pollMs: number): { data: InsightsPayload | null; state: FetchState } {
  const [data, setData] = useState<InsightsPayload | null>(null);
  const [state, setState] = useState<FetchState>('loading');

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetch('/api/insights')
        .then((res) => {
          if (!res.ok) throw new Error(`insights fetch failed: ${res.status}`);
          return res.json() as Promise<InsightsPayload>;
        })
        .then((json) => {
          if (cancelled) return;
          setData(json);
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

  return { data, state };
}

function useProjectSummaries(): { projects: ProjectSummary[]; state: FetchState } {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [state, setState] = useState<FetchState>('loading');

  useEffect(() => {
    let cancelled = false;
    fetch('/api/projects/summary')
      .then((res) => {
        if (!res.ok) throw new Error(`summary fetch failed: ${res.status}`);
        return res.json() as Promise<{ projects?: ProjectSummary[] }>;
      })
      .then((json) => {
        if (cancelled) return;
        setProjects(Array.isArray(json?.projects) ? json.projects : []);
        setState('ready');
      })
      .catch(() => {
        if (!cancelled) setState('error');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { projects, state };
}

function useRecentEvents(): { events: RecentEvent[]; state: FetchState } {
  const [events, setEvents] = useState<RecentEvent[]>([]);
  const [state, setState] = useState<FetchState>('loading');

  useEffect(() => {
    let cancelled = false;
    fetch('/api/recent?limit=10')
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
    return () => {
      cancelled = true;
    };
  }, []);

  return { events, state };
}

// ---------------------------------------------------------------------------
// Motion helpers — count-up numbers, reduced-motion aware.
// ---------------------------------------------------------------------------

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);
  return reduced;
}

/** Animate a whole number from its previous value to `target` on change.
 * Jumps straight to the value under prefers-reduced-motion, and never
 * re-animates when a poll returns the identical number. */
function useCountUp(target: number, durationMs = 900): number {
  const reduced = usePrefersReducedMotion();
  const [val, setVal] = useState(target);
  const prevRef = useRef(target);

  useEffect(() => {
    const from = prevRef.current;
    if (from === target) return;
    if (reduced) {
      prevRef.current = target;
      setVal(target);
      return;
    }
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const p = Math.min((now - start) / durationMs, 1);
      const eased = 1 - Math.pow(1 - p, 3);
      setVal(Math.round(from + (target - from) * eased));
      if (p < 1) {
        raf = requestAnimationFrame(tick);
      } else {
        prevRef.current = target;
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, durationMs, reduced]);

  return val;
}

// ---------------------------------------------------------------------------
// Small formatters
// ---------------------------------------------------------------------------

function formatShortDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' });
}

function formatHourLabel(hour: number): string {
  const h = ((hour % 24) + 24) % 24;
  if (h === 0) return '12a';
  if (h === 12) return '12p';
  return h < 12 ? `${h}a` : `${h - 12}p`;
}

/** Compact token count for axis rules and dense labels: 1.2m / 34k / 812. */
function compactNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}m`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(Math.round(n));
}

/** Real green→lime color ramp for the hour heat band. `t` is 0..1 intensity.
 * Ramps perceptual lightness and chroma (not just opacity over a dark base),
 * so a busy hour genuinely reads brighter and warmer, an idle hour stays a
 * flat dark-green cell. */
function heatColor(t: number): string {
  const clamped = Math.max(0, Math.min(1, t));
  const L = 22 + clamped * 58; // 22% → 80%
  const C = (0.02 + clamped * 0.27).toFixed(3); // 0.02 → 0.29
  const H = 156 - clamped * 14; // green → lime
  return `oklch(${L}% ${C} ${H})`;
}

const SEVERITY_ICON: Record<SuggestionSeverity, LucideIcon> = {
  info: Info,
  tip: Lightbulb,
  warn: Flame,
};

function formatRelative(iso: string | null, now: number): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const minutes = Math.max(0, Math.round((now - then) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days}d ago`;
  return `${Math.round(days / 7)}w ago`;
}

function describeEvent(evt: RecentEvent): string {
  const name = humanizeSlug(evt.toolName ?? 'task');
  if (evt.category === 'agent') return `Ran agent ${name}`;
  if (evt.category === 'skill') return `Used skill ${name}`;
  return `Ran ${name}`;
}

// ---------------------------------------------------------------------------
// Shared empty state — visual + explanation + what-to-do (per frontend rules,
// never a single dim line marooned in a photo void).
// ---------------------------------------------------------------------------

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  hint: string;
  action?: string;
}

function EmptyState({ icon: Icon, title, hint, action }: EmptyStateProps) {
  return (
    <div className="analytics-empty">
      <span className="analytics-empty__icon" aria-hidden="true">
        <Icon size={20} />
      </span>
      <p className="analytics-empty__title">{title}</p>
      <p className="analytics-empty__hint">{hint}</p>
      {action && <span className="analytics-empty__action">{action}</span>}
    </div>
  );
}

function SkeletonBars() {
  return (
    <div className="analytics-skel analytics-skel--bars" aria-hidden="true">
      {Array.from({ length: 14 }).map((_, i) => (
        <span key={i} style={{ height: `${30 + ((i * 37) % 60)}%` }} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function AnalyticsScreen() {
  const { data, state } = useInsights(POLL_MS);
  const { projects, state: projectsState } = useProjectSummaries();
  const { events, state: eventsState } = useRecentEvents();
  const [mountedAt] = useState(() => Date.now());

  const sinceBaseline = data?.sinceBaseline ?? null;
  const daily = data?.daily ?? [];
  const hourly = data?.hourly ?? [];
  const burners = data?.burners ?? [];
  const suggestions = data?.suggestions ?? [];

  const dailyMax = Math.max(...daily.map((d) => d.tokens), 1);
  const hourlyMax = Math.max(...hourly.map((h) => h.tokens), 1);
  const burnerMax = Math.max(...burners.map((b) => b.tokens), 1);
  const hasAnyUsage = (sinceBaseline?.totalRuns ?? 0) > 0;
  const hasDaily = daily.some((d) => d.tokens > 0);
  const loading = state === 'loading' && !data;

  // Live pulse — all derived from the real daily series (ASC, today = last).
  const todayEntry = daily.length > 0 ? daily[daily.length - 1] : null;
  const todayTokens = todayEntry?.tokens ?? 0;
  const todayRuns = todayEntry?.runs ?? 0;
  let streak = 0;
  for (let i = daily.length - 1; i >= 0; i--) {
    if (daily[i].tokens > 0) streak++;
    else break;
  }
  const peakEntry = daily.reduce<DailyTokensAndRuns | null>(
    (best, d) => (best === null || d.tokens > best.tokens ? d : best),
    null,
  );

  const todayTokensCU = useCountUp(todayTokens);
  const todayRunsCU = useCountUp(todayRuns, 700);

  return (
    <div className="analytics-screen">
      <header className="analytics-screen__header">
        <span className="analytics-screen__header-icon" aria-hidden="true">
          <BarChart3 size={18} />
        </span>
        <div className="analytics-screen__header-copy">
          <h1>Analytics</h1>
          <p>Real token usage, top burners, and patterns since your last reset.</p>
        </div>
        <div className={`analytics-livedot analytics-livedot--${state}`} role="status" aria-live="polite">
          <span className="analytics-livedot__dot" aria-hidden="true" />
          {state === 'ready' ? 'Live' : state === 'loading' ? 'Syncing' : 'Offline'}
        </div>
      </header>

      <div className="analytics-screen__stats">
        <StatChip label="Tokens Since Baseline" value={(sinceBaseline?.totalTokens ?? 0).toLocaleString()} />
        <StatChip label="Runs Since Baseline" value={(sinceBaseline?.totalRuns ?? 0).toLocaleString()} />
        <StatChip label="Days Tracked" value={sinceBaseline?.days ?? 0} />
        <StatChip label="Projects Found" value={projectsState === 'ready' ? projects.length : '…'} />
      </div>

      {state === 'error' && (
        <p className="analytics-screen__error">Couldn&rsquo;t load insights. Is the dev server running?</p>
      )}

      <div className="analytics-screen__grid">
        {/* HERO — Daily token usage, spans two columns. */}
        <Panel accent avoidRoam title="Daily Token Usage" className="analytics-panel analytics-panel--daily">
          {loading ? (
            <SkeletonBars />
          ) : hasDaily ? (
            <div className="analytics-daily-wrap">
              <div className="analytics-daily__axis" aria-hidden="true">
                <span>{compactNumber(dailyMax)}</span>
                <span>{compactNumber(dailyMax / 2)}</span>
                <span>0</span>
              </div>
              <div className="analytics-daily">
                {daily.map((d, idx) => {
                  const pct = Math.max(2, (d.tokens / dailyMax) * 100);
                  const showLabel = idx % 5 === 0 || idx === daily.length - 1;
                  return (
                    <div
                      key={d.date}
                      className="analytics-daily__col"
                      title={`${d.date}: ${d.tokens.toLocaleString()} tokens · ${d.runs} runs`}
                    >
                      <span className="analytics-daily__val">{compactNumber(d.tokens)}</span>
                      <span
                        className="analytics-daily__bar"
                        style={{ height: `${pct}%`, animationDelay: `${Math.min(idx * 18, 520)}ms` }}
                      />
                      <span className="analytics-daily__label">{showLabel ? formatShortDate(d.date) : ''}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <EmptyState
              icon={BarChart3}
              title="No token usage recorded yet"
              hint="This 30-day trend fills in automatically as skills, agents, and terminal sessions run."
              action="Run any skill or agent to start the trend"
            />
          )}
        </Panel>

        {/* HERO — Live pulse column. Clean glass to pop against the plated hero. */}
        <Panel accent avoidRoam title="Live Pulse" className="analytics-panel analytics-panel--pulse">
          {loading ? (
            <div className="analytics-skel analytics-skel--pulse" aria-hidden="true" />
          ) : hasDaily ? (
            <div className="analytics-pulse">
              <div className="analytics-pulse__hero">
                <span className="analytics-pulse__value">{todayTokensCU.toLocaleString()}</span>
                <span className="analytics-pulse__label">
                  <Zap size={12} aria-hidden="true" /> tokens today
                </span>
              </div>
              <div className="analytics-pulse__row">
                <div className="analytics-pulse__stat">
                  <span className="analytics-pulse__stat-value">{todayRunsCU.toLocaleString()}</span>
                  <span className="analytics-pulse__stat-label">
                    <Activity size={11} aria-hidden="true" /> runs today
                  </span>
                </div>
                <div className="analytics-pulse__stat">
                  <span className="analytics-pulse__stat-value">
                    {streak}
                    <small>d</small>
                  </span>
                  <span className="analytics-pulse__stat-label">
                    <CalendarDays size={11} aria-hidden="true" /> day streak
                  </span>
                </div>
              </div>
              {peakEntry && peakEntry.tokens > 0 && (
                <div className="analytics-pulse__peak">
                  <TrendingUp size={12} aria-hidden="true" />
                  <span>
                    Peak <strong>{compactNumber(peakEntry.tokens)}</strong> on {formatShortDate(peakEntry.date)}
                  </span>
                </div>
              )}
            </div>
          ) : (
            <EmptyState
              icon={Zap}
              title="No live burn yet"
              hint="Today's token total, run count, and streak light up here the moment real work lands."
            />
          )}
        </Panel>

        {/* BAND — hour-of-day heat, full width. */}
        <Panel avoidRoam title="Usage by Hour of Day" className="analytics-panel analytics-panel--heat">
          {loading ? (
            <div className="analytics-skel analytics-skel--band" aria-hidden="true" />
          ) : hasAnyUsage ? (
            <div className="analytics-heat-wrap">
              <div className="analytics-heat" role="img" aria-label="Token usage by hour of day">
                {hourly.map((h) => {
                  const t = h.tokens > 0 ? h.tokens / hourlyMax : 0;
                  const strong = t > 0.55;
                  return (
                    <span
                      key={h.hour}
                      className={`analytics-heat__cell${h.tokens > 0 ? ' is-active' : ''}`}
                      title={`${formatHourLabel(h.hour)} — ${h.tokens.toLocaleString()} tokens`}
                      style={{
                        background: heatColor(t),
                        boxShadow: strong ? `0 0 8px ${heatColor(Math.min(1, t + 0.1))}` : undefined,
                      }}
                    />
                  );
                })}
              </div>
              <div className="analytics-heat__labels" aria-hidden="true">
                {[0, 6, 12, 18].map((h) => (
                  <span key={h} style={{ gridColumn: h + 1 }}>
                    {formatHourLabel(h)}
                  </span>
                ))}
                <span style={{ gridColumn: 24, justifySelf: 'end' }}>12a</span>
              </div>
              <div className="analytics-heat__legend" aria-hidden="true">
                <span>idle</span>
                <span className="analytics-heat__ramp" />
                <span>peak</span>
              </div>
            </div>
          ) : (
            <EmptyState
              icon={Clock}
              title="No hourly pattern yet"
              hint="Once usage is recorded, this band shows which hours of the day burn the most tokens."
              action="Come back after a few sessions"
            />
          )}
        </Panel>

        {/* TRIPTYCH — Top Burners (plated). */}
        <Panel avoidRoam title="Top Burners" className="analytics-panel analytics-panel--burners">
          {loading ? (
            <div className="analytics-skel analytics-skel--rows" aria-hidden="true">
              {Array.from({ length: 5 }).map((_, i) => (
                <span key={i} />
              ))}
            </div>
          ) : burners.length > 0 ? (
            <ul className="analytics-agents">
              {burners.map((burner, i) => (
                <li key={`${burner.category}-${burner.name}`} className="analytics-agents__row">
                  <span className="analytics-agents__rank">{i + 1}</span>
                  <span className="analytics-agents__name">
                    <span className="analytics-agents__name-text">{humanizeSlug(burner.name)}</span>
                    <span className={`analytics-badge analytics-badge--${burner.category}`}>{burner.category}</span>
                  </span>
                  <span className="analytics-agents__bar">
                    <span
                      className="analytics-agents__fill"
                      style={{ width: `${(burner.tokens / burnerMax) * 100}%` }}
                    />
                  </span>
                  <span className="analytics-agents__meta">
                    <span className="analytics-agents__share">{burner.sharePct}%</span>
                    <span className="analytics-agents__tok">{compactNumber(burner.tokens)}</span>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState
              icon={Flame}
              title="No burners tracked yet"
              hint="Skills and agents rank here by token share as soon as they run."
              action="Run a skill or agent"
            />
          )}
        </Panel>

        {/* TRIPTYCH — Suggestions (glass). */}
        <Panel avoidRoam title="Suggestions" className="analytics-panel analytics-panel--suggest">
          {loading ? (
            <div className="analytics-skel analytics-skel--rows" aria-hidden="true">
              {Array.from({ length: 3 }).map((_, i) => (
                <span key={i} />
              ))}
            </div>
          ) : suggestions.length > 0 ? (
            <ul className="analytics-suggestions">
              {suggestions.map((s, i) => {
                const Icon = SEVERITY_ICON[s.severity];
                return (
                  <li key={i} className={`analytics-suggestion analytics-suggestion--${s.severity}`}>
                    <Icon size={14} aria-hidden="true" className="analytics-suggestion__icon" />
                    <div>
                      <p className="analytics-suggestion__text">{s.text}</p>
                      <p className="analytics-suggestion__basis">{s.basedOn}</p>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <EmptyState
              icon={TrendingUp}
              title="Nothing to flag yet"
              hint="Cost and pattern tips appear here once there's enough usage to spot a trend."
            />
          )}
        </Panel>

        {/* TRIPTYCH — Projects (glass). */}
        <Panel avoidRoam title="Projects" className="analytics-panel analytics-panel--projects">
          {projectsState === 'loading' && (
            <div className="analytics-skel analytics-skel--rows" aria-hidden="true">
              {Array.from({ length: 3 }).map((_, i) => (
                <span key={i} />
              ))}
            </div>
          )}
          {projectsState === 'error' && (
            <EmptyState icon={FolderKanban} title="Couldn't load projects" hint="The project-summary scan failed — retry after the dev server settles." />
          )}
          {projectsState === 'ready' && projects.length === 0 && (
            <EmptyState
              icon={FolderKanban}
              title="No project folders found"
              hint="Nothing under ACTIVE / HOBBY / general / research yet."
              action="Add a project folder to see it here"
            />
          )}
          {projectsState === 'ready' && projects.length > 0 && (
            <div className="analytics-projects">
              {projects.map((project) => (
                <div key={`${project.root}/${project.name}`} className="analytics-project-card">
                  <div className="analytics-project-card__top">
                    <span className="analytics-project-card__icon" aria-hidden="true">
                      <FolderKanban size={14} />
                    </span>
                    <span className="analytics-project-card__name">{humanizeSlug(project.name)}</span>
                    <span className="analytics-project-card__root">{project.root}</span>
                  </div>
                  {project.summary ? (
                    <p className="analytics-project-card__summary">{project.summary}</p>
                  ) : (
                    <p className="analytics-project-card__summary analytics-project-card__summary--empty">
                      No docs/ai-context.md, CLAUDE.md, or README.md found yet.
                    </p>
                  )}
                  <div className="analytics-project-card__meta">
                    {project.source && <span className="analytics-project-card__badge">{SOURCE_LABEL[project.source]}</span>}
                    <span className="analytics-project-card__updated">
                      <Clock size={11} aria-hidden="true" /> {formatRelative(project.modifiedAt, mountedAt)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Panel>

        {/* FOOTER — Recent activity, full width, multi-column. */}
        <Panel avoidRoam title="Recent Activity" className="analytics-panel analytics-panel--recent">
          {eventsState === 'loading' && (
            <div className="analytics-skel analytics-skel--rows" aria-hidden="true">
              {Array.from({ length: 4 }).map((_, i) => (
                <span key={i} />
              ))}
            </div>
          )}
          {eventsState === 'error' && (
            <EmptyState icon={ListChecks} title="Couldn't load recent activity" hint="The recent-events feed failed to load — it will retry on the next refresh." />
          )}
          {eventsState === 'ready' && events.length === 0 && (
            <EmptyState
              icon={Timer}
              title="No activity recorded yet"
              hint="Every skill and agent run lands here with a timestamp as work happens."
              action="Run any skill or agent"
            />
          )}
          {eventsState === 'ready' && events.length > 0 && (
            <div className="analytics-activity">
              {events.map((evt, i) => (
                <ActivityItem
                  key={`${evt.ts}-${i}`}
                  icon={<Activity size={13} />}
                  text={describeEvent(evt)}
                  timestamp={formatRelative(evt.ts, mountedAt)}
                />
              ))}
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}
