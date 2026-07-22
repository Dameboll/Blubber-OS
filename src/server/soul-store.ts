/**
 * soul-store — tracks the answers to the Soul Interview (Lane 3), Blubber's
 * optional personalization interview offered after the Starter-Kit tour.
 *
 * This does NOT own its own table or database file. It reads/writes a single
 * row on the `app_meta` key/value table that src/server/db.ts already creates
 * (the same table onboarding-store.ts and kit-store.ts use) via the shared
 * `db` singleton exported from that module. db.ts itself is never edited by
 * this file.
 *
 * Single key: 'soul_interview_v1'. The value is one JSON blob — `{ answers,
 * completedAt }` — rather than one row per question, because there's exactly
 * one reader (GET /api/soul) and one writer (POST /api/soul, which always
 * replaces the whole thing on a retake) and no query ever needs a single
 * answer in isolation. `answers` only ever contains keys for questions the
 * user actually answered — a skipped question (individually, or the whole
 * interview) is simply absent from the object, never stored as an empty
 * string. That absence IS the skipped flag; there's no separate boolean list
 * to keep in sync with src/lib/soul-questions.ts's id set.
 */

import { db } from './db';

const SOUL_KEY = 'soul_interview_v1';

export interface SoulRecord {
  /** Question id (src/lib/soul-questions.ts) -> the user's answer text.
   * Skipped questions are simply not present as a key. */
  answers: Record<string, string>;
  /** ISO timestamp of the most recent save (fresh completion or a retake). */
  completedAt: string;
}

/** Overwrites the saved record wholesale — a retake replaces everything,
 * there's no partial-merge path. Matches kit-store.ts's INSERT ... ON
 * CONFLICT upsert shape exactly. */
export function saveSoulAnswers(record: SoulRecord): void {
  db.prepare(
    `INSERT INTO app_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(SOUL_KEY, JSON.stringify(record));
}

/** The saved record, or null if the interview has never been saved on this
 * machine (including: never attempted, or a corrupt/unparsable row — an
 * unreadable save reads as "no interview" rather than crashing the caller). */
export function getSoulAnswers(): SoulRecord | null {
  const row = db.prepare(`SELECT value FROM app_meta WHERE key = ?`).get(SOUL_KEY) as
    | { value: string }
    | undefined;
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value) as Partial<SoulRecord> | null;
    if (
      parsed &&
      typeof parsed === 'object' &&
      parsed.answers &&
      typeof parsed.answers === 'object' &&
      typeof parsed.completedAt === 'string'
    ) {
      return { answers: parsed.answers, completedAt: parsed.completedAt };
    }
    return null;
  } catch {
    return null;
  }
}

/** True once the Soul Interview has been saved at least once on this
 * machine — fresh completion or any retake. */
export function hasCompletedSoulInterview(): boolean {
  return getSoulAnswers() !== null;
}

/** Clears the saved record. Not currently wired to any route/button —
 * exported for a future Settings "clear my profile" action or a master-reset
 * hook, mirroring resetOnboardingState()'s same unwired-but-ready shape. */
export function resetSoulInterview(): void {
  db.prepare(`DELETE FROM app_meta WHERE key = ?`).run(SOUL_KEY);
}
