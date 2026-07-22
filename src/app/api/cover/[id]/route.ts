/**
 * /api/cover/[id]
 *
 * Serves + accepts cover art for a track or a playlist. `id` is either a
 * track id (its filename, matching /api/tracks) or a playlist id (its uuid,
 * matching /api/playlists) — disambiguated by the `?type=track|playlist`
 * query param (defaults to "track").
 *
 * GET  -> streams the resolved cover image bytes (custom upload wins over
 *         auto-extracted ID3 art). 404 when neither exists — the client
 *         falls back to its generated placeholder tile rather than treating
 *         that as an error.
 * POST -> uploads a custom cover, either multipart/form-data (field "file")
 *         or application/json ({ dataUrl } or { base64, mime }). Custom
 *         covers always take priority over auto-extracted art from then on.
 *
 * All actual cache/storage logic lives in cover-art-store.ts — this route is
 * just the HTTP surface over it.
 */

import { readFile } from "node:fs/promises";
import { NextRequest, NextResponse } from "next/server";
import { resolveCover, saveCustomCover, type CoverKind } from "@/server/cover-art-store";

function parseKind(request: NextRequest): CoverKind {
  const type = new URL(request.url).searchParams.get("type");
  return type === "playlist" ? "playlist" : "track";
}

/** Next.js's App Router already URL-decodes dynamic route segments before
 *  handing them to the handler, so `rawId` here is normally the plain
 *  filename/uuid already (the client's encodeURIComponent() round-trips
 *  back out through Next's own decode). Calling decodeURIComponent() again
 *  is usually a harmless no-op, EXCEPT when the id legitimately contains a
 *  literal "%" not followed by two hex digits (e.g. a track named
 *  "50% off.mp3") — decoding an already-decoded string like that throws
 *  URIError: URI malformed. Fail soft to the raw value instead of 500ing. */
function safeDecodeId(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: rawId } = await params;
  const id = safeDecodeId(rawId ?? "");
  if (!id) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }

  const kind = parseKind(request);
  const cover = await resolveCover(kind, id);
  if (!cover) {
    return NextResponse.json({ error: "no cover" }, { status: 404 });
  }

  try {
    const data = await readFile(cover.filePath);
    return new NextResponse(new Uint8Array(data), {
      status: 200,
      headers: {
        "Content-Type": cover.mime,
        // Client appends a `v=` cache-busting param after every upload, so a
        // reasonably long max-age here doesn't risk serving stale art.
        "Cache-Control": "public, max-age=300",
      },
    });
  } catch (error) {
    console.error(`[/api/cover/${id}] read failed:`, error);
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: rawId } = await params;
  const id = safeDecodeId(rawId ?? "");
  if (!id) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }

  const kind = parseKind(request);
  const contentType = request.headers.get("content-type") ?? "";

  let buffer: Buffer;
  let mime: string;

  try {
    if (contentType.includes("multipart/form-data")) {
      const formData = await request.formData();
      const file = formData.get("file");
      if (!(file instanceof File)) {
        return NextResponse.json({ error: "missing 'file' field" }, { status: 400 });
      }
      mime = file.type || "image/jpeg";
      buffer = Buffer.from(await file.arrayBuffer());
    } else if (contentType.includes("application/json")) {
      const body = (await request.json()) as { dataUrl?: unknown; base64?: unknown; mime?: unknown };
      if (typeof body.dataUrl === "string") {
        const match = /^data:([^;,]+);base64,(.+)$/.exec(body.dataUrl);
        if (!match) {
          return NextResponse.json({ error: "invalid dataUrl" }, { status: 400 });
        }
        mime = match[1];
        buffer = Buffer.from(match[2], "base64");
      } else if (typeof body.base64 === "string" && typeof body.mime === "string") {
        mime = body.mime;
        buffer = Buffer.from(body.base64, "base64");
      } else {
        return NextResponse.json({ error: "expected 'dataUrl' or 'base64' + 'mime'" }, { status: 400 });
      }
    } else {
      return NextResponse.json({ error: "expected multipart/form-data or application/json" }, { status: 400 });
    }
  } catch {
    return NextResponse.json({ error: "invalid request body" }, { status: 400 });
  }

  try {
    await saveCustomCover(kind, id, buffer, mime);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error(`[/api/cover/${id}] upload failed:`, error);
    const message = error instanceof Error ? error.message : "failed to save cover";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
