/**
 * agent-outfits.ts — maps a real agent's name/description to a role identity
 * from the outfit gallery (flubber outfits.png): a role label, an icon badge,
 * a rarity, and a role-flavored Blubber expression. Shared by AgentsScreen,
 * the sidebar's Recent Agents, and the dashboard feeds so every agent avatar
 * across the app reads the same role the same way (BADGE APPROXIMATION — a role
 * icon badge + rarity ring + expression, not a full 3D costume).
 *
 * Pure data + logic, no React. The icon values are lucide component refs, which
 * are plain values (safe to import into a .ts module — no JSX here).
 */

import {
  Boxes,
  Cloud,
  Code2,
  Database,
  Eye,
  FileText,
  FlaskConical,
  Megaphone,
  Palette,
  Search,
  ShieldCheck,
  Sparkles,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import type { FlubberExpression } from '../components/FlubberCharacter';

export type Rarity = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';

export interface OutfitRole {
  role: string;
  icon: LucideIcon;
  rarity: Rarity;
  expression: FlubberExpression;
  /** Test-flavored roles surface as TESTING when active instead of WORKING. */
  isTester: boolean;
}

interface OutfitRule extends OutfitRole {
  match: RegExp;
}

const OUTFIT_RULES: OutfitRule[] = [
  { match: /test|qa\b|e2e/i, role: 'QA Tester', icon: FlaskConical, rarity: 'uncommon', expression: 'focused', isTester: true },
  { match: /secur|hacker|attack|defen/i, role: 'Security', icon: ShieldCheck, rarity: 'rare', expression: 'determined', isTester: false },
  { match: /database|\bsql\b|\bdb\b|supabase/i, role: 'Data Analyst', icon: Database, rarity: 'uncommon', expression: 'thinking', isTester: false },
  { match: /api|cloud|integrat|deploy|devops|infra/i, role: 'DevOps', icon: Cloud, rarity: 'uncommon', expression: 'working', isTester: false },
  { match: /design|\bui\b|\bux\b|frontend|visual|slop|a11y|accessib/i, role: 'Designer', icon: Palette, rarity: 'rare', expression: 'plotting', isTester: false },
  { match: /doc|readme|writer|content|changelog/i, role: 'Writer', icon: FileText, rarity: 'common', expression: 'focused', isTester: false },
  { match: /review|audit|evaluat|lint/i, role: 'Editor', icon: Eye, rarity: 'uncommon', expression: 'thinking', isTester: false },
  { match: /build|error|fix|resolv/i, role: 'Coder', icon: Wrench, rarity: 'uncommon', expression: 'determined', isTester: false },
  { match: /architect|planner|plan|orchestrat|scope/i, role: 'Architect', icon: Boxes, rarity: 'epic', expression: 'working', isTester: false },
  { match: /research|explore|intel|compete/i, role: 'Researcher', icon: Search, rarity: 'common', expression: 'thinking', isTester: false },
  { match: /refactor|clean|simplif/i, role: 'Innovator', icon: Sparkles, rarity: 'rare', expression: 'focused', isTester: false },
  { match: /market|sales|gtm|monetize|growth/i, role: 'Marketer', icon: Megaphone, rarity: 'uncommon', expression: 'excited', isTester: false },
];

const DEFAULT_ROLE: OutfitRole = {
  role: 'Coder',
  icon: Code2,
  rarity: 'common',
  expression: 'working',
  isTester: false,
};

export function resolveOutfit(name: string, description = ''): OutfitRole {
  const haystack = `${name} ${description}`;
  const hit = OUTFIT_RULES.find((r) => r.match.test(haystack));
  if (!hit) return DEFAULT_ROLE;
  const { match: _match, ...role } = hit;
  return role;
}

/** Stable hash off a string id (FNV-ish) — used to desync per-agent seeds. */
export function hashSeed(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
  }
  return hash;
}

/** A small, stable seed for a Flubber3D slot from an agent key. */
export function agentSeed(key: string): number {
  return hashSeed(key) % 997;
}
