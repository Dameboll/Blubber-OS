// Historical usage-log indexer.
//
// Scans every ~/.claude/projects/**/*.jsonl transcript (session files AND
// nested subagents/**/*.jsonl files -- a plain recursive walk covers both,
// same approach as live-usage-watcher.ts) and rolls token usage + tool
// invocations into the SQLite `events` table (see db.ts) for the /api/weekly
// aggregate endpoint.
//
// Safe to re-run at any time:
//   - Per-file byte offsets are tracked in `indexed_files` so a re-run only
//     reads bytes appended since the last scan.
//   - Every inserted row also carries a UNIQUE `source_id` derived from the
//     transcript line's own `uuid`, so even a full re-scan (e.g. after an
//     offset reset from a truncated/rotated file) can never double-count.
//
// This is intentionally separate from live-usage-watcher.ts, which exists
// purely for cheap real-time SSE deltas and does not touch SQLite at all.

import fs from "fs";
import path from "path";
import os from "os";
import {
  getFileOffset,
  getAllFileOffsets,
  setFileOffset,
  insertEventsBatch,
  insertRunsBatch,
  type UsageEventInput,
  type ToolInvocationEventInput,
  type ToolRunStartInput,
  type ToolRunEndInput,
  type ToolCategory,
} from "./db";

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");

const TOOL_NAMES_OF_INTEREST = new Set(["Skill", "Agent", "Workflow", "Task"]);
// Which tools count as a trackable long-running RUN (start -> tool_result end)
// for the live monitor. Skill loads inline and doesn't reliably produce a
// paired tool_result, so it stays a plain invocation event, not a "run".
const RUN_TOOL_NAMES = new Set(["Agent", "Workflow", "Task"]);

export interface IndexResult {
  filesScanned: number;
  filesWithNewData: number;
  usageEventsInserted: number;
  toolEventsInserted: number;
}

function walkJsonlFiles(dir: string): string[] {
  const results: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    // ~/.claude/projects may not exist yet on a fresh install.
    return results;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkJsonlFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      results.push(full);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Project attribution — each transcript lives under a ~/.claude/projects slug
// dir derived from the project's real path (separators flattened to '-').
// We match that slug against the REAL Development project folders, so every
// event is attributed to an actual project or honestly left null.
// ---------------------------------------------------------------------------

const DEV_ROOT = "C:\\Users\\jeffh\\Development";
const DEV_ROOT_LABELS = ["ACTIVE", "HOBBY", "general", "research"] as const;

/** Slug-sanitize the way ~/.claude does: every non-alphanumeric becomes '-'. */
function slugify(part: string): string {
  return part.replace(/[^A-Za-z0-9]/g, "-");
}

/** Map of slug-suffix ("Development-HOBBY-dame-os") -> project folder name,
 * built from the real filesystem once per indexing pass. Longest-suffix match
 * wins so names containing dashes resolve correctly. */
function buildProjectResolver(): (filePath: string) => string | null {
  const suffixes: { suffix: string; name: string }[] = [];
  for (const root of DEV_ROOT_LABELS) {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(path.join(DEV_ROOT, root), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      suffixes.push({
        suffix: `${slugify("Development")}-${slugify(root)}-${slugify(entry.name)}`,
        name: entry.name,
      });
    }
  }
  suffixes.sort((a, b) => b.suffix.length - a.suffix.length);

  const cache = new Map<string, string | null>();
  return (filePath: string) => {
    const rel = path.relative(CLAUDE_PROJECTS_DIR, filePath);
    const slugDir = rel.split(path.sep)[0] ?? "";
    if (cache.has(slugDir)) return cache.get(slugDir) ?? null;
    const hit = suffixes.find((s) => slugDir.endsWith(s.suffix));
    const name = hit ? hit.name : null;
    cache.set(slugDir, name);
    return name;
  };
}

interface UsageBlock {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface ToolUseBlock {
  type: string;
  name?: string;
  id?: string;
  tool_use_id?: string;
  input?: Record<string, unknown>;
}

interface TranscriptLine {
  type?: string;
  uuid?: string;
  sessionId?: string;
  timestamp?: string;
  message?: {
    role?: string;
    usage?: UsageBlock;
    content?: unknown;
  };
}

function resolveToolNameAndCategory(
  block: ToolUseBlock
): { toolName: string; category: ToolCategory } | null {
  const input = block.input ?? {};

  if (block.name === "Skill") {
    const name = (input.skill as string) || (input.name as string) || "unknown-skill";
    return { toolName: String(name), category: "skill" };
  }

  if (block.name === "Agent") {
    const name =
      (input.agent as string) ||
      (input.subagent_type as string) ||
      (input.name as string) ||
      (input.description as string) ||
      "unknown-agent";
    return { toolName: String(name), category: "agent" };
  }

  if (block.name === "Task") {
    const name =
      (input.subagent_type as string) ||
      (input.description as string) ||
      "unknown-task";
    return { toolName: String(name), category: "agent" };
  }

  if (block.name === "Workflow") {
    const name = (input.workflow as string) || (input.name as string) || "workflow";
    return { toolName: String(name), category: "agent" };
  }

  return null;
}

function readSliceSync(filePath: string, start: number, end: number): string {
  if (end <= start) return "";
  const length = end - start;
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(filePath, "r");
  try {
    fs.readSync(fd, buffer, 0, length, start);
  } finally {
    fs.closeSync(fd);
  }
  return buffer.toString("utf8");
}

/** Parses a single complete transcript line into 0+ event rows, each
 * attributed to the transcript's real source project (or null). */
function extractEventsFromLine(
  line: string,
  project: string | null
): {
  usage: UsageEventInput | null;
  tools: ToolInvocationEventInput[];
  runStarts: ToolRunStartInput[];
  runEnds: ToolRunEndInput[];
} {
  let obj: TranscriptLine;
  try {
    obj = JSON.parse(line);
  } catch {
    return { usage: null, tools: [], runStarts: [], runEnds: [] };
  }

  const uuid = obj.uuid;
  const ts = obj.timestamp;
  const sessionId = obj.sessionId ?? null;

  // Lines without a uuid/timestamp (e.g. the very first bookkeeping line in
  // a session file) never carry usage or tool_use blocks worth indexing.
  if (!uuid || !ts) return { usage: null, tools: [], runStarts: [], runEnds: [] };

  let usage: UsageEventInput | null = null;
  const rawUsage = obj.message?.usage;
  if (
    rawUsage &&
    (typeof rawUsage.input_tokens === "number" || typeof rawUsage.output_tokens === "number")
  ) {
    usage = {
      sourceId: `${uuid}:usage`,
      ts,
      sessionId,
      tokensIn: rawUsage.input_tokens ?? 0,
      tokensOut: rawUsage.output_tokens ?? 0,
      tokensCacheRead: rawUsage.cache_read_input_tokens ?? 0,
      tokensCacheCreation: rawUsage.cache_creation_input_tokens ?? 0,
      project,
    };
  }

  const tools: ToolInvocationEventInput[] = [];
  const runStarts: ToolRunStartInput[] = [];
  const runEnds: ToolRunEndInput[] = [];
  const content = obj.message?.content;
  if (Array.isArray(content)) {
    content.forEach((block: ToolUseBlock, idx: number) => {
      if (!block) return;

      // A tool_result closes the matching run (the UPDATE is a no-op for any
      // tool_use_id we never tracked, so unrelated results cost nothing).
      if (block.type === "tool_result" && block.tool_use_id) {
        runEnds.push({ runId: block.tool_use_id, tsEnd: ts });
        return;
      }

      if (block.type !== "tool_use") return;
      if (!block.name || !TOOL_NAMES_OF_INTEREST.has(block.name)) return;
      const resolved = resolveToolNameAndCategory(block);
      if (!resolved) return;
      tools.push({
        sourceId: `${uuid}:tool:${idx}`,
        ts,
        sessionId,
        toolName: resolved.toolName,
        category: resolved.category,
        project,
      });
      // Long-running agent/workflow/task tool_use with a real id opens a run.
      if (block.id && RUN_TOOL_NAMES.has(block.name)) {
        runStarts.push({
          runId: block.id,
          tsStart: ts,
          toolName: resolved.toolName,
          category: resolved.category,
          sessionId,
          project,
        });
      }
    });
  }

  return { usage, tools, runStarts, runEnds };
}

/** Indexes a single file incrementally, returns counts of what was inserted. */
function indexFile(
  filePath: string,
  project: string | null,
  knownOffset?: { lastSize: number; lastMtimeMs: number },
): { usageCount: number; toolCount: number; hadNewData: boolean } {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return { usageCount: 0, toolCount: 0, hadNewData: false };
  }

  const { lastSize } = knownOffset ?? getFileOffset(filePath);
  let start = lastSize;

  // File shrank or was replaced (rotated) since last scan -- restart from 0
  // so nothing is silently missed. UNIQUE source_id makes this safe even if
  // some lines get re-inserted.
  if (stat.size < lastSize) {
    start = 0;
  }

  if (stat.size <= start) {
    return { usageCount: 0, toolCount: 0, hadNewData: false };
  }

  const chunk = readSliceSync(filePath, start, stat.size);
  const lines = chunk.split("\n");
  // The last element may be a partial line still being written -- hold it
  // back and only advance the offset up to the end of the last full line.
  const trailing = lines.pop() ?? "";
  const trailingBytes = Buffer.byteLength(trailing, "utf8");
  const consumedUpTo = stat.size - trailingBytes;

  const usageEvents: UsageEventInput[] = [];
  const toolEvents: ToolInvocationEventInput[] = [];
  const runStarts: ToolRunStartInput[] = [];
  const runEnds: ToolRunEndInput[] = [];

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    const parsed = extractEventsFromLine(trimmed, project);
    if (parsed.usage) usageEvents.push(parsed.usage);
    if (parsed.tools.length) toolEvents.push(...parsed.tools);
    if (parsed.runStarts.length) runStarts.push(...parsed.runStarts);
    if (parsed.runEnds.length) runEnds.push(...parsed.runEnds);
  }

  if (usageEvents.length || toolEvents.length) {
    insertEventsBatch(usageEvents, toolEvents);
  }
  if (runStarts.length || runEnds.length) {
    insertRunsBatch(runStarts, runEnds);
  }

  setFileOffset(filePath, consumedUpTo, stat.mtimeMs);

  return {
    usageCount: usageEvents.length,
    toolCount: toolEvents.length,
    hadNewData: usageEvents.length > 0 || toolEvents.length > 0,
  };
}

/** Runs one full incremental indexing pass across all transcript files.
 * Cheap to call on every /api/weekly request -- files with no new bytes
 * since the last scan are skipped in O(1) via the stat-size check. */
export function runIndexer(): IndexResult {
  const files = walkJsonlFiles(CLAUDE_PROJECTS_DIR);
  // One query for every tracked offset instead of a SELECT per file — the walk
  // touches hundreds of transcripts, so batching this cuts a real chunk of the pass.
  const offsets = getAllFileOffsets();
  const projectFor = buildProjectResolver();

  let filesWithNewData = 0;
  let usageEventsInserted = 0;
  let toolEventsInserted = 0;

  for (const file of files) {
    const { usageCount, toolCount, hadNewData } = indexFile(file, projectFor(file), offsets.get(file));
    if (hadNewData) filesWithNewData += 1;
    usageEventsInserted += usageCount;
    toolEventsInserted += toolCount;
  }

  return {
    filesScanned: files.length,
    filesWithNewData,
    usageEventsInserted,
    toolEventsInserted,
  };
}

// ---------------------------------------------------------------------------
// Non-blocking entry point for API routes
// ---------------------------------------------------------------------------

let lastIndexAt = 0;
let indexing = false;
const INDEX_THROTTLE_MS = 8_000;

/**
 * Request-path-safe indexer trigger. The full walk over ~/.claude/projects
 * (a statSync per transcript across hundreds of files) is the expensive part,
 * so it must NEVER block a response: /api/weekly + /api/top-agents both fire on
 * a single dashboard mount and each used to run it synchronously (~3s each).
 *
 * Instead this kicks an incremental pass in the background — at most once per
 * throttle window, never overlapping — and returns immediately. Routes serve
 * the persisted SQLite snapshot (queries are sub-100ms) and pick up refreshed
 * numbers on the next fetch. Worst case the dashboard lags real usage by a few
 * seconds; in exchange the load drops from ~3s to ~50ms. The SQLite file
 * persists across restarts, so even a cold start serves real historical data.
 */
export function ensureIndexed(): void {
  const now = Date.now();
  if (indexing || now - lastIndexAt < INDEX_THROTTLE_MS) return;
  indexing = true;
  lastIndexAt = now;
  setImmediate(() => {
    try {
      runIndexer();
    } catch (err) {
      console.error("[indexer] background pass failed:", err);
    } finally {
      indexing = false;
    }
  });
}

export default runIndexer;
