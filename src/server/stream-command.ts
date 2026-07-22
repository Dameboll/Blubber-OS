// stream-command — runs a sequence of shell commands and returns a
// ReadableStream of newline-delimited JSON (NDJSON) progress events. Shared by
// the two "run a real installer and show me it working" routes:
//   - POST /api/onboarding/install-claude   (installs Claude Code itself)
//   - POST /api/onboarding/install-plugins  (adds marketplaces + plugins)
//
// Why a stream and not a single blocking POST: these commands can take a
// minute+ and the user must SEE real output scrolling, and must be able to
// bail. The client passes an AbortController; when it aborts (user hits
// Cancel / navigates away), request.signal fires, we kill the live child, and
// the stream ends. Nothing is faked — every line here is real stdout/stderr
// off the spawned process.
//
// EVENT SHAPES (one JSON object per line):
//   { type: 'step',   label }            — a command in the sequence started
//   { type: 'stdout', data }             — a chunk of the child's stdout
//   { type: 'stderr', data }             — a chunk of the child's stderr
//   { type: 'exit',   label, code }      — that command exited (code|null)
//   { type: 'done',   ok }               — whole sequence finished; ok=all 0
//   { type: 'error',  message }          — spawn failure / aborted, sequence ends
//
// A non-zero exit code stops the sequence (later commands don't run) and ends
// with { type:'done', ok:false } — the caller sees exactly which step failed
// and its real error output above it.

import { spawn, type ChildProcess } from "node:child_process";

export interface StreamStep {
  /** Human label shown in the UI for this command (e.g. "Installing superpowers"). */
  label: string;
  /** Executable to run (e.g. "npm", "claude"). */
  cmd: string;
  /** Arguments. */
  args: string[];
}

const encoder = new TextEncoder();

function line(obj: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(obj) + "\n");
}

/**
 * Runs `steps` in order, streaming NDJSON. `signal` (from the incoming
 * Request) aborts the live child and ends the stream. `shell: true` so
 * platform-resolved launchers (npm.cmd on Windows, the claude shim on PATH)
 * resolve without the caller hardcoding an extension.
 */
export function runCommandStream(steps: StreamStep[], signal?: AbortSignal): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      let child: ChildProcess | null = null;
      let aborted = false;

      const onAbort = () => {
        aborted = true;
        if (child) {
          // SIGTERM the whole child; on Windows spawn(shell:true) this ends the
          // launcher. Best-effort — the point is the UI is never trapped.
          try {
            child.kill();
          } catch {
            /* already gone */
          }
        }
      };

      if (signal) {
        if (signal.aborted) {
          controller.enqueue(line({ type: "error", message: "aborted" }));
          controller.close();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }

      const runStep = (index: number, allOk: boolean): void => {
        if (aborted) {
          controller.enqueue(line({ type: "error", message: "aborted" }));
          controller.close();
          return;
        }
        if (index >= steps.length) {
          controller.enqueue(line({ type: "done", ok: allOk }));
          controller.close();
          if (signal) signal.removeEventListener("abort", onAbort);
          return;
        }

        const step = steps[index];
        controller.enqueue(line({ type: "step", label: step.label }));

        try {
          child = spawn(step.cmd, step.args, { shell: true, windowsHide: true });
        } catch (err) {
          controller.enqueue(line({ type: "error", message: `failed to start ${step.cmd}: ${(err as Error).message}` }));
          controller.enqueue(line({ type: "done", ok: false }));
          controller.close();
          if (signal) signal.removeEventListener("abort", onAbort);
          return;
        }

        child.stdout?.on("data", (buf: Buffer) => controller.enqueue(line({ type: "stdout", data: buf.toString() })));
        child.stderr?.on("data", (buf: Buffer) => controller.enqueue(line({ type: "stderr", data: buf.toString() })));

        child.on("error", (err) => {
          controller.enqueue(line({ type: "error", message: err.message }));
          controller.enqueue(line({ type: "done", ok: false }));
          controller.close();
          if (signal) signal.removeEventListener("abort", onAbort);
        });

        child.on("close", (code) => {
          if (aborted) return; // onAbort path already closed the stream
          controller.enqueue(line({ type: "exit", label: step.label, code }));
          const ok = allOk && code === 0;
          if (code !== 0) {
            // Stop the sequence on first failure — don't run later steps against
            // a broken prerequisite.
            controller.enqueue(line({ type: "done", ok: false }));
            controller.close();
            if (signal) signal.removeEventListener("abort", onAbort);
            return;
          }
          runStep(index + 1, ok);
        });
      };

      runStep(0, true);
    },
  });
}
