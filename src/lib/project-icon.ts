/**
 * project-icon — deterministic project-name -> lucide icon mapping.
 *
 * Project tiles (ProjectCard grid tile, ProjectListRow) previously carried no
 * type signal at all beyond the real thumbnail image/3D fallback — every
 * folder looked the same at a glance regardless of what it actually was.
 * This gives each one an honest visual hint: a small badge derived from the
 * project's own folder name, not a random pick.
 *
 * ICON_RULES is a first-match-wins keyword list checked against the
 * lowercased raw folder name (e.g. "ai-agent-thing", "quari_press_site").
 * Order matters — more specific/common keywords sit first so, e.g., a name
 * containing both "api" and "web" still reads as whichever the author put
 * higher in the list (see comments per rule below).
 *
 * FALLBACK: a folder name that matches nothing gets a small, curated,
 * neutral icon set (Folder / FolderKanban / Box / Layers) selected by a
 * deterministic hash of the name — same djb2-ish hash src/lib/project-plates.ts
 * already uses for room-plate assignment, so the SAME project always lands on
 * the SAME fallback icon across reloads instead of visibly flickering between
 * runs (an unstable icon reads as more broken than no icon at all).
 */

import {
  BookOpen,
  Bot,
  Box,
  Database,
  FlaskConical,
  Folder,
  FolderKanban,
  Gamepad2,
  Globe,
  Layers,
  LayoutDashboard,
  Music,
  Package,
  Server,
  ShoppingBag,
  Smartphone,
  Wrench,
  type LucideIcon,
} from 'lucide-react';

interface IconRule {
  /** Matched against the lowercased raw project name. */
  test: RegExp;
  icon: LucideIcon;
}

// First match wins. Keep the more specific/common signals near the top —
// e.g. "api"/"server" is checked before "app" so an "api-app" folder reads
// as a backend service, not a generic mobile app.
export const ICON_RULES: IconRule[] = [
  { test: /music|audio|beat|sound|song/, icon: Music },
  { test: /bot|agent|\bai\b|gpt|claude/, icon: Bot },
  { test: /game|play|arcade/, icon: Gamepad2 },
  { test: /api|server|backend/, icon: Server },
  { test: /app|mobile|native/, icon: Smartphone },
  { test: /shop|store|commerce|market/, icon: ShoppingBag },
  { test: /doc|book|notes|wiki/, icon: BookOpen },
  { test: /data|scrape|etl/, icon: Database },
  { test: /\bos\b|dash|deck/, icon: LayoutDashboard },
  { test: /kit|starter|template/, icon: Package },
  { test: /test|qa/, icon: FlaskConical },
  { test: /script|tool|cli/, icon: Wrench },
  // web/site/landing/page is intentionally last among the "content" rules —
  // "landing page" / "web app" style names are common but least specific
  // (nearly every project "has a page"), so more distinctive keywords above
  // get first crack.
  { test: /web|site|landing|\bpage\b/, icon: Globe },
];

// Small, neutral pool for names that match no keyword rule — never the loud
// content-specific icons above, so an unmatched project doesn't accidentally
// imply a type it isn't.
const FALLBACK_ICONS: LucideIcon[] = [Folder, FolderKanban, Box, Layers];

/** Same djb2-ish hash as src/lib/project-plates.ts's hashString — kept as a
 *  local copy (not imported) so this module has zero dependency on the plate
 *  system; the two just happen to agree on a hash shape. */
function hashString(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
  }
  return hash;
}

/** Deterministic icon for a project's raw folder name — first ICON_RULES
 *  match wins; unmatched names fall back to a stable hash pick from
 *  FALLBACK_ICONS so the same project always renders the same icon. */
export function getProjectIcon(rawName: string): LucideIcon {
  const name = rawName.toLowerCase();
  for (const rule of ICON_RULES) {
    if (rule.test.test(name)) return rule.icon;
  }
  return FALLBACK_ICONS[hashString(name) % FALLBACK_ICONS.length];
}
