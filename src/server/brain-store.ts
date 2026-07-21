/**
 * brain-store — the persisted FlubberBrain personality/behavior config
 * (personality mode, energy, movement, talkativeness). A single small JSON
 * file, written atomically (tmp file + rename). Defaults are returned when
 * the file doesn't exist yet — nothing is created on disk until the first
 * `update()`, so a fresh install has an honest, uncluttered data/ dir.
 */

import fs from "node:fs";
import path from "node:path";

const DATA_DIR = path.join(process.cwd(), "data");
const STORE_PATH = path.join(DATA_DIR, "brain-config.json");

export type PersonalityMode = "playful" | "professional" | "chill" | "hype" | "sarcastic";

export interface BrainConfig {
  personalityMode: PersonalityMode;
  energyLevel: number;
  movementAmount: number;
  talkativeness: number;
}

const PERSONALITY_MODES: PersonalityMode[] = ["playful", "professional", "chill", "hype", "sarcastic"];

const DEFAULTS: BrainConfig = {
  personalityMode: "playful",
  energyLevel: 75,
  movementAmount: 70,
  talkativeness: 60,
};

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function clamp(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(100, Math.max(0, v));
}

function readStore(): BrainConfig {
  try {
    const raw = fs.readFileSync(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<BrainConfig>;
    return {
      personalityMode: PERSONALITY_MODES.includes(parsed.personalityMode as PersonalityMode)
        ? (parsed.personalityMode as PersonalityMode)
        : DEFAULTS.personalityMode,
      energyLevel: typeof parsed.energyLevel === "number" ? clamp(parsed.energyLevel) : DEFAULTS.energyLevel,
      movementAmount:
        typeof parsed.movementAmount === "number" ? clamp(parsed.movementAmount) : DEFAULTS.movementAmount,
      talkativeness:
        typeof parsed.talkativeness === "number" ? clamp(parsed.talkativeness) : DEFAULTS.talkativeness,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

/** Atomic write: tmp file in the same dir, then rename over the real path. */
function writeStore(config: BrainConfig): void {
  ensureDataDir();
  const tmpPath = `${STORE_PATH}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2), "utf8");
  fs.renameSync(tmpPath, STORE_PATH);
}

/** Current config, or the documented defaults if nothing has been saved yet. */
export function get(): BrainConfig {
  if (!fs.existsSync(STORE_PATH)) return { ...DEFAULTS };
  return readStore();
}

/** Merge a partial update over the current config, validating/clamping every
 * field, and persist it. */
export function update(partial: Partial<BrainConfig>): BrainConfig {
  const current = get();
  const next: BrainConfig = {
    personalityMode:
      partial.personalityMode !== undefined && PERSONALITY_MODES.includes(partial.personalityMode)
        ? partial.personalityMode
        : current.personalityMode,
    energyLevel: partial.energyLevel !== undefined ? clamp(partial.energyLevel) : current.energyLevel,
    movementAmount:
      partial.movementAmount !== undefined ? clamp(partial.movementAmount) : current.movementAmount,
    talkativeness:
      partial.talkativeness !== undefined ? clamp(partial.talkativeness) : current.talkativeness,
  };
  writeStore(next);
  return next;
}

/** Back to documented defaults (Settings master reset). */
export function reset(): BrainConfig {
  writeStore({ ...DEFAULTS });
  return { ...DEFAULTS };
}
