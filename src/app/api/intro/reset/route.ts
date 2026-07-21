// POST /api/intro/reset
//
// "Replay Setup" — clears the persisted intro-flow state so the app shows
// the first-run intro sequence again on next load. Companion route to
// /api/onboarding/reset (same button triggers both); this one covers the
// intro flow specifically.
//
// Owned by Settings lane (B7). Delegates the actual state reset to
// src/server/intro-store.ts's resetIntroState() — that module is owned by a
// different lane in this same build pass; this route only wires the HTTP
// contract to it and does not know or care about its internals.
//
// POST-only (state-changing). Client reloads the page after a 200.

import { NextResponse } from "next/server";
import { resetIntroState } from "../../../../server/intro-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  try {
    resetIntroState();
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[api/intro/reset] reset failed:", err);
    return NextResponse.json({ ok: false, error: "intro reset failed" }, { status: 500 });
  }
}
