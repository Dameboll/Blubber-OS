// intro-store — has the one-time "Blubber forms up" intro cinematic played
// yet? Backed by the shared `app_meta` key/value table that src/server/db.ts
// already creates (see its CREATE TABLE app_meta). This module never edits
// db.ts — it only reads/writes its OWN key inside that shared table, the same
// pattern db.ts itself uses for getStatsBaseline()/resetStatsBaseline().
//
// Key: 'intro_seen_v1'. Versioned so a future redesign of the cinematic can
// force it to play again for everyone by bumping to 'intro_seen_v2' — nobody
// has to touch existing rows.

import { db } from './db';

const INTRO_SEEN_KEY = 'intro_seen_v1';
const SEEN_VALUE = '1';

/** True once the intro cinematic has played to completion (or been skipped)
 * at least once, ever, on this machine. */
export function hasSeenIntro(): boolean {
  const row = db.prepare(`SELECT value FROM app_meta WHERE key = ?`).get(INTRO_SEEN_KEY) as
    | { value: string }
    | undefined;
  return row?.value === SEEN_VALUE;
}

/** Marks the intro as seen. It will never auto-play again until
 * resetIntroState() is called (e.g. a future Settings "replay intro" action
 * or the master reset, if the integrator chooses to wire it in there). */
export function markIntroSeen(): void {
  db.prepare(
    `INSERT INTO app_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(INTRO_SEEN_KEY, SEEN_VALUE);
}

/** Clears the seen flag so the cinematic plays again on next load. Not wired
 * into anything by this lane — available for the Settings master reset or a
 * standalone "replay intro" control to call directly. */
export function resetIntroState(): void {
  db.prepare(`DELETE FROM app_meta WHERE key = ?`).run(INTRO_SEEN_KEY);
}
