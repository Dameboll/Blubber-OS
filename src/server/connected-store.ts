/**
 * connected-store — tracks whether this machine's real ~/.claude workspace
 * has ever been connected (Lane C). Mirrors kit-store.ts's pattern exactly:
 * reuses the already-exported `db` singleton from ./db.ts and the `app_meta`
 * key/value table db.ts's schema already creates (the same table
 * getStatsBaseline()/resetStatsBaseline()/kit-store.ts's own key all live
 * in) — no new table, no edits to db.ts.
 *
 * Single key: 'workspace_connected_v1'. This is the free-tier "raw shell"
 * gate: before the user has ever run onboarding's inject flow (POST
 * /api/onboarding/inject — see markWorkspaceConnected()'s call site there),
 * every stats/activity API route serves the bundled placeholder dataset from
 * demo-dataset.ts instead of querying real (empty/misleading) local state.
 * Once connected, that gate flips permanently and every route switches over
 * to real data — there's no "disconnect" path in the UI, so this never goes
 * back to false on its own (resetWorkspaceConnected() exists only for the
 * Settings master reset flow, same convention as kit-store.ts's own reset).
 *
 * This is deliberately a boolean-shaped presence check (unlike kit-store's
 * real install timestamp) — nothing downstream needs "connected since when",
 * only "connected or not".
 */

import { db } from "./db";

const WORKSPACE_CONNECTED_KEY = "workspace_connected_v1";

/** Record that the user's real ~/.claude workspace has been connected.
 * Returns true only the FIRST time this flips false → true on this machine —
 * the caller (the onboarding inject route) uses that to know it's the true
 * "day zero" moment and should zero the stats baseline + quest claims so no
 * pre-connect Claude history counts toward stats or quests. A re-run of
 * inject on an already-connected workspace returns false and must NOT
 * re-zero anything. */
export function markWorkspaceConnected(): boolean {
  const wasAlreadyConnected = isWorkspaceConnected();
  db.prepare(
    `INSERT INTO app_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(WORKSPACE_CONNECTED_KEY, new Date().toISOString());
  return !wasAlreadyConnected;
}

/** Whether the workspace has ever been connected on this machine — the gate
 * every stats/activity API route checks to decide placeholder vs. real data. */
export function isWorkspaceConnected(): boolean {
  const row = db.prepare(`SELECT value FROM app_meta WHERE key = ?`).get(WORKSPACE_CONNECTED_KEY) as
    | { value: string }
    | undefined;
  return Boolean(row);
}

/** Clears the connected record (Settings master reset). Does NOT touch any
 * indexed data — it only forgets that a connection happened, matching the
 * "reset = zero the tracked state, not delete real work" convention
 * resetStatsBaseline() and resetKitInstallState() already follow. Not wired
 * into the reset route by this file — the integrator owns that hook-in. */
export function resetWorkspaceConnected(): void {
  db.prepare(`DELETE FROM app_meta WHERE key = ?`).run(WORKSPACE_CONNECTED_KEY);
}
