/**
 * shortAgentName — turns a real agent/workflow/task identifier (a ~/.claude
 * agent slug like "code-analyzer-debugger", a Task subagent_type, or a Workflow
 * name) into a SHORT friendly label for the live monitor + spawned cards
 * ("Debugger", "UI Designer", "Game Dev"). Display-only, like humanizeSlug, but
 * tighter: it never invents meaning, just maps well-known roles and otherwise
 * trims the humanized name to its most meaningful 1-2 words. The real slug is
 * always kept for identity/matching — this only affects what's shown.
 */

import { humanizeSlug } from './humanize';

// Known role slugs → the short label the owner asked for. Substring-matched so
// suffixed/prefixed variants (ui-ux-pro-max, react-code-reviewer) still resolve.
const KNOWN: { match: string; label: string }[] = [
  { match: 'ui-ux', label: 'UI Designer' },
  { match: 'ux-pro', label: 'UI Designer' },
  { match: 'frontend', label: 'Frontend' },
  { match: 'debugger', label: 'Debugger' },
  { match: 'game', label: 'Game Dev' },
  { match: 'security', label: 'Security' },
  { match: 'reviewer', label: 'Reviewer' },
  { match: 'researcher', label: 'Researcher' },
  { match: 'research', label: 'Researcher' },
  { match: 'architect', label: 'Architect' },
  { match: 'build-error', label: 'Build Fixer' },
  { match: 'build-resolver', label: 'Build Fixer' },
  { match: 'refactor', label: 'Refactor' },
  { match: 'test', label: 'Tester' },
  { match: 'planner', label: 'Planner' },
  { match: 'doc', label: 'Docs' },
  { match: 'content', label: 'Writer' },
  { match: 'performance', label: 'Perf' },
  { match: 'database', label: 'Database' },
  { match: 'general-purpose', label: 'Generalist' },
];

/** Short, friendly label for an agent/workflow/task identifier. */
export function shortAgentName(slugOrName: string, description?: string): string {
  const raw = (slugOrName ?? '').trim();
  if (!raw) return 'Agent';
  const hay = `${raw} ${description ?? ''}`.toLowerCase();

  for (const { match, label } of KNOWN) {
    if (hay.includes(match)) return label;
  }

  // Fallback: humanize, then keep it short (first 2 words) so a long slug like
  // "ankane-readme-writer" reads as "Ankane Readme" not a full sentence.
  const words = humanizeSlug(raw).split(' ').filter(Boolean);
  if (words.length === 0) return 'Agent';
  return words.slice(0, 2).join(' ');
}
