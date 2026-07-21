/**
 * terminal-signals — the shared success/error/exit signal vocabulary for PTY
 * output, extracted from TerminalScreen.tsx (Phase 4 of
 * docs/plans/flubber-3d-everywhere.md) so both the Terminal screen and the
 * cross-screen FlubberBrain terminal-watcher classify output the same way.
 */

// ANSI escape sequence stripper — the control bytes xterm renders as color
// must not fool the success/error regexes. Verbatim from TerminalScreen.tsx.
const ANSI_PATTERN = new RegExp(
  [
    '[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\\d/#&.:=?%@~_]+)*|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d/#&.:=?%@~_]*)*)?\\u0007)',
    '(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-ntqry=><~]))',
  ].join('|'),
  'g',
);

export const SUCCESS_PATTERN = /success|complete|done|passed|built|ready|✓|✔/i;
export const ERROR_PATTERN = /error|exception|fail(?:ed|ure)?|panic|traceback|✗|✘/i;

export function stripAnsi(input: string): string {
  return input.replace(ANSI_PATTERN, '').replace(/\r(?!\n)/g, '\n');
}

export type TerminalSignal = 'success' | 'error' | null;

/** Classify a chunk of (already ANSI-stripped) PTY output. Error wins ties —
 * a chunk that mentions both a failure and a retry should read as trouble. */
export function classifyOutput(text: string): TerminalSignal {
  if (ERROR_PATTERN.test(text)) return 'error';
  if (SUCCESS_PATTERN.test(text)) return 'success';
  return null;
}
