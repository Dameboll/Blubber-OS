// POST /api/onboarding/inject → { ok: true }
//
// "Inject my setup" — kicks the SAME background indexer every dashboard
// screen already relies on (src/server/log-indexer.ts's ensureIndexed()) so
// the user's real ~/.claude history starts populating the dashboard right
// away instead of waiting for the first screen mount to trigger it. Never
// reimplements indexing here.
//
// ensureIndexed() is throttled + runs off the request path (see its own doc
// comment in log-indexer.ts), so this route returns immediately — the actual
// walk over ~/.claude/projects happens in the background. The onboarding UI
// follows this call with a plain GET /api/system fetch to show real, live
// machine stats as proof the dashboard is reading real data.
//
// A successful inject also flips the workspace-connected gate (see
// src/server/connected-store.ts) — this is the one place in the app that
// marks the free-tier "raw shell" as connected, which is what switches every
// stats/activity API route from the bundled placeholder dataset over to real
// data going forward.
//
// TRUE FRESH START (see docs/plans -- LANE 1 TASK B): ensureIndexed() above
// walks the user's REAL ~/.claude/projects history into usage.db with real
// historical timestamps -- some of which predate this moment by months. Every
// stats/quest query filters by the stats baseline (WHERE ts >= baseline), so
// the fix is not to skip indexing that history (other screens need it for
// e.g. "days active" math) -- it's to move the baseline to right now the
// FIRST time this workspace ever connects, so none of that pre-connect
// history counts toward stats or quest progress. markWorkspaceConnected()
// only returns true on that first flip; a repeat inject on an
// already-connected workspace must NOT re-zero a returning user's progress.
import { NextResponse } from 'next/server';
import { ensureIndexed } from '../../../../server/log-indexer';
import { markWorkspaceConnected } from '../../../../server/connected-store';
import { resetStatsBaseline } from '../../../../server/db';
import { resetQuests } from '../../../../server/quest-store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST() {
  try {
    ensureIndexed();
    const isFirstConnect = markWorkspaceConnected();
    if (isFirstConnect) {
      resetStatsBaseline();
      resetQuests();
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[api/onboarding/inject] POST failed:', err);
    return NextResponse.json({ ok: false, error: 'Failed to inject setup' }, { status: 500 });
  }
}
