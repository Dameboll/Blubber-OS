'use client';

/**
 * TerminalScreen — the "terminal" nav id's screen content (see AppShell.tsx's
 * NAV IDS list and page.tsx's SCREENS map). This file owns only the chrome
 * AROUND the real terminal: TabBar (src/components/TabBar.tsx) + TerminalPane
 * (src/components/TerminalPane.tsx) already implement the actual PTY/xterm
 * session logic over the shared `wsClient` WebSocket singleton and are
 * rendered here unmodified — this screen does not reimplement any of that.
 *
 * Every stat on this screen is wired to a real, already-existing data source
 * in this codebase wherever one exists:
 *   - ACTIVE AGENTS         <- TabBar's own onTabsChange callback (real open
 *                              PTY sessions, not fabricated agents)
 *   - LIVE OUTPUT            <- SessionProvider's own wsClient.subscribe() on
 *                              the active tab's sessionId (see
 *                              src/context/SessionProvider.tsx) -- moved out
 *                              of this screen so the buffer survives this
 *                              screen unmounting on a nav switch
 *   - TOKEN USAGE (bar)      <- GET /api/weekly (dailyTrend), same endpoint
 *                              WeeklyRecap.tsx already consumes
 *   - Tokens Used / today    <- SessionProvider's useLiveUsage() (SSE
 *                              /api/live), one persistent subscription for
 *                              the whole app session instead of one per
 *                              mount of this screen
 *   - Commands Run / Top
 *     Commands / Sessions
 *     Used                   <- real counters kept locally in this screen,
 *                              driven by actual user actions this session
 *   - Uptime                 <- SessionProvider's sessionStartTs, ticking
 *                              continuously regardless of which screen is
 *                              showing
 *
 * SYSTEM OVERVIEW: real machine vitals from GET /api/system (CPU busy %, system
 * MEM used %, and PROC = this dashboard process's RSS as a % of system RAM),
 * polled every ~2.5s by SessionProvider (moved there so polling and the
 * sparkline history keep running across nav switches). The old NET/DISK
 * gauges had no dependency-free per-second reading in this app, so they were
 * dropped rather than faked — three real gauges, no invented fourth/fifth
 * number. Each sparkline is the real trailing sample window for that metric,
 * filling in from empty as polls arrive (no seeded starter waveform).
 *
 * CONTEXT WINDOW: removed. This app has no per-conversation context-window
 * counter anywhere, and the old panel filled that slot with a seeded random
 * walk over a made-up budget. Rather than mislabel some other real metric (e.g.
 * tokens-today) as a live context window, the gauge is gone entirely.
 *
 * ACTIVE AGENTS per-session progress %: removed. Open PTY tabs are real, but a
 * terminal has no real per-session completion/activity metric, so the old
 * seeded/hashed bar was dropped — the rows still list each real session (name +
 * working dir + exited state), just without a fabricated percent.
 *
 * FLUBBER REACTIONS (added 2026-07-10, see PLAN-FLUBBER.md): the dock's
 * FlubberCharacter now reacts to real PTY events, not just a fixed
 * "working" state -- watches SessionProvider's `logEvent` (its classification
 * of the same real output/exit stream "Live Output" renders), plus
 * command-submit and new-tab-open, and briefly switches expression
 * (thinking/focused on start, celebrating on a success-shaped output line,
 * worried/disappointed on an error-shaped line or non-zero exit) before
 * settling back to idle. See `fireReaction` below.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckCircle2,
  Download,
  Minus,
  Square,
  Terminal as TerminalIcon,
  X,
} from 'lucide-react';
import TabBar, { type TabBarHandle, type TabSummary } from '../TabBar';
import FlubberCharacter, { type FlubberExpression } from '../FlubberCharacter';
import MiniFlubberField from '../MiniFlubberField';
import {
  Panel,
  StatChip,
  BarChart,
  AgentRow,
  ActivityItem,
  Sparkline,
  type BarChartDatum,
} from '../ui';
import { useSession } from '../../context/SessionProvider';
import { wsClient } from '../../lib/ws-client';
import { formatShortTime } from '../../lib/time-format';
import './TerminalScreen.css';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// How long a one-shot reaction (thinking/celebrating/worried/etc.) holds
// before FlubberCharacter settles back to its idle expression.
const REACTION_HOLD_MS = 1800;

// ---------------------------------------------------------------------------
// Local types
// ---------------------------------------------------------------------------
// LogLine, SystemVitals/VitalsState, the vitals poller, and the live-usage
// subscription all moved to SessionProvider (src/context/SessionProvider.tsx)
// -- this screen now just reads useSession()'s output instead of owning any
// of it, so none of it resets when this screen unmounts on a nav switch.

interface WeeklyDailyPoint {
  date: string;
  totalTokens: number;
}

interface WeeklyTotals {
  totalTokens: number;
  totalInvocations: number;
}

interface WeeklyUsageResponse {
  dailyTrend: WeeklyDailyPoint[];
  totals?: WeeklyTotals;
}

type FetchState = 'loading' | 'error' | 'ready';
type UsageView = 'live' | 'daily' | 'weekly';

// ---------------------------------------------------------------------------
// Small local helpers
// ---------------------------------------------------------------------------

function shortPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : path;
}

function formatWeekdayLabel(dateStr: string): string {
  const parsed = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return dateStr.slice(0, 3);
  return parsed.toLocaleDateString(undefined, { weekday: 'short' });
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface TerminalScreenProps {
  className?: string;
  /** Anchored in the Dashboard's Terminal tile (~700x350) via
   * PersistentTerminalHost's anchor-portal — hides full-width-only chrome
   * (hero Blubber, window chrome, bottom stats row) so the tile is a pure
   * tab-strip + xterm mirror. See PersistentTerminalHost.tsx. */
  compact?: boolean;
}

export default function TerminalScreen({ className, compact }: TerminalScreenProps) {
  // Uptime, system vitals + sparklines, the live PTY log buffer, and the
  // live-usage SSE subscription all live in SessionProvider now (mounted in
  // AppShell, above this screen's own mount/unmount cycle) — see that file's
  // header for exactly what does and doesn't survive a nav switch.
  const {
    uptime,
    vitals,
    liveUsage,
    logLines,
    logEvent,
    sessionStartTs,
    clearLog,
    setActiveTabId: setSessionActiveTabId,
    syncSessions,
    registerTabControl,
  } = useSession();

  const sessionStartLabel = useMemo(() => formatShortTime(new Date(sessionStartTs)), [sessionStartTs]);

  const terminalCardRef = useRef<HTMLDivElement | null>(null);
  const liveOutputRef = useRef<HTMLDivElement | null>(null);
  const seenTabIdsRef = useRef<Set<string>>(new Set());
  const reactionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tabBarRef = useRef<TabBarHandle>(null);

  const [tabs, setTabs] = useState<TabSummary[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [sessionsUsedCount, setSessionsUsedCount] = useState(0);
  const [pulseKey, setPulseKey] = useState(0);
  const [reactiveExpression, setReactiveExpression] = useState<FlubberExpression | null>(null);
  const [reactionText, setReactionText] = useState<string | null>(null);

  const [weekly, setWeekly] = useState<WeeklyUsageResponse | null>(null);
  const [weeklyState, setWeeklyState] = useState<FetchState>('loading');
  const [usageView, setUsageView] = useState<UsageView>('weekly');

  // -- Event-driven Blubber reactions (PLAN-FLUBBER.md) ----------------------
  // One-shot expression change + orb/character pulse, driven off REAL PTY
  // events (command submitted, new session spawned, success/error-shaped
  // output line, non-zero exit) rather than a fixed "working" placeholder.
  // Always bumps pulseKey too, so the squash-and-stretch fires alongside the
  // expression change. Settles back to idle after REACTION_HOLD_MS unless
  // superseded by another reaction first.
  const fireReaction = useCallback(
    (expression: FlubberExpression, text?: string, holdMs = REACTION_HOLD_MS) => {
      setReactiveExpression(expression);
      setReactionText(text ?? null);
      setPulseKey((k) => k + 1);
      if (reactionTimeoutRef.current) clearTimeout(reactionTimeoutRef.current);
      reactionTimeoutRef.current = setTimeout(() => {
        setReactiveExpression(null);
        setReactionText(null);
      }, holdMs);
    },
    [],
  );

  useEffect(
    () => () => {
      if (reactionTimeoutRef.current) clearTimeout(reactionTimeoutRef.current);
    },
    [],
  );

  // -- TabBar wiring: real open-session list + which one is active ----------
  const handleTabsChange = useCallback(
    (nextTabs: TabSummary[], nextActiveId: string | null) => {
      setTabs(nextTabs);
      setActiveTabId(nextActiveId);
      let newlySeen = 0;
      for (const tab of nextTabs) {
        if (!seenTabIdsRef.current.has(tab.id)) {
          seenTabIdsRef.current.add(tab.id);
          newlySeen += 1;
        }
      }
      if (newlySeen > 0) {
        setSessionsUsedCount((count) => count + newlySeen);
        // A new session starting is a real "something just began" event —
        // same "thinking/focused" reaction a typed command start gets.
        fireReaction('thinking', 'New session started.');
      }
    },
    [fireReaction],
  );

  // Tell SessionProvider which tab is active so IT can drive the real
  // wsClient log subscription (see that file's header for why this lives
  // there instead of here: it's the piece that must survive this screen's
  // own unmount/remount on a nav switch). Also mirror the FULL real tab list
  // into SessionProvider's `sessions` (SESSION CONTRACT, see that file's
  // header) so consumers on other screens — AppShell's session pills,
  // ProjectsScreen's "Open Project" button — can read/drive real terminal
  // state without importing TabBar.
  useEffect(() => {
    setSessionActiveTabId(activeTabId);
    syncSessions(tabs, activeTabId);
  }, [tabs, activeTabId, setSessionActiveTabId, syncSessions]);

  // Register TabBar's real imperative handle with SessionProvider so
  // `session.setActiveTab(id)` called from ANYWHERE in the app (session
  // pills, etc.) really switches TabBar's active tab through the same
  // `activateTab` method the mini-flubber cluster already uses below.
  // Unregistered on unmount so a stale ref is never called after this
  // screen (and TabBar with it) is gone.
  useEffect(() => {
    registerTabControl({
      activateTab: (id: string) => tabBarRef.current?.activateTab(id),
      openTab: (title, cwd, initialPrompt, resume) =>
        tabBarRef.current?.openTab(title, cwd, initialPrompt, resume) ?? null,
      closeTab: (id: string) => tabBarRef.current?.closeTab(id),
    });
    return () => registerTabControl(null);
  }, [registerTabControl]);

  // -- Mini-flubbers: one real blob per open PTY tab (PLAN-FLUBBER.md #2) ---
  // Renders near the terminal card, source-of-truth is TabBar's own
  // `tabs`/`activeTabId` state (already threaded up via handleTabsChange
  // above) — clicking a blob switches TabBar's active tab through the same
  // imperative handle the tab strip itself uses.
  const miniFlubberSessions = useMemo(
    () => tabs.map((tab) => ({ id: tab.id, label: tab.title, accent: tab.exited ? ('error' as const) : undefined })),
    [tabs],
  );
  const handleSelectMiniBlubber = useCallback((sessionId: string) => {
    tabBarRef.current?.activateTab(sessionId);
  }, []);

  // -- Live Output reactions: SessionProvider owns the real wsClient ------
  // subscription and the log buffer itself now (see file header); this
  // screen just watches `logEvent` for the same one-shot Blubber reaction
  // it always fired -- celebrate on a success-shaped line, worry on an
  // error-shaped line, show disappointed on a non-zero exit.
  useEffect(() => {
    if (!logEvent) return;
    if (logEvent.kind === 'error') fireReaction('worried', 'Hit an error.');
    else if (logEvent.kind === 'success') fireReaction('celebrating', 'That worked.');
    else if (logEvent.kind === 'exit-nonzero') fireReaction('disappointed', 'Exited non-zero.');
  }, [logEvent, fireReaction]);

  useEffect(() => {
    const el = liveOutputRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [logLines]);

  // -- Weekly token usage (real, same endpoint WeeklyRecap.tsx uses) --------
  useEffect(() => {
    let cancelled = false;
    fetch('/api/weekly')
      .then((res) => {
        if (!res.ok) throw new Error(`weekly fetch failed: ${res.status}`);
        return res.json() as Promise<WeeklyUsageResponse>;
      })
      .then((json) => {
        if (cancelled) return;
        setWeekly(json);
        setWeeklyState('ready');
      })
      .catch(() => {
        if (!cancelled) setWeeklyState('error');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const weeklyBarData = useMemo<BarChartDatum[]>(() => {
    if (!weekly?.dailyTrend) return [];
    return weekly.dailyTrend.map((point) => ({ label: formatWeekdayLabel(point.date), value: point.totalTokens }));
  }, [weekly]);

  const weeklyTotalTokens = weekly?.totals?.totalTokens ?? weeklyBarData.reduce((acc, d) => acc + d.value, 0);

  // -- Token Usage view toggle: three real data sources, no fabricated ------
  // numbers. "Live" = the current SSE burst (tokensInDelta+tokensOutDelta),
  // "Daily" = liveUsage.totalToday (already a real running total-for-today
  // counter, same value shown in Session Info), "Weekly" = the /api/weekly
  // total. The bar chart underneath always shows the real 7-day trend
  // regardless of which pill is selected -- only the headline total swaps.
  const usageViewTotals: Record<UsageView, { value: number; header: string; unitLabel: string }> = {
    live: { value: liveUsage.tokensInDelta + liveUsage.tokensOutDelta, header: 'Live Right Now', unitLabel: 'tokens in the last burst' },
    daily: { value: liveUsage.totalToday, header: 'Total Today', unitLabel: 'tokens today' },
    weekly: { value: weeklyTotalTokens, header: 'Total This Week', unitLabel: 'tokens this week' },
  };
  const activeUsageTotal = usageViewTotals[usageView];

  // Real day-over-day change from the same fetched dailyTrend array (no
  // fabricated "vs last week" figure -- this app never fetches a prior
  // week's totals, so that comparison has no real backing data). Compares
  // the two most recent days actually returned by /api/weekly.
  const dayOverDayTrend = useMemo(() => {
    if (weeklyBarData.length < 2) return null;
    const prevDay = weeklyBarData[weeklyBarData.length - 2].value;
    const today = weeklyBarData[weeklyBarData.length - 1].value;
    if (prevDay <= 0) return null;
    const pct = Math.round(((today - prevDay) / prevDay) * 100);
    return { direction: pct >= 0 ? ('up' as const) : ('down' as const), pct: Math.abs(pct) };
  }, [weeklyBarData]);

  // -- Export (real client-side download of this session's actual state) ---
  const handleExport = useCallback(() => {
    const payload = {
      exportedAt: new Date().toISOString(),
      sessionStart: new Date(sessionStartTs).toISOString(),
      uptime,
      sessionsUsed: sessionsUsedCount,
      tokensUsedToday: liveUsage.totalToday,
      liveOutput: logLines.map(({ timestamp, text }) => ({ timestamp, text })),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `flubber-session-${Date.now()}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }, [uptime, sessionsUsedCount, liveUsage.totalToday, logLines, sessionStartTs]);

  // -- Derived display state -------------------------------------------------
  const anyExited = tabs.some((tab) => tab.exited);
  const exitedCount = tabs.filter((tab) => tab.exited).length;
  const overviewLabel = !liveUsage.connected
    ? 'Reconnecting…'
    : anyExited
      ? `${exitedCount} session${exitedCount === 1 ? '' : 's'} exited`
      : 'All Systems Operational';

  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  const isStreaming = Boolean(activeTabId) && !activeTab?.exited;

  const flubberExpression: FlubberExpression =
    reactiveExpression ?? (tabs.length === 0 ? 'waving' : 'happy');

  const isEmpty = tabs.length === 0;

  const classes = [
    'terminal-screen',
    compact ? 'terminal-screen--compact' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={classes}>
      <div className="terminal-screen__hero">
        <div className="terminal-screen__main">
          <div
            className={`terminal-screen__terminal-card${isEmpty ? ' terminal-screen__terminal-card--hero' : ''}`}
            ref={terminalCardRef}
          >
            {isEmpty && (
              <div className="terminal-screen__hero-stage" aria-hidden="true">
                <div className="terminal-screen__hero-backdrop" />
                <div className="terminal-screen__hero-grid" />
                <div className="terminal-screen__hero-glow" />
              </div>
            )}
            <div className="terminal-screen__window-chrome" aria-hidden="true">
              <span className="terminal-screen__window-icon">
                <Minus size={12} aria-hidden="true" />
              </span>
              <span className="terminal-screen__window-icon">
                <Square size={11} aria-hidden="true" />
              </span>
              <span className="terminal-screen__window-icon terminal-screen__window-icon--close">
                <X size={13} aria-hidden="true" />
              </span>
            </div>

            <TabBar ref={tabBarRef} onTabsChange={handleTabsChange} />

            <div className="terminal-screen__mini-flubbers">
              <MiniFlubberField
                sessions={miniFlubberSessions}
                activeSessionId={activeTabId}
                onSelect={handleSelectMiniBlubber}
              />
            </div>

            <div className={`terminal-screen__flubber-dock${isEmpty ? ' terminal-screen__flubber-dock--hero' : ''}`}>
              <FlubberCharacter
                expression={flubberExpression}
                size={isEmpty ? 220 : 150}
                mode="character"
                showToggle={false}
                pulseKey={pulseKey}
              />
              {/* Bubble only ever echoes a real PTY-classified reaction
                  (new session / success / error / non-zero exit) — no
                  canned placeholder copy. No reaction firing = no bubble. */}
              {reactionText && <div className="terminal-screen__speech-bubble">{reactionText}</div>}
            </div>
          </div>
        </div>

        <div className="terminal-screen__sidebar">
          <Panel title="System Overview" accent>
            <div className="terminal-screen__status-row">
              <span
                className={`terminal-screen__status-dot${
                  !liveUsage.connected
                    ? ' terminal-screen__status-dot--offline'
                    : anyExited
                      ? ' terminal-screen__status-dot--warn'
                      : ''
                }`}
                aria-hidden="true"
              />
              {overviewLabel}
            </div>
            {/* No `trend` prop here on purpose: StatChip's down-trend color
                is a shared ui/ token (var(--accent-danger), red) that has no
                swatch in this reference's system-overview stats -- the spec
                calls for a green sparkline conveying direction, not a
                red/green arrow. The Sparkline below carries that signal
                instead, entirely in the green family. */}
            {/* Three real gauges from /api/system (CPU busy %, system MEM used %,
                PROC = this process's RSS %); the reference's fabricated NET/DISK
                gauges are dropped. "—" until the first poll lands. Column count
                (3, not the reference's 4) lives directly in the CSS class now --
                see .terminal-screen__stat-grid in TerminalScreen.css. */}
            <div className="terminal-screen__stat-grid" data-flubber-avoid="true">
              <div className="terminal-screen__stat-cell">
                <StatChip
                  label="CPU"
                  value={vitals.values ? `${vitals.values.cpu}%` : '—'}
                  className="terminal-screen__stat-chip"
                />
                <Sparkline data={vitals.history.cpu} width={140} height={28} className="terminal-screen__stat-spark" />
              </div>
              <div className="terminal-screen__stat-cell">
                <StatChip
                  label="MEM"
                  value={vitals.values ? `${vitals.values.mem}%` : '—'}
                  className="terminal-screen__stat-chip"
                />
                <Sparkline data={vitals.history.mem} width={140} height={28} className="terminal-screen__stat-spark" />
              </div>
              <div className="terminal-screen__stat-cell">
                <StatChip
                  label="PROC"
                  value={vitals.values ? `${vitals.values.proc}%` : '—'}
                  className="terminal-screen__stat-chip"
                />
                <Sparkline data={vitals.history.proc} width={140} height={28} className="terminal-screen__stat-spark" />
              </div>
            </div>
          </Panel>

          <Panel
            title="Active Agents"
            accent
            avoidRoam
            action={
              <button
                type="button"
                className="terminal-screen__link-btn"
                onClick={() => terminalCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })}
              >
                Spawn New
              </button>
            }
          >
            <div className="terminal-screen__agent-list">
              {tabs.length === 0 && (
                <p className="terminal-screen__empty-note">
                  No active sessions. Open a tab in the terminal to launch one.
                </p>
              )}
              {/* No per-session % / progress bar: a terminal has no real
                  per-tab completion or activity metric, so the old seeded/hashed
                  bar was dropped rather than faked. Each row is a real open PTY
                  session (title + working dir + exited state). */}
              {tabs.map((tab) => (
                <div className="terminal-screen__agent-item" key={tab.id}>
                  <AgentRow
                    name={tab.title}
                    status={tab.exited ? 'Session exited' : `Running in ${shortPath(tab.cwd)}`}
                    variant="none"
                    avatarColor={tab.id === activeTabId ? 'var(--core-accent-bright)' : 'var(--core-accent)'}
                  />
                </div>
              ))}
            </div>
            {tabs.length > 0 && (
              <button
                type="button"
                className="terminal-screen__view-all-btn"
                onClick={() => terminalCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })}
              >
                View All Agents →
              </button>
            )}
          </Panel>

          <Panel
            title="Live Output"
            accent
            avoidRoam
            action={
              <span
                className={`terminal-screen__streaming-pill${
                  isStreaming ? '' : ' terminal-screen__streaming-pill--idle'
                }`}
              >
                <span className="terminal-screen__streaming-dot" aria-hidden="true" />
                {isStreaming ? 'Streaming' : 'Idle'}
              </span>
            }
          >
            <div className="terminal-screen__live-output" ref={liveOutputRef}>
              {!activeTabId && (
                <p className="terminal-screen__empty-note">Open a session to see live output here.</p>
              )}
              {activeTabId && logLines.length === 0 && (
                <p className="terminal-screen__empty-note">No output yet. Run a command to see live logs.</p>
              )}
              {logLines.map((line) => (
                <ActivityItem
                  key={line.id}
                  icon={
                    line.success ? (
                      <CheckCircle2 size={13} aria-hidden="true" />
                    ) : (
                      <TerminalIcon size={13} aria-hidden="true" />
                    )
                  }
                  text={line.text}
                  timestamp={line.timestamp}
                />
              ))}
            </div>
          </Panel>
        </div>
      </div>

      <div className="terminal-screen__bottom-row">
        <Panel
          title="Token Usage"
          accent
          action={
            <div className="terminal-screen__toggle-group" role="tablist" aria-label="Token usage timeframe">
              {(['live', 'daily', 'weekly'] as UsageView[]).map((view) => (
                <button
                  key={view}
                  type="button"
                  role="tab"
                  aria-selected={usageView === view}
                  className={`terminal-screen__toggle-pill${
                    usageView === view ? ' terminal-screen__toggle-pill--active' : ''
                  }`}
                  onClick={() => setUsageView(view)}
                >
                  {view === 'live' ? 'Live' : view === 'daily' ? 'Daily' : 'Weekly'}
                </button>
              ))}
            </div>
          }
        >
          {weeklyState === 'loading' && <p className="terminal-screen__empty-note">Loading token usage…</p>}
          {weeklyState === 'error' && <p className="terminal-screen__empty-note">Couldn&rsquo;t load token usage.</p>}
          {weeklyState === 'ready' && weeklyBarData.length === 0 && (
            <p className="terminal-screen__empty-note">No usage yet this week.</p>
          )}
          {weeklyState === 'ready' && weeklyBarData.length > 0 && (
            <>
              <span className="terminal-screen__token-header">{activeUsageTotal.header}</span>
              <div className="terminal-screen__token-total">
                <span className="terminal-screen__token-total-value">{activeUsageTotal.value.toLocaleString()}</span>
                <span className="terminal-screen__token-total-label">{activeUsageTotal.unitLabel}</span>
              </div>
              {dayOverDayTrend && (
                <p
                  className={`terminal-screen__token-trend terminal-screen__token-trend--${dayOverDayTrend.direction}`}
                >
                  {dayOverDayTrend.direction === 'up' ? '▲' : '▼'} {dayOverDayTrend.pct}% vs yesterday
                </p>
              )}
              <BarChart data={weeklyBarData} highlightIndex={weeklyBarData.length - 1} height={46} />
            </>
          )}
        </Panel>

        {/* Context Window + Top Commands panels removed: neither had a real
            data source in this app (no per-conversation context counter; user
            input never reaches this screen in the persistent-terminal
            architecture, so command counts were always empty). Bottom row is
            now two real panels -- the column count lives directly in
            .terminal-screen__bottom-row in TerminalScreen.css. */}

        <Panel title="Session Info" accent>
          <div className="terminal-screen__info-list">
            <div className="terminal-screen__info-row">
              <span className="terminal-screen__info-key">Session Start</span>
              <span className="terminal-screen__info-value">{sessionStartLabel}</span>
            </div>
            <div className="terminal-screen__info-row">
              <span className="terminal-screen__info-key">Uptime</span>
              <span className="terminal-screen__info-value">{uptime}</span>
            </div>
            <div className="terminal-screen__info-row">
              <span className="terminal-screen__info-key">Agents Used</span>
              <span className="terminal-screen__info-value">{sessionsUsedCount}</span>
            </div>
            <div className="terminal-screen__info-row">
              <span className="terminal-screen__info-key">Tokens Used</span>
              <span className="terminal-screen__info-value">{liveUsage.totalToday.toLocaleString()}</span>
            </div>
          </div>
          <button type="button" className="terminal-screen__export-btn" onClick={handleExport}>
            <Download size={14} aria-hidden="true" />
            Export Session Log
          </button>
        </Panel>
      </div>
    </div>
  );
}
