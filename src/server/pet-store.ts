/**
 * pet-store — the persistent Virtual Blubber. A single-row `pet_state` table
 * plus a `pet_actions` log, in its own SQLite file. Phase 5 of
 * docs/plans/flubber-3d-everywhere.md.
 *
 * Needs decay continuously in real time: they are recomputed on every read as
 *   clamp(stored − ratePerHour × hoursSince(updated_at))
 * and written back (write-through), so the pet keeps getting hungrier while
 * the app is closed and neglect is visible app-wide via the brain baseline.
 *
 * Same globalThis-singleton + WAL pattern as src/server/db.ts so Next dev-mode
 * Fast Refresh never opens two competing connections.
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const DATA_DIR = path.join(process.cwd(), 'data');
const DB_PATH = path.join(DATA_DIR, 'pet.db');

export type NeedField = 'hunger' | 'hygiene' | 'fun' | 'energy' | 'love';
export type PetAction = 'feed' | 'shower' | 'play' | 'sleep' | 'pet' | 'talk';

export type Needs = Record<NeedField, number>;

export interface PetState {
  needs: Needs;
  avg: number;
  xp: number;
  level: number;
  careStreak: number;
  /** Care actions taken today (drives the "N / 10" daily stars). */
  careToday: number;
  lastCareAt: string | null;
  lastFedAt: string | null;
  lastPlayedAt: string | null;
  /** When this Blubber was first hatched — real age source (reset on master reset). */
  createdAt: string;
  updatedAt: string;
}

// Per-hour decay rates — hunger falls fastest, love slowest.
const DECAY_PER_HOUR: Needs = { hunger: 2.5, hygiene: 1.5, fun: 2.0, energy: 1.2, love: 0.8 };

// Server-side care effects (moved out of VirtualPetScreen).
const NEED_BUMPS: Record<PetAction, Partial<Needs>> = {
  feed: { hunger: 18 },
  shower: { hygiene: 18 },
  play: { fun: 18 },
  sleep: { energy: 25 },
  pet: { love: 12 },
  talk: { love: 6, fun: 4 },
};

const SEED: Needs = { hunger: 78, hygiene: 64, fun: 82, energy: 61, love: 91 };
const XP_PER_ACTION = 15;
const XP_PER_LEVEL = 250;
const DAILY_CARE_CAP = 10;

const clamp = (v: number) => Math.min(100, Math.max(0, v));
const levelForXp = (xp: number) => 1 + Math.floor(xp / XP_PER_LEVEL);
const dateKey = (iso: string) => iso.slice(0, 10); // YYYY-MM-DD

function createSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pet_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      hunger REAL NOT NULL,
      hygiene REAL NOT NULL,
      fun REAL NOT NULL,
      energy REAL NOT NULL,
      love REAL NOT NULL,
      xp INTEGER NOT NULL DEFAULT 0,
      level INTEGER NOT NULL DEFAULT 1,
      care_streak INTEGER NOT NULL DEFAULT 0,
      last_care_date TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pet_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      ts TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pet_actions_ts ON pet_actions(ts);
  `);
}

const globalForPet = globalThis as unknown as { __dameOsPetDb?: Database.Database };

function openDb(): Database.Database {
  if (globalForPet.__dameOsPetDb) return globalForPet.__dameOsPetDb;
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  createSchema(db);
  globalForPet.__dameOsPetDb = db;
  return db;
}

const db = openDb();

interface PetRow {
  hunger: number; hygiene: number; fun: number; energy: number; love: number;
  xp: number; level: number; care_streak: number;
  last_care_date: string | null; created_at: string; updated_at: string;
}

function seedIfEmpty(nowIso: string): void {
  const existing = db.prepare('SELECT 1 FROM pet_state WHERE id = 1').get();
  if (existing) return;
  db.prepare(
    `INSERT INTO pet_state (id, hunger, hygiene, fun, energy, love, xp, level, care_streak, last_care_date, created_at, updated_at)
     VALUES (1, @hunger, @hygiene, @fun, @energy, @love, 0, 1, 0, NULL, @now, @now)`,
  ).run({ ...SEED, now: nowIso });
}

/** Apply real-time decay to a stored row and return the current needs. */
function decayNeeds(row: PetRow, now: number): Needs {
  const hours = Math.max(0, (now - Date.parse(row.updated_at)) / 3_600_000);
  return {
    hunger: clamp(row.hunger - DECAY_PER_HOUR.hunger * hours),
    hygiene: clamp(row.hygiene - DECAY_PER_HOUR.hygiene * hours),
    fun: clamp(row.fun - DECAY_PER_HOUR.fun * hours),
    energy: clamp(row.energy - DECAY_PER_HOUR.energy * hours),
    love: clamp(row.love - DECAY_PER_HOUR.love * hours),
  };
}

function readRow(): PetRow {
  return db.prepare('SELECT * FROM pet_state WHERE id = 1').get() as PetRow;
}

function careTodayCount(nowIso: string): number {
  const today = dateKey(nowIso);
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM pet_actions WHERE substr(ts, 1, 10) = ?`)
    .get(today) as { n: number };
  return Math.min(row.n, DAILY_CARE_CAP);
}

function lastActionAt(actions: PetAction[]): string | null {
  const placeholders = actions.map(() => '?').join(',');
  const row = db
    .prepare(`SELECT ts FROM pet_actions WHERE action IN (${placeholders}) ORDER BY ts DESC LIMIT 1`)
    .get(...actions) as { ts: string } | undefined;
  return row?.ts ?? null;
}

function buildState(needs: Needs, row: PetRow, nowIso: string): PetState {
  const avg = (needs.hunger + needs.hygiene + needs.fun + needs.energy + needs.love) / 5;
  return {
    needs,
    avg,
    xp: row.xp,
    level: row.level,
    careStreak: row.care_streak,
    careToday: careTodayCount(nowIso),
    lastCareAt: lastActionAt(['feed', 'shower', 'play', 'sleep', 'pet', 'talk']),
    lastFedAt: lastActionAt(['feed']),
    lastPlayedAt: lastActionAt(['play']),
    createdAt: row.created_at,
    updatedAt: nowIso,
  };
}

/** Current pet state, with decay applied and written back. */
export function getPetState(now: number = Date.now()): PetState {
  const nowIso = new Date(now).toISOString();
  seedIfEmpty(nowIso);
  const row = readRow();
  const needs = decayNeeds(row, now);
  // Write-through so decay is persisted (a later read from a longer-idle
  // baseline never double-counts elapsed time).
  db.prepare(
    `UPDATE pet_state SET hunger=@hunger, hygiene=@hygiene, fun=@fun, energy=@energy, love=@love, updated_at=@now WHERE id=1`,
  ).run({ ...needs, now: nowIso });
  return buildState(needs, { ...row, ...needs, updated_at: nowIso }, nowIso);
}

/** Wipe the pet back to a brand-new Blubber — fresh needs, level 1, xp 0,
 *  streak 0, no action history (Settings master reset). */
export function resetPet(now: number = Date.now()): PetState {
  const nowIso = new Date(now).toISOString();
  db.transaction(() => {
    db.prepare('DELETE FROM pet_actions').run();
    db.prepare('DELETE FROM pet_state').run();
  })();
  seedIfEmpty(nowIso);
  return getPetState(now);
}

/** Apply a care action: decay → bump → xp/level → streak → persist + log. */
export function applyPetAction(action: PetAction, now: number = Date.now()): PetState {
  const nowIso = new Date(now).toISOString();
  seedIfEmpty(nowIso);
  const row = readRow();
  const needs = decayNeeds(row, now);

  const bumps = NEED_BUMPS[action];
  (Object.keys(bumps) as NeedField[]).forEach((key) => {
    needs[key] = clamp(needs[key] + (bumps[key] ?? 0));
  });

  const xp = row.xp + XP_PER_ACTION;
  const level = levelForXp(xp);

  // Streak advances once per calendar day; a skipped day resets it to 1.
  const today = dateKey(nowIso);
  let careStreak = row.care_streak;
  if (row.last_care_date !== today) {
    const yesterday = dateKey(new Date(now - 86_400_000).toISOString());
    careStreak = row.last_care_date === yesterday ? row.care_streak + 1 : 1;
  }

  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE pet_state SET hunger=@hunger, hygiene=@hygiene, fun=@fun, energy=@energy, love=@love,
        xp=@xp, level=@level, care_streak=@careStreak, last_care_date=@today, updated_at=@now WHERE id=1`,
    ).run({ ...needs, xp, level, careStreak, today, now: nowIso });
    db.prepare(`INSERT INTO pet_actions (action, ts) VALUES (?, ?)`).run(action, nowIso);
  });
  tx();

  return buildState(needs, { ...row, ...needs, xp, level, care_streak: careStreak, last_care_date: today, updated_at: nowIso }, nowIso);
}
