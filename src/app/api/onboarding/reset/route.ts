// POST /api/onboarding/reset
//
// "Replay Setup" — clears the persisted onboarding-flow state so the app
// shows the onboarding sequence again on next load, same spirit as
// /api/reset's "start fresh from now" but scoped to just the onboarding flow
// instead of the whole dashboard.
//
// Owned by Settings lane (B7). Delegates the actual state reset to
// src/server/onboarding-store.ts's resetOnboardingState() — that module is
// owned by a different lane in this same build pass; this route only wires
// the HTTP contract to it and does not know or care about its internals.
//
// POST-only (state-changing). Client reloads the page after a 200.

import { NextResponse } from "next/server";
import { resetOnboardingState } from "../../../../server/onboarding-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  try {
    resetOnboardingState();
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[api/onboarding/reset] reset failed:", err);
    return NextResponse.json({ ok: false, error: "onboarding reset failed" }, { status: 500 });
  }
}
