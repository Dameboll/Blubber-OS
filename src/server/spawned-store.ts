/**
 * spawned-store — the roster of agents the user has spawned from the Agent
 * Control Center / spawn choreography. A flat JSON file (no SQLite needed —
 * this list is small and read/written as a whole), written atomically
 * (tmp file + rename) so a crash mid-write never corrupts the roster.
 *
 * REAL identities only (LAW 1): `name` is an actual ~/.claude/agents slug (e.g.
 * "security-reviewer", "game-developer") resolved from Dame's spawn ask, and
 * `file` is that agent's source .md. No more fabricated slime names — a spawned
 * card is a real agent on standby, matched to a live run the moment Claude fires
 * it. If a caller somehow omits a name we fall back to the real built-in
 * "general-purpose" agent, never an invented one.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const DATA_DIR = path.join(process.cwd(), "data");
const STORE_PATH = path.join(DATA_DIR, "spawned-agents.json");

export interface SpawnedAgent {
  id: string;
  /** Real agent slug (~/.claude/agents/<name>.md filename, sans extension). */
  name: string;
  /** Real source file for that agent, when known. */
  file?: string;
  purpose: string;
  createdAt: string;
}

interface StoreShape {
  agents: SpawnedAgent[];
}

// Fallback identity when a caller omits a name — a real built-in agent, not a
// made-up one.
const FALLBACK_AGENT = "general-purpose";

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readStore(): StoreShape {
  try {
    const raw = fs.readFileSync(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw) as StoreShape;
    if (!Array.isArray(parsed.agents)) return { agents: [] };
    return parsed;
  } catch {
    return { agents: [] };
  }
}

/** Atomic write: write to a tmp file in the same dir, then rename over the
 * real path. A rename is atomic on the same filesystem, so a reader never
 * sees a half-written file. */
function writeStore(store: StoreShape): void {
  ensureDataDir();
  const tmpPath = `${STORE_PATH}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(store, null, 2), "utf8");
  fs.renameSync(tmpPath, STORE_PATH);
}

export function list(): SpawnedAgent[] {
  return readStore().agents;
}

export function create(input: { name?: string; file?: string; purpose: string }): SpawnedAgent {
  const store = readStore();
  const name = input.name && input.name.trim().length > 0 ? input.name.trim() : FALLBACK_AGENT;
  const agent: SpawnedAgent = {
    id: crypto.randomUUID(),
    name,
    file: input.file && input.file.trim().length > 0 ? input.file.trim() : undefined,
    purpose: input.purpose,
    createdAt: new Date().toISOString(),
  };
  store.agents.push(agent);
  writeStore(store);
  return agent;
}

export function remove(id: string): boolean {
  const store = readStore();
  const before = store.agents.length;
  store.agents = store.agents.filter((a) => a.id !== id);
  if (store.agents.length === before) return false;
  writeStore(store);
  return true;
}

export function clear(): void {
  writeStore({ agents: [] });
}
