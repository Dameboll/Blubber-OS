// On-demand (non-indexed) live activity reader.
//
// Complements log-indexer.ts's throttled SQLite rollup with a tiny, targeted,
// real-time read: given a specific run (spawned subagent) or the current
// project's own main session, tail-read the last few KB of its ACTUAL
// transcript file on disk and pull out a compact "what's it doing right now"
// string, plus (for the main session) the latest assistant message text.
//
// This is intentionally NOT part of the incremental indexer -- the indexer
// only tracks Skill/Agent/Workflow/Task tool_use blocks (see
// TOOL_NAMES_OF_INTEREST in log-indexer.ts), never the general Edit/Bash/Read
// tool calls that make up "what is this run actually doing". Storing every
// such event in SQLite would mean indexing a firehose of noise nobody queries
// historically. Instead this module does a bounded, single-file tail read per
// call -- never a directory walk over the whole ~/.claude/projects tree --
// which is cheap enough to run on every poll (the file list under one
// project's slug dir is a few dozen entries at most; the tail read is capped
// at TAIL_BYTES).
//
// Correlation key for subagent runs: verified on disk that Claude Code writes
// ~/.claude/projects/<slug>/<parentSessionId>/subagents/agent-<id>.meta.json
// alongside agent-<id>.jsonl, and the .meta.json carries the real
// `toolUseId` -- the exact tool_use id (`run.runId`) that spawned it. That is
// the real correlation key, not an invented one.

import fs from "fs";
import path from "path";
import os from "os";

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");
const DEV_ROOT = path.join(os.homedir(), "Development");
const DEV_ROOT_LABELS = ["ACTIVE", "HOBBY", "general", "research"] as const;

// Last ~16KB of a transcript comfortably covers the newest tool_use + newest
// assistant text even on a chatty line; far cheaper than reading whole files
// that can run into many MB over a long session.
const TAIL_BYTES = 16_384;
const ACTIVITY_TARGET_MAX_LEN = 40;
const ASSISTANT_TEXT_MAX_LEN = 140;

/** A fresh event within this window counts as "working right now" for the
 * hero session gate. Chosen to sit close to (never looser than) the client's
 * fixed WORK_DEBOUNCE_MS=15000 latch in SessionProvider.tsx, with a small
 * margin for the fact this reads the raw transcript directly (no indexer
 * throttle lag to account for, unlike the SQLite-backed run data). */
export const RECENT_EVENT_WINDOW_MS = 20_000;

function slugify(part: string): string {
  return part.replace(/[^A-Za-z0-9]/g, "-");
}

// project name -> resolved slug dir (or null). Project folders don't appear
// or vanish mid-process, so caching for the process lifetime is safe and
// avoids re-checking all four root labels on every request.
const slugDirCache = new Map<string, string | null>();

function resolveSlugDir(projectName: string): string | null {
  const cached = slugDirCache.get(projectName);
  if (cached !== undefined) return cached;

  // Claude Code slugs a project dir by flattening its FULL absolute path
  // (every non-alphanumeric char -> '-'), not just the "Development/<root>/
  // <name>" tail -- e.g. "C:\Users\<you>\Development\HOBBY\some-project"
  // becomes "C--Users-you-Development-HOBBY-some-project" (verified on
  // disk). Slugifying only the tail (as first written) silently produced a
  // dir that never existed on Windows, so this must slugify the whole
  // candidate path.
  let resolved: string | null = null;
  for (const root of DEV_ROOT_LABELS) {
    const candidate = path.join(DEV_ROOT, root, projectName);
    try {
      if (fs.statSync(candidate).isDirectory()) {
        resolved = path.join(CLAUDE_PROJECTS_DIR, slugify(candidate));
        break;
      }
    } catch {
      // Doesn't exist under this root -- try the next one.
    }
  }
  slugDirCache.set(projectName, resolved);
  return resolved;
}

/** Most recently modified top-level *.jsonl session file directly under a
 * project's slug dir (never a nested subagents/ file) -- i.e. the project's
 * currently-active main session. Single readdir + stat pass over one
 * directory (a few dozen files at most), not a recursive walk. */
function findLatestMainSessionFile(slugDir: string): string | null {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(slugDir, { withFileTypes: true });
  } catch {
    return null;
  }
  let best: { file: string; mtimeMs: number } | null = null;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const full = path.join(slugDir, entry.name);
    try {
      const stat = fs.statSync(full);
      if (!best || stat.mtimeMs > best.mtimeMs) best = { file: full, mtimeMs: stat.mtimeMs };
    } catch {
      continue;
    }
  }
  return best?.file ?? null;
}

/** Locates a spawned subagent's own transcript file by matching its real
 * tool_use id (`runId`) against each subagents/*.meta.json's `toolUseId`
 * field. Returns null (never guessed) when no match exists on disk -- e.g.
 * a "Workflow" run that doesn't spawn a subagents/ transcript the same way. */
function findSubagentTranscriptFile(slugDir: string, parentSessionId: string, runId: string): string | null {
  const subDir = path.join(slugDir, parentSessionId, "subagents");
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(subDir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".meta.json")) continue;
    const metaPath = path.join(subDir, entry.name);
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf8")) as { toolUseId?: string };
      if (meta.toolUseId === runId) {
        const jsonlPath = metaPath.slice(0, -".meta.json".length) + ".jsonl";
        return fs.existsSync(jsonlPath) ? jsonlPath : null;
      }
    } catch {
      continue; // unreadable/malformed meta -- skip, try the next file
    }
  }
  return null;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)).trimEnd() + "…";
}

/** Compact "Tool → target" label from a real tool_use block -- short and
 * human, same spirit as shortAgentName/humanizeSlug elsewhere in this
 * codebase. Falls back to the bare tool name when no useful target exists. */
function formatActivity(toolName: string, input: Record<string, unknown> | undefined): string {
  const inp = input ?? {};
  switch (toolName) {
    case "Edit":
    case "Write":
    case "Read":
    case "NotebookEdit": {
      const fp = typeof inp.file_path === "string" ? inp.file_path : null;
      return fp ? `${toolName} → ${path.basename(fp)}` : toolName;
    }
    case "Bash": {
      const cmd = typeof inp.command === "string" ? inp.command.split("\n")[0] : null;
      return cmd ? `Bash → ${truncate(cmd, ACTIVITY_TARGET_MAX_LEN)}` : "Bash";
    }
    case "Grep":
    case "Glob": {
      const pattern = typeof inp.pattern === "string" ? inp.pattern : null;
      return pattern ? `${toolName} → ${truncate(pattern, ACTIVITY_TARGET_MAX_LEN)}` : toolName;
    }
    case "Task":
    case "Agent": {
      const desc =
        (typeof inp.description === "string" && inp.description) ||
        (typeof inp.subagent_type === "string" && inp.subagent_type) ||
        null;
      return desc ? `${toolName} → ${truncate(desc, ACTIVITY_TARGET_MAX_LEN)}` : toolName;
    }
    case "Skill": {
      const name =
        (typeof inp.skill === "string" && inp.skill) || (typeof inp.name === "string" && inp.name) || null;
      return name ? `Skill → ${name}` : "Skill";
    }
    case "WebFetch":
    case "WebSearch": {
      const q = (typeof inp.url === "string" && inp.url) || (typeof inp.query === "string" && inp.query) || null;
      return q ? `${toolName} → ${truncate(q, ACTIVITY_TARGET_MAX_LEN)}` : toolName;
    }
    default:
      return toolName;
  }
}

interface TranscriptLineShape {
  timestamp?: string;
  message?: {
    role?: string;
    content?: Array<{
      type?: string;
      name?: string;
      input?: Record<string, unknown>;
      text?: string;
    }>;
  };
}

export interface ActivitySnapshot {
  activity: string | null;
  lastAssistantText: string | null;
  lastEventTs: string | null;
}

const EMPTY_SNAPSHOT: ActivitySnapshot = { activity: null, lastAssistantText: null, lastEventTs: null };

/** Parses a chunk (the tail of a transcript file) into an ActivitySnapshot by
 * walking its complete lines newest-first. `droppedPartialFirstLine` is true
 * when the chunk didn't start at byte 0 -- its first line is then treated as
 * a possibly-truncated partial and skipped. */
function parseChunk(chunk: string, droppedPartialFirstLine: boolean): ActivitySnapshot {
  const lines = chunk.split("\n").filter((l) => l.trim().length > 0);
  if (droppedPartialFirstLine && lines.length > 0) lines.shift();

  let activity: string | null = null;
  let lastAssistantText: string | null = null;
  let lastEventTs: string | null = null;

  for (let i = lines.length - 1; i >= 0; i--) {
    let obj: TranscriptLineShape;
    try {
      obj = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (!lastEventTs && obj.timestamp) lastEventTs = obj.timestamp;

    const content = obj.message?.content;
    if (!Array.isArray(content)) continue;

    if (!activity) {
      for (let b = content.length - 1; b >= 0; b--) {
        const block = content[b];
        if (block?.type === "tool_use" && block.name) {
          activity = formatActivity(block.name, block.input);
          break;
        }
      }
    }

    if (!lastAssistantText && obj.message?.role === "assistant") {
      for (const block of content) {
        if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
          lastAssistantText = truncate(block.text.trim().replace(/\s+/g, " "), ASSISTANT_TEXT_MAX_LEN);
          break;
        }
      }
    }

    if (activity && lastAssistantText && lastEventTs) break;
  }

  return { activity, lastAssistantText, lastEventTs };
}

// Real transcripts interleave a lot of bookkeeping lines with no usable
// content -- "attachment", "last-prompt", "ai-title", "mode",
// "permission-mode" -- and busy turns (a Write with a large file body, a big
// tool_result) can push the actual latest tool_use/assistant-text block well
// past a single small tail read. So this widens the read in a few bounded
// steps instead of guessing one fixed size: cheap in the common case (first
// 16KB usually has it), still bounded (1MB ceiling) on a genuinely busy file.
const TAIL_BUDGETS = [TAIL_BYTES, 65_536, 262_144, 1_048_576];

/** Tails a transcript file (widening the read up to TAIL_BUDGETS' ceiling
 * only if needed) and returns the latest tool_use activity + latest
 * assistant text found -- bounded reads of one file, never a directory
 * walk. */
function tailParseActivity(filePath: string): ActivitySnapshot {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return EMPTY_SNAPSHOT;
  }
  if (stat.size === 0) return EMPTY_SNAPSHOT;

  let fd: number;
  try {
    fd = fs.openSync(filePath, "r");
  } catch {
    return EMPTY_SNAPSHOT;
  }

  let best: ActivitySnapshot = EMPTY_SNAPSHOT;
  try {
    for (const budget of TAIL_BUDGETS) {
      const start = Math.max(0, stat.size - budget);
      const length = stat.size - start;
      if (length <= 0) break;
      const buffer = Buffer.alloc(length);
      try {
        fs.readSync(fd, buffer, 0, length, start);
      } catch {
        break;
      }
      best = parseChunk(buffer.toString("utf8"), start > 0);
      const complete = best.activity !== null && best.lastAssistantText !== null;
      if (complete || start === 0) break;
    }
  } finally {
    fs.closeSync(fd);
  }
  return best;
}

/** Whether a spawned run's OWN transcript file is still being actively
 * written to, independent of the PARENT session's tool_use/tool_result
 * state. Needed because background-dispatched agents (run_in_background,
 * the default for the Agent/Workflow tools) resolve the parent's tool_use
 * with an acknowledgment almost immediately after dispatch -- "launched
 * successfully" -- not when the real subagent work finishes. Verified on
 * disk: tool_runs rows for background-dispatched runs close (ts_end set)
 * ~1-2 seconds after ts_start, while the correlated subagents/*.jsonl file
 * keeps growing for the real duration of the work (minutes). Callers use
 * this to promote a run the indexer marked "done" back to "running" for
 * display when its transcript is still fresh -- the mtime is the only
 * signal actually available on disk for a background dispatch's true
 * liveness. Returns null (never guessed) when no correlated transcript
 * exists. */
export function getRunTranscriptMtimeMs(project: string | null, sessionId: string | null, runId: string): number | null {
  if (!project || !sessionId) return null;
  const slugDir = resolveSlugDir(project);
  if (!slugDir) return null;
  const file = findSubagentTranscriptFile(slugDir, sessionId, runId);
  if (!file) return null;
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

/** Live activity for one specific spawned run (Agent/Task/Workflow), read
 * straight from that subagent's OWN transcript file -- never from the parent
 * session's transcript, which only ever sees the Task tool_use/tool_result,
 * not the subagent's real Edit/Bash/Read calls. Returns the empty snapshot
 * (never fabricated) when the run can't be correlated to a real subagent
 * transcript on disk (e.g. a Workflow run, or a run older than what's still
 * on disk). */
export function getRunActivity(project: string | null, sessionId: string | null, runId: string): ActivitySnapshot {
  if (!project || !sessionId) return EMPTY_SNAPSHOT;
  const slugDir = resolveSlugDir(project);
  if (!slugDir) return EMPTY_SNAPSHOT;
  const file = findSubagentTranscriptFile(slugDir, sessionId, runId);
  if (!file) return EMPTY_SNAPSHOT;
  return tailParseActivity(file);
}

/** Live snapshot of the CURRENT project's own main session (not a subagent)
 * -- the most recently modified top-level transcript file in that project's
 * slug dir. Powers /api/agents-live's `heroSession`. */
export function getMainSessionActivity(project: string): ActivitySnapshot {
  const slugDir = resolveSlugDir(project);
  if (!slugDir) return EMPTY_SNAPSHOT;
  const file = findLatestMainSessionFile(slugDir);
  if (!file) return EMPTY_SNAPSHOT;
  return tailParseActivity(file);
}
