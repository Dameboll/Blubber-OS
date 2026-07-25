// GET /api/agents-live
//
// The REAL live Agents monitor (Item 10). Surfaces genuine in-flight and just-
// finished agent/workflow/task RUNS parsed from ~/.claude logs into usage.db.
// Base classification: "running" while the parent tool_use has no matching
// tool_result yet, "done" once it lands. That alone is blind to background-
// dispatched runs (run_in_background, the default) -- their parent tool_use
// resolves with a dispatch acknowledgment almost instantly, not when the real
// work finishes -- so a "done" run whose own subagent transcript is still
// fresh gets reclassified back to "running" below (STILL_ACTIVE_WINDOW_MS).
// Every row is a real invocation with a real elapsed time and real
// session-token attribution. Nothing here is fabricated (LAW 1): empty
// arrays until Claude actually runs an agent or workflow.
//
// Same plumbing as /api/recent: ensureIndexed() kicks a throttled background
// pass, then we serve the persisted snapshot (sub-100ms).
//
// activity + heroSession (last-hard-push Phase 1): two additions layered on
// top, both sourced from session-activity.ts's targeted, non-indexed tail
// reads (never the throttled SQLite snapshot, never a directory walk) --
//   - `activity` on each RUNNING run: a compact "Tool → target" string read
//     straight from that subagent's own transcript file (see
//     session-activity.ts for the real toolUseId correlation key). Finished
//     runs don't get one -- there's nothing "happening now" to report, and
//     it avoids extra file reads for rows nobody needs live data for.
//   - `heroSession`: the CURRENT project's own main session (this app's own
//     ~/.claude transcript, not a subagent) -- working/activity/lastAssistantText,
//     all real, all read live off disk.

import path from "path";
import { NextResponse } from "next/server";
import { ensureIndexed } from "../../../server/log-indexer";
import { getLiveRuns, type LiveRun } from "../../../server/db";
import { shortAgentName } from "../../../lib/agent-name";
import { humanizeSlug } from "../../../lib/humanize";
import { isWorkspaceConnected } from "../../../server/connected-store";
import {
  getMainSessionActivity,
  getRunActivity,
  getRunTranscriptMtimeMs,
  RECENT_EVENT_WINDOW_MS,
} from "../../../server/session-activity";

// A run the indexer marked "done" (its parent tool_use/tool_result closed)
// is reclassified back to "running" for display when its own subagent
// transcript file was modified more recently than this window ago -- see
// getRunTranscriptMtimeMs's doc comment for why the indexer's view alone is
// blind to background-dispatched agents. Same window as the hero session's
// own liveness gate for consistency.
const STILL_ACTIVE_WINDOW_MS = RECENT_EVENT_WINDOW_MS;

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function shapeRun(r: LiveRun, includeActivity: boolean) {
  return {
    runId: r.runId,
    name: shortAgentName(r.toolName),
    fullName: humanizeSlug(r.toolName),
    slug: r.toolName,
    category: r.category,
    project: r.project,
    status: r.status,
    elapsedMs: r.elapsedMs,
    tokens: r.tokens,
    startedAt: r.tsStart,
    endedAt: r.tsEnd,
    activity: includeActivity ? getRunActivity(r.project, r.sessionId, r.runId).activity : null,
  };
}

export async function GET() {
  // A fresh shell has not been authorized to read ~/.claude yet. Keep every
  // live/session field empty until onboarding explicitly connects a workspace;
  // otherwise the placeholder Agents screen can leak text from a real session.
  if (!isWorkspaceConnected()) {
    return NextResponse.json({
      running: [],
      recent: [],
      runningCount: 0,
      heroSession: { working: false, activity: null, lastAssistantText: null },
    });
  }

  try {
    ensureIndexed();
    const { running, recent } = getLiveRuns();

    // Reclassify: a "done" run whose own transcript is still fresh is
    // actually still running (see STILL_ACTIVE_WINDOW_MS above) -- move it
    // over before shaping either array so runningCount, the Workfloor's
    // bay-materialize effect, and this run's `activity` field all agree.
    const now = Date.now();
    const stillRecent: LiveRun[] = [];
    const reclassifiedRunning: LiveRun[] = [];
    for (const r of recent) {
      const mtimeMs = getRunTranscriptMtimeMs(r.project, r.sessionId, r.runId);
      if (mtimeMs !== null && now - mtimeMs <= STILL_ACTIVE_WINDOW_MS) {
        reclassifiedRunning.push({
          ...r,
          status: "running",
          tsEnd: null,
          elapsedMs: Math.max(0, now - Date.parse(r.tsStart)),
        });
      } else {
        stillRecent.push(r);
      }
    }
    const effectiveRunning = [...running, ...reclassifiedRunning];

    // The CURRENT project is this app's own working directory -- the same
    // convention db.ts/log-indexer.ts already use (process.cwd() is the
    // project root; the indexer attributes events by matching real
    // Development/<root>/<name> folders the same way).
    const currentProject = path.basename(process.cwd());
    const mainSession = getMainSessionActivity(currentProject);
    const working =
      mainSession.lastEventTs !== null &&
      Date.now() - Date.parse(mainSession.lastEventTs) <= RECENT_EVENT_WINDOW_MS;

    return NextResponse.json({
      running: effectiveRunning.map((r) => shapeRun(r, true)),
      recent: stillRecent.map((r) => shapeRun(r, false)),
      runningCount: effectiveRunning.length,
      heroSession: {
        working,
        activity: mainSession.activity,
        lastAssistantText: mainSession.lastAssistantText,
      },
    });
  } catch (err) {
    console.error("[api/agents-live] failed to load live runs:", err);
    return NextResponse.json(
      {
        error: "Failed to load live agents",
        running: [],
        recent: [],
        runningCount: 0,
        heroSession: { working: false, activity: null, lastAssistantText: null },
      },
      { status: 500 },
    );
  }
}
