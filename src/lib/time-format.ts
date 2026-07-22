/**
 * time-format — one place the "Time Format" setting (12h / 24h) is honored.
 *
 * The Settings screen persists `timeFormat` in ui prefs; the app-wide prefs
 * applier (AppShell) calls setUse24h() from that value on load and whenever it
 * changes. The two clock/time surfaces (SessionProvider's live clock stamp and
 * TerminalScreen's session-start label) format through the helpers below
 * instead of hardcoding hour12, so flipping the setting actually changes what
 * the user sees. A module-level flag (not React state) is deliberate: the live
 * clock re-renders every second and picks up a change within a tick, and the
 * one-shot terminal label refreshes on its next mount — no context plumbing
 * needed for a single boolean.
 */

let use24hFlag = false;

/** Set by the app-wide prefs applier from ui prefs `timeFormat === '24h'`. */
export function setUse24h(value: boolean): void {
  use24hFlag = value;
}

export function isUse24h(): boolean {
  return use24hFlag;
}

/** Live clock stamp: HH:MM:SS, honoring the Time Format setting. */
export function formatClockTime(date: Date): string {
  return date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: !use24hFlag,
  });
}

/** Short time label: H:MM (no seconds), honoring the Time Format setting. */
export function formatShortTime(date: Date): string {
  return date.toLocaleTimeString([], {
    hour: use24hFlag ? '2-digit' : 'numeric',
    minute: '2-digit',
    hour12: !use24hFlag,
  });
}
