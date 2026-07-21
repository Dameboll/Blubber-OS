/**
 * project-plates — shared deterministic plate-hash utility for the "room
 * plate" background treatment used on project tiles.
 *
 * Extracted from dash/MiniProjects.tsx's inline `PROJECT_PLATES` +
 * `hashString` + `assignPlates` (the dashboard mini Projects tab) so
 * ProjectCard.tsx / ProjectsScreen.tsx (the real Projects screen, Phase 4 of
 * docs/plans/last-hard-push-2026-07-20.md) can apply the exact same
 * deterministic project -> plate assignment without a second implementation
 * drifting out of sync. Pure, no React/DOM dependency.
 *
 * HANDOFF NOTE for whoever next owns dash/MiniProjects.tsx: that file still
 * carries its own private copy of this logic (this pass's owner does not
 * have write access to that file — see the Phase 4 task split). It should be
 * switched to import PROJECT_PLATES / hashString / assignPlates / platePath
 * from here instead, so there is exactly one source of truth for plate
 * assignment. The logic below is a verbatim port (same hash function, same
 * plate pool, same adjacent-duplicate-avoidance pass), so swapping the
 * import is a safe, zero-behavior-change follow-up, not a rewrite.
 */

// Same 24-image plate pool AgentWorkstation/AgentsScreen already use for
// agent role nooks (public/bg/role-*.webp) — no new art, just reused here.
export const PROJECT_PLATES = [
  'role-architect',
  'role-architect2',
  'role-coder',
  'role-coder2',
  'role-data',
  'role-data2',
  'role-designer',
  'role-designer2',
  'role-devops',
  'role-devops2',
  'role-editor',
  'role-editor2',
  'role-innovator',
  'role-innovator2',
  'role-marketer',
  'role-marketer2',
  'role-qa',
  'role-qa2',
  'role-researcher',
  'role-researcher2',
  'role-security',
  'role-security2',
  'role-writer',
  'role-writer2',
] as const;

export type ProjectPlate = (typeof PROJECT_PLATES)[number];

/** Simple deterministic string hash (djb2-ish, unsigned 32-bit) — the same
 *  project key always resolves to the same plate. */
export function hashString(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
  }
  return hash;
}

/** Deterministic plate for a single project key (e.g. `${rootLabel}/${rawName}`). */
export function plateForKey(key: string): ProjectPlate {
  const idx = hashString(key) % PROJECT_PLATES.length;
  return PROJECT_PLATES[idx];
}

/** Deterministic plate per key, with adjacent-duplicate avoidance so
 *  neighboring tiles in a rendered list don't share the exact same plate.
 *  Best-effort — a nudge to the next hash bucket, not a full shuffle. Order
 *  of `keys` matters (it's whatever order the caller renders them in). */
export function assignPlates(keys: string[]): ProjectPlate[] {
  const plates = keys.map((key) => plateForKey(key));
  for (let i = 1; i < plates.length; i++) {
    if (plates[i] === plates[i - 1]) {
      const idx = (hashString(keys[i]) + 1) % PROJECT_PLATES.length;
      plates[i] = PROJECT_PLATES[idx];
    }
  }
  return plates;
}

/** Public asset path for a plate. */
export function platePath(plate: ProjectPlate): string {
  return `/bg/${plate}.webp`;
}
