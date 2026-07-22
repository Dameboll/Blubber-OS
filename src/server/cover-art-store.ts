/**
 * cover-art-store.ts
 *
 * Disk cache + small JSON index for track/playlist cover art — both
 * auto-extracted (from ID3 APIC frames via id3-parser.ts) and user-uploaded
 * custom covers. Same "flat JSON file + atomic rename write" pattern as
 * playlist-store.ts (see that file's header for why: small, human-inspectable
 * shape, no query power needed, and rename() is atomic on both POSIX and
 * NTFS so a crash mid-write never leaves a truncated index).
 *
 * On-disk layout:
 *   data/cover-art/index.json           — the index below
 *   data/cover-art/<hash>.<ext>          — auto-extracted art, one per track
 *   data/cover-art/custom/<hash>.<ext>   — user-uploaded art (track or playlist)
 *
 * Every cached image file is named by a SHA-1 hash of a stable key, never by
 * the raw track filename or playlist id — track filenames come from
 * whatever the user (or a previous uploader) named the file and can contain
 * characters that are awkward or unsafe on a filesystem (Windows especially).
 * Hashing sidesteps sanitizing every possible input.
 *
 * Auto-extraction is cached against the SOURCE FILE's size + mtime, so a
 * track re-uploaded/replaced under the same filename gets re-parsed instead
 * of serving stale art, and a track confirmed to have no embedded art is
 * remembered as such (hasArt: false) so /api/tracks doesn't re-run the ID3
 * parser on every single request — only on the first request after a track
 * shows up or changes.
 */

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { readId3Tags } from "./id3-parser";

const DATA_DIR = path.join(process.cwd(), "data");
const COVER_DIR = path.join(DATA_DIR, "cover-art");
const CUSTOM_DIR = path.join(COVER_DIR, "custom");
const INDEX_PATH = path.join(COVER_DIR, "index.json");

const KNOWN_EXTS = ["jpg", "png", "webp", "gif"] as const;

interface AutoEntry {
  hasArt: boolean;
  ext?: string; // present only when hasArt is true
  sizeBytes: number; // source audio file size at extraction time — staleness check
  mtimeMs: number; // source audio file mtime at extraction time
  title?: string;
  artist?: string;
  album?: string;
}

interface CustomEntry {
  ext: string;
}

interface CoverIndexShape {
  auto: Record<string, AutoEntry>; // keyed by track id (filename)
  custom: Record<string, CustomEntry>; // keyed by `${kind}:${id}`
}

async function ensureDirs(): Promise<void> {
  await fs.mkdir(CUSTOM_DIR, { recursive: true }); // creates COVER_DIR too (parent of custom/)
}

async function readIndex(): Promise<CoverIndexShape> {
  try {
    const raw = await fs.readFile(INDEX_PATH, "utf-8");
    const parsed = JSON.parse(raw) as Partial<CoverIndexShape>;
    return { auto: parsed.auto ?? {}, custom: parsed.custom ?? {} };
  } catch {
    // Missing file (first run) or corrupt JSON — start clean rather than
    // throwing, same fail-soft philosophy as playlist-store.ts.
    return { auto: {}, custom: {} };
  }
}

async function writeIndex(index: CoverIndexShape): Promise<void> {
  await ensureDirs();
  const tmpPath = `${INDEX_PATH}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(index, null, 2), "utf-8");
  await fs.rename(tmpPath, INDEX_PATH);
}

function hashKey(key: string): string {
  return crypto.createHash("sha1").update(key).digest("hex");
}

function extFromMime(mime: string): string {
  const clean = mime.toLowerCase().trim();
  if (clean.includes("png")) return "png";
  if (clean.includes("webp")) return "webp";
  if (clean.includes("gif")) return "gif";
  return "jpg"; // covers image/jpeg and any unrecognized-but-image mime — safe default
}

function mimeFromExt(ext: string): string {
  switch (ext) {
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    default:
      return "image/jpeg";
  }
}

export interface TrackMetadata {
  title?: string;
  artist?: string;
  album?: string;
  hasArt: boolean;
}

export interface TrackMetaInput {
  trackId: string;
  filePath: string;
  sizeBytes: number;
  mtimeMs: number;
  /** Only mp3 gets ID3 parsing — wav/m4a/ogg fall back to "no metadata" (see file header). */
  isMp3: boolean;
}

/**
 * Batched metadata + art lookup for the whole library — reads the index
 * once, parses ID3 only for tracks whose cache entry is missing or stale,
 * writes the index once at the end (not once per track), and prunes cache
 * entries for tracks that no longer exist in `inputs`. /api/tracks calls
 * this with the full current library on every GET.
 */
export async function getTracksMetadata(inputs: TrackMetaInput[]): Promise<Map<string, TrackMetadata>> {
  const index = await readIndex();
  const result = new Map<string, TrackMetadata>();
  let dirty = false;

  for (const { trackId, filePath, sizeBytes, mtimeMs, isMp3 } of inputs) {
    const cached = index.auto[trackId];
    if (cached && cached.sizeBytes === sizeBytes && cached.mtimeMs === mtimeMs) {
      result.set(trackId, { title: cached.title, artist: cached.artist, album: cached.album, hasArt: cached.hasArt });
      continue;
    }

    if (!isMp3) {
      index.auto[trackId] = { hasArt: false, sizeBytes, mtimeMs };
      result.set(trackId, { hasArt: false });
      dirty = true;
      continue;
    }

    const tags = await readId3Tags(filePath);
    let hasArt = false;
    let ext: string | undefined;

    if (tags?.art) {
      ext = extFromMime(tags.art.mime);
      const hash = hashKey(`auto:track:${trackId}`);
      await ensureDirs();
      await fs.writeFile(path.join(COVER_DIR, `${hash}.${ext}`), tags.art.data);
      hasArt = true;
    }

    index.auto[trackId] = { hasArt, ext, sizeBytes, mtimeMs, title: tags?.title, artist: tags?.artist, album: tags?.album };
    result.set(trackId, { title: tags?.title, artist: tags?.artist, album: tags?.album, hasArt });
    dirty = true;
  }

  // Prune auto entries (and their cached art files) for tracks that vanished
  // from the library since the last GET, so deleted tracks don't leave
  // orphaned cover files behind forever.
  const currentIds = new Set(inputs.map((i) => i.trackId));
  for (const staleId of Object.keys(index.auto)) {
    if (currentIds.has(staleId)) continue;
    const stale = index.auto[staleId];
    if (stale.hasArt && stale.ext) {
      const hash = hashKey(`auto:track:${staleId}`);
      await fs.unlink(path.join(COVER_DIR, `${hash}.${stale.ext}`)).catch(() => {});
    }
    delete index.auto[staleId];
    dirty = true;
  }

  if (dirty) await writeIndex(index);
  return result;
}

export type CoverKind = "track" | "playlist";

export interface ResolvedCover {
  filePath: string;
  mime: string;
}

/** Resolves the actual on-disk cover for a track/playlist — a custom upload
 *  always wins over auto-extracted art. Returns null when neither exists;
 *  the route 404s and the client falls back to its generated placeholder. */
export async function resolveCover(kind: CoverKind, id: string): Promise<ResolvedCover | null> {
  const index = await readIndex();
  const customKey = `${kind}:${id}`;
  const custom = index.custom[customKey];
  if (custom) {
    const hash = hashKey(`custom:${customKey}`);
    const filePath = path.join(CUSTOM_DIR, `${hash}.${custom.ext}`);
    try {
      await fs.access(filePath);
      return { filePath, mime: mimeFromExt(custom.ext) };
    } catch {
      // Index says it exists but the file is gone — fall through to
      // auto/none rather than error; a stale index entry shouldn't 500.
    }
  }

  if (kind === "track") {
    const auto = index.auto[id];
    if (auto?.hasArt && auto.ext) {
      const hash = hashKey(`auto:track:${id}`);
      const filePath = path.join(COVER_DIR, `${hash}.${auto.ext}`);
      try {
        await fs.access(filePath);
        return { filePath, mime: mimeFromExt(auto.ext) };
      } catch {
        return null;
      }
    }
  }

  return null;
}

/** True if a custom cover has been uploaded for this id — used by
 *  /api/playlists so the client knows whether to even attempt fetching a
 *  playlist's cover, without speculatively probing /api/cover for every
 *  playlist on every load. */
export async function hasCustomCover(kind: CoverKind, id: string): Promise<boolean> {
  const index = await readIndex();
  return Boolean(index.custom[`${kind}:${id}`]);
}

const MAX_CUSTOM_COVER_BYTES = 8 * 1024 * 1024; // 8MB — plenty for a cover image, guards against accidental huge uploads
const ALLOWED_UPLOAD_MIMES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

/** Saves a user-uploaded cover for a track or playlist, overwriting any
 *  previous custom cover for that id (custom always wins over auto art). */
export async function saveCustomCover(kind: CoverKind, id: string, data: Buffer, mime: string): Promise<void> {
  if (!ALLOWED_UPLOAD_MIMES.has(mime)) {
    throw new Error(`unsupported image type: ${mime}`);
  }
  if (data.length === 0 || data.length > MAX_CUSTOM_COVER_BYTES) {
    throw new Error("cover image size out of range (max 8MB)");
  }

  const ext = extFromMime(mime);
  const customKey = `${kind}:${id}`;
  const hash = hashKey(`custom:${customKey}`);

  await ensureDirs();

  // A previous upload for this id may have used a different extension —
  // clean up any stale sibling files first so two formats never sit on disk
  // for the same cover at once.
  for (const staleExt of KNOWN_EXTS) {
    if (staleExt === ext) continue;
    await fs.unlink(path.join(CUSTOM_DIR, `${hash}.${staleExt}`)).catch(() => {});
  }

  await fs.writeFile(path.join(CUSTOM_DIR, `${hash}.${ext}`), data);

  const index = await readIndex();
  index.custom[customKey] = { ext };
  await writeIndex(index);
}

/** Removes a custom cover (if any) for a track or playlist — called when the
 *  underlying track/playlist itself is deleted, so orphaned uploads don't
 *  accumulate on disk. */
export async function deleteCustomCover(kind: CoverKind, id: string): Promise<void> {
  const index = await readIndex();
  const key = `${kind}:${id}`;
  const entry = index.custom[key];
  if (!entry) return;
  const hash = hashKey(`custom:${key}`);
  await fs.unlink(path.join(CUSTOM_DIR, `${hash}.${entry.ext}`)).catch(() => {});
  delete index.custom[key];
  await writeIndex(index);
}
