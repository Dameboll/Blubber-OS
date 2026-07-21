/**
 * kit-store — tracks whether the Starter Kit has been installed onto this
 * machine (Lane B8). Reuses the already-exported `db` singleton from
 * ./db.ts and the `app_meta` key/value table that db.ts's schema already
 * creates (the same table getStatsBaseline()/resetStatsBaseline() use for
 * the stats-reset baseline) — no new table, no edits to db.ts.
 *
 * Single key: 'kit_installed_v1'. Value is the ISO timestamp of the install
 * (real, not a boolean) so a future "installed on <date>" UI has something
 * honest to show — hasInstalledKit() just checks the row exists.
 *
 * resetKitInstallState() is exported for the Settings master reset flow
 * (POST /api/reset) to call alongside resetPet()/resetQuests()/etc. — this
 * file does not wire it in itself (that route is integrator-owned; see the
 * INTEGRATION REPORT for the exact hook-in line).
 */

import { db } from "./db";

const KIT_INSTALLED_KEY = "kit_installed_v1";

/** Record that the Starter Kit was just installed (real timestamp, now). */
export function markKitInstalled(): void {
  db.prepare(
    `INSERT INTO app_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(KIT_INSTALLED_KEY, new Date().toISOString());
}

/** Whether the Starter Kit has ever been installed on this machine. */
export function hasInstalledKit(): boolean {
  const row = db.prepare(`SELECT value FROM app_meta WHERE key = ?`).get(KIT_INSTALLED_KEY) as
    | { value: string }
    | undefined;
  return Boolean(row);
}

/** The real install timestamp, or null if the kit has never been installed. */
export function getKitInstalledAt(): string | null {
  const row = db.prepare(`SELECT value FROM app_meta WHERE key = ?`).get(KIT_INSTALLED_KEY) as
    | { value: string }
    | undefined;
  return row ? row.value : null;
}

/** Clears the install record (Settings master reset). Does NOT touch any
 * files the kit installed (~/.claude/CLAUDE.md, agents/, skills/, or the
 * Development/Projects scaffold) — it only forgets that the install
 * happened, matching the "reset = zero the tracked state, not delete real
 * work" convention resetStatsBaseline() and resetPet() already follow. */
export function resetKitInstallState(): void {
  db.prepare(`DELETE FROM app_meta WHERE key = ?`).run(KIT_INSTALLED_KEY);
}
