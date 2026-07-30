'use client';

/**
 * MiniProjects — Dashboard "Projects" tab (renamed from "Files", PILL WORLDS
 * + MINI DASH, Lane 2). A real 8-most-recent grid (4x2), sorted by real
 * per-project last-worked-in-it activity (`lastActivityAt`, the max indexed
 * transcript-event timestamp) from GET /api/projects/summary, falling back to
 * the doc mtime (`modifiedAt`) for any project with zero indexed sessions —
 * see `sortTimestamp()` below. Same cheap, server-cached route the
 * Memory/Projects screens already trust — no full per-project filesystem walk
 * needed just to sort a dashboard tile.
 *
 * Each card's icon is the deterministic keyword-mapped type icon from the real
 * folder name (src/lib/project-icon.ts) — the same honest badge the Projects
 * screen grid uses. (Was the old random folder-image thumbnail, which read as
 * a lucky-dip of whatever image happened to live in the folder.)
 *
 * FINAL STRETCH Lane 2+3: live 30s poll + focus refetch with a FLIP reorder
 * animation (transform/opacity only, reduced-motion aware), a "hot" accent
 * on whichever project is now most-recently-touched, and a deterministic
 * per-card room-plate background reused from the existing public/bg/role-*
 * plate library (see src/styles/pill-room.css for the plate/scrim recipe
 * this project follows — z-index is set EXPLICITLY on both the plate layer
 * and the content layer per that file's documented gotcha: room plates were
 * previously invisible on 7 pills because z-index:0 was missing).
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { FolderOpen } from 'lucide-react';
import { getProjectIcon } from '../../lib/project-icon';
import { useSession } from '../../context/SessionProvider';
import { humanizeSlug } from '../../lib/humanize';
import './MiniProjects.css';

interface ProjectSummaryEntry {
  root: string;
  rootLabel?: string;
  path?: string;
  name: string;
  summary: string | null;
  modifiedAt: string | null;
  /** Real max indexed transcript-event timestamp for this project (actual
   * worked-in-it signal), or null when no session has ever been indexed for
   * it. Preferred sort key over `modifiedAt` — see GET /api/projects/summary. */
  lastActivityAt: string | null;
}

type LoadState = 'loading' | 'ready' | 'error';

const MAX_RECENT = 8;
const POLL_INTERVAL_MS = 30_000;

// Deterministic per-project room plate, reused from the shared plate library
// (public/bg/role-*.webp) — same assets AgentWorkstation/AgentsScreen already
// use for agent role nooks, no new art generated.
const PROJECT_PLATES = [
  'role-architect',
  'role-architect2',
  'role-coder',
  'role-coder2',
  'role-data',
  'role-data2',
  'role-designer',
  'role-designer2',
  'role-devops',
  'role-devops2',
  'role-editor',
  'role-editor2',
  'role-innovator',
  'role-innovator2',
  'role-marketer',
  'role-marketer2',
  'role-qa',
  'role-qa2',
  'role-researcher',
  'role-researcher2',
  'role-security',
  'role-security2',
  'role-writer',
  'role-writer2',
] as const;

function hashString(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function assignPlates(entries: ProjectSummaryEntry[]): string[] {
  const plates = entries.map((p) => {
    const idx = hashString(`${p.root}/${p.name}`) % PROJECT_PLATES.length;
    return PROJECT_PLATES[idx];
  });
  // Best-effort: nudge adjacent duplicates so neighboring cards don't share
  // the exact same plate.
  for (let i = 1; i < plates.length; i++) {
    if (plates[i] === plates[i - 1]) {
      const idx = (hashString(`${entries[i].root}/${entries[i].name}`) + 1) % PROJECT_PLATES.length;
      plates[i] = PROJECT_PLATES[idx];
    }
  }
  return plates;
}

function cardKey(p: ProjectSummaryEntry): string {
  return `${p.root}/${p.name}`;
}

/** Real "the user worked here" sort key: real indexed transcript activity wins
 * over a doc file's mtime. Falls back to `modifiedAt` only when a project has
 * no indexed sessions yet (lastActivityAt null), and to 0 when neither is
 * present, so unsorted/never-touched projects sink to the bottom. */
function sortTimestamp(p: ProjectSummaryEntry): number {
  const source = p.lastActivityAt ?? p.modifiedAt;
  return source ? Date.parse(source) : 0;
}

export default function MiniProjects() {
  const { openProjectInTab, openTabWith } = useSession();
  const [projects, setProjects] = useState<ProjectSummaryEntry[]>([]);
  const [state, setState] = useState<LoadState>('loading');

  const cardRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const prevRectsRef = useRef<Map<string, DOMRect> | null>(null);

  const load = useCallback(() => {
    // Snapshot current card positions BEFORE the fetch resolves, so the
    // upcoming re-render can FLIP from where cards actually are right now.
    const rects = new Map<string, DOMRect>();
    cardRefs.current.forEach((el, key) => {
      rects.set(key, el.getBoundingClientRect());
    });
    prevRectsRef.current = rects;

    return fetch('/api/projects/summary')
      .then((res) => {
        if (!res.ok) throw new Error(`projects summary fetch failed: ${res.status}`);
        return res.json() as Promise<{ projects?: ProjectSummaryEntry[] }>;
      })
      .then((json) => {
        const list = Array.isArray(json.projects) ? json.projects : [];
        const sorted = [...list].sort((a, b) => sortTimestamp(b) - sortTimestamp(a));
        setProjects(sorted.slice(0, MAX_RECENT));
        setState('ready');
      })
      .catch(() => {
        setState('error');
      });
  }, []);

  useEffect(() => {
    let cancelled = false;
    load();

    const interval = setInterval(() => {
      if (!cancelled) load();
    }, POLL_INTERVAL_MS);

    const onFocus = () => {
      if (!cancelled) load();
    };
    const onVisibility = () => {
      if (!cancelled && document.visibilityState === 'visible') load();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      clearInterval(interval);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [load]);

  // FLIP: after the DOM reflects the new order, measure new positions and
  // transform each moved card back to its old spot, then transition to 0.
  useLayoutEffect(() => {
    const prevRects = prevRectsRef.current;
    if (!prevRects || prevRects.size === 0) return;
    prevRectsRef.current = null;

    const reduceMotion =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    cardRefs.current.forEach((el, key) => {
      const prev = prevRects.get(key);
      if (!prev) return;
      const next = el.getBoundingClientRect();
      const dx = prev.left - next.left;
      const dy = prev.top - next.top;
      if (!dx && !dy) return;

      if (reduceMotion) return;

      el.style.transition = 'none';
      el.style.transform = `translate(${dx}px, ${dy}px)`;
      // Force a layout flush so the browser registers the start position
      // before we transition to the resting transform.
      void el.getBoundingClientRect();
      el.style.transition = 'transform 280ms cubic-bezier(0.16, 1, 0.3, 1)';
      el.style.transform = 'translate(0, 0)';

      const clear = () => {
        el.style.transition = '';
        el.style.transform = '';
        el.removeEventListener('transitionend', clear);
      };
      el.addEventListener('transitionend', clear);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects]);

  const plates = useMemo(() => assignPlates(projects), [projects]);

  return (
    <div className="mini-projects">
      <div className="mini-projects__head">
        <FolderOpen size={13} aria-hidden="true" />
        <span>Projects</span>
        <span className="mini-projects__count">{state === 'ready' ? projects.length : '—'}</span>
      </div>
      <div className="mini-projects__body">
        {state === 'loading' && <p className="mini-projects__empty">Loading projects…</p>}
        {state === 'error' && <p className="mini-projects__empty">Couldn&rsquo;t load projects.</p>}
        {state === 'ready' && projects.length === 0 && (
          <p className="mini-projects__empty">No project folders found.</p>
        )}
        {state === 'ready' && projects.length > 0 && (
          <div className="mini-projects__grid">
            {projects.map((p, i) => {
              const key = cardKey(p);
              const plate = plates[i];
              // Deterministic keyword-mapped type icon from the real folder name
              // (src/lib/project-icon.ts) — same honest badge the Projects screen
              // grid uses, replacing the old random folder-image thumbnail.
              const TypeIcon = getProjectIcon(p.name);
              return (
                <button
                  key={key}
                  ref={(el) => {
                    if (el) cardRefs.current.set(key, el);
                    else cardRefs.current.delete(key);
                  }}
                  type="button"
                  className={`mini-projects__card${i === 0 ? ' mini-projects__card--hot' : ''}`}
                  title={`Open ${p.name} in a terminal tab`}
                  onClick={() =>
                    p.path
                      ? openTabWith({ title: p.name, cwd: p.path })
                      : openProjectInTab(p.root, p.name)
                  }
                >
                  <span
                    className="mini-projects__card-plate"
                    style={{ backgroundImage: `url('/bg/${plate}.webp')` }}
                    aria-hidden="true"
                  />
                  <span className="mini-projects__card-scrim" aria-hidden="true" />
                  <span className="mini-projects__card-content">
                    <span className="mini-projects__card-icon" aria-hidden="true">
                      <TypeIcon size={30} />
                    </span>
                    <span className="mini-projects__card-name">{humanizeSlug(p.name)}</span>
                    <span className="mini-projects__card-root">{p.rootLabel ?? p.root}</span>
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
