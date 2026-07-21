// waitlist-store — the Blubber Academy interest list.
//
// Academy ships LOCKED in v1 (Lane B3): it will only ever be bundled inside a
// future paid "All Access" tier, never sold standalone, and there is no real
// course content or payment flow yet. This store exists purely to capture
// "notify me" emails ahead of that launch.
//
// Imports the already-exported `{ db }` singleton from ./db (never edits
// db.ts itself) and owns its own table — same "bring your own table" pattern
// pet-store.ts and quest-store.ts already use against the same connection.

import { db } from './db';

db.exec(`
  CREATE TABLE IF NOT EXISTS waitlist (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
  )
`);

const insertStmt = db.prepare(`INSERT OR IGNORE INTO waitlist (email, created_at) VALUES (?, ?)`);
const countStmt = db.prepare(`SELECT COUNT(*) AS count FROM waitlist`);

export interface AddWaitlistResult {
  ok: boolean;
}

/** Adds an email to the waitlist. Emails are normalized (trim + lowercase)
 * before the INSERT OR IGNORE against the UNIQUE column, so a re-submitted
 * or differently-cased duplicate is always a graceful no-op — never throws. */
export function addWaitlistEmail(email: string): AddWaitlistResult {
  const normalized = email.trim().toLowerCase();
  insertStmt.run(normalized, new Date().toISOString());
  return { ok: true };
}

/** Real signup count. Not surfaced in the UI yet, but available for a future
 * "N builders already waiting" line without any new plumbing. */
export function getWaitlistCount(): number {
  const row = countStmt.get() as { count: number };
  return row.count;
}
