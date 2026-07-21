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
// Demo Mode: when the `blubber_demo` cookie is set (see src/lib/demo-mode.ts),
// this returns a reshaped slice of the bundled demo dataset instead of
// touching the indexer/SQLite at all -- a demo visitor has no real ~/.claude
// history to index.

import { NextResponse } from "next/server";
import { ensureIndexed } from "../../../server/log-indexer";
import { getRecentEvents } from "../../../server/db";
import { isDemoModeRequest } from "../../../lib/demo-mode";
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

    if (isDemoModeRequest(request)) {
      return NextResponse.json({ events: getDemoRecentEvents(limit, project) });
    }

    ensureIndexed();
    const events = getRecentEvents(limit, project);
    return NextResponse.json({ events });
  } catch (err) {
    console.error("[api/recent] failed to load recent events:", err);
    return NextResponse.json({ error: "Failed to load recent activity", events: [] }, { status: 500 });
  }
}
