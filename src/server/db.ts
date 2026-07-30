// SQLite rollup store for the usage-log indexer.
//
// One `events` table holds two kinds of rows, distinguished by `event_type`:
//   - "usage"           -> one row per assistant-message usage block (tokens)
//   - "tool_invocation"  -> one row per Skill/Agent/Workflow/Task tool_use block
// A second `indexed_files` table tracks per-file byte offsets so the indexer
// can do incremental re-scans instead of re-reading every *.jsonl on every
// run. Correctness does not depend on the offset tracking alone though --
// `events.source_id` is UNIQUE, so re-processing the same line twice (e.g.
// after an offset gets reset) is always a safe no-op via INSERT OR IGNORE.

import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

import { DATA_DIR } from "./app-dirs";
const DB_PATH = path.join(DATA_DIR, "usage.db");

export type EventType = "usage" | "tool_invocation";
export type ToolCategory = "skill" | "agent";

export interface UsageEventInput {
  sourceId: string;
  ts: string; // ISO timestamp string
  sessionId: string | null;
  tokensIn: number;
  tokensOut: number;
  tokensCacheRead: number;
  tokensCacheCreation: number;
  /** Real project folder name this event's transcript belongs to (derived from
   * the ~/.claude/projects dir slug by the indexer), or null when unknown. */
  project: string | null;
  /** Root-qualified identity (`rootId/projectName`) for collision-free project
   * rollups. Legacy rows may leave this null and fall back to `project`. */
  projectKey: string | null;
}

export interface ToolInvocationEventInput {
  sourceId: string;
  ts: string;
  sessionId: string | null;
  toolName: string;
  category: ToolCategory;
  /** See UsageEventInput.project. */
  project: string | null;
  /** See UsageEventInput.projectKey. */
  projectKey: string | null;
}

export interface DailyTotal {
  date: string; // YYYY-MM-DD
  totalTokens: number;
}

export interface NamedCount {
  name: string;
  count: number;
}

export interface OverallTotals {
  totalTokens: number;
  totalInvocations: number;
}

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function createSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id TEXT UNIQUE NOT NULL,
      ts TEXT NOT NULL,
      session_id TEXT,
      event_type TEXT NOT NULL,
      tool_name TEXT,
      category TEXT,
      tokens_in INTEGER NOT NULL DEFAULT 0,
      tokens_out INTEGER NOT NULL DEFAULT 0,
      tokens_cache_read INTEGER NOT NULL DEFAULT 0,
      tokens_cache_creation INTEGER NOT NULL DEFAULT 0,
      project TEXT,
      project_key TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
    CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);
    CREATE INDEX IF NOT EXISTS idx_events_category_tool ON events(category, tool_name);

    -- Real agent/workflow/task RUNS: one row per Agent/Task/Workflow tool_use,
    -- keyed by the tool_use id. ts_end fills in when the matching tool_result
    -- lands, so a row with ts_end IS NULL is genuinely still in flight — the
    -- truthful source for the live Agents monitor (no fabrication, LAW 1).
    CREATE TABLE IF NOT EXISTS tool_runs (
      run_id TEXT PRIMARY KEY,
      ts_start TEXT NOT NULL,
      ts_end TEXT,
      tool_name TEXT NOT NULL,
      category TEXT NOT NULL,
      session_id TEXT,
      project TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_tool_runs_end ON tool_runs(ts_end);
    CREATE INDEX IF NOT EXISTS idx_tool_runs_start ON tool_runs(ts_start);

    CREATE TABLE IF NOT EXISTS indexed_files (
      file_path TEXT PRIMARY KEY,
      last_size INTEGER NOT NULL DEFAULT 0,
      last_mtime_ms INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

// Survive Next.js dev-mode module re-evaluation (Fast Refresh) with the same
// globalThis-singleton pattern used elsewhere in this project (see
// live-usage-watcher.ts) so we never open two competing connections to the
// same SQLite file.
const globalForDb = globalThis as unknown as {
  __blubberDb?: Database.Database;
};

function openDb(): Database.Database {
  if (globalForDb.__blubberDb) return globalForDb.__blubberDb;

  ensureDataDir();
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  createSchema(db);

  // Additive migration: `project` attributes each event to its real source
  // project (populated by the indexer going forward; older rows stay NULL —
  // never backfilled with guesses).
  const cols = db.prepare(`PRAGMA table_info(events)`).all() as { name: string }[];
  if (!cols.some((c) => c.name === "project")) {
    try {
      db.exec(`ALTER TABLE events ADD COLUMN project TEXT`);
    } catch (err) {
      // Parallel processes (next build page-data workers) can race this ALTER;
      // losing the race is fine — the column exists either way.
      if (!String(err).includes("duplicate column")) throw err;
    }
  }
  if (!cols.some((c) => c.name === "project_key")) {
    try {
      db.exec(`ALTER TABLE events ADD COLUMN project_key TEXT`);
    } catch (err) {
      if (!String(err).includes("duplicate column")) throw err;
    }
  }

  globalForDb.__blubberDb = db;
  return db;
}

export const db = openDb();

// Idempotent guarantee: openDb() short-circuits on the Fast-Refresh-cached
// singleton and so skips createSchema on hot reloads — but the tool_runs table
// (added later than the original schema) must exist for the live monitor even
// on a hot-reloaded dev process that never re-ran createSchema. CREATE ...
// IF NOT EXISTS is a cheap no-op once the table is there.
db.exec(`
  CREATE TABLE IF NOT EXISTS tool_runs (
    run_id TEXT PRIMARY KEY,
    ts_start TEXT NOT NULL,
    ts_end TEXT,
    tool_name TEXT NOT NULL,
    category TEXT NOT NULL,
    session_id TEXT,
    project TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_tool_runs_end ON tool_runs(ts_end);
  CREATE INDEX IF NOT EXISTS idx_tool_runs_start ON tool_runs(ts_start);
`);

// ---------------------------------------------------------------------------
// Stats baseline — "fresh out the box"
//
// Every real dashboard number counts only events at/after this timestamp. It
// is auto-initialized to now on first read (so a fresh OS starts at zero and
// climbs with real use) and moved to now by the Settings master reset. We
// FILTER by it rather than deleting events, so the underlying ~/.claude history
// is preserved and re-indexing stays a safe no-op — the reset just draws a new
// "count from here" line.
// ---------------------------------------------------------------------------

function readMeta(key: string): string | null {
  const row = db.prepare(`SELECT value FROM app_meta WHERE key = ?`).get(key) as
    | { value: string }
    | undefined;
  return row ? row.value : null;
}

function writeMeta(key: string, value: string): void {
  db.prepare(
    `INSERT INTO app_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, value);
}

const BASELINE_KEY = "stats_baseline_ts";

/** The ISO timestamp every real stat counts from. Auto-set to now on first read. */
export function getStatsBaseline(): string {
  const existing = readMeta(BASELINE_KEY);
  if (existing) return existing;
  const now = new Date().toISOString();
  writeMeta(BASELINE_KEY, now);
  return now;
}

/** Move the baseline to now — zeros every real dashboard number going forward. */
export function resetStatsBaseline(): string {
  const now = new Date().toISOString();
  writeMeta(BASELINE_KEY, now);
  return now;
}

// ---------------------------------------------------------------------------
// Indexed-file offset bookkeeping
// ---------------------------------------------------------------------------

export function getFileOffset(filePath: string): { lastSize: number; lastMtimeMs: number } {
  const row = db
    .prepare(`SELECT last_size, last_mtime_ms FROM indexed_files WHERE file_path = ?`)
    .get(filePath) as { last_size: number; last_mtime_ms: number } | undefined;
  return row
    ? { lastSize: row.last_size, lastMtimeMs: row.last_mtime_ms }
    : { lastSize: 0, lastMtimeMs: 0 };
}

/** All tracked file offsets in one query — lets the indexer avoid N per-file
 * SELECTs on each pass (one in-memory Map lookup per file instead). */
export function getAllFileOffsets(): Map<string, { lastSize: number; lastMtimeMs: number }> {
  const rows = db
    .prepare(`SELECT file_path, last_size, last_mtime_ms FROM indexed_files`)
    .all() as { file_path: string; last_size: number; last_mtime_ms: number }[];
  const map = new Map<string, { lastSize: number; lastMtimeMs: number }>();
  for (const r of rows) map.set(r.file_path, { lastSize: r.last_size, lastMtimeMs: r.last_mtime_ms });
  return map;
}

export function setFileOffset(filePath: string, lastSize: number, lastMtimeMs: number): void {
  db.prepare(
    `INSERT INTO indexed_files (file_path, last_size, last_mtime_ms)
     VALUES (?, ?, ?)
     ON CONFLICT(file_path) DO UPDATE SET last_size = excluded.last_size, last_mtime_ms = excluded.last_mtime_ms`
  ).run(filePath, lastSize, lastMtimeMs);
}

// ---------------------------------------------------------------------------
// Event inserts (idempotent via UNIQUE source_id + INSERT OR IGNORE)
// ---------------------------------------------------------------------------

const insertUsageStmt = db.prepare(`
  INSERT INTO events
    (source_id, ts, session_id, event_type, tool_name, category, tokens_in, tokens_out, tokens_cache_read, tokens_cache_creation, project, project_key)
  VALUES
    (@sourceId, @ts, @sessionId, 'usage', NULL, NULL, @tokensIn, @tokensOut, @tokensCacheRead, @tokensCacheCreation, @project, @projectKey)
  ON CONFLICT(source_id) DO UPDATE SET
    project = COALESCE(events.project, excluded.project),
    project_key = COALESCE(events.project_key, excluded.project_key)
`);

export function insertUsageEvent(evt: UsageEventInput): void {
  insertUsageStmt.run(evt);
}

const insertToolStmt = db.prepare(`
  INSERT INTO events
    (source_id, ts, session_id, event_type, tool_name, category, tokens_in, tokens_out, tokens_cache_read, tokens_cache_creation, project, project_key)
  VALUES
    (@sourceId, @ts, @sessionId, 'tool_invocation', @toolName, @category, 0, 0, 0, 0, @project, @projectKey)
  ON CONFLICT(source_id) DO UPDATE SET
    project = COALESCE(events.project, excluded.project),
    project_key = COALESCE(events.project_key, excluded.project_key)
`);

export function insertToolInvocationEvent(evt: ToolInvocationEventInput): void {
  insertToolStmt.run(evt);
}

export const insertEventsBatch = db.transaction(
  (usageEvents: UsageEventInput[], toolEvents: ToolInvocationEventInput[]) => {
    for (const evt of usageEvents) insertUsageStmt.run(evt);
    for (const evt of toolEvents) insertToolStmt.run(evt);
  }
);

// ---------------------------------------------------------------------------
// Tool RUNS — real running/done tracking for the live Agents monitor
// ---------------------------------------------------------------------------

export interface ToolRunStartInput {
  runId: string; // the tool_use id (toolu_...)
  tsStart: string;
  toolName: string;
  category: ToolCategory;
  sessionId: string | null;
  project: string | null;
}

export interface ToolRunEndInput {
  runId: string; // tool_result's tool_use_id
  tsEnd: string;
}

// A run's start is seen exactly once (idempotent by run_id). A run's end only
// ever moves a still-open row to closed — never reopens or overwrites.
const insertRunStartStmt = db.prepare(`
  INSERT OR IGNORE INTO tool_runs (run_id, ts_start, ts_end, tool_name, category, session_id, project)
  VALUES (@runId, @tsStart, NULL, @toolName, @category, @sessionId, @project)
`);
const markRunEndStmt = db.prepare(`
  UPDATE tool_runs SET ts_end = @tsEnd WHERE run_id = @runId AND ts_end IS NULL
`);

export const insertRunsBatch = db.transaction(
  (starts: ToolRunStartInput[], ends: ToolRunEndInput[]) => {
    for (const s of starts) insertRunStartStmt.run(s);
    for (const e of ends) markRunEndStmt.run(e);
  }
);

export interface LiveRun {
  runId: string;
  toolName: string;
  category: ToolCategory;
  sessionId: string | null;
  project: string | null;
  tsStart: string;
  tsEnd: string | null;
  status: "running" | "done";
  elapsedMs: number;
  tokens: number;
}

/** Real in-flight + just-finished agent/workflow/task runs for the live monitor.
 *   running  — ts_end IS NULL and started within `runningWindowMs` (older open
 *              rows are treated as orphaned: a session file rotated before the
 *              tool_result was ever written, so we don't claim they're "running"
 *              forever).
 *   recent   — finished within `recentDoneMs`.
 * Tokens are a real, derived attribution: the sum of usage tokens in the run's
 * own session between its start and its end (or now, for a running one). Not a
 * per-call meter (the transcript has none) but real session burn during the run,
 * honestly labelled. */
export function getLiveRuns(
  runningWindowMs = 20 * 60 * 1000,
  recentDoneMs = 30 * 60 * 1000,
): { running: LiveRun[]; recent: LiveRun[] } {
  const baseline = getStatsBaseline();
  const now = Date.now();
  const runningSince = new Date(now - runningWindowMs).toISOString();
  const recentSince = new Date(now - recentDoneMs).toISOString();

  const runningRows = db
    .prepare(
      `SELECT run_id AS runId, ts_start AS tsStart, ts_end AS tsEnd, tool_name AS toolName,
              category, session_id AS sessionId, project
       FROM tool_runs
       WHERE ts_end IS NULL AND ts_start >= ? AND ts_start >= ?
       ORDER BY ts_start DESC`
    )
    .all(baseline, runningSince) as Omit<LiveRun, "status" | "elapsedMs" | "tokens">[];

  const recentRows = db
    .prepare(
      `SELECT run_id AS runId, ts_start AS tsStart, ts_end AS tsEnd, tool_name AS toolName,
              category, session_id AS sessionId, project
       FROM tool_runs
       WHERE ts_end IS NOT NULL AND ts_end >= ? AND ts_start >= ?
       ORDER BY ts_end DESC
       LIMIT 20`
    )
    .all(recentSince, baseline) as Omit<LiveRun, "status" | "elapsedMs" | "tokens">[];

  const tokensForRun = db.prepare(
    `SELECT SUM(tokens_in + tokens_out + tokens_cache_read + tokens_cache_creation) AS tokens
     FROM events
     WHERE event_type = 'usage' AND session_id = ? AND ts >= ? AND ts <= ?`
  );

  const hydrate = (row: Omit<LiveRun, "status" | "elapsedMs" | "tokens">, status: "running" | "done"): LiveRun => {
    const startMs = Date.parse(row.tsStart);
    const endMs = row.tsEnd ? Date.parse(row.tsEnd) : now;
    let tokens = 0;
    if (row.sessionId) {
      const r = tokensForRun.get(row.sessionId, row.tsStart, row.tsEnd ?? new Date(now).toISOString()) as {
        tokens: number | null;
      };
      tokens = r?.tokens ?? 0;
    }
    return {
      ...row,
      status,
      elapsedMs: Math.max(0, endMs - startMs),
      tokens,
    };
  };

  return {
    running: runningRows.map((r) => hydrate(r, "running")),
    recent: recentRows.map((r) => hydrate(r, "done")),
  };
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

/** Trailing N days (including today) of total token burn, oldest first.
 * Days with no data are zero-filled so charts never show gaps. */
export function getDailyTotals(days = 7): DailyTotal[] {
  const baseline = getStatsBaseline();
  const rows = db
    .prepare(
      `SELECT
         date(ts) AS date,
         SUM(tokens_in + tokens_out + tokens_cache_read + tokens_cache_creation) AS totalTokens
       FROM events
       WHERE event_type = 'usage'
         AND ts >= ?
         AND date(ts) >= date('now', ?)
       GROUP BY date(ts)
       ORDER BY date(ts) ASC`
    )
    .all(baseline, `-${days - 1} days`) as { date: string; totalTokens: number }[];

  const byDate = new Map(rows.map((r) => [r.date, r.totalTokens || 0]));
  const result: DailyTotal[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    result.push({ date: key, totalTokens: byDate.get(key) ?? 0 });
  }
  return result;
}

/** Top-N tool invocations for a category ("skill" or "agent"), most-used first. */
export function getTopByCategory(category: ToolCategory, limit = 5, days = 7): NamedCount[] {
  const rows = db
    .prepare(
      `SELECT tool_name AS name, COUNT(*) AS count
       FROM events
       WHERE event_type = 'tool_invocation'
         AND category = ?
         AND ts >= ?
         AND date(ts) >= date('now', ?)
       GROUP BY tool_name
       ORDER BY count DESC
       LIMIT ?`
    )
    .all(category, getStatsBaseline(), `-${days - 1} days`, limit) as NamedCount[];
  return rows;
}

/** Same as getTopByCategory but across all history (no date filter) --
 * useful for an "all time" view if ever needed. */
export function getTopByCategoryAllTime(category: ToolCategory, limit = 5): NamedCount[] {
  const rows = db
    .prepare(
      `SELECT tool_name AS name, COUNT(*) AS count
       FROM events
       WHERE event_type = 'tool_invocation' AND category = ? AND ts >= ?
       GROUP BY tool_name
       ORDER BY count DESC
       LIMIT ?`
    )
    .all(category, getStatsBaseline(), limit) as NamedCount[];
  return rows;
}

export interface RecentEvent {
  ts: string;
  toolName: string | null;
  category: ToolCategory | null;
  /** Source project folder name, or null for rows indexed before attribution existed. */
  project: string | null;
  /** Real duration from a matched tool_runs row. Only Agent/Task/Workflow
   * tool_use blocks open a tracked run (see log-indexer.ts's RUN_TOOL_NAMES) —
   * Skill invocations never do, so those rows always come back null here.
   * Also null for legacy category="agent" rows indexed before the tool_runs
   * table existed and no match is found. Never guessed. */
  elapsedMs: number | null;
  /** "running" while the matched run's ts_end is still NULL, "done" once it
   * closed, null when no run was matched (see elapsedMs). Same done/running
   * split as getLiveRuns()'s hydrate(). */
  status: "running" | "done" | null;
}

/** The most recent real tool invocations (skill/agent runs), newest first —
 * the truthful "what the agent actually did" feed. Powers the dashboard
 * Activity Feed and terminal-preview log with real, timestamped events instead
 * of a fabricated script. Empty until real activity is indexed. Pass `project`
 * to filter to one real project's events (rows from before attribution are
 * NULL and simply won't match — honest, never guessed).
 *
 * Each row is LEFT JOINed against tool_runs, matched on ts_start + tool_name +
 * session_id — the same transcript line inserts both the `events` row and the
 * `tool_runs` row in lockstep (see log-indexer.ts's extractEventsFromLine), so
 * this is a real correlation, not a guess. Where a match exists we attach a
 * real elapsedMs + done/running status; Skill rows (which never open a
 * tracked run) and any unmatched legacy row simply come back with both null —
 * an honest "duration unknown", never fabricated. */
export function getRecentEvents(limit = 8, project?: string | null): RecentEvent[] {
  const baseline = getStatsBaseline();
  const now = Date.now();

  const joinSql = `
    SELECT e.ts AS ts, e.tool_name AS toolName, e.category AS category, e.project AS project,
           tr.run_id AS runId, tr.ts_end AS tsEnd
    FROM events e
    LEFT JOIN tool_runs tr
      ON tr.ts_start = e.ts AND tr.tool_name = e.tool_name AND tr.session_id IS e.session_id
    WHERE e.event_type = 'tool_invocation'
      AND e.ts >= ?
      ${project ? "AND e.project = ?" : ""}
    ORDER BY e.ts DESC
    LIMIT ?
  `;

  const rows = (
    project ? db.prepare(joinSql).all(baseline, project, limit) : db.prepare(joinSql).all(baseline, limit)
  ) as {
    ts: string;
    toolName: string | null;
    category: ToolCategory | null;
    project: string | null;
    runId: string | null;
    tsEnd: string | null;
  }[];

  return rows.map((r) => {
    if (!r.runId) {
      return { ts: r.ts, toolName: r.toolName, category: r.category, project: r.project, elapsedMs: null, status: null };
    }
    const startMs = Date.parse(r.ts);
    const endMs = r.tsEnd ? Date.parse(r.tsEnd) : now;
    return {
      ts: r.ts,
      toolName: r.toolName,
      category: r.category,
      project: r.project,
      elapsedMs: Math.max(0, endMs - startMs),
      status: r.tsEnd ? ("done" as const) : ("running" as const),
    };
  });
}

export function getOverallTotals(days = 7): OverallTotals {
  const baseline = getStatsBaseline();
  const tokenRow = db
    .prepare(
      `SELECT SUM(tokens_in + tokens_out + tokens_cache_read + tokens_cache_creation) AS totalTokens
       FROM events
       WHERE event_type = 'usage' AND ts >= ? AND date(ts) >= date('now', ?)`
    )
    .get(baseline, `-${days - 1} days`) as { totalTokens: number | null };

  const invocationRow = db
    .prepare(
      `SELECT COUNT(*) AS totalInvocations
       FROM events
       WHERE event_type = 'tool_invocation' AND ts >= ? AND date(ts) >= date('now', ?)`
    )
    .get(baseline, `-${days - 1} days`) as { totalInvocations: number };

  return {
    totalTokens: tokenRow.totalTokens ?? 0,
    totalInvocations: invocationRow.totalInvocations ?? 0,
  };
}

export interface WindowTotals {
  totalTokens: number;
  tokensIn: number;
  tokensOut: number;
  tokensCache: number;
}

/** Real token burn over a rolling window ending now — e.g. getWindowTotals(5)
 * is the true trailing-5-hour total (not a calendar-day approximation). Splits
 * the total into in / out / cache so the live meter can show a real breakdown.
 * Respects the stats baseline like every other query. Additive helper — powers
 * /api/usage-window's real 5h + weekly windows without touching existing fns. */
export function getWindowTotals(hoursBack: number): WindowTotals {
  const baseline = getStatsBaseline();
  const since = new Date(Date.now() - hoursBack * 3_600_000).toISOString();
  // Window start is the later of (now - hoursBack) and the baseline, so a fresh
  // reset never lets an old event leak back into a rolling window.
  const windowStart = since > baseline ? since : baseline;
  const row = db
    .prepare(
      `SELECT
         SUM(tokens_in) AS tokensIn,
         SUM(tokens_out) AS tokensOut,
         SUM(tokens_cache_read + tokens_cache_creation) AS tokensCache
       FROM events
       WHERE event_type = 'usage' AND ts >= ?`
    )
    .get(windowStart) as {
    tokensIn: number | null;
    tokensOut: number | null;
    tokensCache: number | null;
  };

  const tokensIn = row.tokensIn ?? 0;
  const tokensOut = row.tokensOut ?? 0;
  const tokensCache = row.tokensCache ?? 0;
  return { totalTokens: tokensIn + tokensOut + tokensCache, tokensIn, tokensOut, tokensCache };
}

// ---------------------------------------------------------------------------
// Insights aggregates (power /api/insights)
// ---------------------------------------------------------------------------

export interface SinceBaselineTotals {
  totalTokens: number;
  totalRuns: number;
  days: number;
}

/** Real totals across the *entire* baseline window (not a trailing N-day
 * slice like getOverallTotals) plus how many days that window spans, so the
 * insights screen can say "since baseline" honestly. */
export function getSinceBaselineTotals(): SinceBaselineTotals {
  const baseline = getStatsBaseline();
  const tokenRow = db
    .prepare(
      `SELECT SUM(tokens_in + tokens_out + tokens_cache_read + tokens_cache_creation) AS totalTokens
       FROM events WHERE event_type = 'usage' AND ts >= ?`
    )
    .get(baseline) as { totalTokens: number | null };
  const runRow = db
    .prepare(`SELECT COUNT(*) AS totalRuns FROM events WHERE event_type = 'tool_invocation' AND ts >= ?`)
    .get(baseline) as { totalRuns: number };

  const days = Math.max(1, Math.ceil((Date.now() - Date.parse(baseline)) / 86_400_000));
  return { totalTokens: tokenRow.totalTokens ?? 0, totalRuns: runRow.totalRuns ?? 0, days };
}

export interface DailyTokensAndRuns {
  date: string;
  tokens: number;
  runs: number;
}

/** Trailing N days (oldest first), zero-filled, combining token burn (usage
 * events) and invocation counts (tool events) per day. */
export function getDailyTokensAndRuns(days = 30): DailyTokensAndRuns[] {
  const baseline = getStatsBaseline();
  const windowClause = `-${days - 1} days`;

  const tokenRows = db
    .prepare(
      `SELECT date(ts) AS date, SUM(tokens_in + tokens_out + tokens_cache_read + tokens_cache_creation) AS tokens
       FROM events
       WHERE event_type = 'usage' AND ts >= ? AND date(ts) >= date('now', ?)
       GROUP BY date(ts)`
    )
    .all(baseline, windowClause) as { date: string; tokens: number }[];

  const runRows = db
    .prepare(
      `SELECT date(ts) AS date, COUNT(*) AS runs
       FROM events
       WHERE event_type = 'tool_invocation' AND ts >= ? AND date(ts) >= date('now', ?)
       GROUP BY date(ts)`
    )
    .all(baseline, windowClause) as { date: string; runs: number }[];

  const tokensByDate = new Map(tokenRows.map((r) => [r.date, r.tokens || 0]));
  const runsByDate = new Map(runRows.map((r) => [r.date, r.runs || 0]));

  const result: DailyTokensAndRuns[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    result.push({ date: key, tokens: tokensByDate.get(key) ?? 0, runs: runsByDate.get(key) ?? 0 });
  }
  return result;
}

export interface HourlyTotal {
  hour: number;
  tokens: number;
}

/** Token burn bucketed by hour-of-day (0-23), summed across the whole
 * baseline window — surfaces "you tend to burn tokens around 2pm" patterns.
 * Hour is derived from the stored ISO timestamp via SQLite's strftime. */
export function getHourlyTotals(): HourlyTotal[] {
  const baseline = getStatsBaseline();
  const rows = db
    .prepare(
      `SELECT CAST(strftime('%H', ts) AS INTEGER) AS hour,
              SUM(tokens_in + tokens_out + tokens_cache_read + tokens_cache_creation) AS tokens
       FROM events
       WHERE event_type = 'usage' AND ts >= ?
       GROUP BY hour`
    )
    .all(baseline) as { hour: number; tokens: number }[];

  const byHour = new Map(rows.map((r) => [r.hour, r.tokens || 0]));
  const result: HourlyTotal[] = [];
  for (let h = 0; h < 24; h++) result.push({ hour: h, tokens: byHour.get(h) ?? 0 });
  return result;
}

export interface Burner {
  name: string;
  category: ToolCategory;
  tokens: number;
  runs: number;
  sharePct: number;
}

/** Which skills/agents are burning the most tokens.
 *
 * The `events` table doesn't meter tokens per individual tool call (usage
 * rows carry token counts; tool_invocation rows don't). So "tokens" here is a
 * real, derived attribution, not an invented number: each session's total
 * usage tokens are split evenly across that session's tool invocations, and
 * a name's tokens are the sum of its share across every session it appeared
 * in. Runs are exact real counts. Invocations with no session_id (or whose
 * session has no recorded usage) contribute 0 tokens but still count as a
 * real run. */
export function getBurners(limit = 8): Burner[] {
  const baseline = getStatsBaseline();

  const usageRows = db
    .prepare(
      `SELECT session_id AS sessionId, SUM(tokens_in + tokens_out + tokens_cache_read + tokens_cache_creation) AS tokens
       FROM events
       WHERE event_type = 'usage' AND ts >= ? AND session_id IS NOT NULL
       GROUP BY session_id`
    )
    .all(baseline) as { sessionId: string; tokens: number }[];
  const sessionTokens = new Map(usageRows.map((r) => [r.sessionId, r.tokens || 0]));

  const toolRows = db
    .prepare(
      `SELECT session_id AS sessionId, tool_name AS toolName, category
       FROM events
       WHERE event_type = 'tool_invocation' AND ts >= ? AND tool_name IS NOT NULL AND category IS NOT NULL`
    )
    .all(baseline) as { sessionId: string | null; toolName: string; category: ToolCategory }[];

  const sessionToolCounts = new Map<string, number>();
  for (const row of toolRows) {
    if (!row.sessionId) continue;
    sessionToolCounts.set(row.sessionId, (sessionToolCounts.get(row.sessionId) ?? 0) + 1);
  }

  const byKey = new Map<string, Burner>();
  for (const row of toolRows) {
    const key = `${row.category}:${row.toolName}`;
    const existing = byKey.get(key) ?? { name: row.toolName, category: row.category, tokens: 0, runs: 0, sharePct: 0 };
    existing.runs += 1;
    if (row.sessionId) {
      const total = sessionTokens.get(row.sessionId) ?? 0;
      const count = sessionToolCounts.get(row.sessionId) ?? 1;
      existing.tokens += total / count;
    }
    byKey.set(key, existing);
  }

  const burners = Array.from(byKey.values()).map((b) => ({ ...b, tokens: Math.round(b.tokens) }));
  const totalBurnerTokens = burners.reduce((sum, b) => sum + b.tokens, 0);
  for (const b of burners) {
    b.sharePct = totalBurnerTokens > 0 ? Math.round((b.tokens / totalBurnerTokens) * 1000) / 10 : 0;
  }

  return burners.sort((a, b) => b.tokens - a.tokens || b.runs - a.runs).slice(0, limit);
}

// ---------------------------------------------------------------------------
// Per-project activity rollup (powers /api/projects/summary)
// ---------------------------------------------------------------------------

export interface ProjectActivityRollup {
  /** Max indexed event ts (usage or tool_invocation) attributed to this
   * project -- a real "last worked on" timestamp, distinct from a doc file's
   * mtime. Null is impossible for a row present in the map (GROUP BY only
   * emits projects with at least one matching event). */
  lastActivityAt: string;
  /** Indexed event count for this project over the trailing N days. */
  weeklyEventCount: number;
}

/** One indexed query, grouped by project, giving both the real last-activity
 * timestamp and a trailing-N-day event count per project. Respects the stats
 * baseline like every other real query here (a Settings master reset draws a
 * new "count from here" line for this too, consistent with getRecentEvents'
 * per-project filtering). Powers /api/projects/summary's `lastActivityAt` +
 * `weeklyEventCount` fields -- and the weekly count is the same field a
 * future "Project Pulse" widget can read directly, no separate walk needed. */
export function getProjectActivityRollup(days = 7): Map<string, ProjectActivityRollup> {
  const baseline = getStatsBaseline();
  const rows = db
    .prepare(
      `SELECT
         COALESCE(project_key, project) AS project_key,
         MAX(ts) AS lastActivityAt,
         SUM(CASE WHEN date(ts) >= date('now', ?) THEN 1 ELSE 0 END) AS weeklyEventCount
       FROM events
       WHERE COALESCE(project_key, project) IS NOT NULL AND ts >= ?
       GROUP BY COALESCE(project_key, project)`
    )
    .all(`-${days - 1} days`, baseline) as {
    project_key: string;
    lastActivityAt: string;
    weeklyEventCount: number;
  }[];

  return new Map(
    rows.map((r) => [r.project_key, { lastActivityAt: r.lastActivityAt, weeklyEventCount: r.weeklyEventCount || 0 }])
  );
}

export default db;
