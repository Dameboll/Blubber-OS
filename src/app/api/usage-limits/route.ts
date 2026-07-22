// GET /api/usage-limits
//
// Real plan-usage percentages (5-hour session + weekly) — the same data the
// terminal statusline shows. Reads the shared cache the statusline hook writes
// (`%TEMP%/claude-usage-meter.json`); if that's stale, fetches the Anthropic
// OAuth usage endpoint server-side and rewrites the SAME cache file (identical
// shape, so the statusline keeps working off it too).
//
// SECURITY: the OAuth access token is read server-side only and is NEVER
// logged, returned, or exposed to the client. This route runs on the Node
// runtime and returns only aggregate percentages.

import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import os from "os";
import { isDemoModeRequest } from "../../../lib/demo-mode";
import { getDemoUsageLimits } from "../../../server/demo-dataset";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CACHE_FILE = path.join(os.tmpdir(), "claude-usage-meter.json");
const CREDS_FILE = path.join(os.homedir(), ".claude", ".credentials.json");
const FRESH_MS = 120_000; // serve cache without a network hit if younger than this
const OAUTH_URL = "https://api.anthropic.com/api/oauth/usage";

interface CacheShape {
  ts: number;
  session: number | null;
  weekly: number | null;
  session_resets: string | null;
}

interface LimitsResponse {
  session_pct: number | null;
  weekly_pct: number | null;
  session_resets: string | null;
  stale: boolean;
}

function readCache(): CacheShape | null {
  try {
    const raw = fs.readFileSync(CACHE_FILE, "utf8");
    const parsed = JSON.parse(raw) as CacheShape;
    if (typeof parsed.ts !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

function readToken(): string | null {
  try {
    const raw = fs.readFileSync(CREDS_FILE, "utf8");
    const token = JSON.parse(raw)?.claudeAiOauth?.accessToken;
    return typeof token === "string" && token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

/** Fetch the live OAuth usage endpoint and normalize to the cache shape.
 * Mirrors ~/.claude/hooks/usage-meter.js exactly so the rewritten cache file
 * stays statusline-compatible. Returns null on any failure (missing creds,
 * network error, non-200) — the caller then falls back to whatever cache
 * exists and flags it stale. The token never leaves this function. */
async function fetchLiveUsage(): Promise<CacheShape | null> {
  const token = readToken();
  if (!token) return null;

  let json: {
    five_hour?: { utilization?: number; resets_at?: string | null };
    seven_day?: { utilization?: number };
    limits?: { group?: string; percent?: number }[];
  };
  try {
    const res = await fetch(OAUTH_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
        Connection: "close",
        "Cache-Control": "no-cache",
      },
      // Discourage a pinned/stale pooled keep-alive connection from serving a
      // cached pre-rollover snapshot (see stale-payload guard below).
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null; // 401 etc: keep old cache; CC refreshes the token itself
    json = await res.json();
  } catch {
    return null;
  }

  const session = json.five_hour?.utilization ?? null;
  // Weekly: worst of the overall seven-day utilization and any model-scoped
  // weekly limit percent.
  let weekly = json.seven_day?.utilization ?? null;
  for (const l of json.limits ?? []) {
    if (l.group === "weekly" && typeof l.percent === "number" && l.percent > (weekly ?? -1)) {
      weekly = l.percent;
    }
  }
  if (session == null && weekly == null) return null;

  const session_resets = json.five_hour?.resets_at ?? null;

  // STALE-PAYLOAD REJECTION: Anthropic's endpoint intermittently serves a
  // stale pre-rollover snapshot to a pooled connection — its own resets_at
  // timestamp is already in the past. That's a self-evidently invalid
  // sample; treat it as a failed fetch rather than caching/returning it.
  if (session_resets) {
    const resetsAt = Date.parse(session_resets);
    if (!Number.isNaN(resetsAt) && resetsAt < Date.now()) {
      return null;
    }
  }

  return {
    ts: Date.now(),
    session,
    weekly,
    session_resets,
  };
}

function writeCache(cache: CacheShape, previous: CacheShape | null): void {
  // MONOTONIC GUARD: last-good-wins, not last-write-wins. If the new sample's
  // reset timestamp is older than what's already cached, it's the same class
  // of stale/out-of-order response the rejection above targets — refuse the
  // write and keep the newer cache instead of letting it clobber good data.
  if (previous?.session_resets && cache.session_resets) {
    const prevResets = Date.parse(previous.session_resets);
    const nextResets = Date.parse(cache.session_resets);
    if (!Number.isNaN(prevResets) && !Number.isNaN(nextResets) && nextResets < prevResets) {
      return;
    }
  }
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
  } catch {
    // Best-effort: a failed cache write just means the next call re-fetches.
  }
}

export async function GET(request: Request) {
  // Demo Mode: fixed fiction, never the real plan percentages (and never a
  // reason to touch the real OAuth token path at all).
  if (isDemoModeRequest(request)) {
    return NextResponse.json(getDemoUsageLimits());
  }

  const cache = readCache();
  const now = Date.now();

  // Fresh cache — serve it directly, no network hit.
  if (cache && now - cache.ts < FRESH_MS) {
    const body: LimitsResponse = {
      session_pct: cache.session,
      weekly_pct: cache.weekly,
      session_resets: cache.session_resets,
      stale: false,
    };
    return NextResponse.json(body);
  }

  // Stale or missing — try a live fetch, then rewrite the shared cache.
  const live = await fetchLiveUsage();
  if (live) {
    writeCache(live, cache);
    const body: LimitsResponse = {
      session_pct: live.session,
      weekly_pct: live.weekly,
      session_resets: live.session_resets,
      stale: false,
    };
    return NextResponse.json(body);
  }

  // Live fetch failed — fall back to last-known cache (flagged stale) or empty.
  const body: LimitsResponse = {
    session_pct: cache?.session ?? null,
    weekly_pct: cache?.weekly ?? null,
    session_resets: cache?.session_resets ?? null,
    stale: true,
  };
  return NextResponse.json(body);
}
