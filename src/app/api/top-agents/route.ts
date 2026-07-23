// GET /api/top-agents?range=daily|weekly|alltime
//
// Backs DashboardScreen's "Top Agents" panel's Daily/Weekly/All-Time toggle.
// Pure plumbing on top of already-built, already-tested query helpers in
// server/db.ts (getTopByCategory / getTopByCategoryAllTime) -- those existed
// but had no route exposing them yet. No new aggregation logic here, just a
// thin range -> query mapping, same shape/precedent as /api/weekly.
//
// Placeholder until connected: before the user's real ~/.claude workspace has
// ever been connected (see src/server/connected-store.ts), this returns the
// bundled placeholder dataset's topAgents list (scaled per range) instead of
// querying SQLite -- a fresh install has no real agent-run history yet.

import { NextResponse } from "next/server";
import { ensureIndexed } from "../../../server/log-indexer";
import { getTopByCategory, getTopByCategoryAllTime, type NamedCount } from "../../../server/db";
import { isWorkspaceConnected } from "../../../server/connected-store";
import { getDemoTopAgents, type DemoTopAgentsRange } from "../../../server/demo-dataset";

// Depends on live filesystem state + SQLite, same as /api/weekly.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TOP_N = 5;
const RANGES = new Set(["daily", "weekly", "alltime"]);

// Module-scope TTL cache, same precedent as /api/agents and /api/insights.
// This route is polled every 5s from AgentsScreen AND fetched from the Dashboard
// Top Agents panel; each uncached call ran a real SQLite aggregate. An ~8s TTL
// (just over the client cadence) collapses that to one query per range per
// window. Keyed by range + connection state so connecting a workspace can't
// serve a stale placeholder past the TTL.
const CACHE_TTL_MS = 8000;
const cache = new Map<string, { at: number; payload: { agents: NamedCount[]; range: string } }>();

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const rangeParam = searchParams.get("range") ?? "weekly";
    const range = RANGES.has(rangeParam) ? rangeParam : "weekly";
    const connected = isWorkspaceConnected();

    const cacheKey = `${range}:${connected ? 1 : 0}`;
    const now = Date.now();
    const hit = cache.get(cacheKey);
    if (hit && now - hit.at < CACHE_TTL_MS) {
      return NextResponse.json(hit.payload);
    }

    if (!connected) {
      const payload = { agents: getDemoTopAgents(range as DemoTopAgentsRange), range };
      cache.set(cacheKey, { at: now, payload });
      return NextResponse.json(payload);
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

    const payload = { agents, range };
    cache.set(cacheKey, { at: now, payload });
    return NextResponse.json(payload);
  } catch (err) {
    console.error("[api/top-agents] failed to load top agents:", err);
    return NextResponse.json({ error: "Failed to load top agents", agents: [] }, { status: 500 });
  }
}
