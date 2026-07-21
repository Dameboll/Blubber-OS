'use client';

/**
 * useFlubberBrain — consumer entry point for the shared FlubberBrain. Returns
 * the resolved render state (expression / pulseKey / speech) and, separately,
 * the stable dispatch api. Without a FlubberBrainProvider above it both are
 * inert defaults, so any Blubber slot can opt in without hard-depending on the
 * provider being mounted. Phase 4 of docs/plans/flubber-3d-everywhere.md.
 */

export {
  useFlubberBrainState as useFlubberBrain,
  useFlubberBrainApi,
  useFlubberBrainConfig,
  type FlubberBrainConfig,
} from '../components/FlubberBrainProvider';
