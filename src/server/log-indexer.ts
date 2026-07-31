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
import { getProjectRoots } from "./project-roots";

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

/** Slug-sanitize the way ~/.claude does: every non-alphanumeric becomes '-'. */
function slugify(part: string): string {
  return part.replace(/[^A-Za-z0-9]/g, "-");
}

interface ProjectAttribution {
  name: string;
  key: string;
}

function projectSlugSuffix(projectPath: string): string {
  return path
    .resolve(projectPath)
    .split(/[\\/]/)
    .filter(Boolean)
    .map(slugify)
    .join("-");
}

/** Map of Claude transcript slug suffix -> root-qualified project identity,
 * built from every allowlisted default/custom root once per indexing pass.
 * Longest-suffix match wins so nested/dashed path names resolve correctly. */
export function buildProjectResolver(): (filePath: string) => ProjectAttribution | null {
  const suffixes: { suffix: string; attribution: ProjectAttribution }[] = [];
  for (const root of getProjectRoots()) {
    if (root.kind === "project") {
      suffixes.push({
        suffix: projectSlugSuffix(root.path),
        attribution: {
          name: root.label,
          key: `${root.id}/${root.label}`,
        },
      });
      continue;
    }
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(root.path, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      suffixes.push({
        suffix: projectSlugSuffix(path.join(root.path, entry.name)),
        attribution: {
          name: entry.name,
          key: `${root.id}/${entry.name}`,
        },
      });
    }
  }
  suffixes.sort((a, b) => b.suffix.length - a.suffix.length);

  const cache = new Map<string, ProjectAttribution | null>();
  return (filePath: string) => {
    const rel = path.relative(CLAUDE_PROJECTS_DIR, filePath);
    const slugDir = rel.split(path.sep)[0] ?? "";
    if (cache.has(slugDir)) return cache.get(slugDir) ?? null;
    const comparableSlug = process.platform === "win32" ? slugDir.toLowerCase() : slugDir;
    const hit = suffixes.find((entry) =>
      comparableSlug.endsWith(process.platform === "win32" ? entry.suffix.toLowerCase() : entry.suffix),
    );
    const attribution = hit?.attribution ?? null;
    cache.set(slugDir, attribution);
    return attribution;
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
  attribution: ProjectAttribution | null
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
  const project = attribution?.name ?? null;
  const projectKey = attribution?.key ?? null;

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
      projectKey,
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
        projectKey,
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
/**
 * Indexes the bytes appended to one transcript since its last scan.
 *
 * `maxBytes` caps how much is consumed in a single call. It exists because a
 * call is one uninterrupted block of sync read + parse + insert: an unbounded
 * pass over a 155 MB transcript froze the server for ~15s in a measured cold
 * index. Capping is safe precisely because the offset bookkeeping already
 * supports resuming — the offset only ever advances to the end of the last
 * FULL line, so the next call picks up exactly where this one stopped, and
 * `hadMoreBytes` in the return tells the caller to come back for the rest.
 */
function indexFile(
  filePath: string,
  attribution: ProjectAttribution | null,
  knownOffset?: { lastSize: number; lastMtimeMs: number },
  maxBytes?: number,
): { usageCount: number; toolCount: number; hadNewData: boolean; hadMoreBytes: boolean } {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return { usageCount: 0, toolCount: 0, hadNewData: false, hadMoreBytes: false };
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
    return { usageCount: 0, toolCount: 0, hadNewData: false, hadMoreBytes: false };
  }

  // Read at most maxBytes this call; anything left is picked up on the next
  // one via the advanced offset.
  const end = maxBytes && stat.size - start > maxBytes ? start + maxBytes : stat.size;
  const chunk = readSliceSync(filePath, start, end);
  const lines = chunk.split("\n");
  // The last element may be a partial line still being written -- OR, when
  // this read was capped, a line sliced mid-way through. Either way it is held
  // back and the offset advances only to the end of the last full line, so the
  // next pass re-reads that line from its true start.
  const trailing = lines.pop() ?? "";
  const trailingBytes = Buffer.byteLength(trailing, "utf8");
  const consumedUpTo = end - trailingBytes;

  // A capped read that consumed nothing means a single line longer than the
  // cap. Advancing is impossible without splitting a line, so take the whole
  // remainder in one go rather than spin forever on the same offset.
  if (consumedUpTo <= start) {
    return indexFile(filePath, attribution, knownOffset, undefined);
  }

  const usageEvents: UsageEventInput[] = [];
  const toolEvents: ToolInvocationEventInput[] = [];
  const runStarts: ToolRunStartInput[] = [];
  const runEnds: ToolRunEndInput[] = [];

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    const parsed = extractEventsFromLine(trimmed, attribution);
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
    hadMoreBytes: consumedUpTo < stat.size,
  };
}

/** Runs one full incremental indexing pass across all transcript files.
 * Cheap to call on every /api/weekly request -- files with no new bytes
 * since the last scan are skipped in O(1) via the stat-size check. */
/**
 * Yield the event loop back to the HTTP server.
 *
 * setImmediate runs AFTER pending I/O callbacks, so anything already queued
 * (an in-flight request) gets served before the walk resumes.
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Same pass as runIndexer, but pauses periodically so the process can answer
 * requests mid-walk.
 *
 * Why this exists: runIndexer is entirely synchronous — sync fs reads, sync
 * JSON parsing, sync SQLite writes — so on a large history it pins the single
 * Node thread for its whole duration and the server answers NOTHING until it
 * finishes. Wrapping the call in setImmediate (what ensureIndexed used to do)
 * only defers the block, it does not break it up. On a real 2.2 GB / 2284-file
 * ~/.claude that froze onboarding on "Injecting…" for minutes: the overlay's
 * follow-up /api/system fetch could not be served, so the UI looked hung.
 *
 * Yielding per FILE is not enough on its own: sizes here span kilobytes to
 * 155 MB, and a measured cold index still stalled one request 14.8s inside a
 * single large transcript. So indexFile takes a byte cap and each file is
 * drained in bounded slices, with a yield between them. That is safe because
 * the offset bookkeeping already advances only to the end of the last full
 * line, which is exactly what a resumable partial read needs.
 */
export async function runIndexerYielding(): Promise<IndexResult> {
  const files = walkJsonlFiles(CLAUDE_PROJECTS_DIR);
  const offsets = getAllFileOffsets();
  const projectFor = buildProjectResolver();

  let filesWithNewData = 0;
  let usageEventsInserted = 0;
  let toolEventsInserted = 0;

  for (const file of files) {
    const project = projectFor(file);
    // Only the FIRST slice can use the batched offset map; later slices must
    // re-read the offset this loop just advanced, so knownOffset is dropped.
    let known = offsets.get(file);
    let countedFile = false;

    // Drain the file in capped slices, yielding between them, so one huge
    // transcript can't hold the thread for the length of a full read.
    for (;;) {
      const { usageCount, toolCount, hadNewData, hadMoreBytes } = indexFile(file, project, known, INDEX_YIELD_BYTES);
      known = undefined;

      if (hadNewData && !countedFile) {
        filesWithNewData += 1;
        countedFile = true;
      }
      usageEventsInserted += usageCount;
      toolEventsInserted += toolCount;

      // One yield per slice. A slice is bounded by INDEX_YIELD_BYTES, so this
      // bounds how long any request can wait behind the walk. Files smaller
      // than the cap are one slice, so this costs one scheduler turn each —
      // negligible against reading them.
      await yieldToEventLoop();

      if (!hadMoreBytes) break;
    }
  }

  return {
    filesScanned: files.length,
    filesWithNewData,
    usageEventsInserted,
    toolEventsInserted,
  };
}

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

// Bytes to chew through before handing the event loop back. Small enough that
// a request never waits long behind the walk, large enough that a history of
// thousands of small transcripts doesn't pay a scheduler turn per file.
const INDEX_YIELD_BYTES = 4 * 1024 * 1024;

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
  // Yielding variant, NOT runIndexer: a sync pass here blocks every other
  // request for the length of the walk (see runIndexerYielding's comment).
  // Still fire-and-forget — callers await nothing.
  void runIndexerYielding()
    .catch((err) => {
      console.error("[indexer] background pass failed:", err);
    })
    .finally(() => {
      indexing = false;
    });
}

export default runIndexer;
