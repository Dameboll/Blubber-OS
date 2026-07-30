// GET    /api/quickchat        -> { sessionId, messages: QuickChatMessage[] }
// POST   /api/quickchat {message} -> { message: QuickChatMessage, sessionId }
// DELETE /api/quickchat        -> { ok: true }   ("New chat")
//
// The Dashboard's "Quick Chat" tab (PILL WORLDS + MINI DASH, Lane 2): a
// SEPARATE Claude session (pinned to the current top model) that never touches
// the main work terminal (PersistentTerminalHost / TabBar / wsClient /
// node-pty). Each message spawns a real, one-shot, non-interactive `claude -p`
// process:
//
//   first message:      claude -p --model claude-opus-4-8 --output-format json
//   follow-up messages: claude -p --model claude-opus-4-8 --resume <session_id> --output-format json
//
// The message text is never put on the command line (avoids shell-escaping
// entirely) — it's written to the child process's stdin, the same way
// `echo "..." | claude -p` works from a real shell. On Windows the .cmd shim
// can only run through cmd.exe (same constraint pty-manager.ts documents for
// the interactive PTY case), so this spawns cmd.exe /c claude with the fixed
// flag tokens only; the session id (a UUID Claude's own CLI returns, never
// user-typed) is the only variable token on that command line.
//
// `--output-format json` is parsed defensively (multiple candidate field
// names) since this build has not independently verified the CLI's exact
// JSON schema — if parsing fails, the raw stdout text is used as the reply
// and no session id is captured (that turn just won't --resume; never a hard
// failure the user sees as an error). The same defensive parse pulls the REAL
// model id the CLI reported for the turn (modelUsage / usage.model / model /
// modelUsed) so the UI badge shows what actually answered, not a hardcoded
// label — the --model flag is a request, the reported id is the truth.

import { NextResponse } from "next/server";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import * as quickchatStore from "../../../server/quickchat-store";
import { createSafeChildEnv } from "../../../server/child-env";
import { resolveSpawnCwd } from "../../../server/resolve-path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RUN_TIMEOUT_MS = 120_000;

// Model is configurable, but the shipped default omits --model entirely and
// lets the customer's own CLI default answer — pinning a specific Opus id
// hard-breaks any customer whose plan doesn't include that model. Set
// QUICKCHAT_MODEL to a real model id to pin one deliberately.
const QUICKCHAT_MODEL = process.env.QUICKCHAT_MODEL ?? "default";

function buildCommand(resumeId: string | null): { file: string; args: string[] } {
  const claudeArgs = ["-p"];
  if (QUICKCHAT_MODEL && QUICKCHAT_MODEL !== "default") {
    claudeArgs.push("--model", QUICKCHAT_MODEL);
  }
  claudeArgs.push("--output-format", "json");
  if (resumeId) claudeArgs.push("--resume", resumeId);

  if (os.platform() === "win32") {
    // Same constraint as pty-manager.ts: `claude` is an npm .cmd shim on
    // Windows and can only be launched through a command host, not directly
    // as a PE image.
    const comspec = process.env.ComSpec || "cmd.exe";
    return { file: comspec, args: ["/d", "/s", "/c", "claude", ...claudeArgs] };
  }
  const shell = process.env.SHELL || "/bin/bash";
  return { file: shell, args: ["-lc", ["claude", ...claudeArgs].join(" ")] };
}

interface ClaudeJsonResult {
  result?: unknown;
  response?: unknown;
  text?: unknown;
  session_id?: unknown;
  sessionId?: unknown;
  id?: unknown;
  // Model-id candidates the CLI's JSON result has been seen to carry, in
  // descending preference. `modelUsage` is an object keyed by the model id(s)
  // the turn actually used; the others are flat string fields.
  modelUsage?: unknown;
  usage?: unknown;
  model?: unknown;
  modelUsed?: unknown;
  model_used?: unknown;
}

function extractText(parsed: ClaudeJsonResult, fallbackRaw: string): string {
  const candidate = parsed.result ?? parsed.response ?? parsed.text;
  if (typeof candidate === "string" && candidate.trim().length > 0) return candidate.trim();
  const fallback = fallbackRaw.trim();
  return fallback.length > 0 ? fallback : "(no response)";
}

function extractSessionId(parsed: ClaudeJsonResult): string | null {
  const candidate = parsed.session_id ?? parsed.sessionId ?? parsed.id;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
}

// The real model id the CLI reported for this turn. Defensive across schema
// shapes: flat string fields first, then `usage.model`, then the first key of
// the `modelUsage` map. Null when nothing usable is present (the badge then
// falls back to a neutral label rather than claiming a model we can't verify).
function extractModelUsed(parsed: ClaudeJsonResult): string | null {
  const flat = parsed.model ?? parsed.modelUsed ?? parsed.model_used;
  if (typeof flat === "string" && flat.length > 0) return flat;

  if (parsed.usage && typeof parsed.usage === "object") {
    const usageModel = (parsed.usage as { model?: unknown }).model;
    if (typeof usageModel === "string" && usageModel.length > 0) return usageModel;
  }

  if (parsed.modelUsage && typeof parsed.modelUsage === "object") {
    const keys = Object.keys(parsed.modelUsage as Record<string, unknown>);
    if (keys.length > 0 && keys[0].length > 0) return keys[0];
  }

  return null;
}

interface OneShotResult {
  text: string;
  sessionId: string | null;
  modelUsed: string | null;
}

function runClaudeOneShot(message: string, resumeId: string | null): Promise<OneShotResult> {
  return new Promise((resolve, reject) => {
    const { file, args } = buildCommand(resumeId);

    // Harden spawn env: strip ANTHROPIC_API_KEY and CLAUDECODE vars so the child
    // always uses the claude.ai subscription login (via stored session), never an
    // invalid/stale API key from the parent environment.
    const childEnv = createSafeChildEnv(process.env, [
      "ANTHROPIC_API_KEY",
      "CLAUDE_CODE_ENTRYPOINT",
      "CLAUDECODE",
    ]);

    const child = spawn(file, args, {
      // Falls back to the deepest existing ancestor (ultimately the home dir)
      // — a fresh machine has no ~/Development/general and a missing cwd
      // would fail the spawn outright.
      cwd: resolveSpawnCwd(path.join(os.homedir(), "Development", "general")),
      windowsHide: true,
      env: childEnv,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error("Quick chat timed out waiting on Claude."));
    }, RUN_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0 && stdout.trim().length === 0) {
        reject(new Error(stderr.trim() || `claude exited with code ${code}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout.trim()) as ClaudeJsonResult;
        resolve({
          text: extractText(parsed, stdout),
          sessionId: extractSessionId(parsed),
          modelUsed: extractModelUsed(parsed),
        });
      } catch {
        // Non-JSON stdout (unexpected CLI output shape) — still surface it as
        // an honest reply rather than a hard error.
        resolve({ text: stdout.trim() || "(no response)", sessionId: null, modelUsed: null });
      }
    });

    child.stdin.write(message, "utf8");
    child.stdin.end();
  });
}

export async function GET() {
  const { sessionId, messages } = quickchatStore.getTranscript();
  return NextResponse.json({ sessionId, messages });
}

export async function POST(request: Request) {
  let message = "";
  try {
    const body = (await request.json()) as { message?: string };
    message = typeof body.message === "string" ? body.message.trim() : "";
  } catch {
    return NextResponse.json({ error: "invalid request body" }, { status: 400 });
  }
  if (!message) {
    return NextResponse.json({ error: "message is required" }, { status: 400 });
  }

  quickchatStore.appendMessage("user", message);
  const resumeId = quickchatStore.getClaudeSessionId();

  try {
    const { text, sessionId, modelUsed } = await runClaudeOneShot(message, resumeId);
    const resolvedSessionId = sessionId ?? resumeId;
    if (sessionId) quickchatStore.setClaudeSessionId(sessionId);
    const assistantMessage = quickchatStore.appendMessage("assistant", text, modelUsed);
    return NextResponse.json({ message: assistantMessage, sessionId: resolvedSessionId });
  } catch (err) {
    console.error("[api/quickchat] claude spawn failed:", err);
    const errText = err instanceof Error ? err.message : "Quick chat failed";
    const assistantMessage = quickchatStore.appendMessage(
      "assistant",
      `Couldn't reach Claude for this one: ${errText}`,
    );
    return NextResponse.json({ message: assistantMessage, sessionId: resumeId }, { status: 502 });
  }
}

export async function DELETE() {
  quickchatStore.clear();
  return NextResponse.json({ ok: true });
}
