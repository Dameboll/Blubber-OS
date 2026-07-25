/**
 * voice-store — the persisted blubber-speak voice config (voice style, pitch,
 * speed, volume, muted). Mirrors src/server/brain-store.ts exactly: a single
 * small JSON file, written atomically (tmp file + rename), defaults returned
 * when the file doesn't exist yet so a fresh install has an honest,
 * uncluttered data/ dir until the first `update()`.
 */

import fs from "node:fs";
import path from "node:path";

import { DATA_DIR } from "./app-dirs";
const STORE_PATH = path.join(DATA_DIR, "voice-config.json");

export type VoiceStyle = "bubbly" | "deep" | "squeaky" | "robo";

export interface VoiceConfig {
  voiceStyle: VoiceStyle;
  pitch: number;
  speed: number;
  volume: number;
  muted: boolean;
}

const VOICE_STYLES: VoiceStyle[] = ["bubbly", "deep", "squeaky", "robo"];

const DEFAULTS: VoiceConfig = {
  voiceStyle: "bubbly",
  pitch: 55,
  speed: 60,
  volume: 70,
  // Ships MUTED by default — the synth reads as "little robot noises" until a
  // user decides they want it, so the voice is opt-in from the Voice rail
  // (Settings), never a surprise on first boot.
  muted: true,
};

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function clamp(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(100, Math.max(0, v));
}

function readStore(): VoiceConfig {
  try {
    const raw = fs.readFileSync(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<VoiceConfig>;
    return {
      voiceStyle: VOICE_STYLES.includes(parsed.voiceStyle as VoiceStyle)
        ? (parsed.voiceStyle as VoiceStyle)
        : DEFAULTS.voiceStyle,
      pitch: typeof parsed.pitch === "number" ? clamp(parsed.pitch) : DEFAULTS.pitch,
      speed: typeof parsed.speed === "number" ? clamp(parsed.speed) : DEFAULTS.speed,
      volume: typeof parsed.volume === "number" ? clamp(parsed.volume) : DEFAULTS.volume,
      muted: typeof parsed.muted === "boolean" ? parsed.muted : DEFAULTS.muted,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

/** Atomic write: tmp file in the same dir, then rename over the real path. */
function writeStore(config: VoiceConfig): void {
  ensureDataDir();
  const tmpPath = `${STORE_PATH}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2), "utf8");
  fs.renameSync(tmpPath, STORE_PATH);
}

/** Current config, or the documented defaults if nothing has been saved yet. */
export function get(): VoiceConfig {
  if (!fs.existsSync(STORE_PATH)) return { ...DEFAULTS };
  return readStore();
}

/** Merge a partial update over the current config, validating/clamping every
 * field, and persist it. */
export function update(partial: Partial<VoiceConfig>): VoiceConfig {
  const current = get();
  const next: VoiceConfig = {
    voiceStyle:
      partial.voiceStyle !== undefined && VOICE_STYLES.includes(partial.voiceStyle)
        ? partial.voiceStyle
        : current.voiceStyle,
    pitch: partial.pitch !== undefined ? clamp(partial.pitch) : current.pitch,
    speed: partial.speed !== undefined ? clamp(partial.speed) : current.speed,
    volume: partial.volume !== undefined ? clamp(partial.volume) : current.volume,
    muted: partial.muted !== undefined ? partial.muted : current.muted,
  };
  writeStore(next);
  return next;
}

/** Back to documented defaults (Settings master reset). */
export function reset(): VoiceConfig {
  writeStore({ ...DEFAULTS });
  return { ...DEFAULTS };
}
