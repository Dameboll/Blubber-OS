// GET /api/projects/summary
//
// A one-line real summary per project, sourced straight from whatever doc
// that project already has: docs/ai-context.md (preferred — it's the
// cross-tool sync file), then CLAUDE.md, then README.md. The first
// meaningful paragraph (headings, frontmatter, and badge lines skipped) is
// extracted and capped at 280 chars. If none of those files exist, summary
// is null and source is null — an honest empty state, never invented copy.
//
// Enumerates the same four root folders /api/projects does, and every
// resolved path is guarded exactly like /api/projects/meta and
// /api/projects/thumb (fixed root labels, no separators in the project
// name, resolved path must stay inside the root). Per-project TTL cache so
// a full dashboard load doesn't re-read every project's docs on every poll.
//
// lastActivityAt / weeklyEventCount (last-hard-push Phase 1): real per-project
// numbers from the SAME indexed usage.db rollup the rest of the dashboard
// reads (getProjectActivityRollup, one grouped query, sub-100ms) — never a
// fresh filesystem walk. `lastActivityAt` is the max indexed transcript-event
// timestamp attributed to that project (real work, not "when a doc was last
// saved"); `modifiedAt` stays as-is below for backward compat / fallback on
// projects with zero indexed sessions. `weeklyEventCount` is the same
// trailing-7-day count a future "Project Pulse" widget can read directly from
// this response — no separate route needed for that (see report/handoff).

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { ensureIndexed } from "../../../../server/log-indexer";
import { getProjectActivityRollup } from "../../../../server/db";
import { isWorkspaceConnected } from "../../../../server/connected-store";
import {
  getProjectRoots,
  resolveProjectEntry,
  type ProjectRootDefinition,
} from "../../../../server/project-roots";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CACHE_TTL_MS = 10 * 60_000;
const MAX_SUMMARY_LENGTH = 280;

type SummarySource = "claude-md" | "readme" | "ai-context" | null;

export interface ProjectSummary {
  /** Stable project-root id (legacy defaults remain ACTIVE/HOBBY/etc.). */
  root: string;
  rootLabel: string;
  /** Exact allowlisted project directory, used to open custom-root projects. */
  path: string;
  name: string;
  summary: string | null;
  source: SummarySource;
  modifiedAt: string | null;
  /** Real max indexed transcript-event timestamp for this project (any real
   * Claude session activity), or null when no session has ever been indexed
   * for it. Prefer this for "last worked on" sort order; fall back to
   * `modifiedAt` (a doc file's mtime) only when this is null. */
  lastActivityAt: string | null;
  /** Real indexed event count for this project over the trailing 7 days. */
  weeklyEventCount: number;
}

// Preferred doc, in priority order, with the source label the API reports.
const CANDIDATES: { relPath: string; source: SummarySource }[] = [
  { relPath: path.join("docs", "ai-context.md"), source: "ai-context" },
  { relPath: "CLAUDE.md", source: "claude-md" },
  { relPath: "README.md", source: "readme" },
  { relPath: "Readme.md", source: "readme" },
  { relPath: "readme.md", source: "readme" },
];

const cache = new Map<string, { summary: ProjectSummary; expiresAt: number }>();

async function listSubdirectories(root: string): Promise<string[]> {
  try {
    const entries = await fsp.readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch (err) {
    console.error(`[api/projects/summary] could not read ${root}:`, err);
    return [];
  }
}

/** First meaningful paragraph of a markdown doc: frontmatter, HTML comments,
 * headings, horizontal rules, and image/badge-only lines are skipped. Returns
 * null if the doc has no real prose (e.g. it's only a heading + badges). */
function firstMeaningfulParagraph(raw: string): string | null {
  let text = raw;
  if (text.startsWith("---")) {
    const end = text.indexOf("\n---", 3);
    if (end !== -1) text = text.slice(end + 4);
  }
  // ai-context.md files open with editor-directive comments ("<!-- Auto-
  // generated... -->") — never prose, so strip all HTML comments up front.
  text = text.replace(/<!--[\s\S]*?-->/g, "");

  const paragraph: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) {
      if (paragraph.length > 0) break;
      continue;
    }
    if (/^#{1,6}\s/.test(line)) continue; // heading
    if (/^[-*_]{3,}$/.test(line)) continue; // horizontal rule
    if (/^(\[!\[.*?\]\(.*?\)\]\(.*?\)\s*)+$/.test(line)) continue; // badge row
    if (/^!\[.*?\]\(.*?\)$/.test(line)) continue; // bare image
    if (/^>\s*$/.test(line)) continue;
    paragraph.push(line);
  }

  if (paragraph.length === 0) return null;
  let joined = paragraph.join(" ").replace(/\s+/g, " ").trim();
  if (joined.length === 0) return null;

  if (joined.length > MAX_SUMMARY_LENGTH) {
    const cut = joined.slice(0, MAX_SUMMARY_LENGTH);
    const lastSpace = cut.lastIndexOf(" ");
    joined = (lastSpace > 200 ? cut.slice(0, lastSpace) : cut).trimEnd() + "…";
  }
  return joined;
}

// lastActivityAt/weeklyEventCount are filled in by GET() from the real
// usage.db rollup after this doc-derived summary is cached -- they're
// deliberately left as honest placeholders here (never guessed) so this
// function's only job stays "read the doc", not "also know about SQLite".
function docSummary(
  root: ProjectRootDefinition,
  name: string,
  fields: Pick<ProjectSummary, "summary" | "source" | "modifiedAt">
): ProjectSummary {
  return {
    root: root.id,
    rootLabel: root.label,
    path: path.join(root.path, name),
    name,
    lastActivityAt: null,
    weeklyEventCount: 0,
    ...fields,
  };
}

async function summarizeProject(root: ProjectRootDefinition, name: string): Promise<ProjectSummary> {
  for (const candidate of CANDIDATES) {
    const abs = resolveProjectEntry(root.id, name, candidate.relPath);
    if (!abs) continue;
    try {
      const [raw, stat] = await Promise.all([fsp.readFile(abs, "utf8"), fsp.stat(abs)]);
      const summary = firstMeaningfulParagraph(raw);
      if (summary) {
        return docSummary(root, name, { summary, source: candidate.source, modifiedAt: stat.mtime.toISOString() });
      }
    } catch {
      continue; // this candidate doesn't exist / isn't readable — try the next
    }
  }

  return docSummary(root, name, { summary: null, source: null, modifiedAt: null });
}

async function getCachedSummary(root: ProjectRootDefinition, name: string): Promise<ProjectSummary> {
  const key = `${root.id}/${name}`;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) return hit.summary;

  const summary = await summarizeProject(root, name);
  cache.set(key, { summary, expiresAt: now + CACHE_TTL_MS });
  return summary;
}

export async function GET() {
  try {
    const workspaceConnected = isWorkspaceConnected();
    const registeredRoots = getProjectRoots();
    // Match /api/projects' placeholder-shell boundary. Summaries now include
    // exact paths, so returning them before workspace consent would leak the
    // local username and folder layout.
    if (!workspaceConnected && !registeredRoots.some((root) => root.custom)) {
      return NextResponse.json({ projects: [] });
    }

    const roots = workspaceConnected
      ? registeredRoots
      : registeredRoots.filter((root) => root.custom);
    const customRootIds = new Set(roots.filter((root) => root.custom).map((root) => root.id));
    const perRoot = await Promise.all(
      roots.map(async (root) => {
        if (!fs.existsSync(root.path)) return [] as ProjectSummary[];
        const names = await listSubdirectories(root.path);
        return Promise.all(names.map((name) => getCachedSummary(root, name)));
      })
    );

    // Same throttled background pass every other real-data route uses
    // (agents-live, weekly, recent, top-agents) -- kicks an incremental
    // index pass at most once per 8s and returns immediately; the rollup
    // query right below reads whatever is already persisted in SQLite.
    const rollup: ReturnType<typeof getProjectActivityRollup> = new Map();
    if (workspaceConnected) {
      ensureIndexed();
      for (const [name, activity] of getProjectActivityRollup(7)) {
        rollup.set(name, activity);
      }
    }

    const projects = perRoot.flat().map((p) => {
      // New rows use the root-qualified key. Default roots also accept legacy
      // basename-only rows from before project_key existed. Merge both periods
      // so a migration never drops earlier activity from the same project.
      const qualified = rollup.get(`${p.root}/${p.name}`);
      const legacy = customRootIds.has(p.root) ? undefined : rollup.get(p.name);
      const real =
        qualified && legacy
          ? {
              lastActivityAt:
                qualified.lastActivityAt > legacy.lastActivityAt
                  ? qualified.lastActivityAt
                  : legacy.lastActivityAt,
              weeklyEventCount: qualified.weeklyEventCount + legacy.weeklyEventCount,
            }
          : qualified ?? legacy;
      return {
        ...p,
        lastActivityAt: real?.lastActivityAt ?? null,
        weeklyEventCount: real?.weeklyEventCount ?? 0,
      };
    });

    return NextResponse.json({ projects });
  } catch (err) {
    console.error("[api/projects/summary] GET failed:", err);
    return NextResponse.json({ error: "failed to summarize projects" }, { status: 500 });
  }
}
