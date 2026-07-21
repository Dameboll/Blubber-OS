// GET /api/weekly
// Returns the trailing-7-day usage rollup consumed by WeeklyRecap.tsx:
//   { dailyTrend, topAgents, topSkills, totals }
//
// Kicks a throttled, background incremental index (ensureIndexed) and serves
// the persisted SQLite snapshot immediately -- the filesystem walk over every
// transcript never blocks the response, so this returns in ~50ms instead of
// re-walking ~/.claude/projects on each request. Numbers may lag real usage by
// a few seconds; the SQLite file persists, so a cold start still serves real data.

import { NextResponse } from "next/server";
import { ensureIndexed } from "../../../server/log-indexer";
import { getDailyTotals, getTopByCategory, getOverallTotals } from "../../../server/db";

// Depends on live filesystem state (the ~/.claude/projects transcripts) and
// a local SQLite file -- never statically optimize or edge-bundle this.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TRAILING_DAYS = 7;
const TOP_N = 5;

export async function GET() {
  try {
    ensureIndexed();

    const dailyTrend = getDailyTotals(TRAILING_DAYS).map((d) => ({
      date: d.date,
      totalTokens: d.totalTokens,
    }));

    const topAgents = getTopByCategory("agent", TOP_N, TRAILING_DAYS);
    const topSkills = getTopByCategory("skill", TOP_N, TRAILING_DAYS);
    const totals = getOverallTotals(TRAILING_DAYS);

    return NextResponse.json({
      dailyTrend,
      topAgents,
      topSkills,
      totals,
    });
  } catch (err) {
    console.error("[api/weekly] failed to build weekly rollup:", err);
    return NextResponse.json(
      { error: "Failed to build weekly rollup", dailyTrend: [], topAgents: [], topSkills: [] },
      { status: 500 }
    );
  }
}
