/**
 * flubber3d/runtime — the ONE global, framework-free channel through which the
 * config-driven brain steers every live Blubber at once. Phase 1 of the
 * flubber-core upgrade.
 *
 * Why a module singleton instead of React context: the 3D instances are pure
 * three.js with no React above them, and there can be ~30 live at once. Rather
 * than thread props through every Flubber3D/host boundary, the brain provider
 * pushes the resolved config here once, and each instance reads it per-frame
 * (a plain object read — zero allocation). setMovement() on a slot handle is an
 * explicit per-slot override; slots without one inherit these globals.
 *
 * Mapping from GET /api/brain (0-100 ints) → 0..1 here is the provider's job.
 * Defaults mirror the API defaults (playful / energy 75 / movement 70 /
 * talkativeness 60) so the very first frame, before any fetch resolves, already
 * animates at the intended baseline instead of dead-still.
 */

export type FlubberPersonality = 'playful' | 'professional' | 'chill' | 'hype' | 'sarcastic';

export interface FlubberRuntimeConfig {
  /** 0..1 — global animation energy (breathing/gait liveliness, hop cadence). */
  energy: number;
  /** 0..1 — how much idle slots roam by default (wander on/off + speed). */
  movement: number;
  /** Biases expression flavour + narration mood. */
  personality: FlubberPersonality;
  /** 0..1 — how often ambient narration fires. */
  talkativeness: number;
}

const DEFAULT_CONFIG: FlubberRuntimeConfig = {
  energy: 0.75,
  movement: 0.7,
  personality: 'playful',
  talkativeness: 0.6,
};

let current: FlubberRuntimeConfig = { ...DEFAULT_CONFIG };
const listeners = new Set<(cfg: Readonly<FlubberRuntimeConfig>) => void>();

/** Current global config. Cheap to call every frame — returns the live object,
 * treat as read-only. */
export function getFlubberRuntime(): Readonly<FlubberRuntimeConfig> {
  return current;
}

/** Merge a partial config in and notify subscribers. The brain provider calls
 * this after each /api/brain fetch. */
export function setFlubberRuntime(partial: Partial<FlubberRuntimeConfig>): void {
  const next: FlubberRuntimeConfig = { ...current, ...partial };
  // Clamp the numeric channels so a bad payload can't push animation math wild.
  next.energy = clamp01(next.energy);
  next.movement = clamp01(next.movement);
  next.talkativeness = clamp01(next.talkativeness);
  current = next;
  for (const listener of Array.from(listeners)) {
    try {
      listener(current);
    } catch {
      /* ignore a bad subscriber */
    }
  }
}

export function subscribeFlubberRuntime(
  cb: (cfg: Readonly<FlubberRuntimeConfig>) => void,
): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function defaultFlubberRuntime(): FlubberRuntimeConfig {
  return { ...DEFAULT_CONFIG };
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
