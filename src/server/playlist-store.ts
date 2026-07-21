// JSON-backed playlist store — user content, never touched by /api/reset.
//
// Playlists live in a single flat file (data/playlists.json) rather than
// SQLite because the shape is small, human-inspectable, and doesn't need
// query power — just CRUD + one cross-cutting operation (removing a track
// from every playlist when the track file itself gets deleted).
//
// Writes are atomic: write to a temp file in the same directory, then
// rename() over the real path. rename() on the same filesystem is atomic on
// both POSIX and Windows (NTFS), so a crash mid-write never leaves a
// truncated/corrupt playlists.json — the reader always sees either the old
// full file or the new full file, never a partial one.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DATA_DIR = path.join(process.cwd(), "data");
const STORE_PATH = path.join(DATA_DIR, "playlists.json");

export interface Playlist {
  id: string;
  name: string;
  trackIds: string[];
  createdAt: string;
}

interface StoreShape {
  playlists: Playlist[];
}

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function readStore(): StoreShape {
  try {
    const raw = fs.readFileSync(STORE_PATH, "utf-8");
    const parsed = JSON.parse(raw) as StoreShape;
    if (!parsed || !Array.isArray(parsed.playlists)) return { playlists: [] };
    return parsed;
  } catch {
    // Missing file (first run) or corrupt JSON — start clean rather than
    // throwing, same fail-soft philosophy as the rest of the API surface.
    return { playlists: [] };
  }
}

function writeStore(store: StoreShape): void {
  ensureDataDir();
  const tmpPath = `${STORE_PATH}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(store, null, 2), "utf-8");
  fs.renameSync(tmpPath, STORE_PATH);
}

export function listPlaylists(): Playlist[] {
  return readStore().playlists;
}

export function getPlaylist(id: string): Playlist | null {
  return readStore().playlists.find((p) => p.id === id) ?? null;
}

export function createPlaylist(name: string): Playlist {
  const store = readStore();
  const playlist: Playlist = {
    id: crypto.randomUUID(),
    name,
    trackIds: [],
    createdAt: new Date().toISOString(),
  };
  store.playlists.push(playlist);
  writeStore(store);
  return playlist;
}

export interface UpdatePlaylistInput {
  name?: string;
  trackIds?: string[];
}

export function updatePlaylist(id: string, updates: UpdatePlaylistInput): Playlist | null {
  const store = readStore();
  const idx = store.playlists.findIndex((p) => p.id === id);
  if (idx === -1) return null;

  const existing = store.playlists[idx];
  const updated: Playlist = {
    ...existing,
    name: updates.name !== undefined ? updates.name : existing.name,
    trackIds: updates.trackIds !== undefined ? updates.trackIds : existing.trackIds,
  };
  store.playlists[idx] = updated;
  writeStore(store);
  return updated;
}

export function deletePlaylist(id: string): boolean {
  const store = readStore();
  const before = store.playlists.length;
  store.playlists = store.playlists.filter((p) => p.id !== id);
  if (store.playlists.length === before) return false;
  writeStore(store);
  return true;
}

/**
 * Strip a track id out of every playlist's trackIds array. Called when a
 * track file is deleted via DELETE /api/tracks so playlists never point at
 * audio that no longer exists.
 */
export function removeTrackEverywhere(trackId: string): void {
  const store = readStore();
  let changed = false;
  for (const playlist of store.playlists) {
    const filtered = playlist.trackIds.filter((id) => id !== trackId);
    if (filtered.length !== playlist.trackIds.length) {
      playlist.trackIds = filtered;
      changed = true;
    }
  }
  if (changed) writeStore(store);
}
