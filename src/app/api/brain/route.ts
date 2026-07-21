// GET  /api/brain -> { config: BrainConfig }
// POST /api/brain { config: Partial<BrainConfig> } -> { config: BrainConfig }
//
// The FlubberBrain personality/behavior config (personalityMode, energyLevel,
// movementAmount, talkativeness). Backed by a small atomically-written JSON
// file (see src/server/brain-store.ts). Defaults: playful / 75 / 70 / 60.

import { NextResponse } from "next/server";
import * as brainStore from "../../../server/brain-store";
import type { BrainConfig } from "../../../server/brain-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ config: brainStore.get() });
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { config?: Partial<BrainConfig> };
    if (!body.config || typeof body.config !== "object") {
      return NextResponse.json({ error: "config is required" }, { status: 400 });
    }
    const config = brainStore.update(body.config);
    return NextResponse.json({ config });
  } catch (err) {
    console.error("[api/brain] POST failed:", err);
    return NextResponse.json({ error: "failed to update brain config" }, { status: 500 });
  }
}
