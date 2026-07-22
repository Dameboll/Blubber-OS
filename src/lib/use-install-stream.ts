// useInstallStream — a small client hook wrapping readInstallStream (see
// install-stream.ts) so any component can run a streamed installer route with
// live output + a working Cancel, without re-implementing the reader/abort
// dance. Used by both the onboarding overlay (install Claude Code / plugins)
// and the Settings "Recommended plugins" panel.
//
// Cancel is real: it aborts the fetch, which fires request.signal server-side,
// which kills the live child process (see stream-command.ts). The UI is never
// trapped in a running state.

import { useCallback, useEffect, useRef, useState } from "react";
import { readInstallStream, type InstallEvent } from "./install-stream";

export type InstallStatus = "idle" | "running" | "done" | "error";

export interface InstallStreamState {
  status: InstallStatus;
  /** true = every step exited 0; false = something failed; null = not finished. */
  ok: boolean | null;
  /** Accumulated human-readable output (labels + stdout + stderr), newest last. */
  output: string;
  /** The label of the step currently running (or the last one). */
  currentLabel: string;
  start: (url: string, body?: unknown) => void;
  cancel: () => void;
}

export function useInstallStream(): InstallStreamState {
  const [status, setStatus] = useState<InstallStatus>("idle");
  const [ok, setOk] = useState<boolean | null>(null);
  const [output, setOutput] = useState("");
  const [currentLabel, setCurrentLabel] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  const append = useCallback((text: string) => {
    setOutput((prev) => prev + text);
  }, []);

  const start = useCallback(
    (url: string, body?: unknown) => {
      // Never start a second run over a live one.
      if (abortRef.current) abortRef.current.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;

      setStatus("running");
      setOk(null);
      setOutput("");
      setCurrentLabel("");

      const onEvent = (ev: InstallEvent) => {
        switch (ev.type) {
          case "step":
            setCurrentLabel(ev.label);
            append(`\n$ ${ev.label}\n`);
            break;
          case "stdout":
          case "stderr":
            append(ev.data);
            break;
          case "exit":
            append(`\n[exit ${ev.code ?? "?"}] ${ev.label}\n`);
            break;
          case "done":
            setOk(ev.ok);
            setStatus(ev.ok ? "done" : "error");
            break;
          case "error":
            append(`\n[error] ${ev.message}\n`);
            setOk(false);
            setStatus("error");
            break;
        }
      };

      readInstallStream(url, ctrl.signal, onEvent, body)
        .catch((err: unknown) => {
          // AbortError = intentional Cancel, not a failure to surface loudly.
          if ((err as Error)?.name === "AbortError") {
            append("\n[cancelled]\n");
            setStatus("idle");
            setOk(null);
            return;
          }
          append(`\n[error] ${(err as Error).message}\n`);
          setStatus("error");
          setOk(false);
        })
        .finally(() => {
          if (abortRef.current === ctrl) abortRef.current = null;
        });
    },
    [append],
  );

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  // Abort any in-flight run if the component unmounts (e.g. onboarding overlay
  // closes) so we never leak a reader or a running child with no listener.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, []);

  return { status, ok, output, currentLabel, start, cancel };
}
