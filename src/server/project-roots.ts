/**
 * Persistent project-root registry.
 *
 * Blubber's original project browser only knew four folders under
 * ~/Development. Real customers keep repositories in many other places, so a
 * folder chosen through Electron's native picker is stored here and survives
 * app restarts. Downstream routes resolve projects through this registry
 * instead of trusting an arbitrary absolute path supplied by the renderer.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { db } from "./db";

const PROJECT_ROOTS_KEY = "project_roots_v1";
const MAX_CUSTOM_ROOTS = 24;

export const DEFAULT_PROJECT_ROOT_LABELS = ["ACTIVE", "HOBBY", "general", "research"] as const;
export type DefaultProjectRootLabel = (typeof DEFAULT_PROJECT_ROOT_LABELS)[number];

interface StoredProjectRoots {
  version: 1;
  paths: string[];
}

export interface ProjectRootDefinition {
  /** Stable query/API key. Default roots retain their legacy label as the id. */
  id: string;
  label: string;
  path: string;
  custom: boolean;
}

export interface AddProjectRootResult {
  ok: boolean;
  added?: boolean;
  root?: ProjectRootDefinition;
  error?: string;
}

function canonicalForCompare(value: string): string {
  const normalized = path.normalize(value).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function customRootId(rootPath: string): string {
  return `custom-${crypto.createHash("sha256").update(canonicalForCompare(rootPath)).digest("hex").slice(0, 16)}`;
}

function defaultRoots(): ProjectRootDefinition[] {
  const devRoot = path.join(os.homedir(), "Development");
  return DEFAULT_PROJECT_ROOT_LABELS.map((label) => ({
    id: label,
    label,
    path: path.join(devRoot, label),
    custom: false,
  }));
}

function readStoredPaths(): string[] {
  const row = db.prepare(`SELECT value FROM app_meta WHERE key = ?`).get(PROJECT_ROOTS_KEY) as
    | { value: string }
    | undefined;
  if (!row) return [];

  try {
    const parsed = JSON.parse(row.value) as Partial<StoredProjectRoots>;
    if (parsed.version !== 1 || !Array.isArray(parsed.paths)) return [];
    return parsed.paths.filter((entry): entry is string => typeof entry === "string" && path.isAbsolute(entry));
  } catch {
    return [];
  }
}

function writeStoredPaths(paths: string[]): void {
  const payload: StoredProjectRoots = { version: 1, paths };
  db.prepare(
    `INSERT INTO app_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(PROJECT_ROOTS_KEY, JSON.stringify(payload));
}

function transcriptSlugSuffix(projectPath: string): string {
  return path
    .resolve(projectPath)
    .split(/[\\/]/)
    .filter(Boolean)
    .map((part) => part.replace(/[^A-Za-z0-9]/g, "-"))
    .join("-");
}

/** A newly registered custom root may already have transcripts that were
 * indexed as unattributed before Blubber knew that path. Rewind only matching
 * transcript offsets; source-id upserts backfill project/project_key without
 * double-counting any events. */
function rewindIndexedTranscriptsForRoot(rootPath: string): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(rootPath, { withFileTypes: true });
  } catch {
    return;
  }
  const suffixes = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => transcriptSlugSuffix(path.join(rootPath, entry.name)));
  if (suffixes.length === 0) return;

  const claudeProjectsDir = path.join(os.homedir(), ".claude", "projects");
  const indexed = db.prepare(`SELECT file_path FROM indexed_files`).all() as { file_path: string }[];
  const rewind = db.prepare(`UPDATE indexed_files SET last_size = 0 WHERE file_path = ?`);
  const compare = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value);

  const transaction = db.transaction(() => {
    for (const { file_path: filePath } of indexed) {
      const rel = path.relative(claudeProjectsDir, filePath);
      if (rel.startsWith("..") || path.isAbsolute(rel)) continue;
      const slugDir = rel.split(path.sep)[0] ?? "";
      if (suffixes.some((suffix) => compare(slugDir).endsWith(compare(suffix)))) {
        rewind.run(filePath);
      }
    }
  });
  transaction();
}

export function getProjectRoots(): ProjectRootDefinition[] {
  const defaults = defaultRoots();
  const seen = new Set(defaults.map((root) => canonicalForCompare(root.path)));
  const custom: ProjectRootDefinition[] = [];

  for (const storedPath of readStoredPaths()) {
    const normalized = path.normalize(storedPath);
    const canonical = canonicalForCompare(normalized);
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    custom.push({
      id: customRootId(normalized),
      label: path.basename(normalized) || normalized,
      path: normalized,
      custom: true,
    });
  }

  return [...defaults, ...custom];
}

export function hasCustomProjectRoots(): boolean {
  return getProjectRoots().some((root) => root.custom);
}

export function addProjectRoot(rawPath: string): AddProjectRootResult {
  if (typeof rawPath !== "string" || rawPath.trim().length === 0) {
    return { ok: false, error: "Choose a project folder" };
  }
  if (!path.isAbsolute(rawPath)) {
    return { ok: false, error: "Project folder must be an absolute path" };
  }

  let resolved: string;
  try {
    resolved = fs.realpathSync(rawPath);
    if (!fs.statSync(resolved).isDirectory()) {
      return { ok: false, error: "Selected path is not a folder" };
    }
  } catch {
    return { ok: false, error: "Selected folder is missing or unreadable" };
  }

  if (canonicalForCompare(resolved) === canonicalForCompare(path.parse(resolved).root)) {
    return { ok: false, error: "Choose a projects folder, not an entire drive" };
  }

  const roots = getProjectRoots();
  const existing = roots.find((root) => canonicalForCompare(root.path) === canonicalForCompare(resolved));
  if (existing) return { ok: true, added: false, root: existing };

  const stored = readStoredPaths();
  if (stored.length >= MAX_CUSTOM_ROOTS) {
    return { ok: false, error: `Blubber supports up to ${MAX_CUSTOM_ROOTS} custom project folders` };
  }

  writeStoredPaths([...stored, resolved]);
  rewindIndexedTranscriptsForRoot(resolved);
  const root: ProjectRootDefinition = {
    id: customRootId(resolved),
    label: path.basename(resolved) || resolved,
    path: resolved,
    custom: true,
  };
  return { ok: true, added: true, root };
}

export function removeProjectRoot(id: string): boolean {
  const target = getProjectRoots().find((root) => root.custom && root.id === id);
  if (!target) return false;
  const next = readStoredPaths().filter(
    (storedPath) => canonicalForCompare(storedPath) !== canonicalForCompare(target.path)
  );
  writeStoredPaths(next);
  return true;
}

/** Forget every custom folder during Settings' deliberate master reset. */
export function resetProjectRoots(): void {
  db.prepare(`DELETE FROM app_meta WHERE key = ?`).run(PROJECT_ROOTS_KEY);
}

export function resolveProjectRoot(id: string): ProjectRootDefinition | null {
  return getProjectRoots().find((root) => root.id === id) ?? null;
}

/**
 * Resolve one direct child of an allowlisted project root. The child name is
 * deliberately restricted to one path segment, then fenced again with
 * path.relative so custom roots cannot become a traversal primitive.
 */
export function resolveProjectDir(rootId: string, name: string): string | null {
  const root = resolveProjectRoot(rootId);
  if (!root || !name || name.includes("/") || name.includes("\\") || name.includes("..")) return null;
  const target = path.resolve(root.path, name);
  const rel = path.relative(root.path, target);
  if (rel !== name || rel.startsWith("..") || path.isAbsolute(rel)) return null;

  // The lexical fence above is not enough for a junction/symlink child. If
  // the target exists, resolve both sides and require the real target to stay
  // inside the real allowlisted root before any metadata route reads it.
  try {
    const realRoot = fs.realpathSync(root.path);
    const realTarget = fs.realpathSync(target);
    const realRel = path.relative(realRoot, realTarget);
    if (realRel.startsWith("..") || path.isAbsolute(realRel)) return null;
    return realTarget;
  } catch {
    // Preserve downstream 404 behavior for a missing child. An existing but
    // unreadable/broken-link target is rejected instead of bypassing the
    // realpath fence.
    return fs.existsSync(target) ? null : target;
  }
}

/** Resolve an existing file/directory candidate without allowing a nested
 * symlink or junction to escape its already-allowlisted project directory. */
export function resolveContainedProjectPath(projectDir: string, candidatePath: string): string | null {
  const lexicalCandidate = path.resolve(candidatePath);
  const lexicalRel = path.relative(projectDir, lexicalCandidate);
  if (lexicalRel.startsWith("..") || path.isAbsolute(lexicalRel)) return null;

  try {
    const realProject = fs.realpathSync(projectDir);
    const realCandidate = fs.realpathSync(lexicalCandidate);
    const realRel = path.relative(realProject, realCandidate);
    if (realRel.startsWith("..") || path.isAbsolute(realRel)) return null;
    return realCandidate;
  } catch {
    return null;
  }
}

/** Resolve one existing path below a registered project with both lexical and
 * realpath containment checks. */
export function resolveProjectEntry(rootId: string, name: string, relativePath: string): string | null {
  const projectDir = resolveProjectDir(rootId, name);
  if (!projectDir) return null;
  return resolveContainedProjectPath(projectDir, path.resolve(projectDir, relativePath));
}
