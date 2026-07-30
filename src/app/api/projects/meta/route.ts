// GET /api/projects/meta?root=<root-id>&name=<folder>
//
// Real filesystem facts for one allowlisted project folder. Large repositories
// are walked asynchronously in bounded batches so the metadata cards cannot
// block the local app server or make the rest of Blubber appear frozen.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { resolveProjectDir } from "../../../../server/project-roots";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PRUNE = new Set([
  "node_modules", ".git", ".next", "dist", "build", "out",
  ".turbo", ".cache", ".vercel", "coverage", ".venv", "__pycache__",
]);
const MAX_DEPTH = 5;
const MAX_FILES = 12_000;
const STAT_BATCH_SIZE = 64;
const CACHE_TTL_MS = 10 * 60_000;

export interface ProjectMeta {
  fileCount: number;
  sizeBytes: number;
  createdAt: string | null;
  modifiedAt: string | null;
  truncated: boolean;
}

const cache = new Map<string, { meta: ProjectMeta; expiresAt: number }>();
const inFlight = new Map<string, Promise<ProjectMeta>>();

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function scan(dir: string): Promise<ProjectMeta> {
  let createdAt: string | null = null;
  try {
    createdAt = (await fsp.stat(dir)).birthtime.toISOString();
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
      entries = await fsp.readdir(item.p, { withFileTypes: true });
    } catch {
      continue;
    }

    const files: string[] = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (PRUNE.has(entry.name) || entry.name.startsWith(".")) continue;
        if (item.depth < MAX_DEPTH) stack.push({ p: path.join(item.p, entry.name), depth: item.depth + 1 });
      } else if (entry.isFile()) {
        files.push(path.join(item.p, entry.name));
      }
    }

    const remaining = MAX_FILES - fileCount;
    const selectedFiles = files.slice(0, remaining);
    if (selectedFiles.length < files.length) truncated = true;
    fileCount += selectedFiles.length;

    for (let i = 0; i < selectedFiles.length; i += STAT_BATCH_SIZE) {
      const stats = await Promise.all(
        selectedFiles.slice(i, i + STAT_BATCH_SIZE).map(async (filePath) => {
          try {
            return await fsp.stat(filePath);
          } catch {
            return null;
          }
        }),
      );

      for (const st of stats) {
        if (!st) continue;
        sizeBytes += st.size;
        if (st.mtimeMs > latestMtime) latestMtime = st.mtimeMs;
      }

      // Project cards request metadata together. Yield between bounded batches
      // so those scans never freeze unrelated routes or the folder picker.
      await yieldToEventLoop();
    }

    if (fileCount >= MAX_FILES) {
      if (stack.length > 0) truncated = true;
      break;
    }
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

  const dir = resolveProjectDir(root, name);
  if (!dir) return NextResponse.json({ error: "invalid project" }, { status: 400 });

  const key = `${root}/${name}`;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) return NextResponse.json(hit.meta);

  if (!fs.existsSync(dir)) return NextResponse.json({ error: "not found" }, { status: 404 });

  let pending = inFlight.get(key);
  if (!pending) {
    pending = scan(dir);
    inFlight.set(key, pending);
  }

  try {
    const meta = await pending;
    cache.set(key, { meta, expiresAt: Date.now() + CACHE_TTL_MS });
    return NextResponse.json(meta);
  } finally {
    if (inFlight.get(key) === pending) inFlight.delete(key);
  }
}
