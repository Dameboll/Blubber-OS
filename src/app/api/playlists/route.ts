/**
 * /api/playlists
 *
 * CRUD surface over the JSON playlist store (src/server/playlist-store.ts).
 * Playlists are USER CONTENT — never touched by /api/reset.
 *
 * GET    -> { playlists: [{ id, name, trackIds, createdAt, hasCustomCover }] }
 *   `hasCustomCover` is computed from cover-art-store.ts (not stored on the
 *   playlist itself) so the client knows whether to fetch
 *   /api/cover/<id>?type=playlist without probing every playlist speculatively.
 * POST   body { name: string }                                -> { playlist }
 * PATCH  body { id: string, name?: string, trackIds?: string[] } -> { playlist }
 *   trackIds order = play order, so a PATCH reorder is just a full-array
 *   replace rather than a separate "reorder" verb.
 * DELETE ?id=<id> -> { ok: true }
 */

import { NextRequest, NextResponse } from "next/server";
import {
  createPlaylist,
  deletePlaylist,
  listPlaylists,
  updatePlaylist,
} from "@/server/playlist-store";
import { deleteCustomCover, hasCustomCover } from "@/server/cover-art-store";

export async function GET() {
  try {
    const playlists = listPlaylists();
    const enriched = await Promise.all(
      playlists.map(async (playlist) => ({
        ...playlist,
        hasCustomCover: await hasCustomCover("playlist", playlist.id),
      }))
    );
    return NextResponse.json({ playlists: enriched });
  } catch (error) {
    console.error("[/api/playlists] list failed:", error);
    return NextResponse.json({ playlists: [] });
  }
}

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const name = (body as { name?: unknown })?.name;
  if (typeof name !== "string" || name.trim().length === 0) {
    return NextResponse.json({ error: "'name' is required" }, { status: 400 });
  }

  try {
    const playlist = createPlaylist(name.trim());
    return NextResponse.json({ playlist });
  } catch (error) {
    console.error("[/api/playlists] create failed:", error);
    return NextResponse.json({ error: "failed to create playlist" }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const { id, name, trackIds } = (body ?? {}) as {
    id?: unknown;
    name?: unknown;
    trackIds?: unknown;
  };

  if (typeof id !== "string" || id.trim().length === 0) {
    return NextResponse.json({ error: "'id' is required" }, { status: 400 });
  }

  if (name !== undefined && typeof name !== "string") {
    return NextResponse.json({ error: "'name' must be a string" }, { status: 400 });
  }

  if (trackIds !== undefined) {
    const isStringArray = Array.isArray(trackIds) && trackIds.every((t) => typeof t === "string");
    if (!isStringArray) {
      return NextResponse.json({ error: "'trackIds' must be an array of strings" }, { status: 400 });
    }
  }

  try {
    const updated = updatePlaylist(id, {
      name: name as string | undefined,
      trackIds: trackIds as string[] | undefined,
    });
    if (!updated) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    return NextResponse.json({ playlist: updated });
  } catch (error) {
    console.error("[/api/playlists] update failed:", error);
    return NextResponse.json({ error: "failed to update playlist" }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id") ?? "";

  if (!id) {
    return NextResponse.json({ error: "'id' is required" }, { status: 400 });
  }

  try {
    const removed = deletePlaylist(id);
    if (!removed) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    await deleteCustomCover("playlist", id).catch((error) => {
      console.error(`[/api/playlists] cover cleanup failed for ${id}:`, error);
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[/api/playlists] delete failed:", error);
    return NextResponse.json({ error: "failed to delete playlist" }, { status: 500 });
  }
}
