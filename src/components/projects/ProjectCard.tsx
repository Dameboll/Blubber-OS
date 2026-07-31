'use client';

/**
 * ProjectCard — the real per-project grid tile (deterministic type icon + name
 * + real file facts). The card's main visual is the keyword-mapped icon from
 * getProjectIcon (src/lib/project-icon.ts), an honest type hint that beats the
 * old random folder-image scan. `useProjectMeta` / `metaFacts` read real
 * filesystem facts (file count, size, created/last-touched) from
 * GET /api/projects/meta, server-cached, fetched lazily per card on mount.
 */

import { useEffect, useState, type CSSProperties } from 'react';
import { Clock, Database, FileText, Star } from 'lucide-react';
import { humanizeSlug } from '../../lib/humanize';
import { getProjectIcon } from '../../lib/project-icon';
import { platePath, type ProjectPlate } from '../../lib/project-plates';

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

export interface ApiProjectRoot {
  id?: string;
  label: string;
  root: string;
  projects: string[];
  custom?: boolean;
  kind?: "project" | "container";
}

export interface ProjectView {
  key: string;
  name: string;
  rawName: string;
  rootId: string;
  rootLabel: string;
  rootPath: string;
  path: string;
}

export function buildProjectView(root: ApiProjectRoot, rawName: string): ProjectView {
  const rootId = root.id ?? root.label;
  const separator = root.root.includes('\\') ? '\\' : '/';
  const projectPath =
    root.kind === "project"
      ? root.root
      : root.root.endsWith(separator)
        ? `${root.root}${rawName}`
        : `${root.root}${separator}${rawName}`;
  return {
    key: `${rootId}/${rawName}`,
    name: humanizeSlug(rawName),
    rawName,
    rootId,
    rootLabel: root.label,
    rootPath: root.root,
    path: projectPath,
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
export function useProjectMeta(rootId: string, rawName: string): { meta: ProjectMeta | null; state: FetchState } {
  const [meta, setMeta] = useState<ProjectMeta | null>(null);
  const [state, setState] = useState<FetchState>('loading');

  useEffect(() => {
    let cancelled = false;
    setState('loading');
    setMeta(null);
    const url = `/api/projects/meta?root=${encodeURIComponent(rootId)}&name=${encodeURIComponent(rawName)}`;
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
  }, [rootId, rawName]);

  return { meta, state };
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
  const { meta, state } = useProjectMeta(project.rootId, project.rawName);
  const facts = metaFacts(state, meta, now);
  // Per-card plate image handed to ProjectsScreen.css's `::before` pseudo
  // via a CSS custom property (same technique as MusicPlayerScreen's scrub
  // fill / SettingsScreen's slider fill) — the negative-z pseudo-element
  // pair (::before plate, ::after scrim) paints behind this card's own
  // in-flow, non-positioned content automatically, so no content markup
  // below needs touching or an explicit z-index of its own.
  const plateStyle = plate ? ({ '--card-plate-url': `url('${platePath(plate)}')` } as CSSProperties) : undefined;
  // Deterministic keyword-heuristic icon from the folder's real name (see
  // src/lib/project-icon.ts) — a small honest type hint, not a random pick;
  // the same folder always gets the same badge.
  const TypeIcon = getProjectIcon(project.rawName);
  return (
    <button
      type="button"
      className={`project-card${selected ? ' project-card--selected' : ''}`}
      onClick={() => onSelect(project.key)}
      title={`${project.rootLabel}\\${project.rawName}`}
      style={plateStyle}
    >
      {/* Main visual = the deterministic keyword-mapped type icon, big, on a
          tinted tile. The old ProjectThumb folder-image scan read as RANDOM
          (it grabbed whatever image happened to live in the folder — a doc
          screenshot, an asset, anything), which made the grid feel senseless.
          One honest icon that matches what the project IS beats a lucky-dip
          image. ProjectThumb still serves the compact list rows. */}
      <header className="project-card__portrait">
        <span
          className="project-card__icon-tile"
          style={{ width: thumbSize, height: thumbSize }}
          aria-hidden="true"
        >
          <TypeIcon size={Math.round(thumbSize * 0.45)} />
        </span>
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
