// GET /api/recent?limit=8&project=<name>
//
// Real "what the agent actually did" feed: the most recent tool invocations
// (skill/agent runs) parsed from ~/.claude logs into usage.db, newest first,
// with real timestamps. Backs the dashboard Activity Feed and terminal-preview
// log — replacing the old hardcoded, fabricated event list. Empty array until
// real activity is indexed, so the dashboard starts fresh and fills in live.
//
// `project` filters to one real project's events (session-follows-focus). Rows
// indexed before project attribution existed are NULL and honestly won't match.
//
// Each row also carries a real `elapsedMs` + `status` ("running"/"done"/null)
// wherever the invocation matched a tracked tool_runs entry (Agent/Task/
// Workflow calls; Skill calls never open one) — see getRecentEvents in db.ts
// for the join. Powers the Activity Feed's real "Agent X · done in 2m" lines.
//
// Same plumbing precedent as /api/weekly + /api/top-agents: ensureIndexed()
// throttled background refresh, then serve the persisted SQLite snapshot.
//
// Placeholder until connected: before the user's real ~/.claude workspace has
// ever been connected (see src/server/connected-store.ts), this returns a
// reshaped slice of the bundled placeholder dataset instead of touching the
// indexer/SQLite at all -- a fresh install has no real ~/.claude history to
// index yet.
//
// POST clears the feed: it just moves the recent-clear-store baseline to now
// (see src/server/recent-clear-store.ts) -- nothing is deleted from the
// underlying SQLite index. GET then filters real events to ts > that
// baseline. Placeholder-path events never touch the baseline at all.

import { NextResponse } from "next/server";
import { ensureIndexed } from "../../../server/log-indexer";
import { getRecentEvents } from "../../../server/db";
import { getRecentClearedAt, markRecentCleared } from "../../../server/recent-clear-store";
import { isWorkspaceConnected } from "../../../server/connected-store";
import { getDemoRecentEvents } from "../../../server/demo-dataset";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 40;

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const raw = Number.parseInt(searchParams.get("limit") ?? "", 10);
    const limit = Number.isFinite(raw) ? Math.min(Math.max(raw, 1), MAX_LIMIT) : DEFAULT_LIMIT;
    const project = searchParams.get("project")?.trim() || null;

    if (!isWorkspaceConnected()) {
      return NextResponse.json({ events: getDemoRecentEvents(limit, project) });
    }

    ensureIndexed();
    const events = getRecentEvents(limit, project);
    const clearedAt = getRecentClearedAt();
    const visible = clearedAt ? events.filter((evt) => evt.ts > clearedAt) : events;
    return NextResponse.json({ events: visible });
  } catch (err) {
    console.error("[api/recent] failed to load recent events:", err);
    return NextResponse.json({ error: "Failed to load recent activity", events: [] }, { status: 500 });
  }
}

/** Clears the Activity Feed by moving the recent-clear-store baseline to now.
 * See the file header for why this filters rather than deletes. */
export async function POST() {
  try {
    const clearedAt = markRecentCleared();
    return NextResponse.json({ clearedAt });
  } catch (err) {
    console.error("[api/recent] failed to clear recent events:", err);
    return NextResponse.json({ error: "Failed to clear recent activity" }, { status: 500 });
  }
}
