'use client';

/**
 * DashboardScreen — the "dashboard" nav screen (see AppShell.tsx NAV_ITEMS /
 * page.tsx's SCREENS map, keyed "dashboard"). Hero mascot on the left, a
 * System Status + Quick Actions column on the right, a view tab strip above a
 * terminal preview + the consolidated Live Usage pill row.
 *
 * Activity Feed + Top Agents used to live in a bottom row here — they've
 * moved to the Agents tab's right rail (dash/ActivityFeedPanel,
 * dash/TopAgentsPanel — self-fetching, shared components) so the Agents
 * screen's rail isn't a blank void when idle, and this screen stays a single-
 * window layout with no leftover empty bottom row.
 *
 * EVERYTHING SHOWN AS DATA IS REAL — no demo fallbacks, no random-walk, no
 * fabricated feed. Every number traces to a real local source and starts
 * empty/zero, filling in as real activity is indexed:
 *     - Live Usage — the consolidated LiveUsageMeter pill (src/components/dash):
 *       real 5h/weekly % + live burn (self-fetching), plus (via `showWeekly`)
 *       the weekly recap half — real GET /api/weekly daily token bars (peak
 *       day highlighted) and the real in/out/cache split for the week from
 *       GET /api/usage-window's breakdown (getWindowTotals). This one pill
 *       replaces what used to be three separate panels (Token Usage, Usage
 *       Overview, Live Usage).
 *     - System Status CPU/MEM/PROC — real GET /api/system.
 *     - "All Systems Green" / Connected state — real liveUsage.connected.
 * VIEW-TAB MINIS (each a real per-section glance in the left preview band —
 * switching tabs never changes the screen height, LAW 2):
 *     - Terminal — the live terminal preview via the anchor portal.
 *     - Agents — the real spawned-agent roster (GET /api/spawned).
 *     - Projects — the real project folders (dash/MiniProjects, self-fetching).
 *     - Chat — Quick Chat, a separate Claude session (dash/QuickChat).
 *     - Memory / Analytics — real bubbles / bars (dash/MiniMemory,
 *       dash/MiniAnalytics), each self-fetching.
 *
 * SPEECH BUBBLE HONESTY (LAW: bubble text = only real speech): the hero's
 * bubble shows a real UI hint (a Quick-Action/tab-strip affordance the user
 * just triggered) or the FlubberBrain's real terminal-reaction speech — and
 * nothing else. There is no rotating canned greeting. No speech = no bubble
 * (FlubberHome handles null; Lane G guarantees it and gates the work panels on
 * the real work clock, never on mood).
 *
 * IDLE LIFE + WORK CLOCK (LAW 1): the hero mascot (FlubberHome idleLife prop)
 * autonomously wanders/eats/showers/naps/vibes whenever nothing real is
 * happening. It yields to the ONE formal work/break gate: `isWorking` from
 * useSession() (SessionProvider's latched + debounced clock over the real
 * token stream / PTY output / spawned-agent signals) is passed straight into
 * FlubberHome. No mood-derived activity is passed here — the room resolves its
 * own honest work-screen from the real clock, never from expression.
 *
 * SESSION-AWARE FILTERING (not yet possible): GET /api/recent's events carry
 * no project attribution (see src/server/db.ts's `events` table), so the
 * Activity Feed (now in the Agents tab rail) stays app-wide rather than
 * fabricating a per-project filter.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BarChart3,
  Bot,
  Brain,
  ChevronDown,
  FolderOpen,
  Menu,
  MessageSquare,
  Plus,
  Terminal as TerminalIcon,
  type LucideIcon,
} from 'lucide-react';
import FlubberCharacter from '../FlubberCharacter';
import FlubberHome from '../FlubberHome';
import AgentAvatar from '../AgentAvatar';
import QuickChat from '../dash/QuickChat';
import MiniMemory from '../dash/MiniMemory';
import MiniAnalytics from '../dash/MiniAnalytics';
import MiniProjects from '../dash/MiniProjects';
import LiveUsageMeter from '../dash/LiveUsageMeter';
import { useDashboardTerminalAnchor } from '../PersistentTerminalHost';
import { Panel, StatChip } from '../ui';
import type { StatChipTrend } from '../ui';
import { useLiveUsage } from '../../hooks/useLiveUsage';
import { useFlubberBrain } from '../../hooks/useFlubberBrain';
import { useSession } from '../../context/SessionProvider';
import './DashboardScreen.css';
// Lane C's "one workspace" cohesion pass (quieter hairline borders, tightened
// gaps, divided-strip seams between panels) — imported AFTER DashboardScreen.css
// so its equal-or-higher-specificity overrides land later in cascade order.
// See that file's own header comment; it was intentionally left unimported by
// Lane C for this integration pass to wire in.
import '../../styles/dashboard-cohesion.css';

// ---------------------------------------------------------------------------
// Local types
// ---------------------------------------------------------------------------

interface DailyPoint {
  date: string;
  totalTokens: number;
}

/** Mirrors src/server/spawned-store.ts's SpawnedAgent shape — the Agents tab
 * mini's roster comes straight from GET /api/spawned, the same store the Agent
 * Control Center reads. */
interface SpawnedAgent {
  id: string;
  name: string;
  purpose: string;
  createdAt: string;
}

interface WeeklyData {
  dailyTrend: DailyPoint[];
  totals?: { totalTokens: number; totalInvocations: number };
}

type FetchState = 'loading' | 'error' | 'ready';

interface TabConfig {
  id: 'terminal' | 'chat' | 'agents' | 'files' | 'memory' | 'analytics';
  label: string;
  icon: LucideIcon;
}

interface VitalReading {
  value: number;
  trend: StatChipTrend;
}

interface SystemVitals {
  cpu: VitalReading;
  mem: VitalReading;
  proc: VitalReading;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TABS: TabConfig[] = [
  { id: 'terminal', label: 'Terminal', icon: TerminalIcon },
  { id: 'chat', label: 'Chat', icon: MessageSquare },
  { id: 'agents', label: 'Agents', icon: Bot },
  { id: 'files', label: 'Projects', icon: FolderOpen },
  { id: 'memory', label: 'Memory', icon: Brain },
  { id: 'analytics', label: 'Analytics', icon: BarChart3 },
];

const HINT_DURATION_MS = 3200;
const VITALS_INTERVAL_MS = 3200;

// Starts blank — the first real /api/system reading fills it in.
const VITALS_SEED: SystemVitals = {
  cpu: { value: 0, trend: 'neutral' },
  mem: { value: 0, trend: 'neutral' },
  proc: { value: 0, trend: 'neutral' },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function weekdayLabel(dateStr: string): string {
  const parsed = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return dateStr.slice(5);
  return parsed.toLocaleDateString('en-US', { weekday: 'short' });
}

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

// ---------------------------------------------------------------------------
// Local hooks
// ---------------------------------------------------------------------------

/** Fetches the real GET /api/weekly rollup once — same endpoint WeeklyRecap
 *  already trusts for token/agent/skill aggregates. */
function useWeeklyData(): { data: WeeklyData | null; state: FetchState } {
  const [data, setData] = useState<WeeklyData | null>(null);
  const [state, setState] = useState<FetchState>('loading');

  useEffect(() => {
    let cancelled = false;
    fetch('/api/weekly')
      .then((res) => {
        if (!res.ok) throw new Error(`weekly fetch failed: ${res.status}`);
        return res.json() as Promise<WeeklyData>;
      })
      .then((json) => {
        if (cancelled) return;
        setData(json);
        setState('ready');
      })
      .catch(() => {
        if (!cancelled) setState('error');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { data, state };
}

/** Fetches the real spawned-agent roster from GET /api/spawned (the same store
 * the Agent Control Center reads/writes) and re-polls so the Agents tab mini's
 * count stays live. Empty until an agent is actually spawned. */
function useSpawnedAgents(pollMs: number): { agents: SpawnedAgent[]; state: FetchState } {
  const [agents, setAgents] = useState<SpawnedAgent[]>([]);
  const [state, setState] = useState<FetchState>('loading');

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetch('/api/spawned')
        .then((res) => {
          if (!res.ok) throw new Error(`spawned fetch failed: ${res.status}`);
          return res.json() as Promise<{ agents?: SpawnedAgent[] }>;
        })
        .then((json) => {
          if (cancelled) return;
          setAgents(Array.isArray(json?.agents) ? json.agents : []);
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

  return { agents, state };
}

function trendOf(prev: number, next: number): StatChipTrend {
  return next > prev ? 'up' : next < prev ? 'down' : 'neutral';
}

/** Real machine vitals from GET /api/system (node os/process): CPU busy %,
 *  system MEM used %, and this dashboard process's memory footprint %. Polls
 *  on a fixed tick; starts at 0 until the first real reading lands. */
function useSystemVitals(): SystemVitals {
  const [vitals, setVitals] = useState<SystemVitals>(VITALS_SEED);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetch('/api/system')
        .then((res) => (res.ok ? (res.json() as Promise<{ cpu: number; mem: number; proc: number }>) : null))
        .then((json) => {
          if (cancelled || !json) return;
          setVitals((prev) => ({
            cpu: { value: json.cpu, trend: trendOf(prev.cpu.value, json.cpu) },
            mem: { value: json.mem, trend: trendOf(prev.mem.value, json.mem) },
            proc: { value: json.proc, trend: trendOf(prev.proc.value, json.proc) },
          }));
        })
        .catch(() => {});
    };
    load();
    const id = setInterval(load, VITALS_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return vitals;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface DashboardScreenProps {
  className?: string;
}

export default function DashboardScreen({ className }: DashboardScreenProps) {
  const liveUsage = useLiveUsage();
  const vitals = useSystemVitals();
  const { data: weeklyData, state: weeklyState } = useWeeklyData();

  const brain = useFlubberBrain();
  const [hint, setHint] = useState<string | null>(null);
  const hintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [activeTab, setActiveTab] = useState<TabConfig['id']>('terminal');
  const spawned = useSpawnedAgents(15_000);
  // Anchor-portal registration for the Terminal tab tile (PersistentTerminalHost
  // measures this ref's real rect and portals the SAME live terminal instance
  // on top of it while this tab is active — see that file's header).
  const terminalAnchorRef = useDashboardTerminalAnchor(activeTab === 'terminal');
  // SESSION CONTRACT: real work clock + one-click actions (new terminal tab).
  const session = useSession();

  useEffect(
    () => () => {
      if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
    },
    [],
  );

  const showHint = useCallback((text: string) => {
    setHint(text);
    if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
    hintTimerRef.current = setTimeout(() => setHint(null), HINT_DURATION_MS);
  }, []);

  // The hero mood + pulse come from the real brain (terminal/music/intensity/
  // idle). The bubble shows a real UI hint or the brain's real terminal-
  // reaction speech — never a canned greeting. No speech = no bubble.
  const mascotExpression = brain.expression;
  const pulseKey = brain.pulseKey;
  const bubbleText = hint ?? brain.speech?.text ?? null;

  // Weekly token bars, highlighting the peak day — fed into the merged Live
  // Usage pill's weekly recap half (LiveUsageMeter showWeekly) as props.
  const barData = useMemo(
    () => (weeklyData?.dailyTrend ?? []).map((d) => ({ label: weekdayLabel(d.date), value: d.totalTokens })),
    [weeklyData],
  );
  const barHighlightIndex = useMemo(() => {
    if (barData.length === 0) return undefined;
    let best = 0;
    barData.forEach((d, i) => {
      if (d.value > barData[best].value) best = i;
    });
    return best;
  }, [barData]);
  const weeklyTotal = weeklyData?.totals?.totalTokens ?? barData.reduce((acc, d) => acc + d.value, 0);

  const activeTabConfig = TABS.find((t) => t.id === activeTab) ?? TABS[0];

  // Quick Actions — every one a REAL, working action available from this
  // screen: spawn a real terminal tab (navigates to Terminal), or surface a
  // real per-section mini in the view band below. No dead buttons, no fakes.
  const quickActions = useMemo<{ id: string; label: string; icon: LucideIcon; onClick: () => void }[]>(
    () => [
      { id: 'terminal', label: 'New Terminal', icon: Plus, onClick: () => session.openTab() },
      { id: 'projects', label: 'Projects', icon: FolderOpen, onClick: () => setActiveTab('files') },
      { id: 'analytics', label: 'Analytics', icon: BarChart3, onClick: () => setActiveTab('analytics') },
      { id: 'memory', label: 'Memory', icon: Brain, onClick: () => setActiveTab('memory') },
    ],
    [session],
  );

  const classes = ['dashboard-screen', className ?? ''].filter(Boolean).join(' ');

  return (
    <div className={classes}>
      <div className="dashboard-screen__top">
        <div className="dashboard-hero" data-flubber-avoid="true">
          <FlubberHome
            compact
            idleLife
            interactive
            isWorking={session.isWorking}
            backdrop="home"
            expression={mascotExpression}
            speech={bubbleText}
            pulseKey={pulseKey}
            // Real live token-burn-rate (LAW 1) — liveUsage.intensity is
            // already a 0..1 normalized, decaying activity score derived from
            // real /api/live token deltas (see useLiveUsage.ts: each delta
            // bumps it by (in+out)/ACTIVITY_SCALE, clamped to 1, decaying
            // ~10%/400ms when quiet). FlubberBrainProvider already trusts this
            // same value for its own intensity bucketing, so this reuses one
            // real signal rather than inventing a second tok/min normalization.
            energy={liveUsage.intensity}
          />
        </div>

        <div className="dashboard-screen__side">
          <Panel
            accent
            title="System Status"
            className="dashboard-panel dashboard-panel--status"
            action={<ChevronDown size={14} className="dashboard-panel-chevron" aria-hidden="true" />}
          >
            <p className={`dashboard-status-line${liveUsage.connected ? '' : ' dashboard-status-line--warn'}`}>
              <span className={`dashboard-status-dot${liveUsage.connected ? '' : ' dashboard-status-dot--warn'}`} aria-hidden="true" />
              {liveUsage.connected ? 'All Systems Green' : 'Reconnecting…'}
            </p>
            <div className="dashboard-stat-grid" data-flubber-avoid="true">
              <StatChip label="CPU" value={`${vitals.cpu.value}%`} trend={vitals.cpu.trend} percent={vitals.cpu.value} />
              <StatChip label="MEM" value={`${vitals.mem.value}%`} trend={vitals.mem.trend} percent={vitals.mem.value} />
              <StatChip label="PROC" value={`${vitals.proc.value}%`} trend={vitals.proc.trend} percent={vitals.proc.value} />
            </div>
            <div className="dashboard-quick-actions">
              <span className="dashboard-quick-actions__label">Quick Actions</span>
              <div className="quick-actions-grid">
                {quickActions.map((action) => {
                  const Icon = action.icon;
                  return (
                    <button key={action.id} type="button" className="quick-action-btn" onClick={action.onClick}>
                      <span className="quick-action-btn__icon">
                        <Icon size={16} aria-hidden="true" />
                      </span>
                      {action.label}
                    </button>
                  );
                })}
              </div>
            </div>
          </Panel>
        </div>
      </div>

      <div className="dashboard-tabstrip" role="tablist" aria-label="Dashboard views">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const isActive = tab.id === activeTab;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              className={`dashboard-tab${isActive ? ' dashboard-tab--active' : ''}`}
              onClick={() => setActiveTab(tab.id)}
            >
              <Icon size={13} aria-hidden="true" />
              {tab.label}
            </button>
          );
        })}
        <div className="dashboard-tabstrip__end">
          <button
            type="button"
            className="dashboard-tabstrip__new"
            onClick={() => session.openTab()}
          >
            <Plus size={12} aria-hidden="true" />
            New Tab
          </button>
          <button
            type="button"
            className="dashboard-tabstrip__menu"
            aria-label="Tab options"
            onClick={() => showHint('Full tab management lives in the Terminal screen — head over any time.')}
          >
            <Menu size={14} aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className="dashboard-screen__midrow">
        {activeTab === 'terminal' ? (
          // Terminal tab = the REAL terminal via the anchor-portal
          // (PersistentTerminalHost.tsx): this tile is just an empty,
          // correctly-sized anchor — the live TerminalScreen is measured and
          // portaled directly on top of it while this tab is active.
          <div className="dashboard-terminal-anchor" ref={terminalAnchorRef}>
            <div className="dashboard-terminal-anchor__boot" aria-hidden="true">
              <span className="screen-boot__ring" />
              <span>Booting terminal…</span>
            </div>
          </div>
        ) : activeTab === 'agents' ? (
          // Agents tab mini — a live glance at the real spawned-agent roster
          // (GET /api/spawned), the same store the Agent Control Center reads.
          <div className="dashboard-tabmini">
            <div className="dashboard-tabmini__head">
              <span className="dashboard-tabmini__head-icon">
                <Bot size={14} aria-hidden="true" />
              </span>
              <span className="dashboard-tabmini__head-label">Spawned Agents</span>
              <span className="dashboard-tabmini__head-count">
                {spawned.state === 'loading' ? '—' : spawned.agents.length}
              </span>
            </div>
            <div className="dashboard-tabmini__body">
              {spawned.state === 'loading' && <p className="dashboard-tabmini__empty">Loading roster…</p>}
              {spawned.state === 'error' && (
                <p className="dashboard-tabmini__empty">Couldn&rsquo;t load the roster.</p>
              )}
              {spawned.state === 'ready' && spawned.agents.length === 0 && (
                <p className="dashboard-tabmini__empty">
                  No agents spawned yet — deploy a squad from the Agents screen.
                </p>
              )}
              {spawned.state === 'ready' && spawned.agents.length > 0 && (
                <div className="dashboard-tabmini__list" data-flubber-avoid="true">
                  {[...spawned.agents]
                    .reverse()
                    .slice(0, 6)
                    .map((agent) => (
                      <div key={agent.id} className="dashboard-tabmini__row">
                        <AgentAvatar
                          name={agent.name}
                          description={agent.purpose}
                          size={24}
                          tier="mid"
                          className="dashboard-tabmini__avatar"
                        />
                        <span className="dashboard-tabmini__row-main">
                          <span className="dashboard-tabmini__row-name">{agent.name}</span>
                          <span className="dashboard-tabmini__row-sub">{agent.purpose}</span>
                        </span>
                        <span className="dashboard-tabmini__row-time">{formatRelTime(agent.createdAt)}</span>
                      </div>
                    ))}
                </div>
              )}
            </div>
            <button
              type="button"
              className="dashboard-tabmini__foot"
              onClick={() =>
                showHint('The full Agent Control Center lives in the Agents screen — head over from the sidebar.')
              }
            >
              Open Agents →
            </button>
          </div>
        ) : activeTab === 'files' ? (
          // Projects tab — real 8-most-recent grid, sorted by real doc mtime.
          // See dash/MiniProjects.tsx.
          <MiniProjects />
        ) : activeTab === 'chat' ? (
          // Chat tab = Quick Chat — a SEPARATE Claude session (see
          // api/quickchat/route.ts). Never touches the main work terminal.
          <QuickChat />
        ) : activeTab === 'memory' ? (
          // Memory tab mini — real bubbles via /api/memory. See dash/MiniMemory.tsx.
          <MiniMemory />
        ) : activeTab === 'analytics' ? (
          // Analytics tab mini — real daily token bars + top burners via
          // /api/insights. See dash/MiniAnalytics.tsx.
          <MiniAnalytics />
        ) : (
          <div className="terminal-preview terminal-preview--empty">
            <FlubberCharacter expression="confused" size={56} tier="mid" mode="character" showToggle={false} />
            <p>
              The {activeTabConfig.label} view has its own screen — open it from the sidebar for the full picture.
            </p>
          </div>
        )}

        {/* LIVE USAGE — the consolidated live + weekly usage pill (merges what
            used to be three separate panels: Token Usage, Usage Overview, and
            this Live Usage pill). Live half is self-fetching; the weekly bars
            are this screen's own GET /api/weekly data passed down as props so
            the pill never opens a second poll of that endpoint. Sits in the
            midrow's row-height-fixed grid track (see .dashboard-screen__midrow
            CSS comment) so its height:100% resolves correctly. */}
        <LiveUsageMeter
          showWeekly
          weeklyBarData={barData}
          weeklyBarHighlightIndex={barHighlightIndex}
          weeklyTotal={weeklyTotal}
          weeklyState={weeklyState}
        />
      </div>

    </div>
  );
}
