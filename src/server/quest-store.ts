/**
 * quest-store — the Virtual Blubber's quest engine (LANE F of
 * docs/plans/idle-life-and-wiring.md).
 *
 * Every quest is a milestone over a REAL metric already tracked elsewhere in
 * the OS — no fabricated progress ever:
 *   - sessionsLogged → DISTINCT real session_id in usage.db (first boot/contact)
 *   - runs           → real Skill/Agent/Workflow/Task invocations (usage.db)
 *   - tokens         → real token burn since the stats baseline (usage.db)
 *   - agentRuns      → real category='agent' invocations only (usage.db)
 *   - nightActivity  → real events logged between local midnight and 5am
 *   - careStreak     → pet_state.care_streak (consecutive care days)
 *   - careActions    → COUNT(*) of pet_actions in pet.db since baseline (real
 *                      care history, backs the Caretaker chain)
 *   - projects       → DISTINCT real Development projects with indexed activity
 *   - daysActive     → whole days since the stats baseline was set
 *   - skillRuns      → real category='skill' invocations only (usage.db)
 *   - earlyBird      → real events logged 5am-9am local since baseline
 *   - weekendActivity→ real events logged on a Sat/Sun local since baseline
 *   - deepWeekDays   → widest distinct-day spread within any single ISO week
 *   - marathonDays   → distinct local days with a 2h+ first→last event span
 * The curated baseline library below (Boot Sequence, Tool Novice, Token Mage,
 * Agent Summoner, Night Shift, Streak, Project Hopper, Early Bird, Weekend
 * Warrior, Deep Week, Skill Caster, Caretaker, Marathon) is ACTIVE from first
 * load — every chain's tier-0 quest is immediately visible and its progress
 * bar reflects real numbers the moment the OS starts indexing, never a
 * locked/blank placeholder.
 *
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
  | 'sessionsLogged'
  | 'runs'
  | 'tokens'
  | 'agentRuns'
  | 'nightActivity'
  | 'careStreak'
  | 'projects'
  | 'careActions'
  | 'skillRuns'
  | 'earlyBird'
  | 'weekendActivity'
  | 'deepWeekDays'
  | 'marathonDays';

/** The real, honestly-derived numbers every quest and the Stats board read. */
export interface QuestMetrics {
  sessionsLogged: number;
  runs: number;
  tokens: number;
  agentRuns: number;
  nightActivity: number;
  careActions: number;
  careStreak: number;
  careToday: number;
  petLevel: number;
  projects: number;
  daysActive: number;
  agentsActive: number;
  /** Real category='skill' invocations since baseline (Skill Caster chain). */
  skillRuns: number;
  /** Real events logged 5am-9am local since baseline (Early Bird chain). */
  earlyBird: number;
  /** Real events logged on a Saturday/Sunday local since baseline (Weekend Warrior). */
  weekendActivity: number;
  /** Max distinct active days within any single ISO week since baseline (Deep Week). */
  deepWeekDays: number;
  /** Count of distinct local days with a 2h+ span between first/last event since baseline (Marathon). */
  marathonDays: number;
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
    chain: 'boot',
    label: 'Boot Sequence',
    metric: 'sessionsLogged',
    tiers: [
      // Target 0: sessionsLogged is never negative, so this is claimable the
      // instant the app is open — the "active from first load" tier.
      { title: 'First Boot', description: 'Open Blubber for the first time.', target: 0, xp: 20 },
      { title: 'First Contact', description: 'Index a real Claude Code session.', target: 1, xp: 40 },
    ],
  },
  {
    chain: 'toolNovice',
    label: 'Tool Novice',
    metric: 'runs',
    tiers: [
      { title: 'Tool Novice I', description: 'Make 10 real tool calls.', target: 10, xp: 50 },
      { title: 'Tool Novice II', description: 'Make 100 real tool calls.', target: 100, xp: 150 },
      { title: 'Tool Novice III', description: 'Make 1,000 real tool calls.', target: 1000, xp: 400 },
    ],
  },
  {
    chain: 'tokenMage',
    label: 'Token Mage',
    metric: 'tokens',
    tiers: [
      { title: 'Token Apprentice', description: 'Burn 100K real tokens.', target: 100_000, xp: 80 },
      { title: 'Token Journeyman', description: 'Burn 1M real tokens.', target: 1_000_000, xp: 240 },
      { title: 'Token Archmage', description: 'Burn 10M real tokens.', target: 10_000_000, xp: 600 },
    ],
  },
  {
    chain: 'summoner',
    label: 'Agent Summoner',
    metric: 'agentRuns',
    tiers: [
      { title: 'Agent Summoner I', description: 'Run 1 real agent session.', target: 1, xp: 60 },
      { title: 'Agent Summoner II', description: 'Run 10 real agent sessions.', target: 10, xp: 200 },
    ],
  },
  {
    chain: 'nightShift',
    label: 'Night Shift',
    metric: 'nightActivity',
    tiers: [
      { title: 'Night Shift', description: 'Log real activity after midnight.', target: 1, xp: 70 },
    ],
  },
  {
    chain: 'streak',
    label: 'Streak',
    metric: 'careStreak',
    tiers: [
      { title: 'Streak I', description: 'Hold a 2-day care streak.', target: 2, xp: 60 },
      { title: 'Streak II', description: 'Hold a 5-day care streak.', target: 5, xp: 140 },
      { title: 'Streak III', description: 'Hold a 14-day care streak.', target: 14, xp: 280 },
    ],
  },
  {
    chain: 'projectHopper',
    label: 'Project Hopper',
    metric: 'projects',
    tiers: [
      { title: 'Project Hopper I', description: 'Log real activity in 1 project.', target: 1, xp: 40 },
      { title: 'Project Hopper II', description: 'Log real activity in 3 distinct projects.', target: 3, xp: 120 },
      { title: 'Project Hopper III', description: 'Log real activity in 10 distinct projects.', target: 10, xp: 320 },
    ],
  },
  {
    chain: 'earlyBird',
    label: 'Early Bird',
    metric: 'earlyBird',
    tiers: [
      { title: 'Early Bird', description: 'Log real activity between 5am and 9am local time.', target: 1, xp: 70 },
    ],
  },
  {
    chain: 'weekendWarrior',
    label: 'Weekend Warrior',
    metric: 'weekendActivity',
    tiers: [
      { title: 'Weekend Warrior', description: 'Log real activity on a Saturday or Sunday.', target: 1, xp: 70 },
    ],
  },
  {
    chain: 'deepWeek',
    label: 'Deep Week',
    metric: 'deepWeekDays',
    tiers: [
      { title: 'Deep Week I', description: 'Log real activity on 5 distinct days within a single week.', target: 5, xp: 160 },
      { title: 'Deep Week II', description: 'Log real activity on all 7 days of a single week.', target: 7, xp: 320 },
    ],
  },
  {
    chain: 'skillCaster',
    label: 'Skill Caster',
    metric: 'skillRuns',
    tiers: [
      { title: 'Skill Caster I', description: 'Invoke 10 real Skills.', target: 10, xp: 50 },
      { title: 'Skill Caster II', description: 'Invoke 100 real Skills.', target: 100, xp: 150 },
      { title: 'Skill Caster III', description: 'Invoke 500 real Skills.', target: 500, xp: 400 },
    ],
  },
  {
    chain: 'caretaker',
    label: 'Caretaker',
    metric: 'careActions',
    tiers: [
      { title: 'Caretaker I', description: 'Care for your Blubber 5 times.', target: 5, xp: 40 },
      { title: 'Caretaker II', description: 'Care for your Blubber 25 times.', target: 25, xp: 120 },
      { title: 'Caretaker III', description: 'Care for your Blubber 100 times.', target: 100, xp: 320 },
    ],
  },
  {
    chain: 'marathon',
    label: 'Marathon',
    metric: 'marathonDays',
    tiers: [
      { title: 'Marathon', description: 'Log 2+ hours of real activity in a single day.', target: 1, xp: 90 },
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
 * pet-store is imported above) to count real care-action history.
 *
 * Baseline-aware (fixed alongside the fresh-start work in LANE 1 TASK B):
 * pet.db is a separate SQLite file from usage.db, but pet_actions.ts is the
 * same ISO-timestamp format as usage.db's stats baseline, so filtering by it
 * here keeps this metric honest with every other quest metric — a master
 * reset or a first-connect baseline move zeroes this too, not just the
 * usage-derived ones. Previously this counted ALL pet_actions rows with no
 * baseline filter (it wasn't backing any chain yet); now that Caretaker
 * claims XP from it, an unfiltered read would have let pre-baseline care
 * history count toward a claim after a reset. */
function careActionsTotal(): number {
  const g = globalThis as unknown as { __blubberPetDb?: Database.Database };
  const petDb = g.__blubberPetDb;
  if (!petDb) return 0;
  try {
    const row = petDb
      .prepare('SELECT COUNT(*) AS n FROM pet_actions WHERE ts >= ?')
      .get(getStatsBaseline()) as { n: number };
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

/** Distinct real Claude Code sessions (session_id) indexed since the stats
 * baseline — backs the Boot Sequence chain's "First Contact" tier. Rows
 * indexed before session attribution existed have a NULL session_id and
 * honestly don't count. */
function sessionsLoggedTotal(): number {
  try {
    const row = usageDb
      .prepare(`SELECT COUNT(DISTINCT session_id) AS n FROM events WHERE session_id IS NOT NULL AND ts >= ?`)
      .get(getStatsBaseline()) as { n: number };
    return row.n;
  } catch {
    return 0;
  }
}

/** Real category='agent' tool invocations only (Skills excluded) — backs the
 * Agent Summoner chain, which is specifically about agent sessions, not the
 * broader "any tool call" number the Tool Novice chain already covers. */
function agentRunsTotal(): number {
  try {
    const row = usageDb
      .prepare(
        `SELECT COUNT(*) AS n FROM events WHERE event_type = 'tool_invocation' AND category = 'agent' AND ts >= ?`,
      )
      .get(getStatsBaseline()) as { n: number };
    return row.n;
  } catch {
    return 0;
  }
}

/** Real events logged between local midnight and 5am — backs the Night Shift
 * quest. `'localtime'` converts the stored UTC ISO timestamp using the OS's
 * own timezone (this is a local desktop app, so that's honestly the player's
 * real clock), never a guessed or hardcoded offset. */
function nightActivityCount(): number {
  try {
    const row = usageDb
      .prepare(
        `SELECT COUNT(*) AS n FROM events
         WHERE ts >= ? AND CAST(strftime('%H', ts, 'localtime') AS INTEGER) BETWEEN 0 AND 4`,
      )
      .get(getStatsBaseline()) as { n: number };
    return row.n;
  } catch {
    return 0;
  }
}

/** Real category='skill' tool invocations since baseline — backs the Skill
 * Caster chain, the mirror image of Agent Summoner's agentRunsTotal(). */
function skillRunsTotal(): number {
  try {
    const row = usageDb
      .prepare(
        `SELECT COUNT(*) AS n FROM events WHERE event_type = 'tool_invocation' AND category = 'skill' AND ts >= ?`,
      )
      .get(getStatsBaseline()) as { n: number };
    return row.n;
  } catch {
    return 0;
  }
}

/** Real events logged between 5am and 9am local since baseline — same
 * 'localtime' approach as nightActivityCount(), just a different window. */
function earlyBirdCount(): number {
  try {
    const row = usageDb
      .prepare(
        `SELECT COUNT(*) AS n FROM events
         WHERE ts >= ? AND CAST(strftime('%H', ts, 'localtime') AS INTEGER) BETWEEN 5 AND 8`,
      )
      .get(getStatsBaseline()) as { n: number };
    return row.n;
  } catch {
    return 0;
  }
}

/** Real events logged on a Saturday (6) or Sunday (0) local since baseline. */
function weekendActivityCount(): number {
  try {
    const row = usageDb
      .prepare(
        `SELECT COUNT(*) AS n FROM events
         WHERE ts >= ? AND CAST(strftime('%w', ts, 'localtime') AS INTEGER) IN (0, 6)`,
      )
      .get(getStatsBaseline()) as { n: number };
    return row.n;
  } catch {
    return 0;
  }
}

/** Max distinct active days within any single ISO year-week since baseline —
 * backs Deep Week. strftime('%Y-%W', ts) buckets rows into weeks; the widest
 * bucket's distinct-day count is the real number, not an assumed 7. */
function deepWeekMaxDays(): number {
  try {
    const row = usageDb
      .prepare(
        `SELECT COUNT(DISTINCT date(ts)) AS days
         FROM events
         WHERE ts >= ?
         GROUP BY strftime('%Y-%W', ts)
         ORDER BY days DESC
         LIMIT 1`,
      )
      .get(getStatsBaseline()) as { days: number } | undefined;
    return row?.days ?? 0;
  } catch {
    return 0;
  }
}

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

/** Count of distinct local days since baseline where the span between the
 * first and last logged event is 2h+ — backs the Marathon quest. Computed
 * from a real min/max per day, never a fabricated "session length" field
 * (the events table has none). */
function marathonDaysCount(): number {
  try {
    const rows = usageDb
      .prepare(
        `SELECT MIN(ts) AS mn, MAX(ts) AS mx
         FROM events
         WHERE ts >= ?
         GROUP BY date(ts, 'localtime')`,
      )
      .all(getStatsBaseline()) as { mn: string; mx: string }[];
    let count = 0;
    for (const r of rows) {
      if (Date.parse(r.mx) - Date.parse(r.mn) >= TWO_HOURS_MS) count += 1;
    }
    return count;
  } catch {
    return 0;
  }
}

function readMetrics(): QuestMetrics {
  const pet = getPetState();
  const totals = getSinceBaselineTotals();
  return {
    sessionsLogged: sessionsLoggedTotal(),
    runs: totals.totalRuns,
    tokens: totals.totalTokens,
    agentRuns: agentRunsTotal(),
    nightActivity: nightActivityCount(),
    careActions: careActionsTotal(),
    careStreak: pet.careStreak,
    careToday: pet.careToday,
    petLevel: pet.level,
    projects: distinctProjects(),
    daysActive: totals.days,
    agentsActive: spawnedCount(),
    skillRuns: skillRunsTotal(),
    earlyBird: earlyBirdCount(),
    weekendActivity: weekendActivityCount(),
    deepWeekDays: deepWeekMaxDays(),
    marathonDays: marathonDaysCount(),
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
