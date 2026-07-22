/**
 * id3-parser.ts
 *
 * Hand-rolled ID3v2.3 / ID3v2.4 tag reader — extracts the three text frames
 * the Music tab cares about (TIT2 title / TPE1 artist / TALB album) plus the
 * embedded cover image (APIC), and nothing else. No tagging library: the
 * ID3v2 frame format is small, stable, and well-documented (id3.org), and
 * per CLAUDE.md we don't add new npm dependencies without flagging it — a
 * ~250-line parser for exactly the four frames we need is well inside
 * hand-rolled territory.
 *
 * Scope, deliberately narrow:
 *   - ID3v2.3 and ID3v2.4 only. ID3v2.2 (3-char frame ids), no tag at all,
 *     or a corrupt/unrecognized header all return null — the caller (see
 *     cover-art-store.ts) falls back to filename-derived title / no
 *     metadata / no art, same as before this parser existed.
 *   - Only ever reads the tag region the 10-byte ID3 header declares, never
 *     the whole audio file — so this stays cheap even when a small MP3
 *     happens to carry a multi-MB embedded cover.
 *   - Handles the ID3v2.3 whole-tag "unsynchronisation" flag and the
 *     ID3v2.4 per-frame unsynchronisation flag. Skipping that silently
 *     corrupts embedded JPEG/PNG bytes on a meaningful slice of real-world
 *     files (many encoders set it by default), so it's not optional.
 */

import fs from "node:fs/promises";

export interface Id3CoverArt {
  mime: string; // e.g. "image/jpeg"
  data: Buffer;
}

export interface Id3Tags {
  title?: string;
  artist?: string;
  album?: string;
  art?: Id3CoverArt;
}

const ID3_MAGIC = "ID3";
const WANTED_FRAMES = new Set(["TIT2", "TPE1", "TALB", "APIC"]);

/** Decodes a 4-byte ID3v2 "synchsafe" integer — 7 significant bits per byte
 *  (MSB always 0) — so the encoded size value itself can never contain a
 *  byte sequence that looks like an MPEG frame sync. Used for both the tag
 *  size (header) and frame sizes (ID3v2.4 only — v2.3 frame sizes are plain
 *  32-bit big-endian). */
function readSynchsafeInt(buf: Buffer, offset: number): number {
  return ((buf[offset] & 0x7f) << 21) | ((buf[offset + 1] & 0x7f) << 14) | ((buf[offset + 2] & 0x7f) << 7) | (buf[offset + 3] & 0x7f);
}

/** Reverses ID3v2 "unsynchronisation": every 0xFF byte immediately followed
 *  by a byte >= 0xE0 in the *original* audio-adjacent stream gets a 0x00
 *  inserted after it so players can't mistake tag bytes for an MPEG sync
 *  signal. In practice encoders unsync on every literal 0xFF 0x00 pair, so
 *  reversing is just: drop any 0x00 that immediately follows an 0xFF. */
function deUnsynchronize(buf: Buffer): Buffer {
  const out = Buffer.alloc(buf.length);
  let w = 0;
  for (let i = 0; i < buf.length; i++) {
    out[w++] = buf[i];
    if (buf[i] === 0xff && i + 1 < buf.length && buf[i + 1] === 0x00) {
      i++; // drop the inserted padding zero
    }
  }
  return out.subarray(0, w);
}

/** Trims a trailing null terminator — 1 byte for single-byte encodings
 *  (Latin-1/UTF-8), 2 bytes (a null UTF-16 code unit) for UTF-16 — so
 *  embedded NUL padding never ends up inside the decoded string. */
function stripNullTerm(buf: Buffer, width: 1 | 2): Buffer {
  if (width === 1) {
    const idx = buf.indexOf(0x00);
    return idx === -1 ? buf : buf.subarray(0, idx);
  }
  for (let i = 0; i + 1 < buf.length; i += 2) {
    if (buf[i] === 0x00 && buf[i + 1] === 0x00) return buf.subarray(0, i);
  }
  return buf;
}

function decodeUtf16(buf: Buffer): string {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString("utf16le");
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return Buffer.from(buf.subarray(2)).swap16().toString("utf16le");
  return buf.toString("utf16le"); // no BOM present — best-effort assume LE
}

/** Text frame body -> decoded JS string. Byte 0 is the ID3 text-encoding
 *  marker (0=Latin-1, 1=UTF-16+BOM, 2=UTF-16BE no BOM [v2.4 only],
 *  3=UTF-8 [v2.4 only]); the rest is the string in that encoding. */
function decodeTextFrame(body: Buffer): string {
  if (body.length === 0) return "";
  const encoding = body[0];
  const rest = body.subarray(1);
  switch (encoding) {
    case 3:
      return stripNullTerm(rest, 1).toString("utf8");
    case 1:
      return decodeUtf16(stripNullTerm(rest, 2));
    case 2:
      return Buffer.from(stripNullTerm(rest, 2)).swap16().toString("utf16le");
    default:
      return stripNullTerm(rest, 1).toString("latin1");
  }
}

/** Splits an APIC (attached picture) frame body into { mime, data }.
 *  Layout: [encoding:1][mime\0][pictureType:1][description...(term)][image bytes]. */
function decodeApicFrame(body: Buffer): Id3CoverArt | null {
  if (body.length < 4) return null;
  const encoding = body[0];
  let offset = 1;

  const mimeEnd = body.indexOf(0x00, offset);
  if (mimeEnd === -1) return null;
  const mime = body.subarray(offset, mimeEnd).toString("latin1") || "image/jpeg";
  if (mime === "-->") return null; // URL-linked image, not embedded bytes — nothing to serve
  offset = mimeEnd + 1;

  offset += 1; // picture-type byte — we don't discriminate front-cover vs. other, first APIC wins

  const descWidth: 1 | 2 = encoding === 1 || encoding === 2 ? 2 : 1;
  if (descWidth === 1) {
    const idx = body.indexOf(0x00, offset);
    offset = idx === -1 ? body.length : idx + 1;
  } else {
    let idx = -1;
    for (let i = offset; i + 1 < body.length; i += 2) {
      if (body[i] === 0x00 && body[i + 1] === 0x00) {
        idx = i;
        break;
      }
    }
    offset = idx === -1 ? body.length : idx + 2;
  }

  const data = body.subarray(offset);
  if (data.length === 0) return null;
  return { mime, data: Buffer.from(data) };
}

function isValidFrameId(id: string): boolean {
  return /^[A-Z0-9]{4}$/.test(id);
}

/** Parses an already-in-memory ID3v2 tag region (header + declared-size
 *  body). Exported separately from readId3Tags() so it's independently
 *  testable without touching the filesystem. */
export function parseId3Buffer(buf: Buffer): Id3Tags | null {
  if (buf.length < 10 || buf.toString("latin1", 0, 3) !== ID3_MAGIC) return null;

  const majorVersion = buf[3];
  if (majorVersion !== 3 && majorVersion !== 4) return null; // v2.2 and anything else: fall back gracefully

  const flags = buf[5];
  const wholeTagUnsync = (flags & 0x80) !== 0;
  const hasExtendedHeader = (flags & 0x40) !== 0;
  const tagSize = readSynchsafeInt(buf, 6);

  let body = buf.subarray(10, Math.min(buf.length, 10 + tagSize));
  if (wholeTagUnsync) body = deUnsynchronize(body);

  let pos = 0;
  if (hasExtendedHeader && body.length >= 4) {
    // v2.4: the 4-byte size is synchsafe and includes itself. v2.3: it's a
    // plain 32-bit int and does NOT include itself (4 more bytes on top).
    // Real-world files rarely carry an extended header at all; if either
    // reading disagrees with reality the bounds check below just falls back
    // to "no extended header" instead of mis-scanning the rest of the tag.
    pos = majorVersion === 4 ? readSynchsafeInt(body, 0) : 4 + body.readUInt32BE(0);
    if (pos < 0 || pos > body.length) pos = 0;
  }

  const tags: Id3Tags = {};

  while (pos + 10 <= body.length) {
    const frameId = body.toString("latin1", pos, pos + 4);
    if (!isValidFrameId(frameId)) break; // padding or end of real frames

    const frameSize = majorVersion === 4 ? readSynchsafeInt(body, pos + 4) : body.readUInt32BE(pos + 4);
    const frameFlags2 = body[pos + 9];
    const frameStart = pos + 10;
    const frameEnd = frameStart + frameSize;
    if (frameSize <= 0 || frameEnd > body.length) break; // corrupt size — stop rather than misread the rest

    if (WANTED_FRAMES.has(frameId)) {
      let frameBody = body.subarray(frameStart, frameEnd);
      const frameUnsync = majorVersion === 4 && (frameFlags2 & 0x02) !== 0;
      if (frameUnsync) frameBody = deUnsynchronize(frameBody);

      try {
        if (frameId === "APIC") {
          if (!tags.art) {
            const art = decodeApicFrame(frameBody);
            if (art) tags.art = art;
          }
        } else {
          const text = decodeTextFrame(frameBody).trim();
          if (text) {
            if (frameId === "TIT2") tags.title = text;
            else if (frameId === "TPE1") tags.artist = text;
            else if (frameId === "TALB") tags.album = text;
          }
        }
      } catch {
        // One malformed frame shouldn't kill extraction of the rest — keep
        // whatever we already parsed and keep scanning.
      }
    }

    pos = frameEnd;
  }

  return tags;
}

/** Reads just the ID3v2 tag region off disk (the header declares its own
 *  size, so this never reads the full audio file) and parses it. Returns
 *  null on any I/O error, missing tag, or unsupported version — callers
 *  treat that as "no metadata available", not a hard failure. */
export async function readId3Tags(filePath: string): Promise<Id3Tags | null> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(filePath, "r");
    const header = Buffer.alloc(10);
    const { bytesRead: headerBytes } = await handle.read(header, 0, 10, 0);
    if (headerBytes < 10 || header.toString("latin1", 0, 3) !== ID3_MAGIC) return null;

    const tagSize = readSynchsafeInt(header, 6);
    const total = 10 + tagSize;
    const full = Buffer.alloc(total);
    header.copy(full, 0);
    const { bytesRead } = await handle.read(full, 10, total - 10, 10);
    return parseId3Buffer(full.subarray(0, 10 + bytesRead));
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}
