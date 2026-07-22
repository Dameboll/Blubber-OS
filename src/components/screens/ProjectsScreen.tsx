'use client';

/**
 * ProjectsScreen — the "projects" nav screen (AppShell's NAV_ITEMS id
 * "projects"). Layout matches "flubber inspo pics/flubber 8.png": stat strip +
 * New Project + hero character, All Projects (grid/list + search, capped to
 * the 8 most recent + a "View all" expand), Project Templates, and a right
 * rail of Project Overview / Active Agents / Recent Activity.
 *
 * ONE-WINDOW FIT (Lane 3, docs/plans/pill-worlds-mini-dash.md): the grid caps
 * to 8 real projects (4x2) sorted by real recency so the panel — and the
 * whole screen — fits 1440x900 with no page scroll. Layout-only overrides for
 * this live in src/styles/fit-sweep.css (imported below), not in
 * ProjectsScreen.css (Lane 1 owns that file for background-plate rules only).
 * ProjectCard / ProjectThumb / the per-project meta hook now live in
 * ../projects/ProjectCard.tsx, shared with DashboardScreen's mini Projects tab.
 *
 * REAL DATA ONLY:
 * - Every folder shown is real — GET /api/projects (the four fixed root folders
 *   ACTIVE / HOBBY / general / research, each with its real subdirectory names).
 * - Per-project facts (file count, total size, created date, last activity) are
 *   real filesystem reads — GET /api/projects/meta?root=<LABEL>&name=<FOLDER>,
 *   fetched lazily per card/panel and server-cached. Nothing is seeded.
 * - The 8-most-recent cap sorts by GET /api/projects/summary's real doc mtime
 *   (ai-context.md / CLAUDE.md / README.md, whichever exists) — undated
 *   projects sort last, never fabricated.
 * - The agent roster count in the hero is real — GET /api/agents.
 * - Per-project thumbnails are real — GET /api/projects/thumb.
 *
 * HONEST EMPTY (no real source in this local build, so nothing is fabricated):
 * - Project status, progress %, and task counts: no tracker exists → removed.
 * - Per-project agent assignments: not recorded anywhere → "Active Agents"
 *   shows an honest empty state (the roster is real, but which agent works on
 *   which folder is not).
 * - Per-project recent activity: not recorded per folder → honest empty state.
 * - Weekly Project Stats: no per-week metric store → the panel was folded away
 *   entirely (its real counterparts — Total Projects, Agents Available —
 *   already live in the hero strip); Project Templates now runs full width.
 * "New Project" performs the one real action available (re-scan the real
 * folders + pulse the hero); "More Templates" and "Open Project" stay disabled,
 * same honesty pattern as AgentsScreen's disabled controls.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  Activity,
  Bot,
  Calendar,
  Clock,
  Database,
  FileText,
  FolderKanban,
  Globe,
  LayoutGrid,
  List,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  Server,
  Star,
  X,
  type LucideIcon,
} from 'lucide-react';
import FlubberCharacter from '../FlubberCharacter';
import { Panel, Skeleton, SkeletonText, StatChip } from '../ui';
import { useSession } from '../../context/SessionProvider';
import { humanizeSlug } from '../../lib/humanize';
import { getProjectIcon } from '../../lib/project-icon';
import { assignPlates, platePath, type ProjectPlate } from '../../lib/project-plates';
import {
  ProjectCard,
  ProjectThumb,
  buildProjectView,
  metaFacts,
  useProjectMeta,
  type ApiProjectRoot,
  type ProjectView,
} from '../projects/ProjectCard';
import './ProjectsScreen.css';
import '../../styles/fit-sweep.css';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

type ViewMode = 'grid' | 'list';

interface ProjectTypeProfile {
  key: string;
  label: string;
  sub: string;
  icon: LucideIcon;
}

// The "Project Templates" row content — now REAL: each card opens the guided
// New Project flow pre-seeded with that template, which scaffolds a real folder
// via POST /api/projects (Item 6/7).
const PROJECT_TYPES: ProjectTypeProfile[] = [
  { key: 'web-app', label: 'Web App', sub: 'Full stack web application', icon: Globe },
  { key: 'ai-agent', label: 'AI Agent', sub: 'Intelligent agent system', icon: Bot },
  { key: 'api-service', label: 'API Service', sub: 'RESTful API service', icon: Server },
  { key: 'data-pipeline', label: 'Data Pipeline', sub: 'Data processing pipeline', icon: Database },
];

// The four real Development roots, with what each is actually for (from
// file-routing rules) — shown in the New Project flow so the user picks the right home.
const ROOT_META: { label: string; blurb: string }[] = [
  { label: 'ACTIVE', blurb: 'Main ventures' },
  { label: 'HOBBY', blurb: 'Side projects' },
  { label: 'general', blurb: 'Demos & throwaways' },
  { label: 'research', blurb: 'Research docs' },
];

// Which real ~/.claude agents each template leans on — mirrors
// server/project-scaffold.ts recommendedAgents (shown in the flow as the
// "backed by" line so a template reads as backed by real agents, not decoration).
const TEMPLATE_AGENTS: Record<string, string[]> = {
  'web-app': ['react-reviewer', 'typescript-reviewer', 'a11y-architect'],
  'ai-agent': ['architect', 'gemini-analyst', 'researcher'],
  'api-service': ['architect', 'security-reviewer', 'database-reviewer'],
  'data-pipeline': ['database-reviewer', 'performance-optimizer', 'gemini-analyst'],
};

// Recommend a template from the free-text brief — keyword affinity, honest
// fallback to web-app (the most common build).
function recommendTemplate(brief: string): string {
  const b = brief.toLowerCase();
  if (/\b(agent|bot|assistant|automation|llm|chat)\b/.test(b)) return 'ai-agent';
  if (/\b(api|endpoint|service|backend|rest|webhook)\b/.test(b)) return 'api-service';
  if (/\b(data|pipeline|etl|scrape|ingest|dataset|analytics)\b/.test(b)) return 'data-pipeline';
  if (/\b(web|site|app|frontend|dashboard|landing|page|ui)\b/.test(b)) return 'web-app';
  return 'web-app';
}

// ---------------------------------------------------------------------------
// API response shapes
// ---------------------------------------------------------------------------

interface ApiAgentSummary {
  name: string;
  description: string;
  file: string;
}

// Real recency signal for the "8 most recent" cap — mirrors the
// /api/projects/summary response (see src/app/api/projects/summary/route.ts).
// modifiedAt there is the real mtime of whichever doc (ai-context.md /
// CLAUDE.md / README.md) the project has, already server-cached; cheaper to
// fetch once for every project than running a full recursive /api/projects/meta
// scan on all of them just to sort. Projects with no doc (modifiedAt: null)
// sort last — honest, not fabricated.
//
// lastActivityAt / weeklyEventCount (Phase 4, last-hard-push): the SAME real
// indexed usage.db rollup /api/projects/summary already computes server-side
// (getProjectActivityRollup — see that route's header comment). weeklyEventCount
// powers the "Project Pulse" strip below; nothing here is invented client-side.
interface ApiProjectSummary {
  root: string;
  name: string;
  modifiedAt: string | null;
  lastActivityAt: string | null;
  weeklyEventCount: number;
}

// ProjectCard / ProjectThumb / useProjectMeta / metaFacts / ApiProjectRoot /
// ProjectView / buildProjectView now live in ../projects/ProjectCard.tsx
// (shared with DashboardScreen's mini Projects tab — see
// docs/plans/pill-worlds-mini-dash.md Lane 3 task 1 / Lane 2 task 4).

// ---------------------------------------------------------------------------
// Project list row — same real facts, list layout.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// "All Projects" grid empty state — real, transient (unlike the honest
// permanent-disclaimer notes in the right rail below), so it earns the full
// visual + explanation + action treatment: a real folder-scan turned up
// nothing, or a search matched nothing, either of which the user can act on
// right here instead of reading a dead-end sentence.
// ---------------------------------------------------------------------------

interface ProjectsGridEmptyStateProps {
  isSearching: boolean;
  onNewProject: () => void;
  onClearSearch: () => void;
}

function ProjectsGridEmptyState({ isSearching, onNewProject, onClearSearch }: ProjectsGridEmptyStateProps) {
  return (
    <div className="projects-empty">
      <span className="projects-empty__icon" aria-hidden="true">
        <FolderKanban size={20} />
      </span>
      <p className="projects-empty__title">
        {isSearching ? 'No projects match your search' : 'No project folders found'}
      </p>
      <p className="projects-empty__hint">
        {isSearching
          ? 'Try a different name, or clear the search to see everything.'
          : 'Check that ACTIVE / HOBBY / general / research exist under Development — or start a new one.'}
      </p>
      <button
        type="button"
        className="projects-screen__pill-btn"
        onClick={isSearching ? onClearSearch : onNewProject}
      >
        {isSearching ? (
          'Clear search'
        ) : (
          <>
            <Plus size={13} aria-hidden="true" />
            New Project
          </>
        )}
      </button>
    </div>
  );
}

interface ProjectListRowProps {
  project: ProjectView;
  selected: boolean;
  now: Date;
  onSelect: (key: string) => void;
  /** Deterministic room-plate background (Phase 4) — same treatment + prop
   *  shape as ProjectCard's `plate`, see ../../lib/project-plates.ts. */
  plate?: ProjectPlate;
}

function ProjectListRow({ project, selected, now, onSelect, plate }: ProjectListRowProps) {
  const { meta, state } = useProjectMeta(project.rootLabel, project.rawName);
  const facts = metaFacts(state, meta, now);
  const plateStyle = plate ? ({ '--card-plate-url': `url('${platePath(plate)}')` } as CSSProperties) : undefined;
  // Same deterministic name -> icon heuristic as the grid tile (ProjectCard,
  // src/lib/project-icon.ts) — shown inline next to the title here since the
  // list row has no portrait corner to badge.
  const TypeIcon = getProjectIcon(project.rawName);
  return (
    <button
      type="button"
      className={`project-list-row${selected ? ' project-list-row--selected' : ''}`}
      onClick={() => onSelect(project.key)}
      title={`${project.rootLabel}\\${project.rawName}`}
      style={plateStyle}
    >
      <span className="project-card__icon-tile" style={{ width: 40, height: 40 }} aria-hidden="true"><TypeIcon size={18} /></span>
      <span className="project-list-row__main">
        <span className="project-list-row__title-line">
          <TypeIcon size={13} className="project-list-row__type-icon" aria-hidden="true" />
          <span className="project-list-row__title">{project.name}</span>
        </span>
        <span className="project-list-row__desc">{project.rootLabel}</span>
      </span>
      <span className="project-list-row__meta">{facts.files} files</span>
      <span className="project-list-row__meta">{facts.size}</span>
      <span className="project-list-row__meta">{facts.created}</span>
      <span className="project-list-row__meta">{facts.lastTouched}</span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Loading skeleton — shape-matches the real hero + grid + templates layout
// below (thumb rect, title/desc lines, stat-row line, per real ProjectCard's
// own DOM shape) so the first paint reads as "your projects are loading",
// not a generic spinner, and swaps to real content with no layout jump.
// ---------------------------------------------------------------------------

function ProjectCardSkeleton() {
  return (
    <div className="project-card project-card--skeleton" aria-hidden="true">
      <div className="project-card__portrait">
        <Skeleton width={64} height={64} radius={12} />
      </div>
      <Skeleton height="0.92rem" width="70%" radius={4} />
      <Skeleton height="0.76rem" width="45%" radius={4} />
      <div className="project-card__stat-row">
        <Skeleton height="0.7rem" width="3.5rem" radius={4} />
        <Skeleton height="0.7rem" width="3rem" radius={4} />
      </div>
    </div>
  );
}

function ProjectsScreenSkeleton({ classes }: { classes: string }) {
  return (
    <div className={classes}>
      <div className="projects-screen__main">
        <div className="projects-screen__hero">
          <div className="projects-screen__hero-main">
            <div className="projects-screen__hero-title-row">
              <span className="projects-screen__hero-icon" aria-hidden="true">
                <FolderKanban size={18} />
              </span>
              <div>
                <h1 className="projects-screen__hero-title">Projects</h1>
                <p className="projects-screen__hero-sub">Scanning your project folders&hellip;</p>
              </div>
            </div>
            <div className="projects-screen__hero-stats" data-flubber-avoid="true">
              <Skeleton width={110} height={40} radius={10} />
              <Skeleton width={130} height={40} radius={10} />
            </div>
          </div>
          <div className="projects-screen__hero-mascot" aria-hidden="true">
            <FlubberCharacter expression="thinking" size={168} mode="character" showToggle={false} />
          </div>
        </div>

        <Panel accent title="All Projects" className="projects-panel">
          <div className="projects-screen__grid">
            {Array.from({ length: 8 }).map((_, i) => (
              <ProjectCardSkeleton key={i} />
            ))}
          </div>
        </Panel>
      </div>

      <div className="projects-screen__side">
        <Panel accent title="Project Overview" className="projects-panel" avoidRoam>
          <SkeletonText lines={4} lastLineWidth="50%" />
        </Panel>
        <Panel accent title="Active Agents" className="projects-panel">
          <SkeletonText lines={2} lastLineWidth="60%" />
        </Panel>
        <Panel accent title="Recent Activity" className="projects-panel">
          <SkeletonText lines={2} lastLineWidth="60%" />
        </Panel>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Project overview (right rail) — real facts for the selected project.
// ---------------------------------------------------------------------------

interface ProjectOverviewProps {
  project: ProjectView;
  starred: boolean;
  now: Date;
  onToggleStar: (key: string) => void;
  onOpenProject: (project: ProjectView) => void;
}

function ProjectOverview({ project, starred, now, onToggleStar, onOpenProject }: ProjectOverviewProps) {
  const { meta, state } = useProjectMeta(project.rootLabel, project.rawName);
  const facts = metaFacts(state, meta, now);
  // Same deterministic type icon as the grid/list — see project-icon.ts.
  const TypeIcon = getProjectIcon(project.rawName);
  return (
    <div className="project-overview">
      <div className="project-overview__header">
        <span className="project-card__icon-tile" style={{ width: 48, height: 48 }} aria-hidden="true">
          <TypeIcon size={22} />
        </span>
        <div className="project-overview__title-block">
          <span className="project-overview__title-row">
            <span className="project-overview__title">{project.name}</span>
            <button
              type="button"
              className="project-overview__star"
              onClick={() => onToggleStar(project.key)}
              aria-pressed={starred}
              aria-label={starred ? 'Unstar project' : 'Star project'}
            >
              <Star size={14} aria-hidden="true" fill={starred ? 'currentColor' : 'none'} />
            </button>
          </span>
          <span className="project-overview__meta-row">
            <Calendar size={12} aria-hidden="true" />
            <span className="project-overview__started">Created {facts.created}</span>
          </span>
        </div>
      </div>

      <p className="project-overview__desc">
        {project.rootLabel} / {project.rawName}
      </p>

      <ul className="project-overview__facts">
        <li>
          <span className="project-overview__fact-label">
            <FileText size={13} aria-hidden="true" /> Files
          </span>
          <span className="project-overview__fact-value">{facts.files}</span>
        </li>
        <li>
          <span className="project-overview__fact-label">
            <Database size={13} aria-hidden="true" /> Size
          </span>
          <span className="project-overview__fact-value">{facts.size}</span>
        </li>
        <li>
          <span className="project-overview__fact-label">
            <Calendar size={13} aria-hidden="true" /> Created
          </span>
          <span className="project-overview__fact-value">{facts.created}</span>
        </li>
        <li>
          <span className="project-overview__fact-label">
            <Clock size={13} aria-hidden="true" /> Last Activity
          </span>
          <span className="project-overview__fact-value">{facts.lastTouched}</span>
        </li>
      </ul>

      <div className="project-overview__actions">
        <button
          type="button"
          className="projects-screen__pill-btn projects-screen__pill-btn--block"
          onClick={() => onOpenProject(project)}
          title={`Switch to Terminal and launch ${project.rootLabel} → ${project.rawName}`}
        >
          Open Project
        </button>
        <button
          type="button"
          className="projects-screen__pill-btn projects-screen__pill-btn--icon"
          disabled
          title="Not built yet"
          aria-label="More project options"
        >
          <MoreHorizontal size={15} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface ProjectsScreenProps {
  className?: string;
}

// Whole-screen fetch lifecycle (separate concept from the per-card meta
// fetch state that lives in ../projects/ProjectCard.tsx).
type ScreenFetchState = 'loading' | 'error' | 'ready';

// Default visible cap for the "All Projects" grid/list — keeps the panel at
// exactly the 4x2 grid Lane 3's one-window fit is built around. "View all"
// lifts the cap; the panel itself scrolls internally when it does (see
// fit-sweep.css's max-height + overflow-y on .projects-screen__grid/__list —
// the page itself never scrolls).
const RECENT_CAP = 8;

// ---------------------------------------------------------------------------
// New Project flow — the guided, REAL folder creator (Item 7).
// ---------------------------------------------------------------------------

interface NewProjectFlowProps {
  roster: ApiAgentSummary[];
  initialTemplate?: string;
  onClose: () => void;
  onCreated: (root: string, name: string) => void;
}

function NewProjectFlow({ roster, initialTemplate, onClose, onCreated }: NewProjectFlowProps) {
  const [root, setRoot] = useState<string>('HOBBY');
  const [name, setName] = useState('');
  const [brief, setBrief] = useState('');
  // Template auto-tracks the brief until the user picks one explicitly.
  const [templateTouched, setTemplateTouched] = useState(Boolean(initialTemplate));
  const [template, setTemplate] = useState<string>(initialTemplate ?? 'web-app');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  // Recommend a template as the user types the brief — unless they've already chosen one.
  useEffect(() => {
    if (templateTouched || !brief.trim()) return;
    setTemplate(recommendTemplate(brief));
  }, [brief, templateTouched]);

  const recommended = useMemo(() => (brief.trim() ? recommendTemplate(brief) : null), [brief]);

  // Real recommended agents for the chosen template that actually exist in the
  // loaded roster — never invents a name that isn't a real agent file.
  const backingAgents = useMemo(() => {
    const wanted = TEMPLATE_AGENTS[template] ?? [];
    return wanted.filter((slug) => roster.some((a) => a.name === slug)).slice(0, 3);
  }, [template, roster]);

  const canCreate = root.length > 0 && name.trim().length > 0 && !submitting;

  const submit = useCallback(async () => {
    if (!canCreate) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ root, name: name.trim(), template }),
      });
      const data = (await res.json().catch(() => null)) as { ok?: boolean; name?: string; error?: string } | null;
      if (!res.ok || !data?.ok) {
        setError(data?.error ?? 'Could not create the project.');
        return;
      }
      onCreated(root, data.name ?? name.trim());
    } catch {
      setError('Could not reach the create endpoint.');
    } finally {
      setSubmitting(false);
    }
  }, [canCreate, root, name, template, onCreated]);

  return (
    <div
      className="np-flow"
      role="dialog"
      aria-modal="true"
      aria-label="Create a new project"
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
    >
      <div className="np-flow__panel">
        <div className="np-flow__head">
          <span className="np-flow__title">New Project</span>
          <button type="button" className="np-flow__close" onClick={onClose} aria-label="Cancel">
            <X size={16} aria-hidden="true" />
          </button>
        </div>

        <label className="np-flow__field-label">Where does it live?</label>
        <div className="np-flow__roots">
          {ROOT_META.map((r) => (
            <button
              key={r.label}
              type="button"
              className={`np-flow__root${root === r.label ? ' np-flow__root--active' : ''}`}
              onClick={() => setRoot(r.label)}
            >
              <span className="np-flow__root-name">{r.label}</span>
              <span className="np-flow__root-blurb">{r.blurb}</span>
            </button>
          ))}
        </div>

        <label className="np-flow__field-label" htmlFor="np-name">
          Project name
        </label>
        <input
          id="np-name"
          ref={nameRef}
          className="np-flow__input"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. my-new-project"
          autoComplete="off"
          spellCheck={false}
        />

        <label className="np-flow__field-label" htmlFor="np-brief">
          What are we building? <span className="np-flow__hint">(picks a template)</span>
        </label>
        <textarea
          id="np-brief"
          className="np-flow__brief"
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          placeholder="A quick line — e.g. a landing page for the pop-up, or a scraper for menu data."
          rows={2}
        />

        <label className="np-flow__field-label">Template</label>
        <div className="np-flow__templates">
          {PROJECT_TYPES.map((t) => {
            const active = template === t.key;
            const isRec = recommended === t.key;
            return (
              <button
                key={t.key}
                type="button"
                className={`np-flow__tpl${active ? ' np-flow__tpl--active' : ''}`}
                onClick={() => {
                  setTemplate(t.key);
                  setTemplateTouched(true);
                }}
              >
                <t.icon size={15} aria-hidden="true" />
                <span className="np-flow__tpl-label">{t.label}</span>
                {isRec && !active && <span className="np-flow__tpl-rec">suggested</span>}
              </button>
            );
          })}
        </div>

        {backingAgents.length > 0 && (
          <p className="np-flow__backed">
            Backed by {backingAgents.map((s) => humanizeSlug(s)).join(', ')}
          </p>
        )}

        {error && <p className="np-flow__error">{error}</p>}

        <div className="np-flow__actions">
          <button type="button" className="np-flow__cancel" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button type="button" className="np-flow__create" onClick={submit} disabled={!canCreate}>
            {submitting ? 'Creating…' : 'Create & open'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function ProjectsScreen({ className }: ProjectsScreenProps) {
  const { openProjectInTab } = useSession();
  const [roots, setRoots] = useState<ApiProjectRoot[]>([]);
  const [fetchState, setFetchState] = useState<ScreenFetchState>('loading');
  const [roster, setRoster] = useState<ApiAgentSummary[]>([]);
  // Raw /api/projects/summary rows — the single source both the recency map
  // (below) and the Project Pulse strip's weekly counts are derived from, so
  // there's only one fetch, not two competing ones.
  const [summaries, setSummaries] = useState<ApiProjectSummary[]>([]);
  const [mountedAt] = useState(() => new Date());

  const [query, setQuery] = useState('');
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [starred, setStarred] = useState<Set<string>>(() => new Set());
  const [heroPulseKey, setHeroPulseKey] = useState(0);
  const [showAll, setShowAll] = useState(false);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [newProjectTemplate, setNewProjectTemplate] = useState<string | undefined>(undefined);

  const fetchProjects = useCallback((): Promise<ApiProjectRoot[]> => {
    return fetch('/api/projects')
      .then((res) => {
        if (!res.ok) throw new Error(`projects fetch failed: ${res.status}`);
        return res.json() as Promise<{ roots?: ApiProjectRoot[] }>;
      })
      .then((data) => (Array.isArray(data?.roots) ? data.roots : []));
  }, []);

  const fetchRoster = useCallback((): Promise<ApiAgentSummary[]> => {
    return fetch('/api/agents')
      .then((res) => {
        if (!res.ok) throw new Error(`agents fetch failed: ${res.status}`);
        return res.json() as Promise<{ agents?: ApiAgentSummary[] }>;
      })
      .then((data) => (Array.isArray(data?.agents) ? data.agents : []))
      .catch(() => []);
  }, []);

  // Real recency + weekly-activity signal — see ApiProjectSummary above.
  // Never blocks the main projects/roster load; an empty array just means
  // every project sorts as "no signal" (alphabetical fallback order from
  // /api/projects, unchanged) and the Pulse strip renders its honest-empty
  // state instead of fabricating numbers.
  const fetchSummaries = useCallback((): Promise<ApiProjectSummary[]> => {
    return fetch('/api/projects/summary')
      .then((res) => {
        if (!res.ok) throw new Error(`summary fetch failed: ${res.status}`);
        return res.json() as Promise<{ projects?: ApiProjectSummary[] }>;
      })
      .then((data) => (Array.isArray(data?.projects) ? data.projects : []))
      .catch(() => []);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setFetchState('loading');
    Promise.all([fetchProjects(), fetchRoster(), fetchSummaries()])
      .then(([projectRoots, agentRoster, summaryRows]) => {
        if (cancelled) return;
        setRoots(projectRoots);
        setRoster(agentRoster);
        setSummaries(summaryRows);
        setFetchState('ready');
      })
      .catch(() => {
        if (!cancelled) setFetchState('error');
      });
    return () => {
      cancelled = true;
    };
  }, [fetchProjects, fetchRoster, fetchSummaries]);

  const handleRetry = useCallback(() => {
    setFetchState('loading');
    Promise.all([fetchProjects(), fetchRoster(), fetchSummaries()])
      .then(([projectRoots, agentRoster, summaryRows]) => {
        setRoots(projectRoots);
        setRoster(agentRoster);
        setSummaries(summaryRows);
        setFetchState('ready');
      })
      .catch(() => setFetchState('error'));
  }, [fetchProjects, fetchRoster, fetchSummaries]);

  // NEW PROJECT: opens the real guided create flow (Item 7). The hero button is
  // template-agnostic; a template card opens the same flow pre-seeded.
  const openNewProject = useCallback((template?: string) => {
    setHeroPulseKey((k) => k + 1);
    setNewProjectTemplate(template);
    setNewProjectOpen(true);
  }, []);

  // A real project was just created on disk — open it in a terminal tab and
  // re-scan the folders so it shows up in the grid immediately.
  const handleProjectCreated = useCallback(
    (root: string, name: string) => {
      setNewProjectOpen(false);
      fetchProjects()
        .then((projectRoots) => setRoots(projectRoots))
        .catch(() => {});
      openProjectInTab(root, name);
    },
    [fetchProjects, openProjectInTab],
  );

  // OPEN PROJECT, NO QUESTIONS: switches to the Terminal screen and points
  // Blubber's narration at the exact real folder — see
  // SessionProvider.openProjectInTab's header comment for exactly what this
  // does and does not do yet (no confirm dialog either way).
  const handleOpenProject = useCallback(
    (project: ProjectView) => {
      openProjectInTab(project.rootLabel, project.rawName);
    },
    [openProjectInTab],
  );

  const toggleStar = useCallback((key: string) => {
    setStarred((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // modifiedAt-only view of `summaries`, derived (not re-fetched) so there's
  // exactly one network call feeding both the recency sort and the Pulse
  // strip below.
  const recency = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const entry of summaries) {
      map.set(`${entry.root}/${entry.name}`, entry.modifiedAt);
    }
    return map;
  }, [summaries]);

  const allProjects = useMemo<ProjectView[]>(() => {
    const list: ProjectView[] = [];
    for (const root of roots) {
      for (const rawName of root.projects) {
        list.push(buildProjectView(root, rawName));
      }
    }
    return list;
  }, [roots]);

  const totalProjects = allProjects.length;

  // Real recency order — most-recently-touched (by the real doc mtime from
  // /api/projects/summary) first, undated projects last. Stable relative to
  // /api/projects' own alphabetical order for ties (Array.sort is stable).
  const recentProjects = useMemo(() => {
    const withTime = allProjects.map((project) => {
      const iso = recency.get(project.key);
      const time = iso ? new Date(iso).getTime() : 0;
      return { project, time: Number.isFinite(time) ? time : 0 };
    });
    withTime.sort((a, b) => b.time - a.time);
    return withTime.map((entry) => entry.project);
  }, [allProjects, recency]);

  const isSearching = query.trim().length > 0;

  // Default (no search, not expanded): the real 8 most-recent, matching the
  // one-window 4x2 grid this Lane's fit-sweep.css is built around. Searching
  // shows every real match (not just the recent-8) since a search that hides
  // an older project because it wasn't "recent" would be a broken search.
  // "View all" lifts the cap outside of search too — the grid/list panel
  // scrolls internally for anything past the cap (fit-sweep.css), the page
  // itself never does.
  const visibleProjects = useMemo(() => {
    const trimmedQuery = query.trim().toLowerCase();
    if (trimmedQuery) return allProjects.filter((project) => project.name.toLowerCase().includes(trimmedQuery));
    return showAll ? recentProjects : recentProjects.slice(0, RECENT_CAP);
  }, [allProjects, recentProjects, query, showAll]);

  const selectedProject = useMemo<ProjectView | null>(() => {
    if (allProjects.length === 0) return null;
    const found = selectedKey ? allProjects.find((p) => p.key === selectedKey) : undefined;
    return found ?? allProjects[0];
  }, [allProjects, selectedKey]);

  // Deterministic room-plate per visible tile (Phase 4) — same shared logic
  // MiniProjects.tsx uses, computed once for whichever set is on screen
  // (grid or list share the same visibleProjects order) so grid/list toggle
  // doesn't reshuffle plates.
  const platesByKey = useMemo(() => {
    const keys = visibleProjects.map((project) => project.key);
    const assigned = assignPlates(keys);
    const map = new Map<string, ProjectPlate>();
    keys.forEach((key, i) => map.set(key, assigned[i]));
    return map;
  }, [visibleProjects]);

  // Project Pulse (Phase 4): top 5 projects by real trailing-7-day indexed
  // event count, straight from /api/projects/summary's weeklyEventCount
  // (server-computed rollup — see ApiProjectSummary above). Projects with
  // zero indexed events this week are excluded rather than shown as a flat
  // zero-width bar.
  const pulseProjects = useMemo(() => {
    return [...summaries]
      .filter((entry) => entry.weeklyEventCount > 0)
      .sort((a, b) => b.weeklyEventCount - a.weeklyEventCount)
      .slice(0, 5);
  }, [summaries]);

  const pulseMax = pulseProjects[0]?.weeklyEventCount ?? 0;

  const classes = ['projects-screen', className ?? ''].filter(Boolean).join(' ');

  if (fetchState === 'loading') {
    return <ProjectsScreenSkeleton classes={classes} />;
  }

  if (fetchState === 'error') {
    return (
      <div className={classes}>
        <Panel accent title="Projects" className="projects-panel">
          <div className="projects-screen__status-body">
            <FlubberCharacter expression="worried" size={72} mode="character" showToggle={false} />
            <div>
              <p>Couldn&rsquo;t read your project folders.</p>
              <span className="projects-screen__hint">
                Check that the Development folder is reachable, then try again.
              </span>
            </div>
          </div>
          <button type="button" className="projects-screen__pill-btn" onClick={handleRetry}>
            <RefreshCw size={13} aria-hidden="true" />
            Retry
          </button>
        </Panel>
      </div>
    );
  }

  return (
    <div className={classes}>
      <div className="projects-screen__main">
        <div className="projects-screen__hero">
          <div className="projects-screen__hero-main">
            <div className="projects-screen__hero-title-row">
              <span className="projects-screen__hero-icon" aria-hidden="true">
                <FolderKanban size={18} />
              </span>
              <div>
                <h1 className="projects-screen__hero-title">Projects</h1>
                <p className="projects-screen__hero-sub">Organize your work. Track progress. Build the future.</p>
              </div>
            </div>

            <div className="projects-screen__hero-stats" data-flubber-avoid="true">
              <StatChip label="Total Projects" value={totalProjects} />
              <StatChip label="Agents Available" value={roster.length} />
              <button
                type="button"
                className="projects-screen__new-btn"
                onClick={() => openNewProject()}
                title="Create a real new project folder"
              >
                <Plus size={14} aria-hidden="true" />
                New Project
              </button>
            </div>
          </div>

          <div className="projects-screen__hero-mascot" aria-hidden="true">
            <FlubberCharacter expression="happy" size={168} mode="character" showToggle={false} pulseKey={heroPulseKey} />
          </div>
        </div>

        <Panel
          accent
          title="All Projects"
          className="projects-panel"
          action={
            <div className="projects-screen__controls">
              <div className="projects-screen__view-toggle" role="group" aria-label="Switch view">
                <button
                  type="button"
                  className={`projects-screen__view-btn${viewMode === 'grid' ? ' projects-screen__view-btn--active' : ''}`}
                  onClick={() => setViewMode('grid')}
                  aria-pressed={viewMode === 'grid'}
                  title="Grid view"
                >
                  <LayoutGrid size={13} aria-hidden="true" />
                  Grid
                </button>
                <button
                  type="button"
                  className={`projects-screen__view-btn${viewMode === 'list' ? ' projects-screen__view-btn--active' : ''}`}
                  onClick={() => setViewMode('list')}
                  aria-pressed={viewMode === 'list'}
                  title="List view"
                >
                  <List size={13} aria-hidden="true" />
                  List
                </button>
              </div>

              <div className="projects-screen__search">
                <Search size={14} aria-hidden="true" />
                <input
                  type="text"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search projects..."
                  aria-label="Search projects"
                />
              </div>

              {!isSearching && totalProjects > RECENT_CAP && (
                <button
                  type="button"
                  className="projects-panel-link"
                  onClick={() => setShowAll((v) => !v)}
                  aria-pressed={showAll}
                  title={showAll ? 'Show only the 8 most recent' : `Show all ${totalProjects} projects`}
                >
                  {showAll ? 'Show recent' : `View all (${totalProjects})`}
                </button>
              )}
            </div>
          }
        >
          {visibleProjects.length === 0 ? (
            <ProjectsGridEmptyState
              isSearching={isSearching}
              onNewProject={() => openNewProject()}
              onClearSearch={() => setQuery('')}
            />
          ) : viewMode === 'grid' ? (
            <div className="projects-screen__grid">
              {visibleProjects.map((project) => (
                <ProjectCard
                  key={project.key}
                  project={project}
                  selected={selectedProject?.key === project.key}
                  starred={starred.has(project.key)}
                  now={mountedAt}
                  onSelect={setSelectedKey}
                  thumbSize={64}
                  plate={platesByKey.get(project.key)}
                />
              ))}
            </div>
          ) : (
            <div className="projects-screen__list">
              {visibleProjects.map((project) => (
                <ProjectListRow
                  key={project.key}
                  project={project}
                  selected={selectedProject?.key === project.key}
                  now={mountedAt}
                  onSelect={setSelectedKey}
                  plate={platesByKey.get(project.key)}
                />
              ))}
            </div>
          )}
        </Panel>

        {/* Project Stats folded away — it was an honest-empty placeholder
            (no weekly task/agent/code metrics tracked in this build). The
            real numbers it would have echoed (Total Projects, Agents
            Available) already live in the hero strip above, so Templates
            takes the full bottom row instead of splitting it with an empty
            panel (Lane 3 task 1: "compress or fold into the hero strip"). */}
        <Panel accent title="Project Templates" className="projects-panel">
          <p className="projects-screen__subtitle">Start a real new project — pick a template.</p>
          <div className="projects-screen__templates">
            {PROJECT_TYPES.map((template) => (
              <button
                key={template.key}
                type="button"
                className="template-card"
                onClick={() => openNewProject(template.key)}
                title={`New ${template.label} — scaffolds a real folder`}
              >
                <span className="template-card__icon" aria-hidden="true">
                  <template.icon size={16} />
                </span>
                <span className="template-card__info">
                  <span className="template-card__label">{template.label}</span>
                  <span className="template-card__sub">{template.sub}</span>
                </span>
              </button>
            ))}
          </div>
        </Panel>
      </div>

      <div className="projects-screen__side">
        <Panel accent title="Project Overview" className="projects-panel" avoidRoam>
          {selectedProject ? (
            <ProjectOverview
              project={selectedProject}
              starred={starred.has(selectedProject.key)}
              now={mountedAt}
              onToggleStar={toggleStar}
              onOpenProject={handleOpenProject}
            />
          ) : (
            <p className="projects-screen__empty-note">No project selected yet.</p>
          )}
        </Panel>

        <Panel accent title="Active Agents" className="projects-panel">
          <p className="projects-screen__empty-note">
            Per-project agent assignments aren&rsquo;t tracked in this build. The full agent roster lives on the Agents
            screen.
          </p>
        </Panel>

        <Panel accent title="Recent Activity" className="projects-panel">
          <p className="projects-screen__empty-note">Per-project activity isn&rsquo;t recorded in this build yet.</p>
        </Panel>
      </div>

      {/* Project Pulse (Phase 4, last-hard-push): full-width strip under both
          columns — real trailing-7-day per-project event counts from the same
          indexed usage.db rollup /api/projects/summary already computes
          (getProjectActivityRollup), never fabricated. Fills the bottom void
          that was flagged with something the user would actually read: who they've
          really been working in this week, not a decorative empty panel. */}
      <Panel accent title="Project Pulse — This Week" className="projects-panel projects-screen__pulse-panel" avoidRoam>
        {pulseProjects.length === 0 ? (
          <p className="projects-screen__empty-note">
            No indexed project activity in the last 7 days yet — work a session and this fills in.
          </p>
        ) : (
          <div className="pulse-strip">
            {pulseProjects.map((entry, i) => {
              const key = `${entry.root}/${entry.name}`;
              // 0-1 fill ratio, floored so even a small count still reads as
              // a visible sliver — consumed by the bar's `transform: scaleX()`
              // (compositor-friendly; never an animated `width`).
              const ratio = pulseMax > 0 ? Math.max(0.06, entry.weeklyEventCount / pulseMax) : 0;
              const barStyle = { '--pulse-pct': ratio } as CSSProperties;
              return (
                <div key={key} className={`pulse-row${i === 0 ? ' pulse-row--top' : ''}`}>
                  <span className="pulse-row__icon" aria-hidden="true">
                    <Activity size={12} />
                  </span>
                  <span className="pulse-row__name" title={`${entry.root} / ${entry.name}`}>
                    {humanizeSlug(entry.name)}
                  </span>
                  <span className="pulse-row__track">
                    <span className="pulse-row__bar" style={barStyle} />
                  </span>
                  <span className="pulse-row__count">{entry.weeklyEventCount}</span>
                </div>
              );
            })}
          </div>
        )}
      </Panel>

      {newProjectOpen && (
        <NewProjectFlow
          roster={roster}
          initialTemplate={newProjectTemplate}
          onClose={() => setNewProjectOpen(false)}
          onCreated={handleProjectCreated}
        />
      )}
    </div>
  );
}
