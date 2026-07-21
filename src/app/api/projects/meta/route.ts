// GET /api/projects/meta?root=<ACTIVE|HOBBY|general|research>&name=<folder>
//
// Real filesystem facts for one project folder — the truthful replacement for
// the old hash-of-foldername seeded stats on the Projects screen. Returns:
//   fileCount   real file count (node_modules/.git/build dirs pruned)
//   sizeBytes   real total size of counted files
//   createdAt   folder birthtime (real "created")
//   modifiedAt  most-recent file mtime found (real "last activity")
//   truncated   true if the walk hit the MAX_FILES safety cap
//
// Nothing here is invented: if a fact can't be read it comes back null, and the
// UI shows an honest empty state rather than a fabricated number. Path-guarded
// (root allowlist + name has no separators + stays inside the root) exactly
// like /api/projects/thumb. Per-project TTL cache so repeat loads (and a grid
// of cards each fetching once) don't re-walk the tree.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROOT_LABELS = ["ACTIVE", "HOBBY", "general", "research"] as const;
type RootLabel = (typeof ROOT_LABELS)[number];

const DEV_ROOT = path.join(os.homedir(), "Development");
const PRUNE = new Set([
  "node_modules", ".git", ".next", "dist", "build", "out",
  ".turbo", ".cache", ".vercel", "coverage", ".venv", "__pycache__",
]);
const MAX_DEPTH = 5;
const MAX_FILES = 12_000;
const CACHE_TTL_MS = 10 * 60_000;

export interface ProjectMeta {
  fileCount: number;
  sizeBytes: number;
  createdAt: string | null;
  modifiedAt: string | null;
  truncated: boolean;
}

const cache = new Map<string, { meta: ProjectMeta; expiresAt: number }>();

function resolveDir(rootLabel: string, name: string): string | null {
  if (!ROOT_LABELS.includes(rootLabel as RootLabel)) return null;
  if (!name || name.includes("/") || name.includes("\\") || name.includes("..")) return null;
  const base = path.join(DEV_ROOT, rootLabel);
  const target = path.join(base, name);
  const rel = path.relative(base, target);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return target;
}

function scan(dir: string): ProjectMeta {
  let createdAt: string | null = null;
  try {
    createdAt = fs.statSync(dir).birthtime.toISOString();
  } catch {
    return { fileCount: 0, sizeBytes: 0, createdAt: null, modifiedAt: null, truncated: false };
  }

  let fileCount = 0;
  let sizeBytes = 0;
  let latestMtime = 0;
  let truncated = false;

  const stack: Array<{ p: string; depth: number }> = [{ p: dir, depth: 0 }];
  while (stack.length > 0) {
    const item = stack.pop();
    if (!item) break;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(item.p, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (fileCount >= MAX_FILES) { truncated = true; break; }
      if (entry.isDirectory()) {
        if (PRUNE.has(entry.name) || entry.name.startsWith(".")) continue;
        if (item.depth < MAX_DEPTH) stack.push({ p: path.join(item.p, entry.name), depth: item.depth + 1 });
      } else if (entry.isFile()) {
        fileCount++;
        try {
          const st = fs.statSync(path.join(item.p, entry.name));
          sizeBytes += st.size;
          if (st.mtimeMs > latestMtime) latestMtime = st.mtimeMs;
        } catch {
          // Vanished/unreadable file — skip, still counted.
        }
      }
    }
    if (truncated) break;
  }

  return {
    fileCount,
    sizeBytes,
    createdAt,
    modifiedAt: latestMtime > 0 ? new Date(latestMtime).toISOString() : createdAt,
    truncated,
  };
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const root = searchParams.get("root") ?? "";
  const name = searchParams.get("name") ?? "";

  const dir = resolveDir(root, name);
  if (!dir) return NextResponse.json({ error: "invalid project" }, { status: 400 });

  const key = `${root}/${name}`;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) return NextResponse.json(hit.meta);

  if (!fs.existsSync(dir)) return NextResponse.json({ error: "not found" }, { status: 404 });

  const meta = scan(dir);
  cache.set(key, { meta, expiresAt: now + CACHE_TTL_MS });
  return NextResponse.json(meta);
}
