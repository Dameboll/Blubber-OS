/**
 * GET /api/projects/thumb?root=<ACTIVE|HOBBY|general|research>&name=<folder>
 *
 * Streams ONE real, representative image out of a real project folder so the
 * Projects screen can show an actual thumbnail per project instead of a
 * seeded Blubber. Every byte served is a real file that already lives on disk
 * in that project — nothing is generated or faked.
 *
 * Asset selection, in order:
 *   1. Curated pick — data/project-thumbs.json (written by the
 *      "project-thumbnail-grab" workflow: one agent per project chose the
 *      single most recognizable asset). Keyed "<root>/<name>" -> { asset }.
 *   2. Heuristic scan — if no curated pick (or its file moved), a bounded
 *      depth-limited walk of the folder scores image files by identity signal
 *      (favicon/icon/logo/og/hero/cover > screenshot/mockup > anything) and
 *      picks the best. This keeps thumbnails LIVE: change a project's assets
 *      and the thumbnail follows, no re-run needed.
 *   3. 404 — folder has no usable image; the card falls back to its Blubber.
 *
 * Path-traversal guard: `root` must be one of the four fixed labels, `name`
 * may not contain a separator or "..", and every resolved asset path (curated
 * or scanned) must stay inside the project folder.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { DATA_DIR } from "../../../../server/app-dirs";
import {
  resolveContainedProjectPath,
  resolveProjectDir,
} from "../../../../server/project-roots";

const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".avif": "image/avif",
};

const IMAGE_EXTS = new Set(Object.keys(CONTENT_TYPES));
const PRUNE_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  "coverage",
  ".cache",
  ".turbo",
  ".vercel",
  "out",
]);

const MAX_DEPTH = 3;
const MAX_DIRS = 240;
const MAX_FILES = 600;
const MIN_BYTES = 200; // skip 1px spacers / empty files
const MAX_BYTES = 12 * 1024 * 1024; // skip huge source art if anything smaller exists
const SCAN_TTL_MS = 60_000;

const curatedPath = path.join(DATA_DIR, "project-thumbs.json");

// -- curated picks (re-read only when the file's mtime changes) --------------

interface CuratedEntry {
  asset: string;
  label?: string;
}
let curatedCache: { mtimeMs: number; map: Record<string, CuratedEntry> } | null = null;

function readCurated(): Record<string, CuratedEntry> {
  try {
    const stat = fs.statSync(curatedPath);
    if (curatedCache && curatedCache.mtimeMs === stat.mtimeMs) return curatedCache.map;
    const parsed = JSON.parse(fs.readFileSync(curatedPath, "utf8")) as Record<string, CuratedEntry>;
    curatedCache = { mtimeMs: stat.mtimeMs, map: parsed };
    return parsed;
  } catch {
    return {};
  }
}

// -- heuristic scan (cached per project for a short TTL) ---------------------

interface ScanCacheEntry {
  at: number;
  asset: string | null;
}
const scanCache = new Map<string, ScanCacheEntry>();

function nameScore(nameLower: string): number {
  if (/favicon|app[-_]?icon|(^|[-_])icon([-_]|\.|$)|logo|wordmark|brandmark/.test(nameLower)) return 5000;
  if (/(^|[-_])og([-_]|\.|$)|opengraph|hero|cover|banner|key[-_]?art|splash|poster/.test(nameLower)) return 4000;
  if (/brand|mark|badge|emblem|avatar|profile/.test(nameLower)) return 3500;
  if (/screenshot|mockup|preview|render|showcase|thumb/.test(nameLower)) return 2500;
  return 1000;
}

function extBonus(ext: string, nameLower: string): number {
  // crisp vector/icon formats are better identity marks
  if ((ext === ".svg" || ext === ".ico" || ext === ".png") && /icon|logo|favicon|mark/.test(nameLower)) return 400;
  if (ext === ".svg") return 150;
  return 0;
}

interface Candidate {
  abs: string;
  score: number;
}

function scanForAsset(projectDir: string): string | null {
  const cached = scanCache.get(projectDir);
  if (cached && Date.now() - cached.at < SCAN_TTL_MS) return cached.asset;

  let dirsSeen = 0;
  let filesSeen = 0;
  let best: Candidate | null = null;

  // BFS so shallower (more likely identity) files are considered first and the
  // file cap doesn't get eaten by one deep asset directory.
  const queue: { dir: string; depth: number }[] = [{ dir: projectDir, depth: 0 }];
  while (queue.length > 0 && dirsSeen < MAX_DIRS && filesSeen < MAX_FILES) {
    const { dir, depth } = queue.shift()!;
    dirsSeen += 1;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (PRUNE_DIRS.has(entry.name)) continue;
        if (depth + 1 <= MAX_DEPTH) queue.push({ dir: full, depth: depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!IMAGE_EXTS.has(ext)) continue;
      filesSeen += 1;
      if (filesSeen > MAX_FILES) break;

      let size = 0;
      try {
        size = fs.statSync(full).size;
      } catch {
        continue;
      }
      if (size < MIN_BYTES || size > MAX_BYTES) continue;

      const nameLower = entry.name.toLowerCase();
      const dirLower = path.basename(dir).toLowerCase();
      let score = nameScore(nameLower) + extBonus(ext, nameLower);
      if (dirLower === "public" || dirLower === "assets" || dirLower === "static" || dirLower === "brand") score += 300;
      score -= depth * 40; // prefer shallower
      if (best === null || score > best.score) best = { abs: full, score };
    }
  }

  const asset = best ? best.abs : null;
  scanCache.set(projectDir, { at: Date.now(), asset });
  return asset;
}

// -- resolution helpers ------------------------------------------------------

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function resolveCurated(projectDir: string, rootName: string): string | null {
  const entry = readCurated()[rootName];
  if (!entry || typeof entry.asset !== "string" || entry.asset.length === 0) return null;
  const abs = path.resolve(projectDir, entry.asset);
  if (!isInside(projectDir, abs)) return null;
  if (!IMAGE_EXTS.has(path.extname(abs).toLowerCase())) return null;
  try {
    const st = fs.statSync(abs);
    // Empty/corrupt or absurdly large picks fall through to the heuristic scan
    // rather than serving a blank <img> (e.g. a 0-byte placeholder svg).
    if (!st.isFile() || st.size < MIN_BYTES || st.size > MAX_BYTES) return null;
  } catch {
    return null;
  }
  return abs;
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const root = searchParams.get("root") ?? "";
  const name = searchParams.get("name") ?? "";

  if (!name || name.includes("..") || name.includes("/") || name.includes("\\")) {
    return NextResponse.json({ error: "invalid name" }, { status: 400 });
  }

  const projectDir = resolveProjectDir(root, name);
  if (!projectDir) return NextResponse.json({ error: "invalid root" }, { status: 400 });
  try {
    if (!fs.statSync(projectDir).isDirectory()) {
      return NextResponse.json({ error: "not a folder" }, { status: 404 });
    }
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const rootName = `${root}/${name}`;
  const assetPath = resolveCurated(projectDir, rootName) ?? scanForAsset(projectDir);
  if (!assetPath) {
    return NextResponse.json({ error: "no image" }, { status: 404 });
  }
  const containedAssetPath = resolveContainedProjectPath(projectDir, assetPath);
  if (!containedAssetPath) {
    return NextResponse.json({ error: "invalid image path" }, { status: 400 });
  }

  const ext = path.extname(containedAssetPath).toLowerCase();
  const contentType = CONTENT_TYPES[ext] ?? "application/octet-stream";
  try {
    const bytes = await fsp.readFile(containedAssetPath);
    return new NextResponse(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(bytes.length),
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch (error) {
    console.error(`[/api/projects/thumb] read failed for ${rootName}:`, error);
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
}
