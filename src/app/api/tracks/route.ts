/**
 * /api/tracks
 *
 * GET    — lists audio files in music/ (relative to the project root, i.e.
 *          process.cwd() since server.js/next both run from the project
 *          dir). Creates the folder if it doesn't exist yet — the user
 *          hasn't dropped any tracks in there yet, so an empty/missing folder
 *          is the expected default state, not an error.
 * POST   — uploads a new track into that same folder (multipart/form-data,
 *          field name "file").
 * DELETE — removes a track file (?id=<filename>) and scrubs it out of every
 *          playlist that referenced it.
 *
 * Response shape (GET):
 *   { tracks: [{ id, title, file, sizeBytes, artist?, album?, hasArt }] }
 *
 * - `file` is the filename only (e.g. "midnight-drive.mp3"). The player
 *   fetches actual audio bytes from `/api/audio/<file>` — see the note in
 *   MusicPlayer.tsx about the static-serving requirement.
 * - `title` is the ID3 TIT2 tag when a track has one (mp3 only), otherwise
 *   the filename with its extension stripped.
 * - `artist`/`album` come from ID3 TPE1/TALB when present — omitted (not
 *   fabricated) when a track has no tag or isn't an mp3.
 * - `hasArt` tells the client whether `/api/cover/<id>` has anything to
 *   serve (auto-extracted or custom-uploaded) — see cover-art-store.ts.
 * - `id` is the filename itself (stable, unique within the folder).
 *
 * Music files are USER CONTENT — never touched by /api/reset.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { removeTrackEverywhere } from "@/server/playlist-store";
import { deleteCustomCover, getTracksMetadata } from "@/server/cover-art-store";

export interface Track {
  id: string;
  title: string;
  file: string;
  sizeBytes: number;
  artist?: string;
  album?: string;
  hasArt: boolean;
}

import { MUSIC_DIR } from "../../../server/app-dirs";
const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".m4a", ".ogg"]);
const MAX_UPLOAD_BYTES = 60 * 1024 * 1024; // 60MB

function titleFromFilename(filename: string): string {
  const ext = path.extname(filename);
  return filename.slice(0, filename.length - ext.length);
}

/** Reject anything that isn't a plain filename living directly in MUSIC_DIR
 * — no separators, no "..", no empty string. Shared by POST/DELETE so both
 * paths apply identical scrutiny to user-supplied names. */
function isSafeFilename(name: string): boolean {
  if (!name) return false;
  if (name.includes("/") || name.includes("\\") || name.includes("..")) return false;
  if (name !== path.basename(name)) return false;
  return true;
}

/** Strip anything that isn't a safe filename character, collapsing the rest
 * to hyphens, so an uploaded "My Song (final) v2!.mp3" becomes a clean,
 * URL-safe name instead of being rejected outright. */
function sanitizeUploadName(rawName: string): { base: string; ext: string } | null {
  const original = path.basename(rawName);
  const ext = path.extname(original).toLowerCase();
  if (!AUDIO_EXTENSIONS.has(ext)) return null;

  const rawBase = original.slice(0, original.length - ext.length);
  const cleaned = rawBase
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");

  const base = cleaned || "track";
  return { base, ext };
}

/** Resolve a collision-free filename inside MUSIC_DIR by appending -1, -2,
 * etc. until a free name is found. */
async function resolveAvailableFilename(base: string, ext: string): Promise<string> {
  let candidate = `${base}${ext}`;
  let suffix = 1;
  // Cap the search so a pathological case can't loop forever.
  while (suffix < 10_000) {
    try {
      await fs.access(path.join(MUSIC_DIR, candidate));
      candidate = `${base}-${suffix}${ext}`;
      suffix++;
    } catch {
      return candidate;
    }
  }
  return `${base}-${Date.now()}${ext}`;
}

/** Pre-enrichment shape — just what we need to ask cover-art-store for
 *  cached/extracted metadata, kept separate from the public Track type so
 *  mtimeMs (an internal staleness key) never leaks into the API response. */
interface RawEntry {
  id: string;
  title: string;
  file: string;
  sizeBytes: number;
  mtimeMs: number;
}

export async function GET() {
  try {
    await fs.mkdir(MUSIC_DIR, { recursive: true });

    const entries = await fs.readdir(MUSIC_DIR, { withFileTypes: true });

    const rawTracks: RawEntry[] = await Promise.all(
      entries
        .filter((entry) => entry.isFile())
        .filter((entry) => AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
        .map(async (entry) => {
          let sizeBytes = 0;
          let mtimeMs = 0;
          try {
            const stat = await fs.stat(path.join(MUSIC_DIR, entry.name));
            sizeBytes = stat.size;
            mtimeMs = stat.mtimeMs;
          } catch {
            // Vanished between readdir and stat — report 0 rather than fail
            // the whole list.
          }
          return {
            id: entry.name,
            title: titleFromFilename(entry.name),
            file: entry.name,
            sizeBytes,
            mtimeMs,
          };
        })
    );

    // ID3 metadata + cover-art extraction (mp3 only, cached — see
    // cover-art-store.ts). Batched into one call so a folder full of new
    // tracks doesn't do N sequential index read/write round trips.
    const metaMap = await getTracksMetadata(
      rawTracks.map((t) => ({
        trackId: t.id,
        filePath: path.join(MUSIC_DIR, t.file),
        sizeBytes: t.sizeBytes,
        mtimeMs: t.mtimeMs,
        isMp3: path.extname(t.file).toLowerCase() === ".mp3",
      }))
    );

    const tracks: Track[] = rawTracks.map((t) => {
      const meta = metaMap.get(t.id);
      const tagTitle = meta?.title?.trim();
      return {
        id: t.id,
        // A real ID3 title beats the filename-derived fallback; an empty/
        // missing tag keeps the honest filename-based title as before.
        title: tagTitle ? tagTitle : t.title,
        file: t.file,
        sizeBytes: t.sizeBytes,
        artist: meta?.artist,
        album: meta?.album,
        hasArt: meta?.hasArt ?? false,
      };
    });

    tracks.sort((a, b) => a.title.localeCompare(b.title));

    return NextResponse.json({ tracks });
  } catch (error) {
    console.error("[/api/tracks] failed to list music folder:", error);
    // Fail soft — an empty playlist, not a 500, so the player renders its
    // empty-state instead of erroring out.
    return NextResponse.json({ tracks: [] });
  }
}

export async function POST(request: NextRequest) {
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "expected multipart/form-data" }, { status: 400 });
  }

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "missing 'file' field" }, { status: 400 });
  }

  const sanitized = sanitizeUploadName(file.name);
  if (!sanitized) {
    return NextResponse.json(
      { error: "unsupported file type — allowed: .mp3, .wav, .m4a, .ogg" },
      { status: 400 }
    );
  }

  if (file.size <= 0) {
    return NextResponse.json({ error: "empty file" }, { status: 400 });
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return NextResponse.json({ error: "file exceeds 60MB limit" }, { status: 413 });
  }

  try {
    await fs.mkdir(MUSIC_DIR, { recursive: true });

    const filename = await resolveAvailableFilename(sanitized.base, sanitized.ext);
    const targetPath = path.join(MUSIC_DIR, filename);

    const bytes = Buffer.from(await file.arrayBuffer());
    await fs.writeFile(targetPath, bytes);

    const track: Track = {
      id: filename,
      title: titleFromFilename(filename),
      file: filename,
      sizeBytes: bytes.length,
      hasArt: false, // fresh upload — ID3 extraction happens lazily on the next GET /api/tracks
    };

    return NextResponse.json({ track });
  } catch (error) {
    console.error("[/api/tracks] upload failed:", error);
    return NextResponse.json({ error: "failed to save upload" }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id") ?? "";

  if (!isSafeFilename(id)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }

  const targetPath = path.join(MUSIC_DIR, id);

  try {
    await fs.unlink(targetPath);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    console.error(`[/api/tracks] delete failed for ${id}:`, error);
    return NextResponse.json({ error: "failed to delete" }, { status: 500 });
  }

  try {
    removeTrackEverywhere(id);
  } catch (error) {
    // File is already gone — don't fail the request over a cleanup issue,
    // but do surface it in logs so a stray playlist reference is debuggable.
    console.error(`[/api/tracks] playlist cleanup failed for ${id}:`, error);
  }

  try {
    await deleteCustomCover("track", id);
  } catch (error) {
    console.error(`[/api/tracks] custom cover cleanup failed for ${id}:`, error);
  }

  return NextResponse.json({ ok: true });
}
