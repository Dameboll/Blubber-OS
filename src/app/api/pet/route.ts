// GET  /api/pet  → current pet state (needs decayed to now, written through)
// POST /api/pet  { action: 'feed'|'shower'|'play'|'sleep'|'pet'|'talk' }
//                → applies the action and returns the updated state
//
// The Virtual Blubber is a persistent, real-time-decaying pet — see
// src/server/pet-store.ts. Neglect (low needs) feeds the FlubberBrain baseline
// so it shows app-wide.

import { NextResponse } from 'next/server';
import { applyPetAction, getPetState, type PetAction } from '../../../server/pet-store';

// Touches a local SQLite file — never statically optimize or edge-bundle.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const VALID_ACTIONS: PetAction[] = ['feed', 'shower', 'play', 'sleep', 'pet', 'talk'];

export async function GET() {
  try {
    return NextResponse.json(getPetState());
  } catch (err) {
    console.error('[api/pet] GET failed:', err);
    return NextResponse.json({ error: 'Failed to read pet state' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { action?: string };
    const action = body.action as PetAction | undefined;
    if (!action || !VALID_ACTIONS.includes(action)) {
      return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
    }
    return NextResponse.json(applyPetAction(action));
  } catch (err) {
    console.error('[api/pet] POST failed:', err);
    return NextResponse.json({ error: 'Failed to apply pet action' }, { status: 500 });
  }
}
