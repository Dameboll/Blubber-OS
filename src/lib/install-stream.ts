// install-stream — client reader for the NDJSON progress stream produced by
// src/server/stream-command.ts (via the install-claude / install-plugins
// routes). Isomorphic-safe imports only (no Node built-ins) so it can live in
// 'use client' components.
//
// Usage:
//   const ctrl = new AbortController();
//   await readInstallStream('/api/onboarding/install-claude', ctrl.signal, (ev) => { ... });
//   // ctrl.abort() from a Cancel button ends it — the server kills the child.

export type InstallEvent =
  | { type: "step"; label: string }
  | { type: "stdout"; data: string }
  | { type: "stderr"; data: string }
  | { type: "exit"; label: string; code: number | null }
  | { type: "done"; ok: boolean }
  | { type: "error"; message: string };

/**
 * POSTs to `url` and reads the NDJSON body, invoking `onEvent` per line.
 * Resolves when the stream ends (a `done` or `error` event, or the body
 * closing). Throws only on a network-level failure or an aborted fetch —
 * callers should treat an AbortError as an intentional user cancel, not a bug.
 */
export async function readInstallStream(
  url: string,
  signal: AbortSignal,
  onEvent: (ev: InstallEvent) => void,
  body?: unknown,
): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (!res.body) {
    onEvent({ type: "error", message: `no response body (HTTP ${res.status})` });
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const flushLines = (final: boolean) => {
    let newlineIdx: number;
    while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
      const raw = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);
      if (raw) emit(raw, onEvent);
    }
    if (final && buffer.trim()) {
      emit(buffer.trim(), onEvent);
      buffer = "";
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    flushLines(false);
  }
  flushLines(true);
}

function emit(raw: string, onEvent: (ev: InstallEvent) => void): void {
  try {
    onEvent(JSON.parse(raw) as InstallEvent);
  } catch {
    // A non-JSON line should never happen from our own server, but never let one
    // malformed line kill the whole read — surface it as stderr text instead.
    onEvent({ type: "stderr", data: raw });
  }
}
