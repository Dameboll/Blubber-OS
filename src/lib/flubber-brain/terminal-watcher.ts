/**
 * flubber-brain/terminal-watcher — a module singleton that taps EVERY PTY
 * session's output/exit (via wsClient.subscribeAll) and turns them into brain
 * reactions, cross-screen. PTYs and the socket outlive the Terminal screen,
 * so this keeps reacting to `build passed` / `error` / non-zero exits even
 * while the user is on Dashboard or Projects. Phase 4 of
 * docs/plans/flubber-3d-everywhere.md.
 *
 * Throttled per session (2s) so a chatty build log fires one celebration, not
 * a stutter of them.
 */

import { wsClient, type ServerMessage } from '../ws-client';
import { classifyOutput, stripAnsi } from '../terminal-signals';

export interface TerminalReaction {
  kind: 'success' | 'error' | 'exit-nonzero';
  sessionId: string;
}

type ReactionListener = (reaction: TerminalReaction) => void;

const THROTTLE_MS = 2000;

class TerminalWatcher {
  private listeners = new Set<ReactionListener>();
  private unsubscribe: (() => void) | null = null;
  private lastReactionAt = new Map<string, number>();

  private ensureTap() {
    if (this.unsubscribe) return;
    this.unsubscribe = wsClient.subscribeAll(this.handleMessage);
  }

  private teardownIfIdle() {
    if (this.listeners.size === 0 && this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
      this.lastReactionAt.clear();
    }
  }

  private throttled(sessionId: string): boolean {
    const now = Date.now();
    const last = this.lastReactionAt.get(sessionId) ?? 0;
    if (now - last < THROTTLE_MS) return true;
    this.lastReactionAt.set(sessionId, now);
    return false;
  }

  private emit(reaction: TerminalReaction) {
    for (const listener of this.listeners) listener(reaction);
  }

  private handleMessage = (message: ServerMessage) => {
    if (message.type === 'exit') {
      // A non-zero exit is a distinct, always-worth-noting event — bypass the
      // output throttle but still clear the session's throttle clock.
      this.lastReactionAt.set(message.sessionId, Date.now());
      if (message.code !== 0) this.emit({ kind: 'exit-nonzero', sessionId: message.sessionId });
      return;
    }
    if (message.type !== 'output') return;
    const signal = classifyOutput(stripAnsi(message.data));
    if (!signal) return;
    if (this.throttled(message.sessionId)) return;
    this.emit({ kind: signal, sessionId: message.sessionId });
  };

  subscribe(listener: ReactionListener): () => void {
    this.listeners.add(listener);
    this.ensureTap();
    return () => {
      this.listeners.delete(listener);
      this.teardownIfIdle();
    };
  }
}

export const terminalWatcher = new TerminalWatcher();
