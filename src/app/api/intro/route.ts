// GET  /api/intro  → { seen: boolean } — has the one-time intro cinematic
//                     played (or been skipped) yet, ever?
// POST /api/intro  → marks it seen. Called by IntroCinematic once the
//                     cinematic completes naturally OR is skipped.
//
// Backs src/components/IntroCinematic.tsx. Persistence lives in
// src/server/intro-store.ts (a key in the shared app_meta table).

import { NextResponse } from 'next/server';
import { hasSeenIntro, markIntroSeen } from '../../../server/intro-store';

// Touches a local SQLite file — never statically optimize or edge-bundle.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  try {
    return NextResponse.json({ seen: hasSeenIntro() });
  } catch (err) {
    console.error('[api/intro] GET failed:', err);
    return NextResponse.json({ error: 'Failed to read intro state' }, { status: 500 });
  }
}

export async function POST() {
  try {
    markIntroSeen();
    return NextResponse.json({ seen: true });
  } catch (err) {
    console.error('[api/intro] POST failed:', err);
    return NextResponse.json({ error: 'Failed to mark intro seen' }, { status: 500 });
  }
}
