/**
 * ws-client.ts
 *
 * Typed browser WebSocket client for the DameOS terminal protocol (see
 * PLAN.md "WebSocket protocol"). A single WebSocket connection is shared and
 * multiplexed across every open tab — each message carries its own
 * `sessionId`, so one socket serves any number of concurrent PTY sessions.
 *
 * Server-side counterpart: src/server/pty-manager.ts (consumed by server.js).
 * Do not diverge from the message shapes below without updating both sides.
 */

export type ClientMessage =
  | { type: "spawn"; sessionId: string; cwd: string; initialPrompt?: string }
  | { type: "input"; sessionId: string; data: string }
  | { type: "resize"; sessionId: string; cols: number; rows: number }
  | { type: "kill"; sessionId: string };

export type ServerMessage =
  | { type: "output"; sessionId: string; data: string }
  | { type: "exit"; sessionId: string; code: number }
  | { type: "spawned"; sessionId: string };

import { stripAnsi } from "./terminal-signals";

export type ServerMessageListener = (message: ServerMessage) => void;

type ConnectionState = "idle" | "connecting" | "open" | "closed";

// How many recent real PTY output lines the shared client keeps for
// getRecentOutput() — enough to fill a holo-terminal work-screen, small enough
// to stay a cheap flat array. See getRecentOutput below.
const OUTPUT_RING_MAX = 120;

// Assumption: server.js upgrades the WebSocket on this exact path, leaving
// every other path free for Next.js. Update if server.js wires a different path.
const WS_PATH = "/ws";

const INITIAL_RECONNECT_DELAY_MS = 500;
const MAX_RECONNECT_DELAY_MS = 8000;

function buildWsUrl(): string {
  if (typeof window === "undefined") return "";
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}${WS_PATH}`;
}

class WsClient {
  private socket: WebSocket | null = null;
  private state: ConnectionState = "idle";
  private outbox: ClientMessage[] = [];
  private sessionListeners = new Map<string, Set<ServerMessageListener>>();
  // Global taps hear EVERY server message regardless of session — used by the
  // cross-screen FlubberBrain terminal-watcher, which must react to PTY
  // output/exit even while the Terminal screen is unmounted (the PTYs and
  // this socket both outlive it). Stored on the singleton so taps survive
  // reconnects for free.
  private globalListeners = new Set<ServerMessageListener>();
  private reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  // Timestamp of the last real keystroke sent on ANY session — lets a global
  // tap (SessionProvider's work-clock Signal 2) tell "output following a
  // keypress" apart from an idle REPL's own banner/spinner/cursor repaints.
  private lastInputAt = 0;
  // Rolling tail of the most recent REAL PTY output lines (ANSI-stripped,
  // trimmed, non-empty) across every session — the source of truth for the
  // HoloPanel terminal work-screen, so it renders the terminal's ACTUAL last
  // lines instead of any fabricated command text. Bounded to OUTPUT_RING_MAX.
  private outputRing: string[] = [];

  /** Capture real output frames into the rolling tail. Called for every server
   * message before it's dispatched, so the tail is populated even for sessions
   * with no active per-session subscriber (e.g. a background tab). */
  private captureOutput(message: ServerMessage): void {
    if (message.type !== "output") return;
    const lines = stripAnsi(message.data)
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length === 0) return;
    this.outputRing.push(...lines);
    if (this.outputRing.length > OUTPUT_RING_MAX) {
      this.outputRing.splice(0, this.outputRing.length - OUTPUT_RING_MAX);
    }
  }

  /** The last `n` real PTY output lines seen across all sessions, oldest first.
   * Empty until real output has actually streamed — callers render a
   * placeholder in that case, never fabricated text. */
  getRecentOutput(n = 6): string[] {
    if (n <= 0) return [];
    return this.outputRing.slice(-n);
  }

  /** Opens the shared connection if it isn't already open/opening. Safe to call repeatedly. */
  connect(): void {
    if (typeof window === "undefined") return;
    if (this.state === "connecting" || this.state === "open") return;

    this.state = "connecting";
    const socket = new WebSocket(buildWsUrl());
    this.socket = socket;

    socket.addEventListener("open", this.handleOpen);
    socket.addEventListener("message", this.handleMessage);
    socket.addEventListener("close", this.handleClose);
    socket.addEventListener("error", this.handleError);
  }

  private handleOpen = (): void => {
    this.state = "open";
    this.reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
    const pending = this.outbox.splice(0);
    for (const message of pending) {
      this.dispatch(message);
    }
  };

  private handleMessage = (event: MessageEvent): void => {
    let message: ServerMessage;
    try {
      message = JSON.parse(event.data as string) as ServerMessage;
    } catch {
      return; // Malformed frame — ignore rather than crash the pane.
    }
    this.routeMessage(message);
  };

  private routeMessage(message: ServerMessage): void {
    this.captureOutput(message);
    for (const listener of this.globalListeners) listener(message);
    const listeners = this.sessionListeners.get(message.sessionId);
    if (!listeners) return;
    for (const listener of listeners) listener(message);
  }

  /**
   * Test seam: inject a server message as if it arrived on the socket, so
   * verification can exercise the real global-tap → terminal-watcher → brain
   * path (including the success/error regex) without a flaky live PTY. Same
   * routing the socket uses; harmless in production (nothing calls it there).
   */
  deliverForTest(message: ServerMessage): void {
    this.routeMessage(message);
  }

  private handleClose = (): void => {
    this.state = "closed";
    this.socket = null;
    this.scheduleReconnect();
  };

  private handleError = (): void => {
    this.socket?.close();
  };

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
      this.connect();
    }, this.reconnectDelay);
  }

  private dispatch(message: ClientMessage): void {
    if (this.state === "open" && this.socket) {
      this.socket.send(JSON.stringify(message));
    } else {
      this.outbox.push(message);
      this.connect();
    }
  }

  /** Low-level send — prefer the typed helpers below in components. */
  send(message: ClientMessage): void {
    this.dispatch(message);
  }

  spawn(sessionId: string, cwd: string, initialPrompt?: string): void {
    this.dispatch({ type: "spawn", sessionId, cwd, initialPrompt });
  }

  input(sessionId: string, data: string): void {
    this.lastInputAt = Date.now();
    this.dispatch({ type: "input", sessionId, data });
  }

  /** Timestamp of the last real keystroke sent on any session (ms epoch), or 0 if none yet. */
  getLastInputAt(): number {
    return this.lastInputAt;
  }

  resize(sessionId: string, cols: number, rows: number): void {
    this.dispatch({ type: "resize", sessionId, cols, rows });
  }

  kill(sessionId: string): void {
    this.dispatch({ type: "kill", sessionId });
    this.sessionListeners.delete(sessionId);
  }

  /**
   * Subscribe to server messages for one session. Returns an unsubscribe
   * function — always call it on unmount to avoid leaking listeners.
   */
  subscribe(sessionId: string, listener: ServerMessageListener): () => void {
    let listeners = this.sessionListeners.get(sessionId);
    if (!listeners) {
      listeners = new Set();
      this.sessionListeners.set(sessionId, listeners);
    }
    listeners.add(listener);
    this.connect();

    return () => {
      const current = this.sessionListeners.get(sessionId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) {
        this.sessionListeners.delete(sessionId);
      }
    };
  }

  /**
   * Subscribe to EVERY server message across all sessions. Does not open the
   * connection on its own (a passive observer) — it hears whatever the active
   * PTY panes are already streaming. Returns an unsubscribe function.
   */
  subscribeAll(listener: ServerMessageListener): () => void {
    this.globalListeners.add(listener);
    return () => {
      this.globalListeners.delete(listener);
    };
  }
}

/** Shared singleton — every TerminalPane talks through this one connection. */
export const wsClient = new WsClient();

// Expose for verification scripts to drive the terminal-watcher end-to-end.
// A read-only handle to the existing singleton — no behavior change.
if (typeof window !== 'undefined') {
  (window as unknown as { __wsClient?: WsClient }).__wsClient = wsClient;
}
