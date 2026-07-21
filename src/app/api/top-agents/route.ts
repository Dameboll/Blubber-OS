// GET /api/top-agents?range=daily|weekly|alltime
//
// Backs DashboardScreen's "Top Agents" panel's Daily/Weekly/All-Time toggle.
// Pure plumbing on top of already-built, already-tested query helpers in
// server/db.ts (getTopByCategory / getTopByCategoryAllTime) -- those existed
// but had no route exposing them yet. No new aggregation logic here, just a
// thin range -> query mapping, same shape/precedent as /api/weekly.
//
// Demo Mode: when the `blubber_demo` cookie is set (see src/lib/demo-mode.ts),
// this returns the bundled demo dataset's topAgents list (scaled per range)
// instead of querying SQLite -- a demo visitor has no real agent-run history.

import { NextResponse } from "next/server";
import { ensureIndexed } from "../../../server/log-indexer";
import { getTopByCategory, getTopByCategoryAllTime, type NamedCount } from "../../../server/db";
import { isDemoModeRequest } from "../../../lib/demo-mode";
import { getDemoTopAgents, type DemoTopAgentsRange } from "../../../server/demo-dataset";

// Depends on live filesystem state + SQLite, same as /api/weekly.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TOP_N = 5;
const RANGES = new Set(["daily", "weekly", "alltime"]);

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const rangeParam = searchParams.get("range") ?? "weekly";
    const range = RANGES.has(rangeParam) ? rangeParam : "weekly";

    if (isDemoModeRequest(request)) {
      return NextResponse.json({ agents: getDemoTopAgents(range as DemoTopAgentsRange), range });
    }

    ensureIndexed();

    let agents: NamedCount[];
    if (range === "daily") {
      agents = getTopByCategory("agent", TOP_N, 1);
    } else if (range === "alltime") {
      agents = getTopByCategoryAllTime("agent", TOP_N);
    } else {
      agents = getTopByCategory("agent", TOP_N, 7);
    }

    return NextResponse.json({ agents, range });
  } catch (err) {
    console.error("[api/top-agents] failed to load top agents:", err);
    return NextResponse.json({ error: "Failed to load top agents", agents: [] }, { status: 500 });
  }
}
