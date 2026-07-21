/**
 * demo-dataset — server-side loader for the bundled Demo Mode fixture (see
 * src/lib/demo-mode.ts for the on/off flag itself). The dataset lives at
 * public/demo/demo-dataset.json — a straight copy of the canned fixture —
 * bundled into the app itself so Demo Mode works on a stranger's machine
 * with zero real Claude Code history and no dependency on any private
 * folder that won't exist outside this dev machine.
 *
 * Each getter below reshapes the raw fixture into the EXACT response shape
 * the real (non-demo) code path already returns for that route, so swapping
 * between real and demo data is invisible to every frontend consumer.
 */

import fs from "node:fs";
import path from "node:path";

const DATASET_PATH = path.join(process.cwd(), "public", "demo", "demo-dataset.json");

interface RawDemoProject {
  id: string;
  name: string;
  description: string;
  stack: string;
  lastModifiedMinutesAgo: number;
  status: "active" | "idle" | "archived";
}

interface RawDemoActivity {
  id: string;
  agent: string;
  action: string;
  project: string;
  summary: string;
  minutesAgo: number;
}

interface RawDemoTopAgent {
  id: string;
  name: string;
  taskCount: number;
  specialty: string;
}

interface RawDemoDataset {
  demoMode: true;
  generatedAt: string;
  projects: RawDemoProject[];
  activity: RawDemoActivity[];
  topAgents: RawDemoTopAgent[];
  stats: {
    sessionsThisWeek: number;
    tasksCompletedThisWeek: number;
    currentStreakDays: number;
    tokenUsagePercent: number;
  };
  weeklyRecap: string;
}

let cached: RawDemoDataset | null = null;

function loadDataset(): RawDemoDataset {
  if (cached) return cached;
  const raw = fs.readFileSync(DATASET_PATH, "utf8");
  cached = JSON.parse(raw) as RawDemoDataset;
  return cached;
}

// ---------------------------------------------------------------------------
// /api/system — {cpu, mem, proc}
//
// The fixture carries no machine-vitals numbers (there's no real machine
// behind a demo visit), so these are hand-picked plausible constants, gently
// drifting with wall-clock time so a demo screenshot doesn't look frozen.
// This is the one field this module invents rather than reshapes from the
// fixture — documented here per the lane brief.
// ---------------------------------------------------------------------------

export interface DemoSystemStats {
  cpu: number;
  mem: number;
  proc: number;
}

export function getDemoSystemStats(): DemoSystemStats {
  const t = Date.now() / 60_000; // slow drift, multi-minute cycles — never static, never jumpy
  const cpu = Math.round(28 + Math.sin(t / 9) * 9);
  const mem = Math.round(52 + Math.sin(t / 13 + 1) * 6);
  const proc = Math.round(4 + Math.sin(t / 17 + 2) * 1.5);
  return {
    cpu: Math.min(100, Math.max(0, cpu)),
    mem: Math.min(100, Math.max(0, mem)),
    proc: Math.min(100, Math.max(0, proc)),
  };
}

// ---------------------------------------------------------------------------
// /api/recent — {events: RecentEvent[]}
// ---------------------------------------------------------------------------

export interface DemoRecentEvent {
  ts: string;
  toolName: string | null;
  category: "skill" | "agent" | null;
  project: string | null;
  elapsedMs: number | null;
  status: "running" | "done" | null;
}

/** Deterministic pseudo-duration derived from a stable string id, so the same
 * demo row always reports the same "done in Xm" — never re-randomized
 * between requests, matching the honest/never-fabricated spirit of the real
 * getRecentEvents (just a demo constant standing in for a real join). */
function stableDurationMs(id: string, minMs: number, maxMs: number): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  const span = Math.max(1, maxMs - minMs);
  return minMs + (hash % span);
}

/** Reshapes the fixture's `activity` rows (agent/action/summary/minutesAgo)
 * into real RecentEvent rows. `ts` is computed from `minutesAgo` relative to
 * NOW (not the fixture's fixed generatedAt) so the feed always reads as
 * freshly-happened whenever a demo visitor loads it, exactly like a real
 * live feed would. Every demo activity row is an agent run (the fixture's
 * six personas mirror its own topAgents list), so category is always
 * "agent" and status is always "done" — matches the shape every consumer
 * (ActivityFeedPanel, AgentsScreen, AgentPoolWorld) already expects. */
export function getDemoRecentEvents(limit: number, project: string | null): DemoRecentEvent[] {
  const { activity } = loadDataset();
  const now = Date.now();

  const events: DemoRecentEvent[] = activity
    .filter((a) => !project || a.project === project)
    .map((a) => ({
      ts: new Date(now - a.minutesAgo * 60_000).toISOString(),
      toolName: a.agent,
      category: "agent" as const,
      project: a.project,
      elapsedMs: stableDurationMs(a.id, 20_000, 340_000),
      status: "done" as const,
    }));

  return events.slice(0, limit);
}

// ---------------------------------------------------------------------------
// /api/top-agents — {agents: NamedCount[], range}
// ---------------------------------------------------------------------------

export interface DemoNamedCount {
  name: string;
  count: number;
}

export type DemoTopAgentsRange = "daily" | "weekly" | "alltime";

// The fixture's taskCount is one all-time-shaped number; scale it down for
// the daily/weekly views so the toggle isn't a no-op in demo mode, same
// directional relationship the real daily/weekly/alltime queries have to
// each other (daily << weekly << alltime).
const RANGE_SCALE: Record<DemoTopAgentsRange, number> = {
  daily: 0.08,
  weekly: 0.4,
  alltime: 1,
};

export function getDemoTopAgents(range: DemoTopAgentsRange, topN = 5): DemoNamedCount[] {
  const { topAgents } = loadDataset();
  const scale = RANGE_SCALE[range];
  return topAgents
    .map((a) => ({ name: a.name, count: Math.max(1, Math.round(a.taskCount * scale)) }))
    .sort((a, b) => b.count - a.count)
    .slice(0, topN);
}

// ---------------------------------------------------------------------------
// /api/projects — {roots: [{label, root, projects: string[]}]}
// ---------------------------------------------------------------------------

export interface DemoProjectRoot {
  label: string;
  root: string;
  projects: string[];
}

const ROOT_LABELS = ["ACTIVE", "HOBBY", "general", "research"] as const;

/** All demo project folders live under a placeholder HOBBY root (they read
 * like small side projects, e.g. "todo-app", "recipe-finder") -- the other
 * three roots come back empty, an honest "nothing here yet" rather than
 * inventing folders for them. `root` is a literal placeholder path, never the
 * visiting machine's real home directory. Names sorted alphabetically,
 * matching the real route's listSubdirectories() contract. */
export function getDemoProjectRoots(): DemoProjectRoot[] {
  const { projects } = loadDataset();
  const names = projects.map((p) => p.name).sort((a, b) => a.localeCompare(b));

  return ROOT_LABELS.map((label) => ({
    label,
    root: `~/Development/${label}`,
    projects: label === "HOBBY" ? names : [],
  }));
}
