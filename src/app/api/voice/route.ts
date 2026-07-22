// GET  /api/voice -> { config: VoiceConfig }
// POST /api/voice { config: Partial<VoiceConfig> } -> { config: VoiceConfig }
//
// The blubber-speak voice config (voiceStyle, pitch, speed, volume, muted).
// Backed by a small atomically-written JSON file (see src/server/voice-store.ts),
// mirroring src/app/api/brain/route.ts exactly. Defaults: bubbly / 55 / 60 / 70 / unmuted.

import { NextResponse } from "next/server";
import * as voiceStore from "../../../server/voice-store";
import type { VoiceConfig } from "../../../server/voice-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ config: voiceStore.get() });
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { config?: Partial<VoiceConfig> };
    if (!body.config || typeof body.config !== "object") {
      return NextResponse.json({ error: "config is required" }, { status: 400 });
    }
    const config = voiceStore.update(body.config);
    return NextResponse.json({ config });
  } catch (err) {
    console.error("[api/voice] POST failed:", err);
    return NextResponse.json({ error: "failed to update voice config" }, { status: 500 });
  }
}
