// GET  /api/quests            → current quest state (real metrics + tiered
//                               chains + adventure level/XP, all derived from
//                               real activity — see src/server/quest-store.ts)
// POST /api/quests  { id }     → server-validates and claims a completed quest,
//                               returns the updated state
//
// Quests are milestones over REAL numbers (care history, token burn, agent
// runs, projects worked, care streak, days active). Nothing here is fabricated:
// a quest can only be claimed once its real metric has actually reached the
// target and every earlier tier in its chain is already claimed.

import { NextResponse } from 'next/server';
import { claimQuest, getQuestState } from '../../../server/quest-store';

// Touches local SQLite + a JSON file — never statically optimize or edge-bundle.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Short module-scope TTL cache: getQuestState() fires ~10 separate SQLite COUNT
// queries, and this route is polled every 60s from the pet screen. A ~15s TTL
// absorbs mounts/double-effects cheaply. POST (claimQuest) clears it so a claim
// is reflected immediately rather than waiting out the window.
const CACHE_TTL_MS = 15_000;
let cache: { at: number; payload: ReturnType<typeof getQuestState> } | null = null;

export async function GET() {
  try {
    const now = Date.now();
    if (cache && now - cache.at < CACHE_TTL_MS) {
      return NextResponse.json(cache.payload);
    }
    const payload = getQuestState();
    cache = { at: now, payload };
    return NextResponse.json(payload);
  } catch (err) {
    console.error('[api/quests] GET failed:', err);
    return NextResponse.json({ error: 'Failed to read quest state' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { id?: string };
    if (!body.id || typeof body.id !== 'string') {
      return NextResponse.json({ error: 'id is required' }, { status: 400 });
    }
    const result = claimQuest(body.id);
    if (!result.ok) {
      return NextResponse.json({ error: result.reason }, { status: 409 });
    }
    cache = null; // a claim changed state — don't serve the pre-claim snapshot
    return NextResponse.json({ awarded: result.awarded, state: result.state });
  } catch (err) {
    console.error('[api/quests] POST failed:', err);
    return NextResponse.json({ error: 'Failed to claim quest' }, { status: 500 });
  }
}
