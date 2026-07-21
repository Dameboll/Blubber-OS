// GET    /api/spawned                       -> { agents: SpawnedAgent[] }
// POST   /api/spawned  { name?, file?, purpose } -> { agent: SpawnedAgent }
// DELETE /api/spawned?id=<id>                -> { ok: true }
//
// The roster backing the Agent Control Center / spawn choreography. Backed by
// a small atomically-written JSON file (see src/server/spawned-store.ts) —
// no database needed for a list this size.

import { NextResponse } from "next/server";
import * as spawnedStore from "../../../server/spawned-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ agents: spawnedStore.list() });
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { name?: string; file?: string; purpose?: string };
    if (!body.purpose || typeof body.purpose !== "string" || body.purpose.trim().length === 0) {
      return NextResponse.json({ error: "purpose is required" }, { status: 400 });
    }
    const agent = spawnedStore.create({ name: body.name, file: body.file, purpose: body.purpose.trim() });
    return NextResponse.json({ agent });
  } catch (err) {
    console.error("[api/spawned] POST failed:", err);
    return NextResponse.json({ error: "failed to spawn agent" }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  const removed = spawnedStore.remove(id);
  if (!removed) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
