'use client';

/**
 * AppShell — the persistent layout wrapper for the whole app: a left sidebar
 * (brand lockup, primary nav, recent agents, Blubber tip card), a thin
 * topbar (user chip), and a footer status bar. Every screen renders inside
 * `children`, in the main content area; AppShell owns none of the screen
 * content itself.
 *
 * NOT TabBar. TabBar (see TabBar.tsx) owns real PTY terminal-session tabs
 * and stays scoped entirely inside the "terminal" screen — it must never be
 * repurposed for app-level screen switching. NAV_ITEMS below is the single
 * source of truth for primary navigation between screens; TabBar's own tab
 * strip is a separate, lower-level concept (one tab == one real terminal
 * session) that only exists once you're already on the "terminal" screen.
 *
 * NAV IDS (exact, used everywhere a screen is looked up — see page.tsx's
 * SCREENS map): 'dashboard' | 'terminal' | 'agents' | 'projects' | 'music' |
 * 'pet' | 'settings'.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import {
  BarChart3,
  Bot,
  Database,
  FlaskConical,
  FolderKanban,
  GraduationCap,
  Home,
  LayoutDashboard,
  Music,
  PawPrint,
  Plus,
  Settings,
  Smile,
  Terminal,
} from 'lucide-react';
import Flubber3D from './Flubber3D';
import AgentAvatar from './AgentAvatar';
import PersistentTerminalHost from './PersistentTerminalHost';
import { humanizeSlug } from '../lib/humanize';
import { SessionProvider, useSession } from '../context/SessionProvider';
import { subscribeNarration, type NarrationMessage } from '../lib/flubber3d/narration';
import { wsClient } from '../lib/ws-client';
import './AppShell.css';
import '../styles/pill-room.css';

export type NavId =
  | 'dashboard'
  | 'terminal'
  | 'agents'
  | 'projects'
  | 'memory'
  | 'analytics'
  | 'music'
  | 'pet'
  | 'academy'
  | 'settings';

interface NavItemConfig {
  id: NavId;
  label: string;
  icon: typeof LayoutDashboard;
}

// Nav keeps everything: the reference's Memory + Analytics are ADDED, and the
// app's own Music Player + Virtual Pet are KEPT (flubber-3d-everywhere Phase 6
// nav decision — nothing built gets deleted).
const NAV_ITEMS: NavItemConfig[] = [
  { id: 'dashboard', label: 'Dashboard', icon: Home },
  { id: 'terminal', label: 'Terminal', icon: Terminal },
  { id: 'agents', label: 'Agents', icon: Bot },
  { id: 'projects', label: 'Projects', icon: FolderKanban },
  { id: 'memory', label: 'Memory', icon: Database },
  { id: 'analytics', label: 'Analytics', icon: BarChart3 },
  { id: 'music', label: 'Music Player', icon: Music },
  { id: 'pet', label: 'Virtual Pet', icon: PawPrint },
  { id: 'academy', label: 'Academy', icon: GraduationCap },
  { id: 'settings', label: 'Settings', icon: Settings },
];

// Data screens with no hero backdrop of their own get a dim cinematic "room"
// wallpaper behind the whole content frame (see AppShell.css .blubber-shell__room).
// The other screens (dashboard/terminal/agents/music/pet) render their own room
// via FlubberHome or a screen-scoped plate, so they're intentionally absent here.
const ROOM_BY_NAV: Partial<Record<NavId, string>> = {
  projects: 'projects',
  memory: 'memory',
  analytics: 'analytics',
  academy: 'engine',
  settings: 'engine',
};

const TIPS = [
  'Pro tip: the more you bounce, the more I compute.',
  'Delegate, parallelize, dominate.',
  'Break big projects into smaller chunks — I’ll handle the rest.',
  'Every open tab is a real session. Close what you’re not using.',
  'Real events make me squash and rebound harder each time.',
];

const QUOTES = [
  '“Energy is neither created nor destroyed, it just gets flubberized.” — Prof. Brainard',
  '“The best code, like flubber, always bounces back.” — Prof. Brainard',
  '“Never underestimate a substance that wants to help you build.” — Prof. Brainard',
];

interface RosterAgent {
  name: string;
  description: string;
  file: string;
}

// ---- /api/projects + /api/tracks response shapes --------------------------
// Match the real routes exactly (see src/app/api/projects/route.ts and
// src/app/api/tracks/route.ts) -- same contract TabBar.tsx and
// MusicPlayer.tsx already consume independently. Fetched here too (rather
// than lifted/threaded from those components) so the sidebar's "Recent"
// module can go context-aware per screen without a cross-screen store —
// same lightweight "every component fetches its own real data" pattern this
// codebase already uses everywhere (WeeklyRecap + TerminalScreen both fetch
// /api/weekly independently, for example).
interface ApiProjectRoot {
  label: string;
  root: string;
  projects: string[];
}

interface ApiTrack {
  id: string;
  title: string;
  file: string;
}

/** One row in the sidebar's context-aware "Recent" list -- same shape regardless of source. */
interface RecentEntry {
  key: string;
  label: string;
}

type RecentKind = 'agents' | 'projects' | 'tracks';

function recentKindFor(navId: NavId): RecentKind {
  if (navId === 'projects') return 'projects';
  if (navId === 'music') return 'tracks';
  return 'agents';
}

function useRotating<T>(items: readonly T[], intervalMs: number): T {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (items.length <= 1) return;
    const id = setInterval(() => setIndex((i) => (i + 1) % items.length), intervalMs);
    return () => clearInterval(id);
  }, [items.length, intervalMs]);
  return items[index % items.length];
}

// Real uptime now comes from SessionProvider (src/context/SessionProvider.tsx)
// instead of a second, independent clock started here — one real "session
// started at" timestamp for the whole app, not two clocks that can drift.

// How long a narration toast stays up before the queue advances to the next
// one (or clears). The queue is a pure pass-through of the shared narration bus
// (see useNarrationQueue) — every message on it comes from a REAL event
// (SessionProvider's session-start / token-milestone / reset lines, or
// FlubberBrain's real terminal reactions). There is no ambient/timer producer
// feeding it (LANE G / LAW 1 removed the old ambient narration at the source).
const NARRATION_DISPLAY_MS = 6000;

/**
 * useNarrationQueue — subscribes to the shared narration bus (see
 * flubber3d/narration.ts) and serializes it into "one message visible at a
 * time", auto-advancing every NARRATION_DISPLAY_MS. Framework-free producers
 * (SessionProvider, FlubberBrainProvider, etc.) can narrate from anywhere;
 * this is the one place that turns that stream into toast UI state.
 */
function useNarrationQueue(): NarrationMessage | null {
  const [current, setCurrent] = useState<NarrationMessage | null>(null);
  const queueRef = useRef<NarrationMessage[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const advance = useCallback(() => {
    const next = queueRef.current.shift() ?? null;
    setCurrent(next);
    timerRef.current = next ? setTimeout(advance, NARRATION_DISPLAY_MS) : null;
  }, []);

  useEffect(() => {
    const unsubscribe = subscribeNarration((msg) => {
      queueRef.current.push(msg);
      if (!timerRef.current) advance();
    });
    return () => {
      unsubscribe();
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [advance]);

  return current;
}

// AppShell.css is owned by another lane, not this one -- everything below is
// styled inline (or via the one scoped <style> tag in ShellChrome for the
// keyframe/reduced-motion rules inline styles can't express) instead of
// adding classes to a stylesheet this lane doesn't own. Colors/spacing still
// reference the same design-system CSS custom properties AppShell.css uses
// everywhere else, so nothing here introduces a new palette.

// Only the keyframe + reduced-motion rule (inline `style` objects can't
// express either) — everything else about the bubble is inline below.
const NARRATION_KEYFRAMES_CSS = `
@keyframes blubber-narration-in {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}
@media (prefers-reduced-motion: reduce) {
  .blubber-shell__narration-bubble { animation: none !important; opacity: 1 !important; }
}
`;

function narrationMoodStyle(mood: NarrationMessage['mood']): CSSProperties {
  if (mood === 'hype') return { borderColor: 'oklch(87% 0.29 142 / 55%)', boxShadow: 'var(--glow-shadow)' };
  if (mood === 'focused') return { borderColor: 'oklch(70% 0 0 / 30%)' };
  return {};
}

/** Global narration toast — one at a time, tinted by mood, auto-dismissing.
 * Sits above every screen (mounted in the SessionProvider subtree) so a line
 * narrated while the user is on Dashboard/Projects/etc. is never missed just
 * because Terminal's own local speech bubble isn't on screen right now. */
function NarrationToast() {
  const message = useNarrationQueue();
  if (!message) return null;
  return (
    <div
      aria-live="polite"
      style={{
        position: 'absolute',
        left: '1.5rem',
        bottom: '4.75rem',
        zIndex: 40,
        maxWidth: 'min(26rem, calc(100% - 3rem))',
        pointerEvents: 'none',
      }}
    >
      <div
        key={message.ts}
        className="blubber-shell__narration-bubble"
        style={{
          pointerEvents: 'auto',
          padding: '0.6rem 0.9rem',
          background: 'oklch(16% 0.03 155 / 92%)',
          border: '1px solid var(--border-glow)',
          borderRadius: 14,
          color: 'var(--text-primary)',
          fontFamily: 'var(--font-ui)',
          fontSize: '0.8rem',
          lineHeight: 1.4,
          boxShadow: '0 12px 28px oklch(0% 0 0 / 45%)',
          animation: 'blubber-narration-in 220ms ease-out',
          ...narrationMoodStyle(message.mood),
        }}
      >
        {message.text}
      </div>
    </div>
  );
}

// How long a session's activity-pulse dot stays lit after its last real
// output chunk arrived — long enough to notice a background tab just did
// something, short enough that it reads as "recent", not "stuck on".
const RECENT_OUTPUT_HOLD_MS = 4000;

/** Real cross-session activity tracker: taps EVERY server message via
 * wsClient.subscribeAll (the same global-tap mechanism the terminal-watcher
 * uses) rather than per-session subscriptions, so it works for tabs that
 * aren't the active one too. Returns the set of session ids that produced
 * real output within the last RECENT_OUTPUT_HOLD_MS. */
function useRecentOutputActivity(sessionIds: readonly string[]): Set<string> {
  const [lastOutputAt, setLastOutputAt] = useState<Record<string, number>>({});

  useEffect(() => {
    const unsubscribe = wsClient.subscribeAll((message) => {
      if (message.type !== 'output') return;
      setLastOutputAt((prev) => ({ ...prev, [message.sessionId]: Date.now() }));
    });
    return unsubscribe;
  }, []);

  // Re-render on a slow tick so a pulse actually clears once it goes stale —
  // subscribeAll only fires on new output, never on "time has passed".
  const [, forceTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const now = Date.now();
  const active = new Set<string>();
  for (const id of sessionIds) {
    const ts = lastOutputAt[id];
    if (ts !== undefined && now - ts < RECENT_OUTPUT_HOLD_MS) active.add(id);
  }
  return active;
}

// Only the keyframe (inline `style` objects can't express it) — everything
// else about the pill row is inline below, same convention as the narration
// bubble's own local <style> tag (see NARRATION_KEYFRAMES_CSS above).
const SESSION_PILL_KEYFRAMES_CSS = `
@keyframes blubber-session-pill-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.35; transform: scale(0.7); }
}
@media (prefers-reduced-motion: reduce) {
  .blubber-shell__session-pill-pulse { animation: none !important; }
}
`;

/** Compact real-session switcher for the topbar — only renders once 2+ real
 * terminal tabs are open (see SessionProvider's `sessions` mirror). Clicking
 * a background pill really switches TabBar's active tab via
 * SessionProvider's `setActiveTab`. */
function SessionPills() {
  const { sessions, activeSessionId, setActiveTab } = useSession();
  const sessionIds = useMemo(() => sessions.map((s) => s.id), [sessions]);
  const recentActivity = useRecentOutputActivity(sessionIds);

  if (sessions.length < 2) return null;

  return (
    <div
      role="tablist"
      aria-label="Open terminal sessions"
      style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', overflowX: 'auto' }}
    >
      <style>{SESSION_PILL_KEYFRAMES_CSS}</style>
      {sessions.map((session) => {
        const isActive = session.id === activeSessionId;
        return (
          <button
            key={session.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => setActiveTab(session.id)}
            title={session.cwd}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.35rem',
              flexShrink: 0,
              padding: '0.3rem 0.65rem',
              border: `1px solid ${isActive ? 'var(--core-accent-bright)' : 'var(--border-glow)'}`,
              borderRadius: 999,
              background: isActive ? 'oklch(74% 0.2 151 / 16%)' : 'var(--bg-surface)',
              color: isActive ? 'var(--core-accent-bright)' : 'var(--text-secondary)',
              fontFamily: 'var(--font-mono)',
              fontSize: '0.68rem',
              opacity: session.exited ? 0.5 : 1,
              cursor: 'pointer',
              transition: 'border-color 150ms ease-out, color 150ms ease-out',
              whiteSpace: 'nowrap',
            }}
          >
            {!isActive && recentActivity.has(session.id) && (
              <span
                className="blubber-shell__session-pill-pulse"
                aria-hidden="true"
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: 'var(--core-accent-bright)',
                  boxShadow: '0 0 6px var(--core-accent-bright)',
                  animation: 'blubber-session-pill-pulse 1.1s ease-in-out infinite',
                }}
              />
            )}
            {session.title}
          </button>
        );
      })}
    </div>
  );
}

interface ShellChromeProps {
  quote: string;
  statusLabel: string;
  statusOk: boolean;
  /** Active screen id — threaded down so the persistent terminal host (mounted
   * here, inside the SessionProvider subtree) knows when to show/hide itself. */
  activeNavId: NavId;
  children: ReactNode;
}

/** Everything inside the SessionProvider subtree: topbar, main content slot,
 * and footer. Split out from AppShell itself only because a component can't
 * consume a context it renders the Provider for — this one sits below it. */
function ShellChrome({ quote, statusLabel, statusOk, activeNavId, children }: ShellChromeProps) {
  const session = useSession();
  return (
    <>
      {/* Only the keyframe / reduced-motion rule the narration bubble needs
          -- AppShell.css belongs to another lane, so this stays local to
          this component instead of adding a class there. */}
      <style>{NARRATION_KEYFRAMES_CSS}</style>
      {/* Item 3 — the two dead pills (live-usage chip + "Operator · Local session"
          user chip) are gone; they did nothing and just added scroll. What's
          left is the FUNCTIONAL session switcher (SessionPills, 2+ terminals).
          On the DASHBOARD the whole topbar is suppressed so the screen shifts
          up — the dashboard has its own live LiveUsageMeter. Other screens keep
          the switcher only when it actually has tabs to switch. An empty
          <header> still eats height, so it's not rendered at all otherwise. */}
      {activeNavId !== 'dashboard' && session.sessions.length >= 2 && (
        <header className="blubber-shell__topbar" style={{ justifyContent: 'flex-start' }}>
          <SessionPills />
        </header>
      )}

      <main className="blubber-shell__content">
        {/* The real terminal lives here, mounted once and kept alive across nav
            switches (LANE P). It's absolutely positioned to fill this content
            area and only VISIBLE on the terminal nav; every other screen renders
            in the normal flow below it. `children` is `null` for the terminal
            nav (see page.tsx's SCREENS map) so the two never both show.
            PersistentTerminalHost now WRAPS children (rather than sitting as a
            sibling before them) so a descendant of children — the Dashboard's
            Terminal-tab tile — can reach its anchor-portal context and pull the
            same live terminal into its own tile rect (PILL WORLDS + MINI DASH,
            Lane 2 — see PersistentTerminalHost.tsx's file header). */}
        <PersistentTerminalHost activeNavId={activeNavId}>{children}</PersistentTerminalHost>
      </main>

      <footer className="blubber-shell__footer">
        <span className="blubber-shell__footer-version">
          <FlaskConical size={13} aria-hidden="true" />
          Blubber OS v1.0.0
        </span>
        <span className="blubber-shell__footer-quote">{quote}</span>
        <span className="blubber-shell__footer-status">
          <span className="blubber-shell__uptime">Uptime: {session.uptime}</span>
          <span className={`blubber-shell__status-pill${statusOk ? '' : ' blubber-shell__status-pill--warn'}`}>
            <Smile size={13} aria-hidden="true" className="blubber-shell__status-smile" />
            {statusLabel}
          </span>
        </span>
      </footer>

      <NarrationToast />
    </>
  );
}

export interface AppShellProps {
  /** Which screen is currently active — drives the highlighted sidebar item. */
  activeNavId: NavId;
  /** Fired when the user picks a sidebar nav item (or a "browse agents" shortcut). */
  onNavChange: (id: NavId) => void;
  /** The active screen's content, rendered in the main content area. */
  children: ReactNode;
  /** Footer status pill. Defaults to a static "All Good" — pass real connection
   *  state (e.g. useLiveUsage's `connected`) once a screen threads it through. */
  statusLabel?: string;
  statusOk?: boolean;
  className?: string;
}

export default function AppShell({
  activeNavId,
  onNavChange,
  children,
  statusLabel = 'All Good',
  statusOk = true,
  className,
}: AppShellProps) {
  const [agents, setAgents] = useState<RosterAgent[]>([]);
  const [agentsLoading, setAgentsLoading] = useState(true);
  const [agentsError, setAgentsError] = useState<string | null>(null);

  const [projectRoots, setProjectRoots] = useState<ApiProjectRoot[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [projectsError, setProjectsError] = useState<string | null>(null);

  const [tracks, setTracks] = useState<ApiTrack[]>([]);
  const [tracksLoading, setTracksLoading] = useState(true);
  const [tracksError, setTracksError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/agents')
      .then((res) => {
        if (!res.ok) throw new Error(`agents fetch failed: ${res.status}`);
        return res.json() as Promise<{ agents: RosterAgent[] }>;
      })
      .then((data) => {
        if (cancelled) return;
        const list = Array.isArray(data?.agents) ? data.agents : [];
        setAgents(list.slice(0, 5));
      })
      .catch((err: unknown) => {
        if (!cancelled) setAgentsError(err instanceof Error ? err.message : 'Failed to load agents');
      })
      .finally(() => {
        if (!cancelled) setAgentsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Sidebar goes context-aware on the "projects" and "music" screens (see
  // recentKindFor below) — both /api/projects and /api/tracks are cheap
  // local reads, so both are fetched once up front rather than lazily on
  // first switch, keeping the swap between screens instant with no flicker.
  useEffect(() => {
    let cancelled = false;
    fetch('/api/projects')
      .then((res) => {
        if (!res.ok) throw new Error(`projects fetch failed: ${res.status}`);
        return res.json() as Promise<{ roots: ApiProjectRoot[] }>;
      })
      .then((data) => {
        if (cancelled) return;
        setProjectRoots(Array.isArray(data?.roots) ? data.roots : []);
      })
      .catch((err: unknown) => {
        if (!cancelled) setProjectsError(err instanceof Error ? err.message : 'Failed to load projects');
      })
      .finally(() => {
        if (!cancelled) setProjectsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/tracks')
      .then((res) => {
        if (!res.ok) throw new Error(`tracks fetch failed: ${res.status}`);
        return res.json() as Promise<{ tracks: ApiTrack[] }>;
      })
      .then((data) => {
        if (cancelled) return;
        setTracks(Array.isArray(data?.tracks) ? data.tracks : []);
      })
      .catch((err: unknown) => {
        if (!cancelled) setTracksError(err instanceof Error ? err.message : 'Failed to load tracks');
      })
      .finally(() => {
        if (!cancelled) setTracksLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const recentKind = recentKindFor(activeNavId);

  const recentEntries: RecentEntry[] = useMemo(() => {
    if (recentKind === 'projects') {
      const flattened: RecentEntry[] = [];
      for (const root of projectRoots) {
        for (const name of root.projects) {
          flattened.push({ key: `${root.label}/${name}`, label: name });
        }
      }
      return flattened.slice(0, 5);
    }
    if (recentKind === 'tracks') {
      return tracks.slice(0, 5).map((t) => ({ key: t.id, label: t.title }));
    }
    return agents.slice(0, 5).map((a) => ({ key: a.file, label: humanizeSlug(a.name) }));
  }, [recentKind, projectRoots, tracks, agents]);

  const recentLoading =
    recentKind === 'projects' ? projectsLoading : recentKind === 'tracks' ? tracksLoading : agentsLoading;
  const recentError = recentKind === 'projects' ? projectsError : recentKind === 'tracks' ? tracksError : agentsError;
  const recentHeading =
    recentKind === 'projects' ? 'Recent Projects' : recentKind === 'tracks' ? 'Recent Tracks' : 'Recent Agents';
  const recentEmptyLabel =
    recentKind === 'projects' ? 'No project folders found.' : recentKind === 'tracks' ? 'No tracks found.' : 'No agents found.';
  const recentTargetNavId: NavId = recentKind === 'projects' ? 'projects' : recentKind === 'tracks' ? 'music' : 'agents';

  const roomSlug = ROOM_BY_NAV[activeNavId];

  const tip = useRotating(TIPS, 10000);
  const quote = useRotating(QUOTES, 14000);

  // Settings > Notifications > "Blubber Tips" controls whether the rotating
  // tip card renders at all. Seeded from the same persisted /api/prefs blob
  // SettingsScreen writes, then kept live via the 'blubber:tips-pref'
  // CustomEvent SettingsScreen dispatches on toggle (no shared store needed
  // for one boolean). Defaults to visible, matching prefs-store's DEFAULTS.
  const [tipsEnabled, setTipsEnabled] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/prefs')
      .then((res) => (res.ok ? (res.json() as Promise<{ prefs?: { notifyBlubberTips?: boolean } }>) : null))
      .then((data) => {
        if (!cancelled && typeof data?.prefs?.notifyBlubberTips === 'boolean') {
          setTipsEnabled(data.prefs.notifyBlubberTips);
        }
      })
      .catch(() => {
        // Pref fetch failing just leaves the card visible (the default).
      });
    const onTipsPref = (e: Event) => {
      const detail = (e as CustomEvent<{ enabled?: boolean }>).detail;
      if (typeof detail?.enabled === 'boolean') setTipsEnabled(detail.enabled);
    };
    window.addEventListener('blubber:tips-pref', onTipsPref);
    return () => {
      cancelled = true;
      window.removeEventListener('blubber:tips-pref', onTipsPref);
    };
  }, []);

  return (
    <div className={['blubber-shell', className].filter(Boolean).join(' ')}>
      <aside className="blubber-shell__sidebar">
        <div className="blubber-shell__brand">
          {/* eslint-disable-next-line @next/next/no-img-element -- static /public asset, no next/image usage elsewhere in this app */}
          <img
            className="blubber-shell__brand-logo"
            src="/brand/flubber-wordmark.webp"
            alt="BLUBBER — Claude OS"
            width={178}
            height={60}
          />
        </div>

        <nav className="blubber-shell__nav" aria-label="Primary">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const isActive = item.id === activeNavId;
            return (
              <button
                key={item.id}
                type="button"
                data-nav-id={item.id}
                className={`blubber-shell__nav-item${isActive ? ' blubber-shell__nav-item--active' : ''}`}
                onClick={() => onNavChange(item.id)}
                aria-current={isActive ? 'page' : undefined}
              >
                <Icon size={17} aria-hidden="true" />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="blubber-shell__recent">
          <div className="blubber-shell__recent-header">
            <span className="section-label">{recentHeading}</span>
            <button
              type="button"
              className="blubber-shell__recent-add"
              onClick={() => onNavChange(recentTargetNavId)}
              aria-label={`Browse all ${recentHeading.toLowerCase()}`}
              title={`Browse all ${recentHeading.toLowerCase()}`}
            >
              <Plus size={12} aria-hidden="true" />
            </button>
          </div>

          <ul className="blubber-shell__recent-list">
            {recentLoading && <li className="blubber-shell__recent-status">Loading…</li>}
            {!recentLoading && recentError && <li className="blubber-shell__recent-status">{recentError}</li>}
            {!recentLoading && !recentError && recentEntries.length === 0 && (
              <li className="blubber-shell__recent-status">{recentEmptyLabel}</li>
            )}
            {!recentLoading &&
              !recentError &&
              recentEntries.map((entry) => (
                <li key={entry.key}>
                  <button
                    type="button"
                    className="blubber-shell__recent-item"
                    onClick={() => onNavChange(recentTargetNavId)}
                    title={entry.label}
                  >
                    {recentKind === 'agents' ? (
                      // tier="mid" forces the glossy clearcoat-goo material at
                      // this sidebar size — without it, ≤56px auto-flattens to the
                      // flat micro look (see Flubber3D's size→tier logic). The
                      // shared host caps MID bodies and overflows to micro past
                      // budget, so ~5 recent slots stay safe.
                      <AgentAvatar name={entry.label} size={30} tier="mid" className="blubber-shell__recent-flubber" />
                    ) : (
                      <span className="blubber-shell__recent-avatar" aria-hidden="true">
                        {entry.label.charAt(0).toUpperCase()}
                      </span>
                    )}
                    <span className="blubber-shell__recent-name">{entry.label}</span>
                  </button>
                </li>
              ))}
          </ul>

          <button type="button" className="blubber-shell__view-all" onClick={() => onNavChange(recentTargetNavId)}>
            View All {recentHeading.replace(/^Recent /, '')} →
          </button>
        </div>

        {tipsEnabled && (
          <div className="blubber-shell__tip">
            {/* Glossy MID 3D flubber (was the flat FlubberCharacter — which is
                FROZEN and only stays imported for the topbar user chip). tier="mid"
                keeps the shiny clearcoat-goo material at this 44px size instead of
                auto-flattening to micro. */}
            <Flubber3D expression="happy" size={44} tier="mid" className="blubber-shell__tip-flubber" />
            <div className="blubber-shell__tip-copy">
              <span className="blubber-shell__tip-label">Blubber Tip</span>
              <p>{tip}</p>
            </div>
          </div>
        )}
      </aside>

      <div className="blubber-shell__main">
        {roomSlug && (
          <div className={`blubber-shell__room blubber-shell__room--${roomSlug}`} aria-hidden="true" />
        )}
        {/* SessionProvider mounts here — ABOVE page.tsx's per-nav screen swap
            (children below is whichever screen is active). Because this div
            never unmounts while the app is open, everything the provider
            owns (uptime, system vitals + sparklines, the terminal log
            buffer, the live-usage SSE subscription) keeps running across nav
            switches instead of restarting from zero every time. See
            src/context/SessionProvider.tsx for the full contract. */}
        <SessionProvider onRequestTerminalNav={() => onNavChange('terminal')}>
          <ShellChrome quote={quote} statusLabel={statusLabel} statusOk={statusOk} activeNavId={activeNavId}>
            {children}
          </ShellChrome>
        </SessionProvider>
      </div>
    </div>
  );
}
