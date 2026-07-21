/**
 * onboarding-store — tracks whether the first-run "Meet Blubber" onboarding
 * flow (Lane B1) has been completed on this machine.
 *
 * This does NOT own its own table or database file. It reads/writes a single
 * row on the `app_meta` key/value table that src/server/db.ts already creates
 * (the same table getStatsBaseline()/resetStatsBaseline() use there) via the
 * shared `db` singleton exported from that module. db.ts itself is never
 * edited by this file.
 */

import { db } from './db';

const ONBOARDING_KEY = 'onboarding_seen_v1';

/** True once the user has completed (or explicitly dismissed) the first-run
 * onboarding overlay. False on a brand-new install / after a state reset. */
export function hasSeenOnboarding(): boolean {
  const row = db.prepare(`SELECT value FROM app_meta WHERE key = ?`).get(ONBOARDING_KEY) as
    | { value: string }
    | undefined;
  return row?.value === 'true';
}

/** Marks onboarding as complete so it never shows again on this machine. */
export function markOnboardingSeen(): void {
  db.prepare(
    `INSERT INTO app_meta (key, value) VALUES (?, 'true')
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(ONBOARDING_KEY);
}

/** Clears the seen flag so the onboarding overlay runs again on next load.
 * Not currently wired to any route/button — exported for a future Settings
 * "replay onboarding" action or a master-reset hook. */
export function resetOnboardingState(): void {
  db.prepare(`DELETE FROM app_meta WHERE key = ?`).run(ONBOARDING_KEY);
}
