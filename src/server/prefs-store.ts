/**
 * prefs-store — a single persisted "ui_prefs_v1" JSON blob covering the
 * small cross-cutting Settings preferences that don't warrant their own
 * store file: Appearance (glow/animation speed/sound effects/accent +
 * theme color) and Notifications toggles.
 *
 * Unlike brain-store.ts / voice-store.ts (their own flat JSON files under
 * data/), this one rides the `app_meta` key/value table src/server/db.ts
 * already creates and owns — same pattern src/server/onboarding-store.ts
 * uses (a single row, JSON-stringified in the `value` column) rather than a
 * second on-disk file for what is, in total, a handful of small fields.
 * db.ts itself is never edited by this file.
 */

import { db } from './db';

const PREFS_KEY = 'ui_prefs_v1';

export type AnimationSpeed = 'Slow' | 'Normal' | 'Fast';
export type TimeFormat = '12h' | '24h';

export interface UiPrefs {
  // General
  timeFormat: TimeFormat;
  // Appearance
  glowIntensity: number;
  animationSpeed: AnimationSpeed;
  soundEffects: boolean;
  themeColor: string;
  accentColor: string;
  // Notifications
  notifyBlubberTips: boolean;
}

const ANIMATION_SPEEDS: AnimationSpeed[] = ['Slow', 'Normal', 'Fast'];
const TIME_FORMATS: TimeFormat[] = ['12h', '24h'];

// Mirrors SettingsScreen.tsx's pre-existing DEFAULT_INTERFACE values exactly,
// so the UI never flashes a different value than what the store will return
// on first fetch (same reasoning as brain-store.ts's header comment).
const DEFAULTS: UiPrefs = {
  timeFormat: '12h',
  glowIntensity: 80,
  animationSpeed: 'Normal',
  soundEffects: true,
  themeColor: 'green',
  accentColor: '#39FF14',
  notifyBlubberTips: true,
};

function clampPct(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(100, Math.max(0, v));
}

function isHexColor(v: unknown): v is string {
  return typeof v === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(v);
}

function readMeta(): string | null {
  const row = db.prepare(`SELECT value FROM app_meta WHERE key = ?`).get(PREFS_KEY) as
    | { value: string }
    | undefined;
  return row ? row.value : null;
}

function writeMeta(value: string): void {
  db.prepare(
    `INSERT INTO app_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(PREFS_KEY, value);
}

/** Validates/clamps every field independently so a partially-corrupt or
 *  hand-edited blob still yields a fully-defaulted, safe config rather than
 *  throwing. */
function sanitize(parsed: Partial<UiPrefs> | null): UiPrefs {
  if (!parsed || typeof parsed !== 'object') return { ...DEFAULTS };
  return {
    timeFormat: TIME_FORMATS.includes(parsed.timeFormat as TimeFormat)
      ? (parsed.timeFormat as TimeFormat)
      : DEFAULTS.timeFormat,
    glowIntensity: typeof parsed.glowIntensity === 'number' ? clampPct(parsed.glowIntensity) : DEFAULTS.glowIntensity,
    animationSpeed: ANIMATION_SPEEDS.includes(parsed.animationSpeed as AnimationSpeed)
      ? (parsed.animationSpeed as AnimationSpeed)
      : DEFAULTS.animationSpeed,
    soundEffects: typeof parsed.soundEffects === 'boolean' ? parsed.soundEffects : DEFAULTS.soundEffects,
    themeColor: typeof parsed.themeColor === 'string' && parsed.themeColor ? parsed.themeColor : DEFAULTS.themeColor,
    accentColor: isHexColor(parsed.accentColor) ? parsed.accentColor : DEFAULTS.accentColor,
    notifyBlubberTips:
      typeof parsed.notifyBlubberTips === 'boolean' ? parsed.notifyBlubberTips : DEFAULTS.notifyBlubberTips,
  };
}

/** Current prefs, or documented defaults if nothing has been saved yet. */
export function get(): UiPrefs {
  const raw = readMeta();
  if (!raw) return { ...DEFAULTS };
  try {
    return sanitize(JSON.parse(raw) as Partial<UiPrefs>);
  } catch {
    return { ...DEFAULTS };
  }
}

/** Merge a partial update over the current prefs, validate, and persist. */
export function update(partial: Partial<UiPrefs>): UiPrefs {
  const next = sanitize({ ...get(), ...partial });
  writeMeta(JSON.stringify(next));
  return next;
}

/** Back to documented defaults (Settings master reset). */
export function reset(): UiPrefs {
  writeMeta(JSON.stringify(DEFAULTS));
  return { ...DEFAULTS };
}
