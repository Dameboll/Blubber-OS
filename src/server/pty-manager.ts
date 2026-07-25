/**
 * pty-manager.ts
 *
 * Spawns and tracks real `claude` CLI processes behind node-pty, one PTY per
 * sessionId (one per terminal tab). This is consumed directly by server.js
 * (the custom Next + ws server), never imported into the browser bundle.
 *
 * Protocol note: this module implements the server-side half of the exact
 * WebSocket contract in PLAN.md — spawn/write/resize/kill in,
 * output/exit/spawned out. server.js owns the WebSocket framing; this file
 * only owns the PTY lifecycle.
 */

import os from "node:os";
import * as pty from "node-pty";
import type { ResumeSpec } from "../lib/ws-client";
import { resolveSpawnCwd } from "./resolve-path";

const isWindows = os.platform() === "win32";

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 30;

// Give the `claude` REPL a moment to finish booting before typing an
// initialPrompt into it, so we don't race the process's own startup output.
const INITIAL_PROMPT_DELAY_MS = 1500;

export interface SpawnSessionOptions {
  sessionId: string;
  cwd: string;
  /** Optional prompt text to type + submit once the session is up. */
  initialPrompt?: string;
  /** Optional resume directive — appends `--continue` / `--resume <id>` to the
   *  `claude` launch args so the tab picks up an existing session (see
   *  buildLaunchCommand). Absent = a fresh session. */
  resume?: ResumeSpec;
  cols?: number;
  rows?: number;
  onData: (data: string) => void;
  onExit: (code: number) => void;
  /** Fired once the PTY has actually started (mirrors the `spawned` ack). */
  onSpawned?: () => void;
}

interface TrackedSession {
  proc: pty.IPty;
  cwd: string;
}

const sessions = new Map<string, TrackedSession>();

/**
 * Resolve the (file, args) pair node-pty should launch to get a real,
 * interactive `claude` REPL.
 *
 * Windows: npm installs `claude` as a `.cmd` shim, and `.cmd` files can only
 * be executed through a command host (cmd.exe) — not directly as a PE image —
 * so we launch cmd.exe and hand it the command line, the same thing a normal
 * terminal does when you type `claude` and hit enter.
 *
 * POSIX: launch the user's shell in login+interactive mode and have it run
 * `claude`, so PATH/nvm/shell rc files resolve exactly like a real terminal.
 */
// A Claude session id is a UUID the CLI itself emits — never user-typed. Still,
// validate it strictly before it reaches a launch arg (defense in depth), so a
// malformed value can't inject shell metacharacters on the POSIX path.
const SESSION_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

function buildLaunchCommand(resume?: ResumeSpec): { file: string; args: string[] } {
  // Extra `claude` flags that resume an existing session. `--continue` picks up
  // the latest session in this cwd; `--resume <id>` targets a specific one.
  const claudeArgs: string[] = [];
  if (resume?.mode === "continue") {
    claudeArgs.push("--continue");
  } else if (resume?.mode === "session") {
    if (SESSION_ID_RE.test(resume.id)) {
      claudeArgs.push("--resume", resume.id);
    } else {
      // Bad id — fall back to a fresh session rather than launch anything
      // derived from an untrusted string. Loud, never silent.
      console.error(`[pty-manager] ignoring resume: invalid session id ${JSON.stringify(resume.id)}`);
    }
  }

  if (isWindows) {
    // cmd.exe with `claude` + its flags as SEPARATE argv tokens (node-pty quotes
    // each) — never a single interpolated command string.
    const comspec = process.env.ComSpec || "cmd.exe";
    return { file: comspec, args: ["/d", "/s", "/c", "claude", ...claudeArgs] };
  }
  // Login+interactive shell so PATH/nvm/rc resolve exactly like a real terminal,
  // but pass claude's flags through "$@" as separate positional args rather than
  // interpolating them into the -lc script string — so no arg (even a rogue
  // session id) can break out into shell command context.
  const shell = process.env.SHELL || "/bin/bash";
  return { file: shell, args: ["-lc", 'claude "$@"', "claude", ...claudeArgs] };
}

/**
 * Spawn a new PTY-backed `claude` process for a session. No-ops (and re-acks)
 * if the sessionId is already tracked, so a duplicate `spawn` message from a
 * reconnecting client can't orphan a second process.
 */
export function spawnSession(opts: SpawnSessionOptions): void {
  const { sessionId, initialPrompt, resume, cols, rows, onData, onExit, onSpawned } = opts;
  // Clients send portable tilde paths ("~/Development/..."), never real
  // machine paths — expand here, and fall back to an existing ancestor so a
  // missing folder (fresh machine) can't hard-fail the spawn.
  const cwd = resolveSpawnCwd(opts.cwd);

  if (sessions.has(sessionId)) {
    onSpawned?.();
    return;
  }

  const { file, args } = buildLaunchCommand(resume);

  let proc: pty.IPty;
  try {
    proc = pty.spawn(file, args, {
      name: "xterm-256color",
      cols: cols ?? DEFAULT_COLS,
      rows: rows ?? DEFAULT_ROWS,
      cwd,
      env: process.env as Record<string, string>,
      useConpty: isWindows,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    onData(`Failed to start Claude in ${cwd}: ${message}\r\n`);
    onExit(1);
    return;
  }

  sessions.set(sessionId, { proc, cwd });

  proc.onData((data) => onData(data));

  proc.onExit(({ exitCode }) => {
    sessions.delete(sessionId);
    onExit(exitCode);
  });

  onSpawned?.();

  if (initialPrompt) {
    setTimeout(() => {
      sessions.get(sessionId)?.proc.write(`${initialPrompt}\r`);
    }, INITIAL_PROMPT_DELAY_MS);
  }
}

/** Write raw input (keystrokes, pasted text, voice transcripts) to a session's PTY. */
export function writeToSession(sessionId: string, data: string): void {
  sessions.get(sessionId)?.proc.write(data);
}

/** Resize a session's PTY to match the browser-side xterm.js viewport. */
export function resizeSession(sessionId: string, cols: number, rows: number): void {
  sessions.get(sessionId)?.proc.resize(cols, rows);
}

/** Kill a session's PTY and stop tracking it. Safe to call on an unknown/already-dead session. */
export function killSession(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  sessions.delete(sessionId);
  try {
    session.proc.kill();
  } catch {
    // Process may have already exited between the map lookup and kill() —
    // nothing left to clean up.
  }
}

export function hasSession(sessionId: string): boolean {
  return sessions.has(sessionId);
}

/** Number of live PTY sessions — used for diagnostics/shutdown logging. */
export function sessionCount(): number {
  return sessions.size;
}
