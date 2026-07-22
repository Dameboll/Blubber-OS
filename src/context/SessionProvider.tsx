'use client';

/**
 * SessionProvider — the persistent "dashboard session" that survives nav
 * switches. Mounted once in AppShell, ABOVE the `{children}` slot where
 * page.tsx swaps screens in and out (see AppShell.tsx). Because AppShell
 * itself never unmounts while the app is open, everything owned here keeps
 * running and accumulating real data even while the user is looking at some
 * other screen — unlike state that lived inside TerminalScreen itself, which
 * was torn down and rebuilt from zero every time that screen unmounted.
 *
 * Owns (see docs/plans/flubber-3d-everywhere.md persistence lane):
 *   - sessionStartTs + a formatted uptime string, ticked once/second
 *   - real system vitals (GET /api/system: CPU/MEM/PROC) + their trailing
 *     sparkline sample windows — was TerminalScreen's own useSystemVitals
 *   - the live PTY output log buffer + the wsClient subscription driving it
 *   - the live-usage SSE subscription (useLiveUsage), so it reconnects once
 *     per app session instead of once per Terminal-screen mount
 *
 * Log-buffer honesty note: the *list* of open terminal tabs still lives in
 * TabBar's own local state (out of this lane's ownership), which does reset
 * when TerminalScreen unmounts and remounts — there is no real PTY tab to
 * resume streaming from the moment you navigate back. What this provider
 * guarantees instead: the buffer of lines already shown is never wiped out
 * from under you just because the Terminal screen itself remounted. It only
 * clears when a genuinely new, different real session starts sending output
 * (see the activeTabId effect below) — never on a transient drop to null.
 *
 * Narration: this provider is also a narration PRODUCER (not just a data
 * source) for three real, verifiable events tied to the live-usage stream —
 * session start (once the first real SSE snapshot lands), each 100k-token
 * crossing for today, and a detected master reset (today's total dropping
 * back to zero after being nonzero). All three use the SAME real numbers
 * already flowing through `liveUsage` below; nothing here is invented.
 *
 * WORK/BREAK CLOCK (LANE W, docs/plans/idle-life-and-wiring.md — LAW 1): this
 * provider also derives one app-wide, LATCHED + DEBOUNCED work mode, exposed as
 * `isWorking`. It is TRUE the instant ANY real task signal fires and only flips
 * back to false once every signal has been quiet for WORK_DEBOUNCE_MS. The
 * signals are all real, already-flowing state — nothing polled just to fake a
 * mode:
 *   - live token stream — a real increase in `liveUsage.totalToday` (the first
 *     post-connect snapshot is skipped, same as useLiveThroughput, so the day's
 *     accumulated total landing on connect never reads as "work happening now").
 *   - active PTY command — any real `output` message on the shared wsClient
 *     (tapped via subscribeAll, the same global tap AppShell's activity dots
 *     use), i.e. a command is actively producing output.
 *   - spawned agents — a fresh GET /api/spawned roster, but CORROBORATED: the
 *     store carries no per-agent active/done flag (see spawned-store.ts), so
 *     presence alone would let a finished-but-uncleared agent pin the clock
 *     forever. A roster entry therefore only counts toward WORKING when paired
 *     with RECENT real evidence — a live token delta (~90s) or real PTY output
 *     (~120s). Result: a stale finished agent no longer pins the clock; the
 *     roster still shows in the Agents pool regardless.
 * `isWorking` is the ONE formal gate the work surfaces (Dashboard/Terminal/
 * Agents) read to halt goofing and show work behavior. Virtual Pet and Music
 * deliberately ignore it. FlubberBrain's momentary 1800ms reactions are a
 * separate, non-latched thing — this is the sustained latch on top of them.
 *
 * SESSION CONTRACT (docs/plans/flubber-3d-everywhere.md "terminal-sessions"
 * lane): this provider is also the single real mirror of "what terminal tabs
 * are open right now" for the whole app, exposed as `sessions` +
 * `activeSessionId`, so a consumer on ANY screen (session pills in AppShell,
 * the Projects screen's "Open Project" button) can read/drive terminal state
 * without importing TabBar directly.
 *
 * Ownership split (important, read before wiring a new consumer):
 *   - TabBar (src/components/TabBar.tsx, owned by another lane) remains the
 *     ONE real owner of the open-tab list and of spawning/closing PTY
 *     sessions -- this provider does not duplicate that state, it MIRRORS it.
 *     TerminalScreen (which does own TabBar's mount point) calls
 *     `syncSessions(tabs, activeId)` on every `TabBar.onTabsChange` firing
 *     and `registerTabControl(handle)` once TabBar's ref is available, so
 *     this provider always reflects the real tab list and can really drive
 *     `setActiveTab` through TabBar's existing `activateTab` imperative
 *     handle.
 *   - `openTab` / `openProjectInTab` REALLY spawn tabs: TabBar's imperative
 *     handle now exposes its own internal `openTab`/`closeTab`, so when the
 *     Terminal screen is mounted the spawn happens instantly through the same
 *     code path the "+ New" popover uses. When it isn't mounted, the spawn is
 *     queued in `pendingSpawnRef`, the app navigates to the Terminal screen,
 *     and `registerTabControl` fires the queued spawn the moment TabBar's
 *     handle registers — one click, zero dialogs, no phantom PTYs.
 *   - `closeTab` IS real: it kills the actual PTY via the shared `wsClient`
 *     singleton (server-side kill is keyed by sessionId, not by which UI
 *     issued it) and marks the mirrored session exited immediately. TabBar's
 *     own tab strip picks up the same exit through its normal
 *     TerminalPane-onExit path, so the tab shows "exited" rather than
 *     vanishing -- accurate, not fabricated.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useLiveUsage, type LiveUsageState } from '../hooks/useLiveUsage';
import { wsClient, type ResumeSpec } from '../lib/ws-client';
import { classifyOutput, stripAnsi } from '../lib/terminal-signals';
import { narrate } from '../lib/flubber3d/narration';
import { DEV_ROOT } from '../lib/dev-root';
import { formatClockTime } from '../lib/time-format';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LogLine {
  id: string;
  text: string;
  timestamp: string;
  /** true = matched the success vocabulary, false = neutral or matched error. */
  success: boolean;
}

/** One real event worth reacting to visually, surfaced as a bump so a
 * consumer's useEffect can fire a one-shot reaction without re-deriving it
 * from the raw log lines itself. `id` increments on every event so the same
 * `kind` firing twice in a row is still detected as a change. */
export interface LogReactionEvent {
  id: number;
  kind: 'success' | 'error' | 'exit-nonzero';
}

export interface SystemVitals {
  cpu: number;
  mem: number;
  proc: number;
}
type VitalKey = keyof SystemVitals;
export type VitalTrend = 'up' | 'down' | 'neutral';

export interface VitalsState {
  /** null until the first successful /api/system poll. */
  values: SystemVitals | null;
  trend: Record<VitalKey, VitalTrend>;
  /** Last SPARKLINE_LENGTH real samples per metric, oldest first. */
  history: Record<VitalKey, number[]>;
  error: boolean;
}

/** One real open terminal tab, mirrored from TabBar's own tab list (see file
 * header "SESSION CONTRACT"). `projectRoot`/`projectName` are derived from
 * the tab's real `cwd` when it falls under one of the four known
 * Development root folders -- null otherwise (e.g. the default fallback
 * cwd), never guessed. */
export interface SessionTab {
  id: string;
  cwd: string;
  title: string;
  projectRoot: string | null;
  projectName: string | null;
  exited: boolean;
}

/** Minimal shape this provider needs from TabBar's real tab list to build
 * `sessions` -- matches TabBar's own exported `TabSummary`, duplicated here
 * (rather than imported) so this context has zero compile-time dependency
 * on a component file owned by another lane. */
export interface SyncableTab {
  id: string;
  title: string;
  cwd: string;
  exited: boolean;
}

/** What TerminalScreen registers once TabBar's imperative handle is mounted,
 * so `setActiveTab` can really drive TabBar's active tab from anywhere in
 * the app (session pills, etc). Null while the Terminal screen isn't
 * mounted -- `setActiveTab` is a safe no-op in that case. */
export interface TabControlHandle {
  activateTab: (id: string) => void;
  /** Spawn a real PTY tab through TabBar's own openTab. Returns the new tab
   * id, or null if TabBar is momentarily unavailable. */
  openTab: (title: string, cwd: string, initialPrompt?: string, resume?: ResumeSpec) => string | null;
  /** Kill + drop a tab through TabBar's own closeTab. */
  closeTab: (id: string) => void;
}

export interface SessionState {
  sessionStartTs: number;
  /** "Xh YYm" — real elapsed time since this provider mounted. */
  uptime: string;
  vitals: VitalsState;
  logLines: LogLine[];
  activeTabId: string | null;
  logEvent: LogReactionEvent | null;
  liveUsage: LiveUsageState;
  /** WORK/BREAK CLOCK (LAW 1, see file header). True while a REAL task is
   * running — a live token stream, an active PTY command, or any spawned agent
   * in the roster — latched and debounced so it stays true for the whole task
   * and only flips back to false ~WORK_DEBOUNCE_MS after everything goes quiet.
   * The ONE gate the work surfaces (Dashboard/Terminal/Agents) read to stop
   * goofing and show work behavior. Virtual Pet + Music ignore it entirely. */
  isWorking: boolean;
  /** Debug-only: WHY the work clock is currently on (or 'break'). One of
   * 'live-tokens' | 'pty-output' | 'spawned+evidence' | 'break'. Not for UI
   * copy — a diagnostic read so it's clear which real signal latched the clock. */
  workReason: string;
  /** Tell the provider which PTY tab is currently active so it can drive the
   * log subscription. Call from TerminalScreen's own tab-change handler. */
  setActiveTabId: (id: string | null) => void;
  /** Explicit user action ("Clear" button) — always allowed to wipe the buffer. */
  clearLog: () => void;

  // -- Session contract (see file header) --------------------------------
  /** Real mirror of every open terminal tab, app-wide, surviving nav switches. */
  sessions: SessionTab[];
  /** Same tab identity as `activeTabId` above, exposed under the contract's
   * name for consumers outside the Terminal screen. */
  activeSessionId: string | null;
  /** TerminalScreen calls this on every real TabBar.onTabsChange firing. */
  syncSessions: (tabs: SyncableTab[], activeId: string | null) => void;
  /** TerminalScreen registers/unregisters TabBar's imperative handle here so
   * `setActiveTab` below can really drive it from anywhere in the app. */
  registerTabControl: (handle: TabControlHandle | null) => void;
  /** Ask the app to make `id` the active terminal tab. Real when the
   * Terminal screen is mounted (proxies to TabBar's `activateTab`); a safe
   * no-op otherwise. */
  setActiveTab: (id: string) => void;
  /** Really spawns a fresh PTY tab (at the Development root) and switches to
   * the Terminal screen — instant when TabBar is mounted, queued-then-spawned
   * on mount otherwise. */
  openTab: () => void;
  /** Really spawns a PTY tab cd'd into the project and switches to the
   * Terminal screen. One click, zero dialogs — see file header. */
  openProjectInTab: (root: string, name: string) => void;
  /** Really spawns a PTY tab at an explicit cwd with an optional initial
   * scaffold prompt and/or resume directive, then switches to Terminal. Powers
   * the Agent Synthesizer and the dashboard resume-session offer. */
  openTabWith: (opts: { title: string; cwd: string; initialPrompt?: string; resume?: ResumeSpec }) => void;
  /** Really kills the PTY behind `id` via the shared wsClient singleton and
   * marks the mirrored session exited immediately. */
  closeTab: (id: string) => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_LOG_LINES = 80;
const SPARKLINE_LENGTH = 20;
const SYSTEM_POLL_MS = 2500;
const TOKEN_MILESTONE = 100_000;

// WORK/BREAK CLOCK (LAW 1). How long every signal must stay quiet before the
// latch flips from WORKING back to BREAK. Was 4s, which was SHORTER than the
// normal think-gap between two token bursts while the model reasons — so the
// latch flipped WORKING→BREAK ("STANDING BY") in every pause and back on the
// next burst = the workstation flicker. 15s comfortably spans a think-gap while
// still resuming break promptly once work genuinely stops (well under the 90s
// idle guarantee). See Signal 2's token-corroboration widening below.
const WORK_DEBOUNCE_MS = 15000;
// How often the spawned-agent roster (a held work signal) is re-polled.
const SPAWNED_POLL_MS = 4000;
// The debounce checker's cadence — flips the latch to BREAK once quiet.
const WORK_TICK_MS = 1000;
// Signal 2 window: a PTY output chunk only counts as work if a real keystroke
// went out on that socket within this long ago. Wide enough to cover a
// command's full output burst after the last keypress, narrow enough that an
// idle REPL's own repaints (no one typing) age out and stop pinning the clock.
const RECENT_INPUT_WINDOW_MS = 15000;
// Signal 3: a spawned-roster entry older than this no longer holds the clock.
// The store has no active/done flag (see spawned-store.ts), so age is the only
// honest way to stop an abandoned entry from pinning WORKING forever; it still
// shows in the Agents pool UI, this only affects whether it counts toward the
// clock.
const SPAWNED_STALE_MS = 30 * 60 * 1000;
// Signal 3 corroboration (LANE G): a spawned roster (a HELD signal with no
// active/done flag) is not proof of live work on its own — a finished-but-
// uncleared agent would otherwise pin the clock. So a roster entry only counts
// toward WORKING when paired with RECENT real evidence: a live token delta
// within TOKEN_EVIDENCE_MS, or real PTY output within PTY_EVIDENCE_MS. Both
// windows are stamped by Signals 1 & 2 (which are unchanged).
const TOKEN_EVIDENCE_MS = 90_000;
const PTY_EVIDENCE_MS = 120_000;

const EMPTY_VITALS: VitalsState = {
  values: null,
  trend: { cpu: 'neutral', mem: 'neutral', proc: 'neutral' },
  history: { cpu: [], mem: [], proc: [] },
  error: false,
};

const INERT_SESSION: SessionState = {
  sessionStartTs: 0,
  uptime: '0h 00m',
  vitals: EMPTY_VITALS,
  logLines: [],
  activeTabId: null,
  logEvent: null,
  liveUsage: { totalToday: 0, tokensInDelta: 0, tokensOutDelta: 0, intensity: 0, connected: false },
  isWorking: false,
  workReason: 'break',
  setActiveTabId: () => {},
  clearLog: () => {},
  sessions: [],
  activeSessionId: null,
  syncSessions: () => {},
  registerTabControl: () => {},
  setActiveTab: () => {},
  openTab: () => {},
  openProjectInTab: () => {},
  openTabWith: () => {},
  closeTab: () => {},
};

/** The four fixed Development root folders this app's terminal already
 * browses (see src/app/api/projects/route.ts) — used only to recognize a
 * real cwd, never to invent one. */
const KNOWN_DEV_ROOTS = ['ACTIVE', 'HOBBY', 'general', 'research'];

/** Derives (projectRoot, projectName) from a real tab cwd, e.g.
 * "C:\Users\<you>\Development\HOBBY\some-project" -> { projectRoot: 'HOBBY',
 * projectName: 'some-project' }. Both null when the cwd doesn't fall under a
 * known Development root (e.g. the folder picker's generic fallback cwd) —
 * an honest unknown, not a guess. */
function deriveProjectIdentity(cwd: string): { projectRoot: string | null; projectName: string | null } {
  const segments = cwd.split(/[\\/]/).filter(Boolean);
  const devIdx = segments.findIndex((seg) => seg.toLowerCase() === 'development');
  if (devIdx === -1 || devIdx + 1 >= segments.length) return { projectRoot: null, projectName: null };
  const rootCandidate = segments[devIdx + 1];
  if (!KNOWN_DEV_ROOTS.includes(rootCandidate)) return { projectRoot: null, projectName: null };
  return { projectRoot: rootCandidate, projectName: segments[devIdx + 2] ?? null };
}

const SessionContext = createContext<SessionState>(INERT_SESSION);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}

function formatUptime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${String(minutes).padStart(2, '0')}m`;
}

// formatClockTime moved to src/lib/time-format.ts so the "Time Format" (12h/24h)
// setting governs it — imported above. The live clock re-renders every second,
// so a setting change is reflected within a tick.

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export interface SessionProviderProps {
  children: ReactNode;
  /** Switches the app's active screen to "terminal". Supplied by AppShell
   * (the one place that owns nav state) so `openTab`/`openProjectInTab`
   * below can really change screens instead of only narrating. Omitted in
   * contexts with no nav concept (e.g. tests) — those calls become a no-op
   * screen switch, narration still fires. */
  onRequestTerminalNav?: () => void;
}

export function SessionProvider({ children, onRequestTerminalNav }: SessionProviderProps) {
  // -- Uptime: real elapsed time since THIS provider mounted (i.e. since the
  // dashboard was opened) — never resets on nav switches, since AppShell
  // (which mounts this) never unmounts while the app is open. -------------
  const sessionStartRef = useRef<number>(Date.now());
  const [uptimeSeconds, setUptimeSeconds] = useState(0);
  useEffect(() => {
    const id = setInterval(() => {
      setUptimeSeconds(Math.floor((Date.now() - sessionStartRef.current) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, []);

  // -- Real system vitals: GET /api/system, polled continuously regardless
  // of which screen is showing. ------------------------------------------
  const [vitals, setVitals] = useState<VitalsState>(EMPTY_VITALS);
  useEffect(() => {
    let cancelled = false;

    const poll = async () => {
      try {
        const res = await fetch('/api/system');
        if (!res.ok) throw new Error(`system fetch failed: ${res.status}`);
        const json = (await res.json()) as Partial<SystemVitals>;
        if (cancelled) return;
        const next: SystemVitals = {
          cpu: clampPercent(json.cpu ?? 0),
          mem: clampPercent(json.mem ?? 0),
          proc: clampPercent(json.proc ?? 0),
        };
        setVitals((prev) => {
          const trend: Record<VitalKey, VitalTrend> = { ...prev.trend };
          const history: Record<VitalKey, number[]> = { cpu: [], mem: [], proc: [] };
          (Object.keys(next) as VitalKey[]).forEach((key) => {
            const before = prev.values ? prev.values[key] : next[key];
            trend[key] = next[key] > before ? 'up' : next[key] < before ? 'down' : 'neutral';
            history[key] = [...prev.history[key], next[key]].slice(-SPARKLINE_LENGTH);
          });
          return { values: next, trend, history, error: false };
        });
      } catch {
        if (!cancelled) setVitals((prev) => ({ ...prev, error: true }));
      }
    };

    poll();
    const id = setInterval(poll, SYSTEM_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // -- Live PTY output log buffer, driven by whichever tab TerminalScreen
  // reports as active. See file header for what does/doesn't survive a nav
  // switch here. --------------------------------------------------------
  const [logLines, setLogLines] = useState<LogLine[]>([]);
  const [activeTabId, setActiveTabIdState] = useState<string | null>(null);
  const [logEvent, setLogEvent] = useState<LogReactionEvent | null>(null);
  const logEventSeqRef = useRef(0);
  const lastRealTabIdRef = useRef<string | null>(null);

  // -- Session contract: real mirror of TabBar's tab list (see file header
  // "SESSION CONTRACT"). `sessions` is derived state, not owned here — it
  // only ever reflects whatever TerminalScreen last reported via
  // `syncSessions`, which itself only ever reflects TabBar's own real
  // onTabsChange callback. -------------------------------------------------
  const [sessions, setSessions] = useState<SessionTab[]>([]);
  const tabControlRef = useRef<TabControlHandle | null>(null);

  const syncSessions = useCallback((tabs: SyncableTab[], activeId: string | null) => {
    setSessions(
      tabs.map((tab) => {
        const identity = deriveProjectIdentity(tab.cwd);
        return {
          id: tab.id,
          cwd: tab.cwd,
          title: tab.title,
          exited: tab.exited,
          ...identity,
        };
      }),
    );
    setActiveTabIdState(activeId);
  }, []);

  /** Spawn queued while the Terminal screen was unmounted — fired the moment
   * TabBar's handle registers, so open-project is one click from anywhere.
   * Carries the full spawn args (initialPrompt + resume) so a queued Agent
   * Synthesizer / resume-session open replays exactly, not as a bare tab. */
  const pendingSpawnRef = useRef<{
    title: string;
    cwd: string;
    initialPrompt?: string;
    resume?: ResumeSpec;
  } | null>(null);

  const registerTabControl = useCallback((handle: TabControlHandle | null) => {
    tabControlRef.current = handle;
    if (handle && pendingSpawnRef.current) {
      const { title, cwd, initialPrompt, resume } = pendingSpawnRef.current;
      pendingSpawnRef.current = null;
      handle.openTab(title, cwd, initialPrompt, resume);
    }
  }, []);

  const setActiveTab = useCallback((id: string) => {
    // Optimistic: reflects instantly even a render before TabBar's own
    // onTabsChange -> syncSessions round-trip confirms it. Real source of
    // truth is still TabBar; if `id` doesn't exist there, activateTab is a
    // documented no-op and the next syncSessions call corrects this back.
    setActiveTabIdState(id);
    tabControlRef.current?.activateTab(id);
  }, []);

  const closeTab = useCallback((id: string) => {
    wsClient.kill(id);
    setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, exited: true } : s)));
  }, []);

  const spawnOrQueue = useCallback(
    (title: string, cwd: string, initialPrompt?: string, resume?: ResumeSpec) => {
      const handle = tabControlRef.current;
      if (handle) {
        handle.openTab(title, cwd, initialPrompt, resume);
      } else {
        pendingSpawnRef.current = { title, cwd, initialPrompt, resume };
      }
      onRequestTerminalNav?.();
    },
    [onRequestTerminalNav],
  );

  const openTab = useCallback(() => {
    spawnOrQueue('terminal', DEV_ROOT);
    narrate('New terminal coming up.', { mood: 'focused' });
  }, [spawnOrQueue]);

  const openProjectInTab = useCallback(
    (root: string, name: string) => {
      spawnOrQueue(name, `${DEV_ROOT}\\${root}\\${name}`);
      narrate(`Opening ${name}.`, { mood: 'focused' });
    },
    [spawnOrQueue],
  );

  /** General spawn used by surfaces that need a specific cwd + an initial
   * scaffold prompt and/or a resume directive — the Agent Synthesizer (opens a
   * `claude` authoring session) and the dashboard "resume your open session"
   * offer (opens the external project's cwd with `--continue`). Same
   * spawn-or-queue plumbing as openTab/openProjectInTab; navigates to Terminal. */
  const openTabWith = useCallback(
    (opts: { title: string; cwd: string; initialPrompt?: string; resume?: ResumeSpec }) => {
      spawnOrQueue(opts.title, opts.cwd, opts.initialPrompt, opts.resume);
    },
    [spawnOrQueue],
  );

  const setActiveTabId = useCallback((id: string | null) => {
    setActiveTabIdState(id);
  }, []);

  const clearLog = useCallback(() => setLogLines([]), []);

  const bumpLogEvent = useCallback((kind: LogReactionEvent['kind']) => {
    logEventSeqRef.current += 1;
    setLogEvent({ id: logEventSeqRef.current, kind });
  }, []);

  useEffect(() => {
    if (!activeTabId) return; // idle — no real session to stream from right
    // now; the buffer already on screen is left exactly as-is.

    // Only reset the visible buffer when this is genuinely a different real
    // session than the last one we streamed — never just because the
    // consumer (TerminalScreen) remounted and briefly reported null.
    if (lastRealTabIdRef.current !== activeTabId) {
      lastRealTabIdRef.current = activeTabId;
      setLogLines([]);
    }

    const unsubscribe = wsClient.subscribe(activeTabId, (message) => {
      if (message.type === 'exit') {
        if (message.code !== 0) bumpLogEvent('exit-nonzero');
        return;
      }
      if (message.type !== 'output') return;

      const lines = stripAnsi(message.data)
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
      if (lines.length === 0) return;

      const stamp = formatClockTime(new Date());
      let sawError = false;
      let sawSuccess = false;
      setLogLines((prev) => {
        const additions: LogLine[] = lines.map((text, idx) => {
          const signal = classifyOutput(text);
          if (signal === 'success') sawSuccess = true;
          if (signal === 'error') sawError = true;
          return {
            id: `${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 7)}`,
            text,
            timestamp: stamp,
            success: signal === 'success',
          };
        });
        return [...prev, ...additions].slice(-MAX_LOG_LINES);
      });

      // Error takes priority over success if a burst contains both.
      if (sawError) bumpLogEvent('error');
      else if (sawSuccess) bumpLogEvent('success');
    });

    return unsubscribe;
  }, [activeTabId, bumpLogEvent]);

  // -- Live token usage: one persistent SSE subscription for the whole app
  // session instead of one per Terminal-screen mount. ---------------------
  const liveUsage = useLiveUsage();

  // -- Narration triggers off the real usage stream (see file header). ----
  const announcedStartRef = useRef(false);
  const liveUsageRef = useRef(liveUsage);
  liveUsageRef.current = liveUsage;

  useEffect(() => {
    if (!liveUsage.connected || announcedStartRef.current) return;
    announcedStartRef.current = true;
    // A short delay lets the server's immediate initial snapshot (sent the
    // instant the SSE stream opens — see /api/live/route.ts) land in state
    // before we read totalToday, so this narrates the real starting number
    // rather than the pre-connection default of 0.
    const timer = setTimeout(() => {
      const total = liveUsageRef.current.totalToday;
      narrate(`Session started. ${total.toLocaleString()} tokens on the board today.`, { mood: 'chill' });
    }, 150);
    return () => clearTimeout(timer);
  }, [liveUsage.connected]);

  const prevTotalRef = useRef<number | null>(null);
  const lastMilestoneBucketRef = useRef(0);
  const bucketInitializedRef = useRef(false);

  useEffect(() => {
    const total = liveUsage.totalToday;
    const prev = prevTotalRef.current;

    // Master reset: a real drop back to zero after being nonzero.
    if (prev !== null && prev > 0 && total === 0) {
      narrate('Counters reset. Starting clean.', { mood: 'chill' });
      lastMilestoneBucketRef.current = 0;
      bucketInitializedRef.current = true;
      prevTotalRef.current = total;
      return;
    }

    const bucket = Math.floor(total / TOKEN_MILESTONE);
    if (!bucketInitializedRef.current) {
      // First real value observed this app session — establish the
      // baseline without narrating (this is not a "crossing", it's where
      // we started reading from).
      bucketInitializedRef.current = true;
      lastMilestoneBucketRef.current = bucket;
    } else if (bucket > lastMilestoneBucketRef.current) {
      lastMilestoneBucketRef.current = bucket;
      narrate(`Crossed ${(bucket * TOKEN_MILESTONE).toLocaleString()} tokens today. Keep it rolling.`, {
        mood: 'hype',
      });
    }

    prevTotalRef.current = total;
  }, [liveUsage.totalToday]);

  // -- WORK/BREAK CLOCK (LAW 1, see file header) ---------------------------
  // One latched + debounced boolean composed from three real signals. Two are
  // EDGE signals (a token increase, a PTY output chunk) that stamp
  // `lastEdgeSignalAtRef`; one is a HELD signal (spawned roster nonempty)
  // tracked in `spawnedActiveRef`. A slow tick flips the latch back to BREAK
  // only once the edge signals have been quiet for WORK_DEBOUNCE_MS AND the
  // held signal is clear. setIsWorking(true) is idempotent — React bails when
  // the value is unchanged, so a busy output stream doesn't thrash renders.
  const [isWorking, setIsWorking] = useState(false);
  const [workReason, setWorkReason] = useState<string>('break');
  const lastEdgeSignalAtRef = useRef(0);
  const spawnedActiveRef = useRef(false);
  const prevTotalForWorkRef = useRef<number | null>(null);
  const wasConnectedForWorkRef = useRef(false);
  const awaitingSnapshotRef = useRef(true);
  // Separate real-evidence timestamps (LANE G) so Signal 3 can require RECENT
  // corroboration before a spawned roster counts toward the clock. Stamped by
  // Signals 1 & 2 alongside lastEdgeSignalAtRef. `workReasonRef` holds the label
  // of the latest signal that asserted work, mirrored into `workReason` state
  // for debug whenever the latch toggles.
  const lastTokenEvidenceAtRef = useRef(0);
  const lastPtyEvidenceAtRef = useRef(0);
  const workReasonRef = useRef<string>('break');

  // Signal 1 — live token stream. A real increase in today's total means the
  // model is producing tokens right now. The FIRST total value seen after each
  // (re)connect is the day's accumulated snapshot arriving at once, not a live
  // delta, so it only resets the baseline. `awaitingSnapshotRef` (not a
  // same-render `justConnected` check) survives across renders, because SSE's
  // 'open' event (connected:true, total still 0) and its 'usage' snapshot
  // (total -> accumulated) land as two SEPARATE, unbatched renders — a
  // same-render check missed the second one and read the whole day's total as
  // a live spike.
  useEffect(() => {
    if (!liveUsage.connected) {
      wasConnectedForWorkRef.current = false;
      awaitingSnapshotRef.current = true;
      return;
    }
    if (!wasConnectedForWorkRef.current) {
      wasConnectedForWorkRef.current = true;
      awaitingSnapshotRef.current = true;
    }
    const total = liveUsage.totalToday;
    if (awaitingSnapshotRef.current) {
      awaitingSnapshotRef.current = false;
      prevTotalForWorkRef.current = total;
      return;
    }
    const prev = prevTotalForWorkRef.current;
    prevTotalForWorkRef.current = total;
    if (prev === null) return;
    if (total > prev) {
      const now = Date.now();
      lastEdgeSignalAtRef.current = now;
      lastTokenEvidenceAtRef.current = now;
      workReasonRef.current = 'live-tokens';
      setIsWorking(true);
    }
  }, [liveUsage.totalToday, liveUsage.connected]);

  // Signal 2 — active PTY command. A real output chunk means a command is
  // producing output, but the persistent terminal keeps a live `claude` REPL
  // running across the whole app session (see PersistentTerminalHost) — its
  // idle banner/spinner/cursor repaints are also 'output' frames, and they
  // land more often than the debounce window, so an UNFILTERED tap pins the
  // clock on the instant a terminal tab is ever opened, forever. Require a
  // recent real keystroke on THAT socket (wsClient.getLastInputAt()) so only
  // output that's actually following user-driven input counts as work; idle
  // REPL chatter with no one typing does not. Passive observer — never opens
  // the socket itself.
  useEffect(() => {
    const unsubscribe = wsClient.subscribeAll((message) => {
      if (message.type !== 'output') return;
      const now = Date.now();
      // Count this output chunk as work if EITHER a recent keystroke OR a recent
      // real token delta corroborates it. The keystroke gate alone dropped PTY
      // support 15s after the last keypress, so during AUTONOMOUS work (owner not
      // typing) only bursty token deltas held the clock — the gap-flicker source.
      // A live token delta within TOKEN_EVIDENCE_MS is honest proof the model is
      // really producing (idle REPL repaints accrue no tokens), so it's a safe
      // second key. Truly idle (no keystroke AND no tokens) ⇒ repaints ignored,
      // the 90s idle guarantee stands.
      const recentKeystroke = now - wsClient.getLastInputAt() <= RECENT_INPUT_WINDOW_MS;
      const recentTokens = now - lastTokenEvidenceAtRef.current <= TOKEN_EVIDENCE_MS;
      if (!recentKeystroke && !recentTokens) return;
      lastEdgeSignalAtRef.current = now;
      lastPtyEvidenceAtRef.current = now;
      workReasonRef.current = 'pty-output';
      setIsWorking(true);
    });
    return unsubscribe;
  }, []);

  // Signal 3 — spawned agents (held), CORROBORATED (LANE G honesty fix). A fresh
  // roster (entries younger than SPAWNED_STALE_MS) is necessary but NOT
  // sufficient: the store has no active/done flag (see spawned-store.ts), so a
  // finished-but-uncleared agent would otherwise pin WORKING forever on presence
  // alone. So a roster entry only counts toward the clock when paired with
  // RECENT real evidence — a live token delta (TOKEN_EVIDENCE_MS) or real PTY
  // output (PTY_EVIDENCE_MS), both stamped by Signals 1 & 2. Result: a stale
  // finished agent no longer pins the clock. The roster still shows in the Agents
  // pool regardless — this only affects the work latch.
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch('/api/spawned');
        if (!res.ok) return;
        const json = (await res.json()) as { agents?: Array<{ createdAt?: unknown }> };
        if (cancelled) return;
        const now = Date.now();
        const rosterFresh =
          Array.isArray(json.agents) &&
          json.agents.some((agent) => {
            const createdAt = typeof agent?.createdAt === 'string' ? Date.parse(agent.createdAt) : NaN;
            return Number.isNaN(createdAt) || now - createdAt < SPAWNED_STALE_MS;
          });
        const hasRecentEvidence =
          now - lastTokenEvidenceAtRef.current <= TOKEN_EVIDENCE_MS ||
          now - lastPtyEvidenceAtRef.current <= PTY_EVIDENCE_MS;
        const active = rosterFresh && hasRecentEvidence;
        spawnedActiveRef.current = active;
        if (active) {
          workReasonRef.current = 'spawned+evidence';
          setIsWorking(true);
        }
      } catch {
        // Network hiccup — leave the last known held state as-is, don't flip.
      }
    };
    poll();
    const id = setInterval(poll, SPAWNED_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // Debounce checker — the only place the latch flips back to BREAK. Reads the
  // refs via a functional update so it always sees the freshest signal state;
  // returns the same `true` (no re-render) until everything is genuinely quiet.
  useEffect(() => {
    const id = setInterval(() => {
      setIsWorking((current) => {
        if (!current) return false;
        const edgeQuiet = Date.now() - lastEdgeSignalAtRef.current > WORK_DEBOUNCE_MS;
        const spawnedQuiet = !spawnedActiveRef.current;
        return edgeQuiet && spawnedQuiet ? false : true;
      });
    }, WORK_TICK_MS);
    return () => clearInterval(id);
  }, []);

  // Mirror the latch's real reason into state (debug read) whenever it toggles:
  // on ⇒ the label of the signal that asserted it; off ⇒ 'break'.
  useEffect(() => {
    setWorkReason(isWorking ? workReasonRef.current : 'break');
  }, [isWorking]);

  // -- Assemble context value ----------------------------------------------
  const uptime = formatUptime(uptimeSeconds);

  const value = useMemo<SessionState>(
    () => ({
      sessionStartTs: sessionStartRef.current,
      uptime,
      vitals,
      logLines,
      activeTabId,
      logEvent,
      liveUsage,
      isWorking,
      workReason,
      setActiveTabId,
      clearLog,
      sessions,
      activeSessionId: activeTabId,
      syncSessions,
      registerTabControl,
      setActiveTab,
      openTab,
      openProjectInTab,
      openTabWith,
      closeTab,
    }),
    [
      uptime,
      vitals,
      logLines,
      activeTabId,
      logEvent,
      liveUsage,
      isWorking,
      workReason,
      setActiveTabId,
      clearLog,
      sessions,
      syncSessions,
      registerTabControl,
      setActiveTab,
      openTab,
      openProjectInTab,
      openTabWith,
      closeTab,
    ],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  return useContext(SessionContext);
}
