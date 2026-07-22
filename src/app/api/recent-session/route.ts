// GET /api/recent-session -> { session: { cwd, project, sessionId, ageMs } | null }
//
// Powers the dashboard "pick up your open Claude session here?" offer (all
// builds — a core dashboard feature, not kit-gated). Finds the single
// most-recently-written top-level Claude Code transcript across ALL projects
// under ~/.claude/projects/**, reads its real `cwd` straight off a transcript
// line, and returns it with an age. The session id is the filename (Claude
// Code names each top-level transcript <sessionId>.jsonl — verified on disk).
//
// This app's OWN session is skipped (cwd === the server's cwd): the offer is
// for resuming work in ANOTHER project, not the one already open here. Nested
// subagents/*.jsonl transcripts are ignored — only a project's real main
// sessions (top-level files directly under the slug dir) count.
//
// mtime proves a recent WRITE, not that a live external `claude` process is
// still attached — the client frames the offer as "resume where you left off,"
// never "take over a live session" (see ResumeSessionOffer.tsx).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");
// Last ~16KB comfortably covers a line carrying the `cwd` field even on a
// chatty transcript, far cheaper than reading whole multi-MB files.
const TAIL_BYTES = 16_384;
// Only the newest handful of transcripts are ever worth tailing — the answer is
// almost always the very first, so this bounds work if the top few are all this
// app's own session.
const MAX_SCAN = 40;

interface CandidateFile {
  file: string;
  mtimeMs: number;
  sessionId: string;
}

/** All top-level *.jsonl session files across every project slug dir, newest
 *  first. One readdir per slug dir (never a recursive walk into subagents/). */
function listSessionsNewestFirst(): CandidateFile[] {
  let slugs: fs.Dirent[];
  try {
    slugs = fs.readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true });
  } catch {
    return [];
  }

  const out: CandidateFile[] = [];
  for (const slug of slugs) {
    if (!slug.isDirectory()) continue;
    const slugDir = path.join(CLAUDE_PROJECTS_DIR, slug.name);
    let files: fs.Dirent[];
    try {
      files = fs.readdirSync(slugDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith(".jsonl")) continue;
      const full = path.join(slugDir, f.name);
      try {
        const stat = fs.statSync(full);
        out.push({ file: full, mtimeMs: stat.mtimeMs, sessionId: f.name.slice(0, -".jsonl".length) });
      } catch {
        // Vanished/unreadable between readdir and stat — skip.
      }
    }
  }

  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

/** Reads the real `cwd` off a transcript by tailing the last chunk and scanning
 *  its complete lines newest-first for a JSON object with a string `cwd`.
 *  Returns null (never guessed) when no line carries one. */
function extractCwd(file: string): string | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  if (stat.size === 0) return null;

  const start = Math.max(0, stat.size - TAIL_BYTES);
  const length = stat.size - start;
  const buffer = Buffer.alloc(length);

  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return null;
  }
  try {
    fs.readSync(fd, buffer, 0, length, start);
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }

  const lines = buffer.toString("utf8").split("\n").filter((l) => l.trim().length > 0);
  // If the read didn't start at byte 0 the first line may be a truncated
  // partial — drop it.
  if (start > 0 && lines.length > 0) lines.shift();

  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(lines[i]) as { cwd?: unknown };
      if (typeof obj.cwd === "string" && obj.cwd.trim().length > 0) return obj.cwd;
    } catch {
      continue;
    }
  }
  return null;
}

export async function GET() {
  const appCwd = path.resolve(process.cwd());
  const candidates = listSessionsNewestFirst();

  for (const candidate of candidates.slice(0, MAX_SCAN)) {
    const cwd = extractCwd(candidate.file);
    if (!cwd) continue;
    // Skip THIS app's own session — the offer is for resuming another project.
    if (path.resolve(cwd) === appCwd) continue;

    return NextResponse.json({
      session: {
        cwd,
        project: path.basename(cwd) || cwd,
        sessionId: candidate.sessionId,
        ageMs: Math.max(0, Date.now() - candidate.mtimeMs),
      },
    });
  }

  return NextResponse.json({ session: null });
}
