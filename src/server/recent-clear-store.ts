/**
 * recent-clear-store — tracks the "Clear feed" baseline for the dashboard
 * Activity Feed (GET /api/recent).
 *
 * This does NOT own its own table or database file. It reads/writes a single
 * row on the `app_meta` key/value table that src/server/db.ts already creates
 * (the same table getStatsBaseline()/resetStatsBaseline() and
 * onboarding-store.ts use there) via the shared `db` singleton exported from
 * that module. db.ts itself is never edited by this file.
 *
 * We store a timestamp rather than deleting rows — same "count from here"
 * approach getStatsBaseline() uses — so the underlying ~/.claude history and
 * SQLite index stay untouched and re-indexing remains a safe no-op. The route
 * just filters real events to ts > this baseline; placeholder/demo-path
 * events never touch this table at all (see api/recent/route.ts).
 */

import { db } from './db';

const RECENT_CLEARED_KEY = 'recent_cleared_at_v1';

/** The ISO timestamp the Activity Feed was last cleared at, or null if it has
 * never been cleared on this machine. */
export function getRecentClearedAt(): string | null {
  const row = db.prepare(`SELECT value FROM app_meta WHERE key = ?`).get(RECENT_CLEARED_KEY) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

/** Marks "now" as the new Activity Feed baseline — every event at/before this
 * instant drops out of GET /api/recent until new activity is indexed. */
export function markRecentCleared(): string {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO app_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(RECENT_CLEARED_KEY, now);
  return now;
}
