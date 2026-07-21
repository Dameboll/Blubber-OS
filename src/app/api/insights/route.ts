// GET /api/insights
//
// Real usage-analytics rollup for the Insights screen: since-baseline totals,
// top token/run burners (skills + agents), a daily trend, an hour-of-day
// distribution, and a short list of rule-based suggestions. Every number
// comes straight out of src/server/db.ts's SQLite aggregates — suggestions
// are generated from thresholds applied to those real numbers, never
// invented text with invented figures. 60s in-memory TTL cache so repeated
// dashboard polls don't re-run five aggregate queries every time.

import { NextResponse } from "next/server";
import {
  getSinceBaselineTotals,
  getBurners,
  getDailyTokensAndRuns,
  getHourlyTotals,
  type Burner,
  type DailyTokensAndRuns,
  type HourlyTotal,
  type SinceBaselineTotals,
} from "../../../server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Severity = "info" | "tip" | "warn";

interface Suggestion {
  text: string;
  severity: Severity;
  basedOn: string;
}

interface InsightsPayload {
  sinceBaseline: SinceBaselineTotals;
  burners: Burner[];
  daily: DailyTokensAndRuns[];
  hourly: HourlyTotal[];
  suggestions: Suggestion[];
}

const CACHE_TTL_MS = 60_000;
const MIN_RUNS_FOR_INSIGHTS = 5;
const TOP_BURNER_SHARE_THRESHOLD = 40;
const HOUR_CONCENTRATION_THRESHOLD = 35;

let cached: { at: number; payload: InsightsPayload } | null = null;

function buildSuggestions(
  sinceBaseline: SinceBaselineTotals,
  burners: Burner[],
  hourly: HourlyTotal[]
): Suggestion[] {
  if (sinceBaseline.totalRuns < MIN_RUNS_FOR_INSIGHTS) {
    return [
      {
        text: "Not enough usage recorded yet to surface real patterns. Keep using skills and agents and check back.",
        severity: "info",
        basedOn: `${sinceBaseline.totalRuns} run(s) recorded since baseline`,
      },
    ];
  }

  const suggestions: Suggestion[] = [];

  const top = burners[0];
  if (top && top.sharePct > TOP_BURNER_SHARE_THRESHOLD) {
    suggestions.push({
      text: `${top.name} accounts for ${top.sharePct}% of attributed token usage — worth checking if repetitive ${top.category} work could route through a cheaper model tier.`,
      severity: "tip",
      basedOn: `${top.name} (${top.category}): ${top.sharePct}% share, ${top.runs} runs`,
    });
  }

  const totalHourlyTokens = hourly.reduce((sum, h) => sum + h.tokens, 0);
  if (totalHourlyTokens > 0) {
    const peak = hourly.reduce((best, h) => (h.tokens > best.tokens ? h : best), hourly[0]);
    const peakSharePct = Math.round((peak.tokens / totalHourlyTokens) * 1000) / 10;
    if (peakSharePct > HOUR_CONCENTRATION_THRESHOLD) {
      suggestions.push({
        text: `Usage clusters around ${peak.hour}:00 (${peakSharePct}% of tracked token burn) — heavy runs could be scheduled outside that window.`,
        severity: "info",
        basedOn: `hour ${peak.hour}: ${peakSharePct}% of hourly token distribution`,
      });
    }
  }

  if (suggestions.length === 0) {
    suggestions.push({
      text: "Usage is spread evenly across skills, agents, and hours — no single burner or time window dominates yet.",
      severity: "info",
      basedOn: `${sinceBaseline.totalRuns} runs across ${burners.length} skill/agent name(s)`,
    });
  }

  return suggestions;
}

function computePayload(): InsightsPayload {
  const sinceBaseline = getSinceBaselineTotals();
  const burners = getBurners(8);
  const daily = getDailyTokensAndRuns(30);
  const hourly = getHourlyTotals();
  const suggestions = buildSuggestions(sinceBaseline, burners, hourly);
  return { sinceBaseline, burners, daily, hourly, suggestions };
}

export async function GET() {
  try {
    const now = Date.now();
    if (cached && now - cached.at < CACHE_TTL_MS) {
      return NextResponse.json(cached.payload);
    }
    const payload = computePayload();
    cached = { at: now, payload };
    return NextResponse.json(payload);
  } catch (err) {
    console.error("[api/insights] GET failed:", err);
    return NextResponse.json({ error: "failed to compute insights" }, { status: 500 });
  }
}
