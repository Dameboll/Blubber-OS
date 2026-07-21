/**
 * quest-store — the Virtual Blubber's quest engine (LANE F of
 * docs/plans/idle-life-and-wiring.md).
 *
 * Every quest is a milestone over a REAL metric already tracked elsewhere in
 * the OS — no fabricated progress ever:
 *   - careActions  → COUNT(*) of pet_actions in pet.db (real care history)
 *   - careStreak   → pet_state.care_streak (consecutive care days)
 *   - tokens       → real token burn since the stats baseline (usage.db)
 *   - runs         → real Skill/Agent/Workflow/Task invocations (usage.db)
 *   - projects     → DISTINCT real Development projects with indexed activity
 *   - daysActive   → whole days since the stats baseline was set
 * The only thing this store OWNS is which quests the user has CLAIMED (a small
 * atomically-written JSON file, same pattern as spawned-store). Quest XP and the
 * "adventure level" (capped at 55) are derived purely from the claimed set, so
 * the claim state is the single source of truth and can never drift.
 *
 * A claim is server-validated: the quest must be unlocked (all earlier tiers in
 * its chain already claimed), its real metric must have reached the target, and
 * it must not already be claimed. So XP only ever reflects real activity the
 * player actually reached.
 */

import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { getPetState } from './pet-store';
import { db as usageDb, getStatsBaseline, getSinceBaselineTotals } from './db';

const DATA_DIR = path.join(process.cwd(), 'data');
const STORE_PATH = path.join(DATA_DIR, 'quests.json');

export const QUEST_LEVEL_CAP = 55;

export type QuestMetric =
  | 'careActions'
  | 'careStreak'
  | 'tokens'
  | 'runs'
  | 'projects'
  | 'daysActive';

/** The real, honestly-derived numbers every quest and the Stats board read. */
export interface QuestMetrics {
  careActions: number;
  careStreak: number;
  careToday: number;
  petLevel: number;
  tokens: number;
  runs: number;
  projects: number;
  daysActive: number;
  agentsActive: number;
}

export type QuestStatus = 'locked' | 'active' | 'claimable' | 'claimed';

export interface QuestChainDef {
  chain: string;
  label: string;
  metric: QuestMetric;
  /** One entry per tier, in ascending order. */
  tiers: { title: string; description: string; target: number; xp: number }[];
}

export interface QuestView {
  id: string;
  chain: string;
  chainLabel: string;
  metric: QuestMetric;
  tier: number;
  title: string;
  description: string;
  target: number;
  current: number;
  xp: number;
  status: QuestStatus;
}

export interface QuestState {
  level: number;
  levelCap: number;
  xp: number;
  xpIntoLevel: number;
  xpForNextLevel: number;
  claimableCount: number;
  metrics: QuestMetrics;
  quests: QuestView[];
}

// ── quest definitions (tiered chains over real metrics) ──────────────────────

const CHAINS: QuestChainDef[] = [
  {
    chain: 'care',
    label: 'Caretaker',
    metric: 'careActions',
    tiers: [
      { title: 'First Contact', description: 'Care for Blubber 5 times.', target: 5, xp: 40 },
      { title: 'Attentive', description: 'Reach 25 total care actions.', target: 25, xp: 80 },
      { title: 'Devoted Keeper', description: 'Reach 75 total care actions.', target: 75, xp: 150 },
      { title: 'Guardian', description: 'Reach 200 total care actions.', target: 200, xp: 300 },
      { title: 'Lifelong Bond', description: 'Reach 600 total care actions.', target: 600, xp: 600 },
    ],
  },
  {
    chain: 'streak',
    label: 'Devotion',
    metric: 'careStreak',
    tiers: [
      { title: 'Warm Up', description: 'Care 2 days in a row.', target: 2, xp: 60 },
      { title: 'Consistent', description: 'Hold a 5-day care streak.', target: 5, xp: 140 },
      { title: 'Ritual', description: 'Hold a 14-day care streak.', target: 14, xp: 280 },
      { title: 'Unbroken', description: 'Hold a 30-day care streak.', target: 30, xp: 480 },
      { title: 'Eternal', description: 'Hold a 55-day care streak.', target: 55, xp: 800 },
    ],
  },
  {
    chain: 'runs',
    label: 'Operator',
    metric: 'runs',
    tiers: [
      { title: 'Getting Going', description: 'Log 10 real agent/skill runs.', target: 10, xp: 50 },
      { title: 'Hands On', description: 'Log 100 real runs.', target: 100, xp: 100 },
      { title: 'In The Flow', description: 'Log 500 real runs.', target: 500, xp: 200 },
      { title: 'Power User', description: 'Log 2,000 real runs.', target: 2000, xp: 400 },
      { title: 'Relentless', description: 'Log 8,000 real runs.', target: 8000, xp: 700 },
    ],
  },
  {
    chain: 'tokens',
    label: 'Token Burner',
    metric: 'tokens',
    tiers: [
      { title: 'Spark', description: 'Burn 50K real tokens.', target: 50_000, xp: 50 },
      { title: 'Kindling', description: 'Burn 500K real tokens.', target: 500_000, xp: 100 },
      { title: 'Bonfire', description: 'Burn 5M real tokens.', target: 5_000_000, xp: 200 },
      { title: 'Inferno', description: 'Burn 25M real tokens.', target: 25_000_000, xp: 400 },
      { title: 'Supernova', description: 'Burn 100M real tokens.', target: 100_000_000, xp: 700 },
    ],
  },
  {
    chain: 'projects',
    label: 'Explorer',
    metric: 'projects',
    tiers: [
      { title: 'Set Foot', description: 'Work in 1 real project.', target: 1, xp: 60 },
      { title: 'Wanderer', description: 'Work across 3 real projects.', target: 3, xp: 120 },
      { title: 'Cartographer', description: 'Work across 5 real projects.', target: 5, xp: 220 },
      { title: 'Trailblazer', description: 'Work across 8 real projects.', target: 8, xp: 360 },
      { title: 'Polymath', description: 'Work across 12 real projects.', target: 12, xp: 600 },
    ],
  },
  {
    chain: 'days',
    label: 'Veteran',
    metric: 'daysActive',
    tiers: [
      { title: 'Day One', description: 'Run Blubber for 1 day.', target: 1, xp: 40 },
      { title: 'One Week In', description: 'Run Blubber for 7 days.', target: 7, xp: 120 },
      { title: 'Seasoned', description: 'Run Blubber for 30 days.', target: 30, xp: 260 },
      { title: 'Old Timer', description: 'Run Blubber for 90 days.', target: 90, xp: 460 },
      { title: 'Institution', description: 'Run Blubber for 180 days.', target: 180, xp: 760 },
    ],
  },
];

const questId = (chain: string, tier: number): string => `${chain}.${tier}`;

const DEF_BY_ID = new Map<string, { chain: QuestChainDef; tier: number }>();
for (const chain of CHAINS) {
  chain.tiers.forEach((_, tier) => DEF_BY_ID.set(questId(chain.chain, tier), { chain, tier }));
}

// ── XP → level curve (capped at QUEST_LEVEL_CAP) ─────────────────────────────
// Each level needs a little more XP than the last; full completion of every
// chain lands the adventure level in the low-50s, so the cap is aspirational
// but genuinely reachable through real play.
const xpToAdvanceFrom = (level: number): number => 40 + level * 4;

function levelForXp(xp: number): { level: number; xpIntoLevel: number; xpForNextLevel: number } {
  let level = 1;
  let remaining = xp;
  while (level < QUEST_LEVEL_CAP) {
    const need = xpToAdvanceFrom(level);
    if (remaining < need) return { level, xpIntoLevel: remaining, xpForNextLevel: need };
    remaining -= need;
    level += 1;
  }
  // At cap — no further level; show the bar full.
  const need = xpToAdvanceFrom(QUEST_LEVEL_CAP);
  return { level: QUEST_LEVEL_CAP, xpIntoLevel: need, xpForNextLevel: need };
}

// ── claimed-set persistence (atomic JSON, same shape as spawned-store) ───────

interface StoreShape {
  claimed: string[];
}

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readStore(): StoreShape {
  try {
    const parsed = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8')) as StoreShape;
    if (!Array.isArray(parsed.claimed)) return { claimed: [] };
    // Drop any ids that no longer map to a real quest definition.
    return { claimed: parsed.claimed.filter((id) => DEF_BY_ID.has(id)) };
  } catch {
    return { claimed: [] };
  }
}

function writeStore(store: StoreShape): void {
  ensureDataDir();
  const tmp = `${STORE_PATH}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8');
  fs.renameSync(tmp, STORE_PATH);
}

// ── real metric readers ──────────────────────────────────────────────────────

/** Reuse the pet-store's live SQLite connection (set on globalThis when
 * pet-store is imported above) to count real care-action history. */
function careActionsTotal(): number {
  const g = globalThis as unknown as { __blubberPetDb?: Database.Database };
  const petDb = g.__blubberPetDb;
  if (!petDb) return 0;
  try {
    const row = petDb.prepare('SELECT COUNT(*) AS n FROM pet_actions').get() as { n: number };
    return row.n;
  } catch {
    return 0;
  }
}

/** Distinct real Development projects that have any indexed activity since the
 * stats baseline (rows indexed before attribution existed are NULL and honestly
 * don't count). */
function distinctProjects(): number {
  try {
    const row = usageDb
      .prepare(
        `SELECT COUNT(DISTINCT project) AS n FROM events WHERE project IS NOT NULL AND ts >= ?`,
      )
      .get(getStatsBaseline()) as { n: number };
    return row.n;
  } catch {
    return 0;
  }
}

function spawnedCount(): number {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'spawned-agents.json'), 'utf8')) as {
      agents?: unknown[];
    };
    return Array.isArray(parsed.agents) ? parsed.agents.length : 0;
  } catch {
    return 0;
  }
}

function readMetrics(): QuestMetrics {
  const pet = getPetState();
  const totals = getSinceBaselineTotals();
  return {
    careActions: careActionsTotal(),
    careStreak: pet.careStreak,
    careToday: pet.careToday,
    petLevel: pet.level,
    tokens: totals.totalTokens,
    runs: totals.totalRuns,
    projects: distinctProjects(),
    daysActive: totals.days,
    agentsActive: spawnedCount(),
  };
}

// ── public API ────────────────────────────────────────────────────────────────

function buildQuests(metrics: QuestMetrics, claimed: Set<string>): QuestView[] {
  const quests: QuestView[] = [];
  for (const chain of CHAINS) {
    const current = metrics[chain.metric];
    let prevClaimed = true; // tier 0 is always unlocked
    chain.tiers.forEach((tier, i) => {
      const id = questId(chain.chain, i);
      const isClaimed = claimed.has(id);
      let status: QuestStatus;
      if (isClaimed) status = 'claimed';
      else if (!prevClaimed) status = 'locked';
      else status = current >= tier.target ? 'claimable' : 'active';
      quests.push({
        id,
        chain: chain.chain,
        chainLabel: chain.label,
        metric: chain.metric,
        tier: i,
        title: tier.title,
        description: tier.description,
        target: tier.target,
        current,
        xp: tier.xp,
        status,
      });
      prevClaimed = isClaimed;
    });
  }
  return quests;
}

function totalXp(claimed: Set<string>): number {
  let xp = 0;
  for (const id of claimed) {
    const def = DEF_BY_ID.get(id);
    if (def) xp += def.chain.tiers[def.tier].xp;
  }
  return xp;
}

export function getQuestState(): QuestState {
  const metrics = readMetrics();
  const claimed = new Set(readStore().claimed);
  const quests = buildQuests(metrics, claimed);
  const xp = totalXp(claimed);
  const { level, xpIntoLevel, xpForNextLevel } = levelForXp(xp);
  return {
    level,
    levelCap: QUEST_LEVEL_CAP,
    xp,
    xpIntoLevel,
    xpForNextLevel,
    claimableCount: quests.filter((q) => q.status === 'claimable').length,
    metrics,
    quests,
  };
}

export type ClaimResult =
  | { ok: true; state: QuestState; awarded: number }
  | { ok: false; reason: 'unknown' | 'locked' | 'not-reached' | 'already-claimed' };

/** Server-validated claim: unlocked + real metric reached + not already claimed. */
export function claimQuest(id: string): ClaimResult {
  const def = DEF_BY_ID.get(id);
  if (!def) return { ok: false, reason: 'unknown' };

  const store = readStore();
  const claimed = new Set(store.claimed);
  if (claimed.has(id)) return { ok: false, reason: 'already-claimed' };

  // All earlier tiers in the chain must already be claimed.
  for (let t = 0; t < def.tier; t += 1) {
    if (!claimed.has(questId(def.chain.chain, t))) return { ok: false, reason: 'locked' };
  }

  const metrics = readMetrics();
  const target = def.chain.tiers[def.tier].target;
  if (metrics[def.chain.metric] < target) return { ok: false, reason: 'not-reached' };

  claimed.add(id);
  writeStore({ claimed: Array.from(claimed) });
  return { ok: true, state: getQuestState(), awarded: def.chain.tiers[def.tier].xp };
}

/** Master-reset hook (clears all claimed quests). */
export function resetQuests(): void {
  writeStore({ claimed: [] });
}
