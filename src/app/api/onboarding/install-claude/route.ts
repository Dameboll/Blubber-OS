// POST /api/onboarding/install-claude — installs Claude Code itself, streaming
// real installer output back as NDJSON (see src/server/stream-command.ts and
// src/lib/install-stream.ts for the event shapes).
//
// Offered only on the onboarding `notfound` branch (no ~/.claude on this
// machine). The user is never forced into it: the overlay keeps "I'll do it
// myself" (external link) and "Try demo mode" alongside, and a Cancel button
// aborts this request mid-run — request.signal fires, the child is killed, the
// stream ends (see stream-command.ts's abort handling).
//
// COMMAND CHOICE: `npm install -g @anthropic-ai/claude-code`. npm is used
// rather than the native curl|bash / irm|iex one-liners on purpose — Blubber's
// own server.js is spawned with system `node` (see electron/main.js), so node +
// npm are already present on any machine that can run this app, and npm avoids
// piping a remote script straight into a shell (which AV / locked-down machines
// frequently block). If a future build wants the native installer, swap the
// single step below for the platform-specific command.

import { NextResponse } from "next/server";
import { runCommandStream, type StreamStep } from "../../../../server/stream-command";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STEPS: StreamStep[] = [
  {
    label: "Installing Claude Code (npm i -g @anthropic-ai/claude-code)",
    cmd: "npm",
    args: ["install", "-g", "@anthropic-ai/claude-code"],
  },
];

export async function POST(request: Request) {
  try {
    const stream = runCommandStream(STEPS, request.signal);
    return new Response(stream, {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
      },
    });
  } catch (err) {
    return NextResponse.json({ error: `could not start install: ${(err as Error).message}` }, { status: 500 });
  }
}
