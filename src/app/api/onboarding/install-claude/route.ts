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
// COMMAND CHOICE: Anthropic's official NATIVE installer, per
// https://code.claude.com/docs/en/setup ("Native Install (Recommended)").
//
// This used to run `npm install -g @anthropic-ai/claude-code`, justified by the
// claim that "node + npm are already present on any machine that can run this
// app, because Blubber's own server.js is spawned with system node". That was
// true once. It is FALSE for the shipped build: electron/main.js runs server.js
// through Electron-as-node and the packaged app bundles its own runtime, which
// is the entire point of the self-contained installer — a fresh-environment
// smoke test confirmed the app launches fine with node AND npm absent from
// PATH. So on exactly the machine this route exists to serve (a clean box with
// no Claude Code), npm did not exist and the install failed at the first step.
// Worse, it failed for Starter Kit buyers, since this flow is kit-gated.
//
// The native installer has no Node dependency at all — it drops a prebuilt
// binary in ~/.local/bin and self-updates from there. Costs: it does pipe a
// remote script into a shell, which some locked-down/AV setups block. That is
// an acceptable trade against "guaranteed failure on a clean machine", and a
// blocked download surfaces as real stderr in the stream the user is watching.
//
// npm remains the documented fallback for anyone who already has Node 22+ and
// would rather use it; it is not what we run for them.

import { NextResponse } from "next/server";
import { runCommandStream, type StreamStep } from "../../../../server/stream-command";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Both commands are passed whole in `cmd` with empty `args` on purpose:
// stream-command spawns with `shell: true`, so the string is handed to the
// platform shell intact and the pipe is interpreted by that shell. Splitting a
// `|` across argv would either be escaped into a literal or, on Windows, be
// eaten by cmd.exe before PowerShell ever saw it.
function installStep(): StreamStep {
  if (process.platform === "win32") {
    // Invoke PowerShell explicitly — spawn(shell:true) uses cmd.exe on Windows,
    // where `irm`/`iex` do not exist. Inner double quotes keep the pipe inside
    // the -Command payload. -NoProfile so a user's broken profile can't fail
    // the install; -ExecutionPolicy Bypass because the default Restricted
    // policy blocks the downloaded script on stock Windows.
    return {
      label: "Installing Claude Code (official Windows installer)",
      cmd: 'powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://claude.ai/install.ps1 | iex"',
      args: [],
    };
  }
  return {
    label: "Installing Claude Code (official installer)",
    cmd: "curl -fsSL https://claude.ai/install.sh | bash",
    args: [],
  };
}

export async function POST(request: Request) {
  try {
    const stream = runCommandStream([installStep()], request.signal);
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
