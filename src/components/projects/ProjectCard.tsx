'use client';

/**
 * ProjectCard — the real per-project grid tile (portrait + name + real file
 * facts), extracted out of ProjectsScreen so DashboardScreen's mini "Projects"
 * tab (Lane 2) can render the exact same card instead of a second
 * reimplementation. Everything here is real data:
 *
 * - `ProjectThumb` renders the real per-project image from
 *   GET /api/projects/thumb, falling back to a shiny mid-tier Flubber3D slot
 *   only when the folder genuinely has no usable image (never a fake asset).
 * - `useProjectMeta` / `metaFacts` read real filesystem facts (file count,
 *   size, created/last-touched) from GET /api/projects/meta, server-cached,
 *   fetched lazily per card on mount.
 *
 * Both ProjectsScreen.tsx (full grid) and DashboardScreen's mini Projects tab
 * import from here — see docs/plans/pill-worlds-mini-dash.md Lane 3 task 1.
 */

import { useEffect, useState, type CSSProperties } from 'react';
import { Clock, Database, FileText, Star } from 'lucide-react';
import type { FlubberExpression } from '../FlubberCharacter';
import Flubber3D from '../Flubber3D';
import { humanizeSlug } from '../../lib/humanize';
import { platePath, type ProjectPlate } from '../../lib/project-plates';

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

export interface ApiProjectRoot {
  label: string;
  root: string;
  projects: string[];
}

export interface ProjectView {
  key: string;
  name: string;
  rawName: string;
  rootLabel: string;
}

export function buildProjectView(root: ApiProjectRoot, rawName: string): ProjectView {
  return {
    key: `${root.label}/${rawName}`,
    name: humanizeSlug(rawName),
    rawName,
    rootLabel: root.label,
  };
}

// ---------------------------------------------------------------------------
// Real-fact formatting
// ---------------------------------------------------------------------------

export interface ProjectMeta {
  fileCount: number;
  sizeBytes: number;
  createdAt: string | null;
  modifiedAt: string | null;
  truncated: boolean;
}

type FetchState = 'loading' | 'error' | 'ready';

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exp;
  const rounded = exp === 0 || value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[exp]}`;
}

function formatDateAbs(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatRelative(iso: string | null, now: Date): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const minutes = Math.round((now.getTime() - then) / 60_000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days}d ago`;
  if (days < 60) return `${Math.round(days / 7)}w ago`;
  return formatDateAbs(iso);
}

export interface MetaFacts {
  files: string;
  size: string;
  created: string;
  lastTouched: string;
}

export function metaFacts(state: FetchState, meta: ProjectMeta | null, now: Date): MetaFacts {
  if (state !== 'ready' || !meta) {
    const placeholder = state === 'loading' ? '…' : '—';
    return { files: placeholder, size: placeholder, created: placeholder, lastTouched: placeholder };
  }
  const count = meta.truncated ? `${meta.fileCount.toLocaleString()}+` : meta.fileCount.toLocaleString();
  return {
    files: count,
    size: formatBytes(meta.sizeBytes),
    created: formatDateAbs(meta.createdAt),
    lastTouched: formatRelative(meta.modifiedAt, now),
  };
}

// Lazy per-project filesystem facts. The route is server-cached (10-min TTL),
// so a full grid of cards each fetching once on mount is cheap and de-duped
// server-side. Facts are static-ish (not live-ticking), so no poll — just a
// single fetch with a cancel guard.
export function useProjectMeta(rootLabel: string, rawName: string): { meta: ProjectMeta | null; state: FetchState } {
  const [meta, setMeta] = useState<ProjectMeta | null>(null);
  const [state, setState] = useState<FetchState>('loading');

  useEffect(() => {
    let cancelled = false;
    setState('loading');
    setMeta(null);
    const url = `/api/projects/meta?root=${encodeURIComponent(rootLabel)}&name=${encodeURIComponent(rawName)}`;
    fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(`meta fetch failed: ${res.status}`);
        return res.json() as Promise<ProjectMeta>;
      })
      .then((data) => {
        if (cancelled) return;
        setMeta(data);
        setState('ready');
      })
      .catch(() => {
        if (!cancelled) setState('error');
      });
    return () => {
      cancelled = true;
    };
  }, [rootLabel, rawName]);

  return { meta, state };
}

// ---------------------------------------------------------------------------
// Real per-project thumbnail
// ---------------------------------------------------------------------------

const THUMB_EXPRESSION: FlubberExpression = 'happy';

export interface ProjectThumbProps {
  root: string;
  name: string;
  expression?: FlubberExpression;
  size: number;
}

// Real per-project thumbnail: the actual representative image discovered by
// GET /api/projects/thumb (curated agent pick first, else a live heuristic
// scan of the folder). Falls back to a Blubber portrait only when the folder
// genuinely has no usable image (route 404s) — never a fake asset.
export function ProjectThumb({ root, name, expression = THUMB_EXPRESSION, size }: ProjectThumbProps) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    // Fallback portrait renders in compact list/row/mini cards well below
    // FlubberCharacter's auto-micro cutoff (<64px), which would flatten it to
    // the dull matcap. Render the shared-host slot directly at tier="mid" so
    // every fallback reads as the shiny clearcoat jelly (host caps + overflows
    // to micro past its global MID budget, so this stays perf-safe).
    return <Flubber3D expression={expression} size={size} tier="mid" />;
  }
  const src = `/api/projects/thumb?root=${encodeURIComponent(root)}&name=${encodeURIComponent(name)}`;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- serving real bytes from an outside-of-/public folder route, next/image can't proxy it
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      onError={() => setFailed(true)}
      className="project-thumb"
      style={{
        width: size,
        height: size,
        objectFit: 'cover',
        borderRadius: 12,
        display: 'block',
        background: 'rgba(0, 0, 0, 0.35)',
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Project card (grid tile) — real facts fetched lazily on mount.
// ---------------------------------------------------------------------------

export interface ProjectCardProps {
  project: ProjectView;
  selected: boolean;
  starred: boolean;
  now: Date;
  onSelect: (key: string) => void;
  /** Grid thumb size (px). Defaults to the full ProjectsScreen size; the
   *  Dashboard mini tab passes a smaller value to fit its tile. Icon size is
   *  independent of the plate below — Phase 4 adds a background only. */
  thumbSize?: number;
  /** Deterministic room-plate background (see ../../lib/project-plates.ts).
   *  Omit for no plate — the card falls back to its plain elevated surface. */
  plate?: ProjectPlate;
}

export function ProjectCard({ project, selected, starred, now, onSelect, thumbSize = 64, plate }: ProjectCardProps) {
  const { meta, state } = useProjectMeta(project.rootLabel, project.rawName);
  const facts = metaFacts(state, meta, now);
  // Per-card plate image handed to ProjectsScreen.css's `::before` pseudo
  // via a CSS custom property (same technique as MusicPlayerScreen's scrub
  // fill / SettingsScreen's slider fill) — the negative-z pseudo-element
  // pair (::before plate, ::after scrim) paints behind this card's own
  // in-flow, non-positioned content automatically, so no content markup
  // below needs touching or an explicit z-index of its own.
  const plateStyle = plate ? ({ '--card-plate-url': `url('${platePath(plate)}')` } as CSSProperties) : undefined;
  return (
    <button
      type="button"
      className={`project-card${selected ? ' project-card--selected' : ''}`}
      onClick={() => onSelect(project.key)}
      title={`${project.rootLabel}\\${project.rawName}`}
      style={plateStyle}
    >
      <header className="project-card__portrait">
        <ProjectThumb root={project.rootLabel} name={project.rawName} expression={THUMB_EXPRESSION} size={thumbSize} />
      </header>

      <h4 className="project-card__title">
        {project.name}
        {starred && <Star size={13} className="project-card__star" aria-hidden="true" />}
      </h4>
      <p className="project-card__desc">{project.rootLabel}</p>

      <div className="project-card__stat-row">
        <span>
          <FileText size={12} aria-hidden="true" /> {facts.files} files
        </span>
        <span>
          <Database size={12} aria-hidden="true" /> {facts.size}
        </span>
        <span>
          <Clock size={12} aria-hidden="true" /> {facts.lastTouched}
        </span>
      </div>
    </button>
  );
}
