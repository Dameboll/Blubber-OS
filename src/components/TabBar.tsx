'use client';

/**
 * TabBar — tab strip + unified "+ New" launcher (folders or agents) + the
 * stage that renders every open tab's TerminalPane.
 *
 * Ownership model:
 *  - TabBar owns the list of tabs and which one is active.
 *  - Every tab's TerminalPane stays mounted for the tab's whole life (only
 *    `active` toggles), so switching tabs never respawns the PTY or drops
 *    scrollback — only closing a tab unmounts its pane and kills its session.
 *  - Launching an agent opens a new tab the same way the folder picker does,
 *    just with `initialPrompt` set to that agent's invocation text —
 *    TerminalPane is what actually calls wsClient.spawn with it.
 *
 * Flubberization pass (PLAN-FLUBBER.md) changes:
 *  - The old flat scrolling `.agent-row` / AgentCard grid is gone. Active
 *    sessions are now represented by the mini-flubber cluster, a separate
 *    component rendered near Core3D (owned by another agent, not this file).
 *    Agent quick-launch didn't disappear — it's folded into the same "+ New"
 *    popover as the folder picker, behind a Folders/Agents mode toggle, so
 *    the default view stays flubbers-not-a-UI-form instead of a permanent
 *    120-card row.
 *  - Dropdown-clipping fix: the "+ New" control + its popover now live in
 *    `.tab-controls`, a sibling of `.tab-strip` (not a child of it). Only
 *    `.tab-strip` has `overflow-x: auto` — a popover nested inside an
 *    overflow-x:auto ancestor gets its overflow-y clipped too, which is what
 *    was cutting the old `.folder-picker` off. `.tab-controls` and the
 *    `.tab-bar-row` wrapper around both never set overflow, so the popover
 *    now renders in full.
 *
 * Contract exposed for the mini-flubber cluster (or whatever assembles the
 * page) to mirror tab state without owning it:
 *  - `onTabsChange?: (tabs: TabSummary[], activeTabId: string | null) => void`
 *    fires whenever the open-tab list or the active tab changes. Diffing
 *    consecutive calls is how the flubber cluster knows a tab opened (id
 *    appeared) or closed (id disappeared) so it can split off / reabsorb.
 *  - `ref` exposes `{ activateTab(id: string): void }` (via
 *    forwardRef/useImperativeHandle) so clicking a mini-flubber can switch
 *    TabBar's active tab the same way clicking a tab-strip button does.
 *    TabBar stays the single source of truth for tab state either way —
 *    this is a notification + remote-control pair, not a controlled handoff.
 */

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import TerminalPane from './TerminalPane';
import { type AgentInfo } from './AgentCard';
import { VoiceButton } from './VoiceButton';
import { wsClient, type ResumeSpec } from '../lib/ws-client';
import { DEV_ROOT } from '../lib/dev-root';
import './TabBar.css';

// ---- /api/projects + /api/agents response shapes -------------------------
// These match the REAL routes at src/app/api/projects/route.ts and
// src/app/api/agents/route.ts exactly (verified by reading both files during
// integration) — both wrap their payload in a top-level key and only return
// names/labels, not pre-built {name,path} pairs, so the shapes below are
// deliberately different from what TabBar originally assumed.
interface ApiProjectRoot {
  id?: string;
  label: string; // "ACTIVE" | "HOBBY" | "general" | "research"
  root: string; // absolute path to that root folder
  projects: string[]; // immediate subdirectory names
  custom?: boolean;
}

interface ApiAgentSummary {
  name: string;
  description: string;
  file: string; // e.g. "planner.md" — used to derive a stable id
}

interface ProjectFolder {
  name: string;
  path: string;
}

interface ProjectRoot {
  root: string; // e.g. "ACTIVE" | "HOBBY" | "general" | "research"
  path: string;
  folders: ProjectFolder[];
}

interface Tab {
  id: string;
  title: string;
  cwd: string;
  initialPrompt?: string;
  /** Optional resume directive, forwarded to TerminalPane -> wsClient.spawn so
   *  this tab's `claude` picks up an existing session (`--continue`/`--resume`). */
  resume?: ResumeSpec;
  exited: boolean;
}

/** Minimal, read-only per-tab snapshot handed to `onTabsChange`. */
export interface TabSummary {
  id: string;
  title: string;
  cwd: string;
  exited: boolean;
}

/** Imperative handle so a mini-flubber (or anything outside this tree) can
 * drive tabs — switch, spawn, and close are the same real actions the strip's
 * own UI performs (SessionProvider routes openProjectInTab through this). */
export interface TabBarHandle {
  /** Same action a tab-strip click performs: make `id` the active tab (no-op if it doesn't exist). */
  activateTab: (id: string) => void;
  /** Same action the launcher performs: spawn a real PTY tab at `cwd` and focus it. Returns the new tab id. */
  openTab: (title: string, cwd: string, initialPrompt?: string, resume?: ResumeSpec) => string;
  /** Same action the tab close button performs: kill the PTY and drop the tab. */
  closeTab: (id: string) => void;
}

export interface TabBarProps {
  onTabsChange?: (tabs: TabSummary[], activeTabId: string | null) => void;
}

type LauncherMode = 'folder' | 'agent';

// Used only if /api/projects returns nothing at all (empty state, not an error).
const FALLBACK_CWD = DEV_ROOT;

function joinPath(root: string, name: string): string {
  const sep = root.includes('\\') ? '\\' : '/';
  return root.endsWith(sep) ? `${root}${name}` : `${root}${sep}${name}`;
}

function createTabId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

const TabBar = forwardRef<TabBarHandle, TabBarProps>(function TabBar({ onTabsChange }, ref) {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);

  const [projectRoots, setProjectRoots] = useState<ProjectRoot[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [projectsError, setProjectsError] = useState<string | null>(null);

  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [agentsLoading, setAgentsLoading] = useState(true);
  const [agentsError, setAgentsError] = useState<string | null>(null);

  const [pickerOpen, setPickerOpen] = useState(false);
  const [launcherMode, setLauncherMode] = useState<LauncherMode>('folder');
  const [query, setQuery] = useState('');
  const filterInputRef = useRef<HTMLInputElement | null>(null);
  const terminalStageRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    onTabsChange?.(
      tabs.map(({ id, title, cwd, exited }) => ({ id, title, cwd, exited })),
      activeTabId,
    );
  }, [tabs, activeTabId, onTabsChange]);

  // Autofocus the search box the moment the picker opens, and clear any
  // leftover filter text from the last time it was open.
  useEffect(() => {
    if (pickerOpen) {
      setQuery('');
      requestAnimationFrame(() => filterInputRef.current?.focus({ preventScroll: true }));
    }
  }, [pickerOpen]);

  const filteredProjectRoots = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return projectRoots;
    return projectRoots
      .map((root) => ({
        ...root,
        folders: root.folders.filter((folder) => folder.name.toLowerCase().includes(q)),
      }))
      .filter((root) => root.folders.length > 0);
  }, [projectRoots, query]);

  const filteredAgents = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return agents;
    return agents.filter(
      (agent) => agent.name.toLowerCase().includes(q) || agent.description.toLowerCase().includes(q),
    );
  }, [agents, query]);

  useEffect(() => {
    let cancelled = false;
    let loadSequence = 0;
    const loadProjects = () => {
      const sequence = ++loadSequence;
      setProjectsLoading(true);
      fetch('/api/projects')
        .then((res) => {
          if (!res.ok) throw new Error(`projects fetch failed: ${res.status}`);
          return res.json() as Promise<{ roots: ApiProjectRoot[] }>;
        })
        .then((data) => {
          if (cancelled || sequence !== loadSequence) return;
          const roots = Array.isArray(data?.roots) ? data.roots : [];
          const adapted: ProjectRoot[] = roots.map((r) => ({
            root: r.label,
            path: r.root,
            folders: r.projects.map((name) => ({ name, path: joinPath(r.root, name) })),
          }));
          setProjectRoots(adapted);
          setProjectsError(null);
        })
        .catch((err: unknown) => {
          if (!cancelled && sequence === loadSequence) {
            setProjectsError(err instanceof Error ? err.message : 'Failed to load folders');
          }
        })
        .finally(() => {
          if (!cancelled && sequence === loadSequence) setProjectsLoading(false);
        });
    };
    loadProjects();
    window.addEventListener('blubber:project-roots-changed', loadProjects);
    return () => {
      cancelled = true;
      window.removeEventListener('blubber:project-roots-changed', loadProjects);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/agents')
      .then((res) => {
        if (!res.ok) throw new Error(`agents fetch failed: ${res.status}`);
        return res.json() as Promise<{ agents: ApiAgentSummary[] }>;
      })
      .then((data) => {
        if (cancelled) return;
        const list = Array.isArray(data?.agents) ? data.agents : [];
        const adapted: AgentInfo[] = list.map((a) => ({
          id: a.file,
          name: a.name,
          description: a.description,
        }));
        setAgents(adapted);
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

  const defaultCwd = useMemo(() => {
    const activeRoot = projectRoots.find((root) => root.root === 'ACTIVE');
    const chosenRoot = activeRoot ?? projectRoots[0];
    return chosenRoot?.folders[0]?.path ?? chosenRoot?.path ?? FALLBACK_CWD;
  }, [projectRoots]);

  const openTab = useCallback((title: string, cwd: string, initialPrompt?: string, resume?: ResumeSpec) => {
    const id = createTabId();
    setTabs((prev) => [...prev, { id, title, cwd, initialPrompt, resume, exited: false }]);
    setActiveTabId(id);
    setPickerOpen(false);
    return id;
  }, []);

  const closeTab = useCallback((id: string) => {
    // Killing the real PTY session belongs here -- the explicit, one-shot
    // "close tab" action -- not in TerminalPane's effect cleanup, which also
    // fires on React's dev-mode Strict Mode mount->cleanup->remount cycle and
    // would kill a session that's supposed to keep running.
    wsClient.kill(id);
    setTabs((prev) => {
      const next = prev.filter((tab) => tab.id !== id);
      setActiveTabId((current) => {
        if (current !== id) return current;
        return next.length > 0 ? next[next.length - 1].id : null;
      });
      return next;
    });
  }, []);

  // Placed after openTab/closeTab so the handle wraps the same real actions
  // the strip's own UI uses — nothing here is a parallel code path.
  useImperativeHandle(
    ref,
    () => ({
      activateTab: (id: string) => setActiveTabId(id),
      openTab,
      closeTab,
    }),
    [openTab, closeTab],
  );

  const markExited = useCallback((id: string) => {
    setTabs((prev) => prev.map((tab) => (tab.id === id ? { ...tab, exited: true } : tab)));
  }, []);

  const handleLaunchAgent = useCallback(
    (agent: AgentInfo) => {
      openTab(agent.name, defaultCwd, agent.invocationPrompt ?? `Invoke the ${agent.name} agent.`);
    },
    [openTab, defaultCwd],
  );

  const handleVoiceTranscript = useCallback(
    (transcript: string) => {
      if (!activeTabId) return;
      wsClient.input(activeTabId, transcript);
    },
    [activeTabId],
  );

  // A tap (not a hold) of Space inside the terminal - send a literal space,
  // same send-input path as a finalized voice transcript.
  const handleVoiceSpaceTap = useCallback(() => {
    if (!activeTabId) return;
    wsClient.input(activeTabId, ' ');
  }, [activeTabId]);

  return (
    <div className="tab-bar">
      <div className="tab-bar-row">
        <div className="tab-strip">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={`tab${tab.id === activeTabId ? ' tab-active' : ''}${tab.exited ? ' tab-exited' : ''}`}
              onClick={() => setActiveTabId(tab.id)}
            >
              <span className="tab-title">{tab.title}</span>
              <span
                className="tab-close"
                role="button"
                tabIndex={0}
                aria-label={`Close ${tab.title}`}
                onClick={(event) => {
                  event.stopPropagation();
                  closeTab(tab.id);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    event.stopPropagation();
                    closeTab(tab.id);
                  }
                }}
              >
                ×
              </span>
            </button>
          ))}
        </div>

        {/* Sibling of .tab-strip, NOT nested inside it -- .tab-strip is the
            only element with overflow-x:auto, so the popover below renders
            fully instead of getting its overflow-y clipped by a scrolling
            ancestor (see file header + PLAN-FLUBBER.md section 4). */}
        <div className="tab-controls">
          <button
            type="button"
            className="tab-new"
            onClick={() => setPickerOpen((open) => !open)}
            aria-expanded={pickerOpen}
          >
            + New
          </button>

          {pickerOpen && (
            <div className="new-picker">
              <div className="new-picker-modes" role="tablist" aria-label="Launch a folder or an agent">
                <button
                  type="button"
                  role="tab"
                  aria-selected={launcherMode === 'folder'}
                  className={`new-picker-mode-btn${launcherMode === 'folder' ? ' new-picker-mode-btn-active' : ''}`}
                  onClick={() => setLauncherMode('folder')}
                >
                  Folders
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={launcherMode === 'agent'}
                  className={`new-picker-mode-btn${launcherMode === 'agent' ? ' new-picker-mode-btn-active' : ''}`}
                  onClick={() => setLauncherMode('agent')}
                >
                  Agents
                </button>
              </div>

              <input
                ref={filterInputRef}
                type="text"
                className="new-picker-search"
                placeholder={launcherMode === 'folder' ? 'Search folders…' : 'Search 120+ agents…'}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    setPickerOpen(false);
                  } else if (event.key === 'Enter') {
                    if (launcherMode === 'folder') {
                      const firstMatch = filteredProjectRoots[0]?.folders[0];
                      if (firstMatch) openTab(firstMatch.name, firstMatch.path);
                    } else {
                      const firstMatch = filteredAgents[0];
                      if (firstMatch) handleLaunchAgent(firstMatch);
                    }
                  }
                }}
              />

              {launcherMode === 'folder' ? (
                <>
                  {projectsLoading && <div className="new-picker-status">Loading folders…</div>}
                  {projectsError && <div className="new-picker-status new-picker-error">{projectsError}</div>}
                  {!projectsLoading && !projectsError && projectRoots.length === 0 && (
                    <div className="new-picker-status">No project folders found.</div>
                  )}
                  {!projectsLoading &&
                    !projectsError &&
                    projectRoots.length > 0 &&
                    filteredProjectRoots.length === 0 && (
                      <div className="new-picker-status">No folders match &ldquo;{query}&rdquo;.</div>
                    )}
                  {filteredProjectRoots.map((root) => (
                    <div key={root.path} className="folder-picker-group">
                      <div className="folder-picker-group-label">{root.root}</div>
                      {root.folders.map((folder) => (
                        <button
                          key={folder.path}
                          type="button"
                          className="folder-picker-item"
                          onClick={() => openTab(folder.name, folder.path)}
                        >
                          {folder.name}
                        </button>
                      ))}
                    </div>
                  ))}
                </>
              ) : (
                <>
                  {agentsLoading && <div className="new-picker-status">Loading agents…</div>}
                  {agentsError && <div className="new-picker-status new-picker-error">{agentsError}</div>}
                  {!agentsLoading && !agentsError && agents.length === 0 && (
                    <div className="new-picker-status">No agents found in ~/.claude/agents.</div>
                  )}
                  {!agentsLoading && !agentsError && agents.length > 0 && filteredAgents.length === 0 && (
                    <div className="new-picker-status">No agents match &ldquo;{query}&rdquo;.</div>
                  )}
                  {filteredAgents.map((agent) => (
                    <button
                      key={agent.id}
                      type="button"
                      className="agent-picker-item"
                      onClick={() => handleLaunchAgent(agent)}
                      title={agent.description}
                    >
                      <span className="agent-picker-name">{agent.name}</span>
                      <span className="agent-picker-desc">{agent.description}</span>
                    </button>
                  ))}
                </>
              )}
            </div>
          )}
        </div>

        <VoiceButton
          containerRef={terminalStageRef}
          onTranscript={handleVoiceTranscript}
          onSpaceTap={handleVoiceSpaceTap}
          disabled={!activeTabId}
          className="voice-button"
        />
      </div>

      <div className="terminal-stage" ref={terminalStageRef}>
        {tabs.length === 0 && (
          <div
            className="terminal-empty"
            onMouseMove={(e) => {
              // Cursor-follow spotlight: the empty void lights up where the
              // cursor is, so the biggest dead rectangle on screen reacts to
              // you. CSS reads --mx/--my (see terminal-empty in TabBar.css).
              const rect = e.currentTarget.getBoundingClientRect();
              e.currentTarget.style.setProperty('--mx', `${((e.clientX - rect.left) / rect.width) * 100}%`);
              e.currentTarget.style.setProperty('--my', `${((e.clientY - rect.top) / rect.height) * 100}%`);
            }}
          >
            <span className="terminal-empty__text">Open a new tab or launch an agent to start a session.</span>
          </div>
        )}
        {tabs.map((tab) => (
          <TerminalPane
            key={tab.id}
            sessionId={tab.id}
            cwd={tab.cwd}
            initialPrompt={tab.initialPrompt}
            resume={tab.resume}
            active={tab.id === activeTabId}
            onExit={() => markExited(tab.id)}
          />
        ))}
      </div>
    </div>
  );
});

export default TabBar;
