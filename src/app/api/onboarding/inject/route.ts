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

import { NextResponse } from 'next/server';
import { ensureIndexed } from '../../../../server/log-indexer';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST() {
  try {
    ensureIndexed();
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[api/onboarding/inject] POST failed:', err);
    return NextResponse.json({ ok: false, error: 'Failed to inject setup' }, { status: 500 });
  }
}
