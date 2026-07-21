'use client';

/**
 * AgentsScreen — the AGENT CONTROL CENTER (reference: flubber inspo pics/flubber
 * 6.png). A living ecosystem built around ONE real, persisted list of agents.
 *
 * THE LIFECYCLE (all real, all persisted — GET/POST/DELETE /api/spawned):
 *   - The grid IS the spawned list. No fixed slot count: it grows and shrinks
 *     with the agents you actually spawned, each card showing its name, its
 *     purpose-derived role, and its own mini-Blubber at a workstation.
 *   - SPAWN: the hero Blubber asks "What agent do you need?" (narration + an
 *     inline, focus-trapped, slime-styled prompt — never window.prompt). You
 *     type a purpose → POST /api/spawned → a dormant Blubber is PULLED from the
 *     pool (AgentPoolWorld) → its mini arcs into a fresh grid cell and flips to
 *     work. See useAgentSpawn for the per-card choreography.
 *   - DESPAWN: each card has a control → inline confirm → DELETE /api/spawned →
 *     the card dissolves back toward the pool and leaves the grid.
 *   - IDLE (zero spawned): no fake anything — the AgentPoolWorld is the living
 *     centerpiece (dormant Flubbers = roster size minus spawned, floor 0), with
 *     one honest line and the Spawn action.
 *
 * EVERYTHING SHOWN AS DATA IS REAL. Every number/list traces to a real source:
 *   - Spawned agents (the grid) — real GET /api/spawned (persisted JSON store).
 *   - Roster (Total Agents, the pool's dormant count) — real GET /api/agents
 *     (~/.claude/agents/*.md).
 *   - Workflow summary (the right rail, only while agents are spawned) —
 *     the same real GET /api/spawned list, grouped by real createdAt.
 *   - Activity Feed (the right rail) — real GET /api/recent (recent skill/
 *     agent tool runs).
 *   - Top Performer — real GET /api/top-agents, polled live + refreshed on every
 *     spawn/despawn and whenever new activity lands.
 * The Blubber 3D visuals + spawn/despawn choreography are presentation, not data.
 *
 * IDLE = LIVING, NEVER FAKE WORK (CORE LAW #2): the hero's holo work-screens
 * (via FlubberHome) render ONLY off real brain activity (real terminal/nav/
 * usage reactions) — there is no more idle-state demo cycle pretending to
 * "design the interface" or "build the engine" while nothing real is
 * happening. Idle instead means genuinely alive: the hero notices real
 * horseplay from the AgentPoolWorld below it (a slime-ball toss, a chase, a
 * pile-up, a beam "peek") and reacts with a gesture + a line — see
 * handlePoolVignette. That reaction is driven by a real scheduler event from
 * the pool's own behavior brain (lib/flubber3d/pool-behaviors.ts), never a
 * canned timer loop.
 *
 * "Agent Network" is now a real workflow summary, not a decorative roster
 * map: it renders ONLY while at least one agent is really spawned, and shows
 * the real spawned list grouped into solo vs. parallel batches by real
 * createdAt proximity (agents spawned within ~90s of each other read as one
 * concurrent batch). See groupByCreation/workflowGroups below.
 *
 * WORKFLOOR (last-hard-push Phase 2): GET /api/agents-live now DOES carry a
 * real per-run "what is this agent doing right now" string (session-activity.ts
 * tails each subagent's own transcript, correlated by its real toolUseId — see
 * that file's header). The Workfloor strip (below the hero, above the pool)
 * materializes one AgentWorkstation bay per real running run that has no
 * matching manually-spawned standby card, fed that live activity string every
 * poll, and dissolves the bay the moment the run finishes. See the "Workfloor"
 * section further down for the full mechanism.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { ChevronRight, Sparkles, X } from 'lucide-react';
import AgentAvatar from '../AgentAvatar';
import Flubber3D from '../Flubber3D';
import FlubberHome, { type FlubberPlaymateHandle } from '../FlubberHome';
import AgentWorkstation from '../AgentWorkstation';
import TopAgentsPanel from '../dash/TopAgentsPanel';
import ActivityFeedPanel from '../dash/ActivityFeedPanel';
import { AgentPoolWorld, type PoolControls } from '../pool/AgentPoolWorld';
import HandoffOverlay, { type HandoffOverlayHandle } from '../agents/HandoffOverlay';
import Workfloor, { type WorkfloorBayView } from '../agents/Workfloor';
import { useFlubberBrainState } from '../FlubberBrainProvider';
import { Panel } from '../ui';
import { useAgentSpawn } from '../../hooks/useAgentSpawn';
import { useSession } from '../../context/SessionProvider';
import { narrate } from '../../lib/flubber3d/narration';
import { activityFromExpression, activityFromRealEvent, type FlubberActivity } from '../../lib/flubber-activity';
import { agentSeed, resolveOutfit } from '../../lib/agent-outfits';
import { resolveSpawn, type RosterAgent } from '../../lib/spawn-parse';
import { CATEGORY_DEFS, groupRoster, type CategoryId } from '../../lib/agent-categories';
import { humanizeSlug } from '../../lib/humanize';
import { summarizeClaudeText } from '../../lib/summarize-claude-text';
import type { FlubberSlotHandle } from '../../lib/flubber3d/host';
import type { GestureName } from '../../lib/flubber3d/motion';
import type { PoolEventKind } from '../../lib/flubber3d/pool-behaviors';
import './AgentsScreen.css';

// The hero's WORDLESS reaction to a real pool vignette (see handlePoolVignette):
// a single gesture per kind. No canned lines anymore — cosmetic pool horseplay
// and break-time playtime are not real speech events, so their triggers fire
// MOTION ONLY. Words only ever come from real sources (real terminal reactions,
// real session events). CORE LAW: bubbles/toasts carry only real speech.
const VIGNETTE_GESTURE: Record<PoolEventKind, GestureName> = {
  bump: 'bounce',
  toss: 'wave',
  chase: 'hop',
  pileup: 'bounce',
  peek: 'wave',
};
const HERO_REACTION_COOLDOWN_MS = 2500;
/** Real spawned agents within this window of each other read as one
 *  concurrent batch in the workflow summary — a real createdAt-derived
 *  signal, never a fabricated topology. */
const PARALLEL_WINDOW_MS = 90_000;
/** Workfloor: at most this many live-run bays show at once; the rest fold
 *  into an honest "+N working" chip (never a fabricated 7th+ bay). */
const MAX_WORKFLOOR_BAYS = 6;
/** Breathing beat between one queued pull landing and the next one starting
 *  — the "one by one, not all at once" cadence for a multi-agent burst. */
const WORKFLOOR_STAGGER_MS = 350;

// --- data shapes -----------------------------------------------------------

interface AgentSummary {
  name: string;
  description: string;
  file: string;
}

/** One persisted spawned agent from GET /api/spawned. `name` is a REAL
 *  ~/.claude/agents slug now (e.g. "security-reviewer"), `file` its source .md. */
interface SpawnedAgent {
  id: string;
  name: string;
  file?: string;
  purpose: string;
  createdAt: string;
}

type FetchState = 'loading' | 'error' | 'ready';

/** A spawned agent resolved for display (role/seed derived from its purpose). */
interface SpawnedView {
  id: string;
  name: string;
  /** Real agent slug, kept for matching against live runs (standby→utilized). */
  slug: string;
  purpose: string;
  role: string;
  seed: number;
}

/** One real tool-invocation from GET /api/recent (newest first). */
interface RecentEvent {
  ts: string;
  toolName: string | null;
  category: 'skill' | 'agent' | null;
}

/** One real agent run-count from GET /api/top-agents. */
interface NamedCount {
  name: string;
  count: number;
}

const RECENT_POLL_MS = 10_000;
const RECENT_LIMIT = 10;
const TOP_POLL_MS = 5000;
/** A real tool event within this window counts as a spawned agent working now. */
const RECENT_MATCH_WINDOW_MS = 10 * 60_000;

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Resolve a spawned agent for display. Its purpose is the meaningful signal
 *  for the role (a security purpose → Security, a design purpose → Designer). */
function buildSpawnedView(agent: SpawnedAgent): SpawnedView {
  const name = humanizeSlug(agent.name);
  const outfit = resolveOutfit(name, agent.purpose);
  return { id: agent.id, name, slug: agent.name, purpose: agent.purpose, role: outfit.role, seed: agentSeed(agent.id) };
}

// --- inline helpers (mirror DashboardScreen's real-data helpers) -----------

/** Normalize a name/slug to a comparable token (lowercase, alphanumerics only)
 *  so a spawned agent's name can be loosely matched against a real recent tool
 *  event's name. Loose by design — the recent feed carries no agent id, so this
 *  is an honest best-effort tie, never a fabricated per-node flag. */
function normalizeToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// --- real-data hooks -------------------------------------------------------

/** Real recent tool-invocation feed from GET /api/recent, re-polled. Also
 *  exposes the newest timestamp so callers can refetch other live panels when
 *  fresh activity lands. `project`, when set, is forwarded as the endpoint's
 *  optional `?project=` filter (session-awareness — see useSession() usage
 *  below); the endpoint may or may not apply it yet, so this never assumes a
 *  filtered result, it only opportunistically asks for one. */
function useRecentEvents(
  pollMs: number,
  project: string | null,
): { events: RecentEvent[]; state: FetchState; newestTs: string | null } {
  const [events, setEvents] = useState<RecentEvent[]>([]);
  const [state, setState] = useState<FetchState>('loading');

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      const query = new URLSearchParams({ limit: String(RECENT_LIMIT) });
      if (project) query.set('project', project);
      fetch(`/api/recent?${query.toString()}`)
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
    const id = window.setInterval(load, pollMs);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [pollMs, project]);

  const newestTs = events[0]?.ts ?? null;
  return { events, state, newestTs };
}

/** Real all-time agent run counts from GET /api/top-agents, polled live and
 *  refetchable on demand (after every spawn/despawn or fresh activity). */
function useTopAgents(pollMs: number): { agents: NamedCount[]; state: FetchState; refetch: () => void } {
  const [agents, setAgents] = useState<NamedCount[]>([]);
  const [state, setState] = useState<FetchState>('loading');
  const load = useRef<() => void>(() => {});

  useEffect(() => {
    let cancelled = false;
    load.current = () => {
      fetch('/api/top-agents?range=alltime')
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
    };
    load.current();
    const id = window.setInterval(() => load.current(), pollMs);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [pollMs]);

  const refetch = useCallback(() => load.current(), []);
  return { agents, state, refetch };
}

// --- workflow summary (real spawned topology — solo vs. parallel batches) --

/** Groups real spawned agents by real createdAt proximity: agents spawned
 *  within PARALLEL_WINDOW_MS of the previous one in the sorted list join the
 *  same batch (a real "these came online together" signal); anything further
 *  out starts a new group. A group of one is a solo agent. */
function groupByCreation(agents: SpawnedAgent[]): SpawnedAgent[][] {
  if (agents.length === 0) return [];
  const sorted = [...agents].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  const groups: SpawnedAgent[][] = [];
  for (const agent of sorted) {
    const current = groups[groups.length - 1];
    const prev = current?.[current.length - 1];
    const gapMs = prev ? new Date(agent.createdAt).getTime() - new Date(prev.createdAt).getTime() : Infinity;
    if (current && gapMs <= PARALLEL_WINDOW_MS) current.push(agent);
    else groups.push([agent]);
  }
  return groups;
}

interface AgentWorkflowSummaryProps {
  groups: SpawnedAgent[][];
  viewById: Map<string, SpawnedView>;
}

/** The real topology of what's actually spawned right now — solo nodes vs.
 *  real parallel batches, each node labeled with its real name + purpose.
 *  Renders nothing when there's nothing real to show (see hasAgents gate at
 *  the call site — this component only ever mounts with agents present). */
function AgentWorkflowSummary({ groups, viewById }: AgentWorkflowSummaryProps) {
  return (
    <div className="acc-workflow">
      {groups.map((group, gi) => (
        <div
          key={group[0]?.id ?? gi}
          className={`acc-workflow__group${group.length > 1 ? ' acc-workflow__group--parallel' : ''}`}
        >
          <span className="acc-workflow__tag">{group.length > 1 ? `Parallel · ${group.length}` : 'Solo'}</span>
          <div className="acc-workflow__nodes">
            {group.map((agent) => {
              const view = viewById.get(agent.id);
              if (!view) return null;
              return (
                <div key={agent.id} className="acc-workflow__node">
                  <AgentAvatar name={view.name} description={view.purpose} size={28} tier="mid" />
                  <div className="acc-workflow__meta">
                    <span className="acc-workflow__name">{view.name}</span>
                    <span className="acc-workflow__role">{view.role}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

// --- live runs monitor (REAL in-flight + just-finished agent/workflow runs) --
// Consumes GET /api/agents-live (the tool_runs table: a run is "running" while
// its tool_use has no tool_result yet). This is the truthful live monitor — no
// fabrication, empty until Claude actually fires a real agent or workflow.

interface LiveRunView {
  runId: string;
  name: string;
  fullName: string;
  slug: string;
  category: 'skill' | 'agent';
  project: string | null;
  status: 'running' | 'done';
  elapsedMs: number;
  tokens: number;
  startedAt: string;
  endedAt: string | null;
  /** Real "Tool → target" read off THIS run's own transcript (session-activity.ts),
   *  only ever populated for `running` rows. Null until something real lands, or
   *  for finished rows (nothing "happening now" left to report). */
  activity: string | null;
}

/** The current project's own main session — the hero's real live read, same
 *  transcript-tail source as each run's `activity` above. */
interface HeroSessionView {
  working: boolean;
  activity: string | null;
  lastAssistantText: string | null;
}

const EMPTY_HERO_SESSION: HeroSessionView = { working: false, activity: null, lastAssistantText: null };

// 2.5s — fast enough that the Workfloor's "spawn one by one" materialization
// (below) reads responsive against a real multi-agent burst, without hitting
// the route harder than the throttled indexer snapshot + targeted tail reads
// underneath it can comfortably serve.
const LIVE_RUNS_POLL_MS = 2500;

function useLiveRuns(): {
  running: LiveRunView[];
  recent: LiveRunView[];
  state: FetchState;
  heroSession: HeroSessionView;
} {
  const [running, setRunning] = useState<LiveRunView[]>([]);
  const [recent, setRecent] = useState<LiveRunView[]>([]);
  const [heroSession, setHeroSession] = useState<HeroSessionView>(EMPTY_HERO_SESSION);
  const [state, setState] = useState<FetchState>('loading');

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetch('/api/agents-live')
        .then((r) => {
          if (!r.ok) throw new Error(`agents-live ${r.status}`);
          return r.json() as Promise<{ running?: LiveRunView[]; recent?: LiveRunView[]; heroSession?: HeroSessionView }>;
        })
        .then((j) => {
          if (cancelled) return;
          setRunning(Array.isArray(j.running) ? j.running : []);
          setRecent(Array.isArray(j.recent) ? j.recent : []);
          setHeroSession(j.heroSession ?? EMPTY_HERO_SESSION);
          setState('ready');
        })
        .catch(() => {
          if (!cancelled) setState('error');
        });
    };
    load();
    const id = setInterval(load, LIVE_RUNS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return { running, recent, state, heroSession };
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}K`;
  return String(Math.round(n));
}

function LiveRunRow({ run }: { run: LiveRunView }) {
  const isRunning = run.status === 'running';
  return (
    <li className={`acc-live__row${isRunning ? ' acc-live__row--running' : ''}`} title={`${run.fullName} · ${run.slug}`}>
      <span className={`acc-live__dot acc-live__dot--${run.status}`} aria-hidden="true" />
      <span className="acc-live__name">{run.name}</span>
      <span className="acc-live__tag">{run.category === 'agent' ? 'agent' : 'skill'}</span>
      <span className="acc-live__meta">
        <span className="acc-live__elapsed">{isRunning ? formatElapsed(run.elapsedMs) : `${formatElapsed(run.elapsedMs)} · done`}</span>
        {run.tokens > 0 && <span className="acc-live__tok">{formatTokens(run.tokens)} tok</span>}
      </span>
    </li>
  );
}

function LiveRunsPanel({
  running,
  recent,
  state,
}: {
  running: LiveRunView[];
  recent: LiveRunView[];
  state: FetchState;
}) {
  const runningCount = running.length;
  const empty = running.length === 0 && recent.length === 0;
  return (
    <Panel
      accent
      title={runningCount > 0 ? `Live Runs · ${runningCount} running` : 'Live Runs'}
      className="acc-live-panel"
      avoidRoam
    >
      {state === 'loading' && <p className="acc-empty">Checking for live agents…</p>}
      {state === 'error' && <p className="acc-empty">Couldn&rsquo;t reach the live monitor.</p>}
      {state === 'ready' && empty && (
        <p className="acc-empty">
          Nothing running right now. The moment Claude fires a real agent or workflow, it lights up here live —
          name, elapsed time, and tokens burned.
        </p>
      )}
      {!empty && (
        <ul className="acc-live">
          {running.map((r) => (
            <LiveRunRow key={r.runId} run={r} />
          ))}
          {recent.map((r) => (
            <LiveRunRow key={r.runId} run={r} />
          ))}
        </ul>
      )}
    </Panel>
  );
}

// --- spawn prompt (inline, focus-trapped, slime-styled) --------------------

interface SpawnPromptProps {
  submitting: boolean;
  onSubmit: (purpose: string) => void;
  onCancel: () => void;
  /** When set, the ask matched several real roster agents — show them so the
   *  user picks the exact one instead of Blubber guessing. */
  choices?: RosterAgent[] | null;
  onChoose?: (agent: RosterAgent) => void;
}

/** The inline "What agent do you need?" panel — the big hero Blubber asking
 *  the user directly. Focus-trapped: Tab cycles inside it, Esc cancels, Enter
 *  submits. Never window.prompt. When the ask is ambiguous it shows the real
 *  matching agents as a pick-list. */
function SpawnPrompt({ submitting, onSubmit, onCancel, choices, onChoose }: SpawnPromptProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
      return;
    }
    if (e.key !== 'Tab') return;
    const focusables = panelRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled])',
    );
    if (!focusables || focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit(inputRef.current?.value ?? '');
  };

  return (
    <div
      ref={panelRef}
      className="acc-prompt"
      role="dialog"
      aria-modal="true"
      aria-label="Spawn a new agent"
      onKeyDown={handleKeyDown}
    >
      <form className="acc-prompt__form" onSubmit={handleSubmit}>
        <label className="acc-prompt__label" htmlFor="acc-purpose">
          What agent do you need?
        </label>
        <input
          id="acc-purpose"
          ref={inputRef}
          className="acc-prompt__input"
          type="text"
          placeholder="e.g. audit my auth flow for security holes"
          autoComplete="off"
          disabled={submitting}
        />
        <div className="acc-prompt__actions">
          <button type="button" className="acc-prompt__cancel" onClick={onCancel} disabled={submitting}>
            Cancel
          </button>
          <button type="submit" className="acc-prompt__go" disabled={submitting}>
            {submitting ? 'Spawning…' : 'Spawn'}
          </button>
        </div>
      </form>
      {choices && choices.length > 0 && (
        <div className="acc-prompt__choices">
          <p className="acc-prompt__choices-label">Which one?</p>
          <ul className="acc-prompt__choices-list">
            {choices.map((agent) => (
              <li key={agent.file}>
                <button
                  type="button"
                  className="acc-prompt__choice"
                  onClick={() => onChoose?.(agent)}
                  disabled={submitting}
                  title={agent.description}
                >
                  <span className="acc-prompt__choice-name">{humanizeSlug(agent.name)}</span>
                  {agent.description && (
                    <span className="acc-prompt__choice-desc">{agent.description}</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// --- roster picker (browse the REAL ~/.claude/agents roster) ---------------

interface RosterPickerProps {
  roster: AgentSummary[];
  /** Real all-time run counts from GET /api/top-agents (already in scope at
   *  the call site) — feeds the "Frequent" strip. Sorted by count desc. */
  topAgents: NamedCount[];
  submitting: boolean;
  onPick: (agent: AgentSummary) => void;
  onClose: () => void;
}

// Rows now ALWAYS render the shiny MID tier — no more rationing gloss across a
// long flat scroll. The fix that made this affordable: mount far fewer rows at
// once (a 12-per-page accordion instead of a 60-row flat list), so the app-wide
// Flubber3D budget (MAX_MID_BODIES in host.ts) never gets close to its cap even
// with every visible row shiny. See docs on the categorize/page approach in
// agent-categories.ts.
const PAGE_SIZE = 12;
const FREQUENT_CAP = 5;

/** Strip the gsd-/ce- pipeline prefix before humanizing so pipeline rows read
 *  "Planner" / "Doc Writer" instead of "Gsd Planner" / "Ce Doc Writer". */
function displayAgentName(agent: AgentSummary, categoryId: CategoryId | null): string {
  let slug = agent.name;
  if (categoryId === 'gsd' && slug.startsWith('gsd-')) slug = slug.slice(4);
  else if (categoryId === 'ce' && slug.startsWith('ce-')) slug = slug.slice(3);
  return humanizeSlug(slug);
}

interface RosterRowProps {
  agent: AgentSummary;
  categoryId: CategoryId | null;
  submitting: boolean;
  onPick: (agent: AgentSummary) => void;
}

/** One roster row — always tier="mid" now (see PAGE_SIZE comment above). */
function RosterRow({ agent, categoryId, submitting, onPick }: RosterRowProps) {
  const outfit = resolveOutfit(agent.name, agent.description);
  return (
    <li key={agent.file}>
      <button
        type="button"
        className="acc-picker__row"
        disabled={submitting}
        onClick={() => onPick(agent)}
        title={agent.description}
      >
        <AgentAvatar name={agent.name} description={agent.description} size={26} tier="mid" />
        <span className="acc-picker__meta">
          <span className="acc-picker__name">{displayAgentName(agent, categoryId)}</span>
          <span className="acc-picker__role">{outfit.role}</span>
        </span>
      </button>
    </li>
  );
}

interface RosterPagerProps {
  page: number;
  totalPages: number;
  total: number;
  onPage: (page: number) => void;
}

function RosterPager({ page, totalPages, total, onPage }: RosterPagerProps) {
  if (totalPages <= 1) return null;
  const start = page * PAGE_SIZE + 1;
  const end = Math.min(total, start + PAGE_SIZE - 1);
  return (
    <div className="acc-picker__pager">
      <button type="button" onClick={() => onPage(page - 1)} disabled={page <= 0}>
        ‹ Prev
      </button>
      <span className="acc-picker__pager-range">
        {start}–{end} of {total}
      </span>
      <button type="button" onClick={() => onPage(page + 1)} disabled={page >= totalPages - 1}>
        Next ›
      </button>
    </div>
  );
}

/** Browse the real agent roster and put one on standby directly. Every row is a
 *  real ~/.claude/agents/*.md agent — the source of truth line at the bottom
 *  says exactly where they come from (LAW 1: nothing invented). Categorized +
 *  paged (12/page) instead of one 60-row flat scroll, so every rendered row can
 *  afford the shiny MID tier — see PAGE_SIZE comment above. */
function RosterPicker({ roster, topAgents, submitting, onPick, onClose }: RosterPickerProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  const grouped = useMemo(() => groupRoster(roster), [roster]);
  const categoryEntries = useMemo(
    () => CATEGORY_DEFS.map((def) => ({ def, agents: grouped.get(def.id) ?? [] })).filter((c) => c.agents.length > 0),
    [grouped],
  );

  const [query, setQuery] = useState('');
  const [openCategory, setOpenCategory] = useState<CategoryId | null>(() => categoryEntries[0]?.def.id ?? null);
  const [page, setPage] = useState(0);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Fresh search or a newly-opened category always starts back at page 1.
  useEffect(() => {
    setPage(0);
  }, [query, openCategory]);

  // Real "recently/most used" agents — joins GET /api/top-agents (already
  // fetched at the call site) back to the real roster by exact name, mirroring
  // the existing Top Performer join above. Real matches only; no invented rows.
  const frequent = useMemo(() => {
    const matches: AgentSummary[] = [];
    for (const top of topAgents) {
      const match = roster.find((a) => a.name === top.name);
      if (match && !matches.some((m) => m.file === match.file)) matches.push(match);
      if (matches.length >= FREQUENT_CAP) break;
    }
    return matches;
  }, [topAgents, roster]);

  const trimmedQuery = query.trim().toLowerCase();
  const searchResults = useMemo(() => {
    if (!trimmedQuery) return [];
    return roster.filter((a) => `${a.name} ${a.description}`.toLowerCase().includes(trimmedQuery));
  }, [roster, trimmedQuery]);

  const openEntry = categoryEntries.find((c) => c.def.id === openCategory) ?? null;
  const activeList = trimmedQuery ? searchResults : openEntry?.agents ?? [];
  const totalPages = Math.max(1, Math.ceil(activeList.length / PAGE_SIZE));
  const clampedPage = Math.min(page, totalPages - 1);
  const pageItems = activeList.slice(clampedPage * PAGE_SIZE, clampedPage * PAGE_SIZE + PAGE_SIZE);

  return (
    <div className="acc-picker" role="dialog" aria-modal="true" aria-label="Browse the agent roster">
      <div className="acc-picker__bar">
        <input
          ref={inputRef}
          className="acc-picker__search"
          type="text"
          placeholder={`Search ${roster.length} real agents…`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
          }}
          autoComplete="off"
        />
        <button type="button" className="acc-picker__close" onClick={onClose} aria-label="Close roster">
          <X size={14} aria-hidden="true" />
        </button>
      </div>

      <div className="acc-picker__body">
        {!trimmedQuery && frequent.length > 0 && (
          <div className="acc-picker__frequent">
            <span className="acc-picker__frequent-label">Frequent</span>
            <ul className="acc-picker__frequent-list">
              {frequent.map((agent) => {
                const outfit = resolveOutfit(agent.name, agent.description);
                return (
                  <li key={agent.file}>
                    <button
                      type="button"
                      className="acc-picker__row acc-picker__row--frequent"
                      disabled={submitting}
                      onClick={() => onPick(agent)}
                      title={agent.description}
                    >
                      <AgentAvatar name={agent.name} description={agent.description} size={26} tier="mid" />
                      <span className="acc-picker__meta">
                        <span className="acc-picker__name">{humanizeSlug(agent.name)}</span>
                        <span className="acc-picker__role">{outfit.role}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {trimmedQuery ? (
          <div className="acc-picker__cat acc-picker__cat--search">
            <p className="acc-picker__match-count">
              {searchResults.length} match{searchResults.length === 1 ? '' : 'es'}
            </p>
            <ul className="acc-picker__list">
              {pageItems.map((agent) => (
                <RosterRow key={agent.file} agent={agent} categoryId={null} submitting={submitting} onPick={onPick} />
              ))}
              {searchResults.length === 0 && <li className="acc-picker__empty">No agent matches “{query}”.</li>}
            </ul>
            <RosterPager page={clampedPage} totalPages={totalPages} total={searchResults.length} onPage={setPage} />
          </div>
        ) : (
          <div className="acc-picker__accordion">
            {categoryEntries.map(({ def, agents }) => {
              const isOpen = openCategory === def.id;
              const Icon = def.icon;
              return (
                <div key={def.id} className="acc-picker__cat">
                  <button
                    type="button"
                    className="acc-picker__cat-head"
                    aria-expanded={isOpen}
                    onClick={() => setOpenCategory(isOpen ? null : def.id)}
                  >
                    <Icon size={14} aria-hidden="true" />
                    <span className="acc-picker__cat-label">{def.label}</span>
                    <span className="acc-picker__cat-count">{agents.length}</span>
                    <ChevronRight
                      size={14}
                      aria-hidden="true"
                      className={`acc-picker__cat-chevron${isOpen ? ' acc-picker__cat-chevron--open' : ''}`}
                    />
                  </button>
                  {isOpen && (
                    <div className="acc-picker__cat-body">
                      <ul className="acc-picker__list">
                        {pageItems.map((agent) => (
                          <RosterRow
                            key={agent.file}
                            agent={agent}
                            categoryId={def.id}
                            submitting={submitting}
                            onPick={onPick}
                          />
                        ))}
                      </ul>
                      <RosterPager page={clampedPage} totalPages={totalPages} total={agents.length} onPage={setPage} />
                    </div>
                  )}
                </div>
              );
            })}
            {categoryEntries.length === 0 && <p className="acc-picker__empty">No agents in the roster yet.</p>}
          </div>
        )}
      </div>

      <p className="acc-picker__source">Real agents from ~/.claude/agents — spawn puts one on standby.</p>
    </div>
  );
}

// --- skeleton --------------------------------------------------------------

function AgentsSkeleton() {
  return (
    <div className="agents-cc agents-cc--loading">
      <Panel accent className="acc-hero-panel">
        <div className="acc-skel acc-skel--hero" />
      </Panel>
      <Panel accent title="Agent Pool" className="acc-pool-panel">
        <div className="acc-skel acc-skel--pool" />
      </Panel>
    </div>
  );
}

// --- component -------------------------------------------------------------

export interface AgentsScreenProps {
  className?: string;
}

export default function AgentsScreen({ className }: AgentsScreenProps) {
  const [roster, setRoster] = useState<AgentSummary[]>([]);
  const [rosterState, setRosterState] = useState<FetchState>('loading');

  // The spawned list IS the grid — real, persisted, dynamic.
  const [spawned, setSpawned] = useState<SpawnedAgent[]>([]);
  const [spawnedState, setSpawnedState] = useState<FetchState>('loading');

  // Spawn flow state.
  const [promptOpen, setPromptOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  // When a vague ask matches several real roster agents, hold the short-list so
  // the spawn panel can ask the user which one (instead of guessing or inventing).
  const [spawnChoices, setSpawnChoices] = useState<{ candidates: RosterAgent[]; purpose: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [pulling, setPulling] = useState<string | null>(null);
  const pendingSpawnIn = useRef<Set<string>>(new Set());

  // Despawn flow state.
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const exitingIds = useRef<Set<string>>(new Set());

  // Session awareness (mirrors the dashboard's pattern): follow whichever
  // project the real active terminal session belongs to, so this screen's
  // detail can track it — real, from the app-wide session mirror, never
  // guessed. Null when no terminal tab is open or its cwd isn't a known
  // project root (see SessionProvider.deriveProjectIdentity).
  const { sessions, activeSessionId, isWorking } = useSession();
  const activeProjectName = useMemo(
    () => sessions.find((s) => s.id === activeSessionId)?.projectName ?? null,
    [sessions, activeSessionId],
  );

  const recent = useRecentEvents(RECENT_POLL_MS, activeProjectName);
  const { agents: topAgents, refetch: refetchTop } = useTopAgents(TOP_POLL_MS);
  const liveRuns = useLiveRuns();

  // Real "which skills fired lately" set — tokens of recent (≤10 min) tool
  // events. Lets a specific spawned card light up only on real evidence.
  const activeToolTokens = useMemo(() => {
    const now = Date.now();
    const tokens = new Set<string>();
    for (const evt of recent.events) {
      const t = new Date(evt.ts).getTime();
      if (Number.isNaN(t) || now - t > RECENT_MATCH_WINDOW_MS) continue;
      if (evt.toolName) tokens.add(normalizeToken(evt.toolName));
    }
    return tokens;
  }, [recent.events]);

  // Per-agent work gating (CORE LAW: a station's monitor renders only during
  // REAL work). An agent counts as working only if (a) a matching real tool
  // event fired for it in the last 10 min, or (b) the session is genuinely
  // working — isWorking is now evidence-backed in SessionProvider. Never a
  // blanket per-card "true".
  const agentIsWorking = useCallback(
    (view: SpawnedView): boolean => {
      const token = normalizeToken(view.name);
      if (token) {
        for (const active of activeToolTokens) {
          if (
            active === token ||
            (active.length >= 4 && token.length >= 4 && (active.includes(token) || token.includes(active)))
          ) {
            return true;
          }
        }
      }
      return isWorking;
    },
    [activeToolTokens, isWorking],
  );

  // STANDBY → UTILIZED (the real bridge): a spawned agent is "utilized" the
  // moment Claude fires a live RUN whose real slug matches this agent's real
  // slug. liveRuns.running comes straight from the tool_runs table (a run with
  // no tool_result yet). Matched by normalized slug so a spawned
  // "security-reviewer" lights up when the real security-reviewer agent runs.
  const runningSlugTokens = useMemo(
    () => new Set(liveRuns.running.map((r) => normalizeToken(r.slug))),
    [liveRuns.running],
  );
  const agentIsUtilized = useCallback(
    (view: SpawnedView): boolean => {
      const token = normalizeToken(view.slug);
      if (!token) return false;
      for (const active of runningSlugTokens) {
        if (
          active === token ||
          (active.length >= 4 && token.length >= 4 && (active.includes(token) || token.includes(active)))
        ) {
          return true;
        }
      }
      return false;
    },
    [runningSlugTokens],
  );

  const spawn = useAgentSpawn();
  // The hero's own live slot handle (distinct from spawn.heroRef, which is
  // the DOM stage node used for the squash pulse) — lets handlePoolVignette
  // below make the hero really react to a real pool event.
  const heroHandleRef = useRef<FlubberSlotHandle | null>(null);
  const lastVignetteReactionAt = useRef(0);

  // ── real pool↔hero playtime (LANE 5) ──────────────────────────────────────
  // handoffRef drives the HandoffOverlay clone across both pills' clip
  // boundaries; poolControlsRef is the pool's break-only +1 control (reused
  // here to restore the resident once the playmate visit ends — "no agent
  // lost"); playmateRef is FlubberHome's own enter(seed) capability;
  // activeHandoffSeedRef tracks which seeds are currently airborne/visiting so a
  // second grab of the SAME mini mid-flight is ignored — but UNLIMITED distinct
  // minis can be handed up at once (Item 5): throw 5 up, the hero is in there
  // with all 5. heroStageElRef mirrors spawn.heroRef's node (that hook only
  // exposes a callback ref, not the element) via setHeroStageRef below, purely so
  // this screen can read the hero stage's real bounding rect for the arc endpoints.
  const handoffRef = useRef<HandoffOverlayHandle>(null);
  const poolControlsRef = useRef<PoolControls | null>(null);
  const playmateRef = useRef<FlubberPlaymateHandle | null>(null);
  const poolWorldElRef = useRef<HTMLDivElement | null>(null);
  const activeHandoffSeedRef = useRef<Set<number>>(new Set());
  const heroStageElRef = useRef<HTMLDivElement | null>(null);
  const setHeroStageRef = useCallback(
    (node: HTMLDivElement | null) => {
      heroStageElRef.current = node;
      spawn.heroRef(node);
    },
    [spawn.heroRef],
  );

  // ── initial loads ────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setRosterState('loading');
    fetch('/api/agents')
      .then((res) => {
        if (!res.ok) throw new Error(`agents fetch failed: ${res.status}`);
        return res.json() as Promise<{ agents?: AgentSummary[] }>;
      })
      .then((data) => {
        if (cancelled) return;
        setRoster(Array.isArray(data?.agents) ? data.agents : []);
        setRosterState('ready');
      })
      .catch(() => {
        if (!cancelled) setRosterState('error');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setSpawnedState('loading');
    fetch('/api/spawned')
      .then((res) => {
        if (!res.ok) throw new Error(`spawned fetch failed: ${res.status}`);
        return res.json() as Promise<{ agents?: SpawnedAgent[] }>;
      })
      .then((data) => {
        if (cancelled) return;
        setSpawned(Array.isArray(data?.agents) ? data.agents : []);
        setSpawnedState('ready');
      })
      .catch(() => {
        if (!cancelled) setSpawnedState('error');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Kill any in-flight card timelines on unmount.
  useEffect(() => spawn.cleanup, [spawn]);

  const spawnedViews = useMemo(() => spawned.map(buildSpawnedView), [spawned]);
  const hasAgents = spawnedViews.length > 0;
  const dormantCount = Math.max(0, roster.length - spawned.length);

  // Real workflow topology — see groupByCreation's doc comment. viewById joins
  // each real spawned agent back to its display view (name/role/purpose).
  const workflowGroups = useMemo(() => groupByCreation(spawned), [spawned]);
  const viewById = useMemo(() => new Map(spawnedViews.map((v) => [v.id, v])), [spawnedViews]);

  // ── brain-driven hero workspace ───────────────────────────────────────────
  const brain = useFlubberBrainState();
  const heroExpr = brain.expression;
  // CORE LAW #1: FlubberHome's work-panels are NEVER fed a mood-derived activity.
  // `heroActivity` below is a LOCAL busy-heuristic used ONLY to gate the playful
  // pool vignettes (don't clown while the hero looks occupied); it never reaches
  // the mascot's panels.
  const heroActivity: FlubberActivity =
    heroExpr && heroExpr !== 'idle' && heroExpr !== 'happy' ? activityFromExpression(heroExpr) : 'idle';

  // The hero's REAL live work-screen (last-hard-push Phase 2): liveRuns.heroSession
  // is a genuine transcript-tail read of THIS project's own main session (see
  // session-activity.ts) — a real tool_use event, not a mood flash, so feeding it
  // into FlubberHome's `activity` prop stays inside CORE LAW #1 (mood must never
  // open a work panel; a real event always may). Only trusted while the session
  // is genuinely working; otherwise FlubberHome falls back to its own /api/recent
  // read exactly as before. The compact "Tool → target" string isn't itself a
  // FlubberActivity, so its leading tool name is run through the same real-event
  // classifier used everywhere else (activityFromRealEvent).
  const heroLiveActivity: FlubberActivity | undefined = useMemo(() => {
    if (!liveRuns.heroSession.working || !liveRuns.heroSession.activity) return undefined;
    const toolName = liveRuns.heroSession.activity.split('→')[0]?.trim() || liveRuns.heroSession.activity;
    return activityFromRealEvent({ toolName });
  }, [liveRuns.heroSession.working, liveRuns.heroSession.activity]);

  // ONE bubble, pinned top of the hero workstation (FlubberHome's own
  // top-anchored .fh__speech — see FlubberHome.css). While the prompt is
  // open, the hero literally asks on-screen. Otherwise a real brain reaction
  // (a terminal build pass/fail) wins for its brief hold; else the bubble
  // carries a live, heuristically-simplified read of whatever this project's
  // own real Claude session last actually said (heroSession.lastAssistantText,
  // tailed live off the real transcript by session-activity.ts — never a
  // canned per-activity line). No LLM call: summarizeClaudeText is a cheap,
  // instant string transform. Null/empty ⇒ no bubble at all (LAW 1).
  const heroSpeech =
    promptOpen
      ? 'What agent do you need?'
      : (brain.speech?.text ?? summarizeClaudeText(liveRuns.heroSession.lastAssistantText));

  // The hero's idle "playtime" tie to the pool below it: fires once per real
  // AgentPoolWorld scheduler event (a toss, a chase, a pile-up, a peek). Only
  // reacts while the hero is genuinely idle and the prompt isn't open — real
  // work (or asking the user a question) always wins over playful banter.
  const handlePoolVignette = useCallback(
    (kind: PoolEventKind) => {
      if (heroActivity !== 'idle' || promptOpen) return;
      const now = Date.now();
      if (now - lastVignetteReactionAt.current < HERO_REACTION_COOLDOWN_MS) return; // never stack reactions
      lastVignetteReactionAt.current = now;
      // Wordless: the hero just glances over with a gesture. A cosmetic pool
      // vignette is not real speech, so it produces motion only — no line.
      heroHandleRef.current?.playGesture(VIGNETTE_GESTURE[kind]);
    },
    [heroActivity, promptOpen],
  );

  // The user dragged a pool mini UP to the hero (break-only) — the REAL round trip
  // (LANE 5): the hero reacts immediately (unchanged), then a HandoffOverlay
  // clone arcs from the exact release point into the hero stage; once it
  // lands, FlubberHome's own playmate takes over the same spot for a real
  // ~15s stage visit. activeHandoffSeedRef gates re-entrancy — a second grab
  // mid-flight is ignored (the pool only ever has one resident airborne at a
  // time in practice, but this keeps the round trip honest either way).
  const handleHeroGrab = useCallback(
    (point: { x: number; y: number }, seed: number) => {
      lastVignetteReactionAt.current = Date.now();
      // Wordless: a celebrate squash-emote greets the grabbed mini. Playtime is
      // not a real work/speech event, so it carries motion only — no words.
      heroHandleRef.current?.playGesture('celebrate');

      if (activeHandoffSeedRef.current.has(seed)) return; // same mini already up
      const heroStage = heroStageElRef.current;
      if (!heroStage) return;
      activeHandoffSeedRef.current.add(seed);

      const rect = heroStage.getBoundingClientRect();
      // Lands roughly where FlubberHome's own .fh__playmate anchors (64%/82% of
      // the stage box) so the overlay clone and the real playmate mini read as
      // the same body handing off, not two separate pops.
      const landing = { x: rect.left + rect.width * 0.64, y: rect.top + rect.height * 0.82 };

      handoffRef.current?.arc({ from: point, to: landing, seed }).then(() => {
        playmateRef.current?.enter(seed);
      });
    },
    [],
  );

  // The playmate's own visit timer ended (FlubberHome decided it's time to hop
  // down) — arc the same clone back toward the pool, then restore the
  // resident there via the pool's break-only +1 control ("no agent lost").
  const handlePlaymateExit = useCallback((seed: number) => {
    const heroStage = heroStageElRef.current;
    const poolWorld = poolWorldElRef.current;
    const fromRect = heroStage?.getBoundingClientRect();
    const from = fromRect
      ? { x: fromRect.left + fromRect.width * 0.64, y: fromRect.top + fromRect.height * 0.82 }
      : { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    const poolRect = poolWorld?.getBoundingClientRect();
    const to = poolRect ? { x: poolRect.left + poolRect.width / 2, y: poolRect.top + poolRect.height * 0.68 } : from;

    // Wordless goodbye: a small wave emote as the playmate heads back down. No
    // canned line — playtime never generates bubble/toast words.
    heroHandleRef.current?.playGesture('wave');

    handoffRef.current?.arc({ from, to, seed, reverse: true }).then(() => {
      poolControlsRef.current?.addOne();
      activeHandoffSeedRef.current.delete(seed);
    });
  }, []);

  // ── shared pull-queue coordinator ────────────────────────────────────────
  // AgentPoolWorld exposes exactly ONE pull slot (`pulling`/`onPullComplete`
  // below) — the real "lift a mini out of the dormant pool" choreography.
  // Both the manual single-agent spawn flow (revealSpawned) and the
  // Workfloor's auto-materialize path (further down) request pulls through
  // this shared queue, so N simultaneous requests (a workflow firing several
  // agents at once) fire the pull ONE AT A TIME — never overlapping, never
  // all at once — with a short breathing beat between each landing and the
  // next one starting.
  interface PullJob {
    key: string;
    onDone: () => void;
  }
  const pullQueueRef = useRef<PullJob[]>([]);
  const activePullRef = useRef<PullJob | null>(null);
  const pullStaggerTimer = useRef<number | null>(null);

  const runNextPull = useCallback(() => {
    if (activePullRef.current) return; // one in flight already
    const job = pullQueueRef.current.shift();
    if (!job) return;
    activePullRef.current = job;
    setPulling(job.key);
  }, []);

  const enqueuePull = useCallback(
    (key: string, onDone: () => void) => {
      pullQueueRef.current.push({ key, onDone });
      runNextPull();
    },
    [runNextPull],
  );

  // AgentPoolWorld's onPullComplete — fires once the current pull's visual
  // choreography has fully landed. Resolves the job, then waits a short
  // stagger beat before starting the next queued pull (the "one by one, not
  // all at once" beat for a multi-agent burst).
  const handlePullComplete = useCallback(() => {
    const job = activePullRef.current;
    activePullRef.current = null;
    setPulling(null);
    job?.onDone();
    if (pullStaggerTimer.current !== null) window.clearTimeout(pullStaggerTimer.current);
    pullStaggerTimer.current = window.setTimeout(() => {
      pullStaggerTimer.current = null;
      runNextPull();
    }, WORKFLOOR_STAGGER_MS);
  }, [runNextPull]);

  useEffect(
    () => () => {
      if (pullStaggerTimer.current !== null) window.clearTimeout(pullStaggerTimer.current);
    },
    [],
  );

  // ── Workfloor: real live-run bays "under the hero" ─────────────────────────
  // A bay materializes for every REAL running run (liveRuns.running) that has
  // NO matching manually-spawned standby card already lit up in the Active
  // Agents grid via the standby→utilized bridge above — duplicating those here
  // would double-count the same real agent. isRunClaimedByStandby mirrors
  // agentIsUtilized's matching (same normalized-slug overlap check), just in
  // the opposite direction (a spawned agent's slug claiming a live run).
  const spawnedSlugTokens = useMemo(
    () => new Set(spawnedViews.map((v) => normalizeToken(v.slug))),
    [spawnedViews],
  );
  const isRunClaimedByStandby = useCallback(
    (run: LiveRunView): boolean => {
      const token = normalizeToken(run.slug);
      if (!token) return false;
      for (const active of spawnedSlugTokens) {
        if (
          active === token ||
          (active.length >= 4 && token.length >= 4 && (active.includes(token) || token.includes(active)))
        ) {
          return true;
        }
      }
      return false;
    },
    [spawnedSlugTokens],
  );

  const [workfloorBays, setWorkfloorBays] = useState<WorkfloorBayView[]>([]);
  const workfloorBaysRef = useRef<WorkfloorBayView[]>([]);
  workfloorBaysRef.current = workfloorBays;
  // Every runId currently queued for a pull, mid-pull, or visible — gates both
  // re-enqueue and the visible cap (a queued-but-not-yet-landed bay still
  // occupies one of the MAX_WORKFLOOR_BAYS slots).
  const workfloorTrackedRef = useRef<Set<string>>(new Set());
  const workfloorDespawningRef = useRef<Set<string>>(new Set());
  // Always holds the CURRENT unclaimed-run id set, read inside enqueuePull's
  // onDone (which can fire long after enqueue, once its turn in the shared
  // pull queue comes up) — closing over the enqueue-time `unclaimedIds`
  // would let an already-finished run's queued job still spawn a bay.
  const unclaimedIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const unclaimed = liveRuns.running.filter((r) => !isRunClaimedByStandby(r));
    const unclaimedIds = new Set(unclaimed.map((r) => r.runId));
    unclaimedIdsRef.current = unclaimedIds;

    // Live activity/name refresh on already-visible bays — the whole point of
    // this strip: the HoloPanel content updates as the real activity string
    // changes, every poll.
    setWorkfloorBays((prev) => {
      let changed = false;
      const next = prev.map((bay) => {
        const run = unclaimed.find((r) => r.runId === bay.runId);
        if (run && (run.activity !== bay.activity || run.name !== bay.name)) {
          changed = true;
          return { ...bay, activity: run.activity, name: run.name };
        }
        return bay;
      });
      return changed ? next : prev;
    });

    // Exits: a tracked bay whose run is no longer running dissolves out via
    // the SAME playDespawn choreography the manually-spawned grid uses.
    for (const bay of workfloorBaysRef.current) {
      if (unclaimedIds.has(bay.runId) || workfloorDespawningRef.current.has(bay.runId)) continue;
      workfloorDespawningRef.current.add(bay.runId);
      spawn.playDespawn(`wf-${bay.runId}`, () => {
        setWorkfloorBays((cur) => cur.filter((b) => b.runId !== bay.runId));
        workfloorTrackedRef.current.delete(bay.runId);
        workfloorDespawningRef.current.delete(bay.runId);
      });
    }

    // Stale-queued prune: a run tracked (queued or in-flight) but no longer
    // unclaimed and not yet visible would otherwise land its bay anyway once
    // its turn in the shared pull queue comes up (the queue can be several
    // jobs deep during a burst) — drop the tracking slot now and cancel its
    // job if it hasn't started pulling yet. An already-active pull can't be
    // interrupted mid-choreography, but the unclaimedIdsRef check inside
    // enqueuePull's onDone below absorbs that case too (lands the mini, just
    // never materializes a bay for it).
    for (const id of workfloorTrackedRef.current) {
      if (unclaimedIds.has(id)) continue;
      if (workfloorBaysRef.current.some((b) => b.runId === id)) continue; // visible — Exits loop above owns it
      workfloorTrackedRef.current.delete(id);
      pullQueueRef.current = pullQueueRef.current.filter((j) => j.key !== `workfloor-${id}`);
    }

    // Arrivals: real new unclaimed runs, capped at MAX_WORKFLOOR_BAYS total
    // (visible + queued), each queued through the shared pull mechanism so a
    // burst of N new runs materializes one bay at a time.
    const capacityLeft = MAX_WORKFLOOR_BAYS - workfloorTrackedRef.current.size;
    if (capacityLeft > 0) {
      const fresh = unclaimed.filter((r) => !workfloorTrackedRef.current.has(r.runId));
      for (const run of fresh.slice(0, capacityLeft)) {
        workfloorTrackedRef.current.add(run.runId);
        const outfit = resolveOutfit(run.slug, run.fullName);
        enqueuePull(`workfloor-${run.runId}`, () => {
          // Re-check against the CURRENT unclaimed set, not the one from
          // enqueue time — this run may have finished while queued behind
          // other pulls.
          if (!unclaimedIdsRef.current.has(run.runId)) return;
          setWorkfloorBays((prev) =>
            prev.some((b) => b.runId === run.runId)
              ? prev
              : [
                  ...prev,
                  {
                    runId: run.runId,
                    role: outfit.role,
                    seed: agentSeed(run.runId),
                    name: run.name,
                    category: run.category,
                    activity: run.activity,
                  },
                ],
          );
        });
      }
    }
  }, [liveRuns.running, isRunClaimedByStandby, enqueuePull, spawn]);

  // Real count of running-and-unclaimed runs beyond the visible cap — honest
  // overflow, never a fabricated 7th+ bay.
  const workfloorOverflow = Math.max(
    0,
    liveRuns.running.filter((r) => !isRunClaimedByStandby(r)).length - MAX_WORKFLOOR_BAYS,
  );

  // ── spawn ─────────────────────────────────────────────────────────────────
  const openPrompt = useCallback(() => {
    if (submitting) return;
    setPickerOpen(false);
    setPromptOpen(true);
    narrate('What agent do you need?', { mood: 'hype' });
  }, [submitting]);

  const cancelPrompt = useCallback(() => {
    setPromptOpen(false);
    setSpawnChoices(null);
  }, []);

  // Spawn one or more REAL roster agents from the user's ask. The text is resolved
  // to actual ~/.claude/agents by parseSpawnRequest (keyword-matched, with
  // multi-spawn counts like "2 game devs, 3 UI experts"). Each spawn stores the
  // real slug + file, so the card is a real agent on standby — no invented
  // names. POST is sequential (the store rewrites the whole JSON per call, so
  // parallel POSTs would race the file); the counts are capped small.
  const spawnOne = useCallback(
    async (name: string, file: string | undefined, purpose: string): Promise<SpawnedAgent | null> => {
      try {
        const res = await fetch('/api/spawned', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, file, purpose }),
        });
        if (!res.ok) return null;
        const { agent } = (await res.json()) as { agent: SpawnedAgent };
        return agent;
      } catch {
        return null;
      }
    },
    [],
  );

  // Drop a batch of freshly-spawned agents into the grid. One agent (not under
  // reduced motion) gets the pool-pull choreography (queued through
  // enqueuePull below — shared with the Workfloor's auto-materialize path); a
  // batch just arcs each card in (playSpawnIn) so the grid doesn't wait on N
  // sequential pool pulls.
  const revealSpawned = useCallback(
    (agents: SpawnedAgent[]) => {
      if (agents.length === 0) return;
      if (agents.length === 1 && !prefersReducedMotion()) {
        const agent = agents[0];
        enqueuePull(`standby-${agent.id}`, () => {
          pendingSpawnIn.current.add(agent.id);
          setSpawned((prev) => (prev.some((a) => a.id === agent.id) ? prev : [...prev, agent]));
        });
      } else {
        agents.forEach((a) => pendingSpawnIn.current.add(a.id));
        setSpawned((prev) => [...prev, ...agents.filter((a) => !prev.some((p) => p.id === a.id))]);
      }
      refetchTop();
    },
    [enqueuePull, refetchTop],
  );

  const submitSpawn = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text || submitting) return;
      const resolution = resolveSpawn(text, roster);
      if (resolution.kind === 'none') {
        narrate("Couldn't match that to a real agent in your roster. Try naming a role — 'security', 'game dev', 'UI', 'research'.", {
          mood: 'chill',
        });
        return;
      }
      // Not sure — surface the real roster candidates and let the user pick, rather
      // than guess. The spawn panel renders them; choosing one calls spawnChoice.
      if (resolution.kind === 'ambiguous') {
        setSpawnChoices({ candidates: resolution.candidates, purpose: resolution.purpose });
        narrate('A few of your agents fit that — which one do you want?', { mood: 'chill' });
        return;
      }
      setSpawnChoices(null);
      const requests =
        resolution.kind === 'multi'
          ? resolution.requests
          : [{ agent: resolution.agent, purpose: resolution.purpose, count: 1 }];
      setSubmitting(true);
      try {
        const spawnedAgents: SpawnedAgent[] = [];
        for (const req of requests) {
          for (let i = 0; i < req.count; i += 1) {
            const agent = await spawnOne(req.agent.name, req.agent.file, req.purpose);
            if (agent) spawnedAgents.push(agent);
          }
        }
        if (spawnedAgents.length === 0) {
          narrate("Hmm — couldn't spin those up. Try again?", { mood: 'chill' });
          return;
        }
        setPromptOpen(false);
        const names = spawnedAgents.map((a) => humanizeSlug(a.name));
        narrate(
          spawnedAgents.length === 1
            ? `${names[0]} is on standby — it'll light up the moment Claude puts it to work.`
            : `${spawnedAgents.length} agents on standby: ${names.slice(0, 3).join(', ')}${spawnedAgents.length > 3 ? '…' : ''}.`,
          { mood: 'hype' },
        );
        revealSpawned(spawnedAgents);
      } finally {
        setSubmitting(false);
      }
    },
    [submitting, roster, spawnOne, revealSpawned],
  );

  // Direct spawn from the roster picker — one exact real agent, its own
  // description as the standby brief.
  const spawnExact = useCallback(
    async (agent: AgentSummary) => {
      if (submitting) return;
      setSubmitting(true);
      try {
        const spawned = await spawnOne(agent.name, agent.file, agent.description || humanizeSlug(agent.name));
        if (!spawned) {
          narrate("Hmm — couldn't spin that up. Try again?", { mood: 'chill' });
          return;
        }
        setPromptOpen(false);
        setPickerOpen(false);
        narrate(`${humanizeSlug(spawned.name)} is on standby.`, { mood: 'hype' });
        revealSpawned([spawned]);
      } finally {
        setSubmitting(false);
      }
    },
    [submitting, spawnOne, revealSpawned],
  );

  // The user picked one of the ambiguous candidates — spawn that exact roster agent
  // with the original ask as its standby brief.
  const chooseSpawnCandidate = useCallback(
    async (agent: RosterAgent) => {
      if (submitting) return;
      const purpose = spawnChoices?.purpose ?? agent.description ?? humanizeSlug(agent.name);
      setSubmitting(true);
      try {
        const spawned = await spawnOne(agent.name, agent.file, purpose);
        if (!spawned) {
          narrate("Hmm — couldn't spin that up. Try again?", { mood: 'chill' });
          return;
        }
        setSpawnChoices(null);
        setPromptOpen(false);
        narrate(`${humanizeSlug(spawned.name)} is on standby.`, { mood: 'hype' });
        revealSpawned([spawned]);
      } finally {
        setSubmitting(false);
      }
    },
    [submitting, spawnChoices, spawnOne, revealSpawned],
  );

  // Once a freshly-spawned card is in the DOM, arc it into place. useLayoutEffect
  // runs after commit (cells registered) but before paint, so GSAP's "from" state
  // lands with no flash.
  useLayoutEffect(() => {
    if (pendingSpawnIn.current.size === 0) return;
    const ids = Array.from(pendingSpawnIn.current);
    pendingSpawnIn.current.clear();
    ids.forEach((id) => spawn.playSpawnIn(id));
  }, [spawnedViews, spawn]);

  // ── despawn ───────────────────────────────────────────────────────────────
  const requestDespawn = useCallback((id: string) => {
    setConfirmingId(id);
  }, []);

  const cancelDespawn = useCallback(() => {
    setConfirmingId(null);
  }, []);

  const confirmDespawn = useCallback(
    async (id: string) => {
      if (exitingIds.current.has(id)) return;
      exitingIds.current.add(id);
      setConfirmingId(null);
      try {
        const res = await fetch(`/api/spawned?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
        if (!res.ok && res.status !== 404) throw new Error(`despawn failed: ${res.status}`);
      } catch {
        exitingIds.current.delete(id);
        return;
      }
      // Dissolve the card, THEN remove it from the grid.
      spawn.playDespawn(id, () => {
        setSpawned((prev) => prev.filter((a) => a.id !== id));
        exitingIds.current.delete(id);
        refetchTop();
      });
    },
    [spawn, refetchTop],
  );

  // Refresh the top-agents rollup (still used for the roster's "frequent"
  // join above) whenever fresh activity lands, in addition to its own poll.
  useEffect(() => {
    if (recent.newestTs) refetchTop();
  }, [recent.newestTs, refetchTop]);

  const classes = ['agents-cc', className ?? ''].filter(Boolean).join(' ');

  // Skeleton only until the two load-bearing lists (roster + spawned) resolve.
  if (rosterState === 'loading' || spawnedState === 'loading') return <AgentsSkeleton />;

  if (rosterState === 'error') {
    return (
      <div className={classes}>
        <Panel accent title="Agent Control Center" className="acc-hero-panel">
          <div className="acc-error">
            <Flubber3D expression="worried" size={96} tier="mid" />
            <p>Couldn&rsquo;t load the agent roster.</p>
            <button type="button" className="acc-spawn-btn" onClick={() => window.location.reload()}>
              Retry
            </button>
          </div>
        </Panel>
      </div>
    );
  }

  const poolLine =
    dormantCount > 0
      ? `${dormantCount} agent${dormantCount === 1 ? '' : 's'} resting in the pool. Ask Blubber up top to put one to work.`
      : 'The pool is warming up. Ask Blubber up top to spawn your first agent.';

  return (
    <div className={classes} data-mode={hasAgents ? 'active' : 'idle'}>
      {/* REVERTED: no full-bleed section room (it read as broken). Each region is
          its own framed pill, and the pool carries its OWN contained room plate
          inside its pill. This node is now inert (CSS display:none) — kept only so
          the DOM shape is stable. */}
      <div className="agents-cc__room" aria-hidden="true" />

      {/* Subtle signage — just the label + a clean "N active" (real spawned.length
          from GET /api/spawned). The big roster total ("N agents") was dropped. */}
      <div className="acc-signage">
        <span className="acc-signage__eyebrow">Agent Control Center</span>
        {spawned.length > 0 && <span className="acc-signage__count">{spawned.length} active</span>}
      </div>

      <div className="agents-cc__grid">
        <div className="agents-cc__main">
          {/* ── Hero: the spawn stage (frameless — part of the room) ─── */}
          <Panel className="acc-hero-panel">
            <FlubberHome
              className="acc-home"
              expression={heroExpr}
              activity={heroLiveActivity}
              speech={heroSpeech}
              pulseKey={brain.pulseKey}
              backdrop="agents"
              isWorking={isWorking}
              hideStatusChip
              stageRef={setHeroStageRef}
              onHeroSlotReady={(handle) => {
                heroHandleRef.current = handle;
              }}
              onPlaymateReady={(handle) => {
                playmateRef.current = handle;
              }}
              onPlaymateExit={handlePlaymateExit}
            >
              {promptOpen ? (
                <SpawnPrompt
                  submitting={submitting}
                  onSubmit={submitSpawn}
                  onCancel={cancelPrompt}
                  choices={spawnChoices?.candidates ?? null}
                  onChoose={chooseSpawnCandidate}
                />
              ) : pickerOpen ? (
                <RosterPicker
                  roster={roster}
                  topAgents={topAgents}
                  submitting={submitting}
                  onPick={spawnExact}
                  onClose={() => setPickerOpen(false)}
                />
              ) : (
                // Two real spawn entry points: describe what you need (keyword →
                // real agent, multi-spawn aware), or browse the real roster.
                <div className="acc-hero-asks">
                  <button type="button" className="acc-hero-ask" onClick={openPrompt} disabled={submitting}>
                    <Sparkles size={15} aria-hidden="true" />
                    Ask Blubber for an agent
                  </button>
                  <button
                    type="button"
                    className="acc-hero-ask acc-hero-ask--ghost"
                    onClick={() => {
                      setPromptOpen(false);
                      setPickerOpen(true);
                    }}
                    disabled={submitting || roster.length === 0}
                  >
                    Browse the roster
                  </button>
                </div>
              )}
            </FlubberHome>
          </Panel>

        {/* ── Workfloor: real live-run bays, materialized one by one ── */}
        <Workfloor
          bays={workfloorBays}
          overflowCount={workfloorOverflow}
          registerCell={spawn.registerCell}
          registerSlot={spawn.registerSlot}
        />

        {/* ── Active Agents: the real spawned grid ──────────────── */}
        {hasAgents && (
          <Panel accent title={`Active Agents (${spawnedViews.length})`} className="acc-active-panel" avoidRoam>
            <div className="acc-active">
              {spawnedViews.map((agent) => {
                const utilized = agentIsUtilized(agent);
                const cardWorking = utilized || agentIsWorking(agent);
                return (
                <article
                  key={agent.id}
                  className={`acc-card${utilized ? ' acc-card--utilized' : ''}`}
                  ref={spawn.registerCell(agent.id)}
                >
                  <button
                    type="button"
                    className="acc-card__despawn"
                    aria-label={`Despawn ${agent.name}`}
                    onClick={() => requestDespawn(agent.id)}
                  >
                    <X size={13} aria-hidden="true" />
                  </button>

                  <div className="acc-card__stage">
                    <AgentWorkstation
                      role={agent.role}
                      seed={agent.seed}
                      working={cardWorking}
                      onSlotReady={spawn.registerSlot(agent.id)}
                    />
                  </div>
                  <div className="acc-card__head">
                    <span className="acc-card__name">{agent.name}</span>
                    <span className="acc-card__role">{agent.role}</span>
                  </div>
                  <span
                    className={`acc-card__status acc-card__status--${utilized ? 'live' : 'standby'}`}
                    title={
                      utilized
                        ? 'Claude is running this agent right now'
                        : 'On standby — lights up the moment Claude uses it'
                    }
                  >
                    <span className="acc-card__status-dot" aria-hidden="true" />
                    {utilized ? 'utilized' : 'standby'}
                  </span>
                  <p className="acc-card__purpose" title={agent.purpose}>
                    {agent.purpose}
                  </p>

                  {confirmingId === agent.id && (
                    <div className="acc-card__confirm" role="dialog" aria-label={`Despawn ${agent.name}?`}>
                      <span className="acc-card__confirm-q">Despawn {agent.name}?</span>
                      <div className="acc-card__confirm-actions">
                        <button type="button" className="acc-card__confirm-no" onClick={cancelDespawn}>
                          Keep
                        </button>
                        <button
                          type="button"
                          className="acc-card__confirm-yes"
                          onClick={() => confirmDespawn(agent.id)}
                        >
                          Despawn
                        </button>
                      </div>
                    </div>
                  )}
                </article>
                );
              })}
            </div>
          </Panel>
        )}

        {/* ── Agent Pool: living centerpiece (idle) / dormant companion (active) ── */}
        <Panel
          accent
          title={hasAgents ? `Dormant Pool (${dormantCount})` : 'Agent Pool'}
          className="acc-pool-panel"
          avoidRoam
        >
          <div className="acc-pool" data-mode={hasAgents ? 'active' : 'idle'}>
            <div className="acc-pool__world" ref={poolWorldElRef}>
              <AgentPoolWorld
                dormantCount={dormantCount}
                pulling={pulling}
                onPullComplete={handlePullComplete}
                reduceMotion={prefersReducedMotion()}
                onVignette={handlePoolVignette}
                isWorking={isWorking}
                onHeroGrab={handleHeroGrab}
                onControlsReady={(controls) => {
                  poolControlsRef.current = controls;
                }}
              />
            </div>
            {!hasAgents && (
              <div className="acc-pool__cta">
                <p className="acc-pool__line">{poolLine}</p>
              </div>
            )}
          </div>
        </Panel>

      </div>

      {/* ── Right rail ──────────────────────────────────────────── */}
      <div className="agents-cc__rail">
        {/* Live monitor (Item 10): REAL in-flight + just-finished agent/workflow
            runs from ~/.claude logs. Always shown — it's the "watch everything
            live" surface, honest empty state when nothing's running. */}
        <LiveRunsPanel running={liveRuns.running} recent={liveRuns.recent} state={liveRuns.state} />

        {/* Hidden ENTIRELY when nothing real is spawned — no decorative
            roster map standing in for real activity (CORE LAW #1/#2). */}
        {hasAgents && (
          <Panel accent title={`Workflow (${spawnedViews.length})`} className="acc-workflow-panel" avoidRoam>
            <AgentWorkflowSummary groups={workflowGroups} viewById={viewById} />
          </Panel>
        )}

        <TopAgentsPanel className="acc-perf-panel" avoidRoam />

        <ActivityFeedPanel className="acc-log-panel" avoidRoam />
        </div>
      </div>

      {/* Fixed full-viewport layer for the real pool→hero handoff (LANE 5) —
          mounted here so it's a plain sibling of both pills, but position:fixed
          means it paints above every clip/stacking boundary regardless of
          where in the tree it sits (see HandoffOverlay.tsx). */}
      <HandoffOverlay ref={handoffRef} reduceMotion={prefersReducedMotion()} />
    </div>
  );
}
