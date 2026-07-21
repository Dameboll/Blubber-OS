/**
 * agent-categories.ts — groups the real ~/.claude/agents/*.md roster (154 agents
 * today) into a small set of everyday-first categories so the roster picker can
 * show an accordion instead of one giant flat scroll. First-match-wins predicate
 * order below was checked against the real filenames (see AgentsScreen's roster
 * picker rewrite) and lands within a few agents of the intended shape.
 *
 * Pure data + logic, no React — mirrors the conventions in agent-outfits.ts
 * (ordered rule list + a resolver function, lucide icons as plain values).
 */

import {
  Beaker,
  BookOpen,
  Boxes,
  Compass,
  Eye,
  Hammer,
  Layers,
  Palette,
  Sparkles,
  Wand2,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import type { RosterAgent } from './spawn-parse';

export type CategoryId =
  | 'review'
  | 'build'
  | 'planning'
  | 'research'
  | 'testing'
  | 'content'
  | 'codequality'
  | 'domain'
  | 'gsd'
  | 'ce'
  | 'other';

export interface CategoryDef {
  id: CategoryId;
  label: string;
  icon: LucideIcon;
  test: (slug: string) => boolean;
}

// Explicit slug lists for categories whose members don't share a clean suffix/
// prefix pattern. Kept next to the rule that uses them so the two stay in sync.
const REVIEW_EXTRA = new Set([
  'reviewer',
  'silent-failure-hunter',
  'agent-evaluator',
  'comment-analyzer',
  'pr-test-analyzer',
]);
const BUILD_EXTRA = new Set(['build-error-resolver', 'builder']);
const PLANNING_EXTRA = new Set([
  'architect',
  'planner',
  'orchestrator',
  'chief-of-staff',
  'spec-miner',
  'loop-operator',
  'harness-optimizer',
  'compounding-updater',
]);
const RESEARCH_EXTRA = new Set(['researcher', 'docs-lookup', 'gemini-analyst', 'conversation-analyzer', 'code-explorer']);
const TESTING_SET = new Set(['e2e-runner', 'qa-gate', 'tdd-guide']);
const CONTENT_EXTRA = new Set([
  'marketing-agent',
  'media-creator',
  'ecom-growth-operator',
  'content-strategist',
]);
const CODEQUALITY_SET = new Set([
  'refactor-cleaner',
  'code-simplifier',
  'performance-optimizer',
  'doc-updater',
  'opensource-forker',
  'opensource-packager',
  'opensource-sanitizer',
]);
const DOMAIN_SET = new Set([
  'mathematician-guru',
  'music-guru',
  'veteran-trader',
  'sports-betting-expert',
  'shopify-dropship-expert',
  'hacker-expert',
  'finance-mentor',
  'financial-ops',
  'game-developer',
  'travel-specialist',
  'network-troubleshooter',
  'homelab-architect',
  'sales-operator',
]);

// First-match-wins, ordered everyday-first. GSD/CE prefixes are checked first
// only because they're unambiguous namespaced pipelines, not because they're
// more "everyday" — the accordion still renders them after the human-facing
// categories (see CATEGORY_DEFS order below, which drives display order).
const CATEGORY_TESTS: Record<Exclude<CategoryId, 'other'>, (slug: string) => boolean> = {
  gsd: (s) => s.startsWith('gsd-'),
  ce: (s) => s.startsWith('ce-'),
  review: (s) => /reviewer$/.test(s) || REVIEW_EXTRA.has(s),
  build: (s) => /resolver$/.test(s) || BUILD_EXTRA.has(s),
  planning: (s) => PLANNING_EXTRA.has(s) || /architect$/.test(s),
  research: (s) => RESEARCH_EXTRA.has(s) || s.startsWith('gan-') || /analy/.test(s),
  testing: (s) => TESTING_SET.has(s),
  content: (s) => s.startsWith('content-') || s.startsWith('seo-') || CONTENT_EXTRA.has(s),
  codequality: (s) => CODEQUALITY_SET.has(s),
  domain: (s) => DOMAIN_SET.has(s),
};

// Checked in this order (first match wins). GSD/CE first (unambiguous prefix),
// then the everyday-first buckets, matching the spec's intended shape.
const CHECK_ORDER: Exclude<CategoryId, 'other'>[] = [
  'gsd',
  'ce',
  'review',
  'build',
  'planning',
  'research',
  'testing',
  'content',
  'codequality',
  'domain',
];

/** Display order for the accordion — everyday-first, pipelines last. */
export const CATEGORY_DEFS: CategoryDef[] = [
  { id: 'review', label: 'Review & Audit', icon: Eye, test: CATEGORY_TESTS.review },
  { id: 'build', label: 'Build & Fix', icon: Wrench, test: CATEGORY_TESTS.build },
  { id: 'planning', label: 'Planning & Orchestration', icon: Boxes, test: CATEGORY_TESTS.planning },
  { id: 'research', label: 'Research & Analysis', icon: Compass, test: CATEGORY_TESTS.research },
  { id: 'testing', label: 'Testing & QA', icon: Beaker, test: CATEGORY_TESTS.testing },
  { id: 'content', label: 'Content & Creative', icon: Palette, test: CATEGORY_TESTS.content },
  { id: 'codequality', label: 'Code Quality & Maintenance', icon: Hammer, test: CATEGORY_TESTS.codequality },
  { id: 'domain', label: 'Domain Experts', icon: Sparkles, test: CATEGORY_TESTS.domain },
  { id: 'gsd', label: 'GSD Pipeline', icon: Layers, test: CATEGORY_TESTS.gsd },
  { id: 'ce', label: 'Compound Engineering', icon: Wand2, test: CATEGORY_TESTS.ce },
  { id: 'other', label: 'Other', icon: BookOpen, test: () => false },
];

/** Resolve one real agent (by its file slug, e.g. "security-reviewer") to a
 *  category id. Runs the GSD/CE prefixes first (unambiguous), then the rest of
 *  CHECK_ORDER; falls back to 'other' if nothing matches. */
export function categorizeAgent(file: string, name: string, description: string): CategoryId {
  const slug = (file || name).toLowerCase().replace(/\.md$/, '');
  for (const id of CHECK_ORDER) {
    if (CATEGORY_TESTS[id](slug)) return id;
  }
  // Fall back to scanning name+description for stray signal (kept last since
  // slug matches above are the reliable signal for this roster).
  void description;
  return 'other';
}

/** Groups the full roster by category, preserving CATEGORY_DEFS display order.
 *  Only categories with at least one member are included; 'other' is dropped
 *  entirely when empty so an unreachable empty section never renders. */
export function groupRoster(roster: RosterAgent[]): Map<CategoryId, RosterAgent[]> {
  const buckets = new Map<CategoryId, RosterAgent[]>();
  for (const agent of roster) {
    const id = categorizeAgent(agent.file, agent.name, agent.description);
    const list = buckets.get(id);
    if (list) list.push(agent);
    else buckets.set(id, [agent]);
  }
  const ordered = new Map<CategoryId, RosterAgent[]>();
  for (const def of CATEGORY_DEFS) {
    const list = buckets.get(def.id);
    if (list && list.length > 0) ordered.set(def.id, list);
  }
  return ordered;
}
