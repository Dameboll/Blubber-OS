// GET /api/usage-window
// Returns real token totals for a rolling 5-hour and 7-day window.
// Consumed by the Dashboard's compact Usage strip and the LiveUsageMeter pill.

import { NextResponse } from "next/server";
import { ensureIndexed } from "../../../server/log-indexer";
import { getWindowTotals } from "../../../server/db";
import { isDemoModeRequest } from "../../../lib/demo-mode";
import { getDemoUsageWindow } from "../../../server/demo-dataset";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const WEEK_HOURS = 24 * 7;

export async function GET(request: Request) {
  // Demo Mode must never leak the real machine's token burn (this was the
  // most visible leak: a "Demo Mode" dashboard showing real 5h/weekly totals).
  if (isDemoModeRequest(request)) {
    return NextResponse.json(getDemoUsageWindow());
  }
  try {
    ensureIndexed();

    // Real rolling windows ending now (not calendar-day approximations).
    const fiveHourWin = getWindowTotals(5);
    const weeklyWin = getWindowTotals(WEEK_HOURS);
    const todayWin = getWindowTotals(24);

    return NextResponse.json({
      // Backward-compatible top-level numbers (existing Dashboard caller).
      fiveHour: fiveHourWin.totalTokens,
      weekly: weeklyWin.totalTokens,
      today: todayWin.totalTokens,
      // Rich breakdown for the LiveUsageMeter (in / out / cache split).
      breakdown: {
        fiveHour: fiveHourWin,
        weekly: weeklyWin,
        today: todayWin,
      },
    });
  } catch (err) {
    console.error("[api/usage-window] failed:", err);
    return NextResponse.json(
      { error: "Failed to fetch usage window", fiveHour: 0, weekly: 0, today: 0 },
      { status: 500 }
    );
  }
}
