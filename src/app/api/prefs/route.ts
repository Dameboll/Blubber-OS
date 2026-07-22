// GET  /api/prefs -> { prefs: UiPrefs }
// POST /api/prefs { prefs: Partial<UiPrefs> } -> { prefs: UiPrefs }
//
// The Settings "ui_prefs_v1" blob (Appearance + Notifications toggles).
// Backed by a single app_meta row (see src/server/prefs-store.ts), mirroring
// src/app/api/brain/route.ts's shape exactly.

import { NextResponse } from "next/server";
import * as prefsStore from "../../../server/prefs-store";
import type { UiPrefs } from "../../../server/prefs-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ prefs: prefsStore.get() });
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { prefs?: Partial<UiPrefs> };
    if (!body.prefs || typeof body.prefs !== "object") {
      return NextResponse.json({ error: "prefs is required" }, { status: 400 });
    }
    const prefs = prefsStore.update(body.prefs);
    return NextResponse.json({ prefs });
  } catch (err) {
    console.error("[api/prefs] POST failed:", err);
    return NextResponse.json({ error: "failed to update prefs" }, { status: 500 });
  }
}
