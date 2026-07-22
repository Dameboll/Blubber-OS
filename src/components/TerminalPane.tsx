'use client';

/**
 * TerminalPane — one xterm.js instance bound to one PTY session, multiplexed
 * over the shared WebSocket connection (see lib/ws-client.ts).
 *
 * One instance per tab. TabBar keeps every tab's pane mounted for the life of
 * the tab and toggles `active` to show/hide — panes are never unmounted on a
 * tab switch, only on tab close, so scrollback and the underlying PTY survive
 * switching between tabs.
 *
 * Lifecycle:
 *  - mount  -> wsClient.spawn(sessionId, cwd, initialPrompt). The server
 *              (pty-manager.ts) types + submits initialPrompt itself ~1.5s
 *              after the PTY is up — this component does not send it as a
 *              separate input message.
 *  - typing -> terminal.onData -> wsClient.input
 *  - resize -> ResizeObserver -> FitAddon.fit() -> terminal.onResize -> wsClient.resize
 *  - unmount (tab closed) -> wsClient.kill(sessionId)
 */

import { useEffect, useRef, useState } from 'react';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import 'xterm/css/xterm.css';
import { wsClient, type ServerMessage, type ResumeSpec } from '../lib/ws-client';
import './TerminalPane.css';

export interface TerminalPaneProps {
  sessionId: string;
  cwd: string;
  /** Typed + submitted into the PTY automatically by the server after spawn. */
  initialPrompt?: string;
  /** Optional resume directive — appends `--continue` / `--resume <id>` to the
   *  spawned `claude` so the tab picks up an existing session. */
  resume?: ResumeSpec;
  /** Panes stay mounted when inactive (display:none) so the PTY keeps running. */
  active: boolean;
  onExit?: (code: number) => void;
}

type PaneStatus = 'connecting' | 'running' | 'exited';

// ---- FULLY FLUBBERIZED terminal theme: every one of the 16 ANSI slots is
// remapped into a green ramp so NO orange survives. Claude Code's orange
// output lands in the yellow slots -> forced to bright green. Only red is kept
// as a restrained danger crimson (never orange). xterm can't read CSS vars,
// so these are literal hex. ----
const TERMINAL_THEME = {
  // Transparent so the blurred Blubber watermark (.terminal-pane::before,
  // see TerminalPane.css) shows through — the pane div owns the #0d0d0d base.
  background: 'rgba(13, 13, 13, 0)',
  foreground: '#39d353',
  cursor: '#6effa0',
  cursorAccent: '#0d0d0d',
  selectionBackground: 'rgba(57,211,83,0.30)',
  selectionForeground: '#b9ffcf',
  // normal — EVERY slot green (total flubberization, zero red/orange)
  black: '#0d0d0d',
  red: '#2f9e44', // was danger red -> deep green (design call: everything green)
  green: '#39d353',
  yellow: '#7CFC00', // was orange/yellow -> neon green (KILLS Claude's orange)
  blue: '#16a016', // -> green
  magenta: '#6effa0', // -> green
  cyan: '#5affb0', // -> green
  white: '#b9ffcf',
  // bright — all green
  brightBlack: '#1f4d1f',
  brightRed: '#57cc6a', // was bright red -> medium green
  brightGreen: '#6effa0',
  brightYellow: '#9dff5a', // was bright orange -> bright green
  brightBlue: '#2bd12b', // -> green
  brightMagenta: '#8effc0', // -> green
  brightCyan: '#7affd0', // -> green
  brightWhite: '#e8ffef',
};

// Claude emits its orange/amber via 24-bit truecolor and 256-index colors,
// which the 16-slot theme can't catch. This rewrites the raw PTY stream before
// xterm renders it so ANY warm color (orange / amber / yellow / salmon) becomes
// flubber green — only DEEP PURE RED survives as danger. Kills all orange
// regardless of encoding. (Cannot change the literal TEXT the binary prints —
// only its color.)
const FLUBBER_FG = '\x1b[38;2;124;252;0m'; // neon flubber green
// 256-palette indices in the orange/amber/yellow bands -> green (reds kept).
const ORANGE_256 = new Set([
  3, 11, 130, 136, 142, 148, 166, 172, 178, 184, 190,
  208, 214, 215, 216, 220, 221, 222, 223, 226, 227, 228, 229,
]);
// 256-palette reds -> green too (no red anywhere).
const RED_256 = new Set([1, 9, 52, 88, 124, 160, 196, 197, 202, 203, 209, 210, 211, 217]);
function greenify(s: string): string {
  // 24-bit truecolor foreground: remap ANY warm/red-dominant color (red, orange,
  // amber, yellow, salmon, brown) to green. Green- and blue-dominant colors and
  // neutral grays pass through untouched.
  s = s.replace(/\x1b\[38;2;(\d{1,3});(\d{1,3});(\d{1,3})m/g, (m, rs, gs, bs) => {
    const r = +rs, g = +gs, b = +bs;
    const warmOrRed = r > 100 && r >= g - 10 && r > b + 20; // red/orange/amber/yellow/salmon
    return warmOrRed ? FLUBBER_FG : m;
  });
  // 256-index oranges/yellows/reds -> green
  s = s.replace(/\x1b\[38;5;(\d{1,3})m/g, (m, ns) => (ORANGE_256.has(+ns) || RED_256.has(+ns) ? FLUBBER_FG : m));
  return s;
}

export default function TerminalPane({ sessionId, cwd, initialPrompt, resume, active, onExit }: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const spawnedOnceRef = useRef(false);
  const [status, setStatus] = useState<PaneStatus>('connecting');
  const [exitCode, setExitCode] = useState<number | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: '"DM Mono", monospace', // --font-mono (literal — see theme note above)
      fontSize: 14,
      theme: TERMINAL_THEME,
      allowTransparency: true, // watermark layer sits under the text
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(container);

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    // React Strict Mode double-invokes this effect in dev (mount -> cleanup
    // -> mount again) to surface missing-cleanup bugs. That means a PRIOR
    // terminal instance can get disposed while a deferred (rAF/ResizeObserver)
    // fit() callback from that same prior instance is still in flight --
    // calling fit() on an already-disposed terminal is exactly what throws
    // "Cannot read properties of undefined (reading 'dimensions')" inside
    // xterm's own Viewport._innerRefresh (its render service is torn down on
    // dispose). `disposed` lets every deferred callback below bail out if
    // this particular effect instance has already been cleaned up.
    let disposed = false;

    // xterm's internal renderer also isn't fully constructed the instant
    // open() returns, so on top of the disposed-guard, defer the actual
    // fit() call to the next animation frame (after the browser has painted
    // the container) rather than calling it synchronously.
    const fitIfVisible = () => {
      if (disposed) return;
      if (container.offsetWidth > 0 && container.offsetHeight > 0) {
        requestAnimationFrame(() => {
          if (disposed) return;
          try {
            fitAddon.fit();
          } catch {
            // Renderer still wasn't ready this frame -- the ResizeObserver
            // below or the next active-tab switch will fit it once it is.
          }
        });
      }
    };

    const handleServerMessage = (message: ServerMessage) => {
      if (message.sessionId !== sessionId) return;
      if (message.type === 'output') {
        terminal.write(greenify(message.data)); // strip any orange -> flubber green
      } else if (message.type === 'spawned') {
        setStatus('running');
        fitIfVisible();
      } else if (message.type === 'exit') {
        setStatus('exited');
        setExitCode(message.code);
        onExit?.(message.code);
      }
    };

    const unsubscribe = wsClient.subscribe(sessionId, handleServerMessage);
    const dataDisposable = terminal.onData((data) => wsClient.input(sessionId, data));
    const resizeDisposable = terminal.onResize(({ cols, rows }) => wsClient.resize(sessionId, cols, rows));

    // Spawn strictly before the first fit's resize message so the server
    // always has a live session by the time a resize arrives for it — both
    // travel over the same socket, so call order here fixes wire order.
    if (!spawnedOnceRef.current) {
      spawnedOnceRef.current = true;
      wsClient.spawn(sessionId, cwd, initialPrompt, resume);
    }
    fitIfVisible();

    const resizeObserver = new ResizeObserver(fitIfVisible);
    resizeObserver.observe(container);

    return () => {
      disposed = true;
      unsubscribe();
      dataDisposable.dispose();
      resizeDisposable.dispose();
      resizeObserver.disconnect();
      terminal.dispose();
      // Deliberately NOT killing the PTY session here. React (Strict Mode
      // in dev) invokes this cleanup on a harmless mount->cleanup->remount
      // cycle as well as on a real unmount, and this effect can't tell those
      // apart -- if it killed the real backend session every time, the dev
      // double-invoke would spawn a session and immediately kill it before
      // the second mount's terminal ever saw its first byte of output.
      // Killing the actual PTY is TabBar's job, tied to the explicit
      // "close tab" action (see TabBar.closeTab), not to this component's
      // lifecycle.
    };
    // sessionId/cwd/initialPrompt identify one tab for its whole lifetime —
    // intentionally not re-running this effect on later prop changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (container && container.offsetWidth > 0 && container.offsetHeight > 0) {
      // Same renderer-not-ready race as the mount effect above -- a tab
      // switch flips display:none -> flex synchronously, so give the browser
      // a paint before asking xterm to measure/fit itself.
      requestAnimationFrame(() => {
        try {
          fitAddonRef.current?.fit();
        } catch {
          // Ignore -- next resize/tab-switch will retry.
        }
      });
    }
    // xterm's own Terminal.focus() takes no arguments and always lets the
    // browser auto-scroll to bring its hidden input textarea into view --
    // since that textarea lives deep in .terminal-stage, focusing it was
    // dragging the whole page down and pushing the orb/mini-flubber hero
    // section off-screen above the fold. Focusing the real textarea element
    // directly (xterm exposes it publicly) lets us pass preventScroll.
    terminalRef.current?.textarea?.focus({ preventScroll: true });
  }, [active]);

  return (
    <div className="terminal-pane" style={{ display: active ? 'flex' : 'none' }}>
      <div ref={containerRef} className="terminal-pane__surface" />
      {status === 'connecting' && (
        <div className="terminal-pane__overlay" aria-live="polite">
          Starting Claude in {cwd}…
        </div>
      )}
      {status === 'exited' && (
        <div className="terminal-pane__overlay terminal-pane__overlay--exited" aria-live="polite">
          Session ended (exit code {exitCode ?? 0})
        </div>
      )}
    </div>
  );
}
