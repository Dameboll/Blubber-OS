/**
 * flubber-brain/baseline — the resting mood (priority 0), derived purely from
 * the brain's ambient inputs. First match wins, in the order the plan fixes
 * (docs/plans/flubber-3d-everywhere.md Phase 4):
 *
 *   pet avg < 35  → disappointed   (neglect shows app-wide)
 *   pet avg < 60  → worried
 *   music playing → dj-mode
 *   intensity ≥ 1 → working        (real token throughput)
 *   idle > 5min + night → sleeping
 *   idle > 5min         → tired
 *   else                → happy
 */

import type { BrainState, FlubberExpression } from './types';

export const IDLE_MS = 5 * 60 * 1000;
const NIGHT_START_HOUR = 22;
const NIGHT_END_HOUR = 6;

const PET_DISAPPOINTED_BELOW = 35;
const PET_WORRIED_BELOW = 60;

function isNight(now: number): boolean {
  const hour = new Date(now).getHours();
  return hour >= NIGHT_START_HOUR || hour < NIGHT_END_HOUR;
}

export function computeBaseline(state: BrainState, now: number): FlubberExpression {
  const pet = state.petSnapshot;
  if (pet) {
    if (pet.avg < PET_DISAPPOINTED_BELOW) return 'disappointed';
    if (pet.avg < PET_WORRIED_BELOW) return 'worried';
  }
  if (state.musicPlaying) return 'dj-mode';
  if (state.intensityBucket >= 1) return 'working';

  const idleMs = now - state.lastEventAt;
  if (idleMs > IDLE_MS) return isNight(now) ? 'sleeping' : 'tired';
  return 'happy';
}
