/**
 * GET /api/audio/[filename]
 *
 * Streams a single audio file out of music/ so <audio src="..."> has
 * something to hit. Next.js App Router only auto-serves static files out
 * of /public, and the music folder intentionally lives outside /public, so
 * this route exists purely to bridge that gap — MusicPlayer.tsx points each
 * track's <audio> src at
 * `/api/audio/<file>` rather than a static path.
 *
 * Path-traversal guard: rejects any filename containing a path separator or
 * "..", and only serves files that live directly inside MUSIC_DIR.
 *
 * HTTP Range support (required, not optional): browsers send a `Range` header
 * to scrub/seek, and Safari/iOS send a `Range: bytes=0-1` probe before they'll
 * play at all and expect a `206 Partial Content` back. The previous version
 * hardcoded `Accept-Ranges: bytes` but always returned the full `200` body,
 * which is a lie the browser acts on — seeking broke and Safari could refuse
 * to start. This version actually honors Range: parses it, reads only the
 * requested slice, and returns `206` with a correct `Content-Range`.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";

const MUSIC_DIR = path.join(process.cwd(), "music");

const CONTENT_TYPES: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
};

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ filename: string }> }
) {
  const { filename } = await params;

  if (!filename || filename.includes("..") || filename.includes("/") || filename.includes("\\")) {
    return NextResponse.json({ error: "invalid filename" }, { status: 400 });
  }

  const ext = path.extname(filename).toLowerCase();
  const contentType = CONTENT_TYPES[ext];
  if (!contentType) {
    return NextResponse.json({ error: "unsupported file type" }, { status: 400 });
  }

  const filePath = path.join(MUSIC_DIR, filename);

  let fileHandle: fs.FileHandle | undefined;
  try {
    fileHandle = await fs.open(filePath, "r");
    const { size } = await fileHandle.stat();

    const rangeHeader = request.headers.get("range");

    // No Range header -> full file, but with a real Content-Length so the
    // browser knows the duration/size up front.
    if (!rangeHeader) {
      const buffer = Buffer.alloc(size);
      await fileHandle.read(buffer, 0, size, 0);
      await fileHandle.close();
      return new NextResponse(new Uint8Array(buffer), {
        status: 200,
        headers: {
          "Content-Type": contentType,
          "Content-Length": String(size),
          "Accept-Ranges": "bytes",
          "Cache-Control": "public, max-age=3600",
        },
      });
    }

    // Parse `bytes=start-end` (end optional -> to EOF).
    const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
    if (!match) {
      await fileHandle.close();
      return new NextResponse(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${size}`, "Accept-Ranges": "bytes" },
      });
    }

    const startStr = match[1];
    const endStr = match[2];
    let start = startStr ? parseInt(startStr, 10) : 0;
    let end = endStr ? parseInt(endStr, 10) : size - 1;

    // Handle a suffix range like `bytes=-500` (last 500 bytes).
    if (!startStr && endStr) {
      start = Math.max(0, size - parseInt(endStr, 10));
      end = size - 1;
    }

    if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= size) {
      await fileHandle.close();
      return new NextResponse(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${size}`, "Accept-Ranges": "bytes" },
      });
    }

    end = Math.min(end, size - 1);
    const chunkSize = end - start + 1;

    const buffer = Buffer.alloc(chunkSize);
    await fileHandle.read(buffer, 0, chunkSize, start);
    await fileHandle.close();

    return new NextResponse(new Uint8Array(buffer), {
      status: 206,
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(chunkSize),
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Accept-Ranges": "bytes",
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch (error) {
    if (fileHandle) {
      await fileHandle.close().catch(() => {});
    }
    console.error(`[/api/audio/${filename}] read failed:`, error);
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
}
