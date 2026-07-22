// recommended-plugins — the curated Claude Code plugin stack Blubber offers to
// install for you (optional, always declinable). Isomorphic-safe (no Node
// built-ins) so both the client UI and the install route import the same list —
// one source of truth for what "the recommended loadout" actually is.
//
// Every id/marketplace below is a REAL, verified marketplace + plugin (confirmed
// against a working install), not a guess:
//   - superpowers       → obra/superpowers-marketplace   (the big one: a whole
//                          skills framework — brainstorming, TDD, debugging,
//                          plan-writing, parallel subagents)
//   - frontend-design    ┐
//   - code-review        │  all from anthropics/claude-plugins-official,
//   - context7           │  the first-party marketplace
//   - commit-commands    ┘
//
// Install mechanics (per plugin, run by /api/onboarding/install-plugins):
//   claude plugin marketplace add <marketplaceSource>   (idempotent)
//   claude plugin install <id>@<marketplace>
//
// Requires the `claude` CLI on PATH — so this is only meaningful once Claude
// Code itself is installed (the notfound branch installs that first).

export interface RecommendedPlugin {
  /** Plugin id as Claude Code knows it. */
  id: string;
  /** Display name. */
  name: string;
  /** Marketplace name the plugin is installed from (the `@<marketplace>` half). */
  marketplace: string;
  /** Source Claude Code uses to add that marketplace (git url or owner/repo). */
  marketplaceSource: string;
  /** One line the user reads to decide whether they want it. */
  description: string;
}

export const RECOMMENDED_PLUGINS: RecommendedPlugin[] = [
  {
    id: "superpowers",
    name: "Superpowers",
    marketplace: "superpowers-marketplace",
    marketplaceSource: "https://github.com/obra/superpowers-marketplace.git",
    description:
      "A full skills framework — Claude picks up disciplined workflows for brainstorming, planning, TDD, debugging, and running work in parallel.",
  },
  {
    id: "frontend-design",
    name: "Frontend Design",
    marketplace: "claude-plugins-official",
    marketplaceSource: "anthropics/claude-plugins-official",
    description: "Pushes generated UI toward distinctive, intentional design instead of templated defaults.",
  },
  {
    id: "code-review",
    name: "Code Review",
    marketplace: "claude-plugins-official",
    marketplaceSource: "anthropics/claude-plugins-official",
    description: "A /code-review command that audits your changes for bugs and quality before you ship them.",
  },
  {
    id: "context7",
    name: "Context7",
    marketplace: "claude-plugins-official",
    marketplaceSource: "anthropics/claude-plugins-official",
    description: "Live, version-accurate framework docs on tap so Claude codes against the real current API.",
  },
  {
    id: "commit-commands",
    name: "Commit Commands",
    marketplace: "claude-plugins-official",
    marketplaceSource: "anthropics/claude-plugins-official",
    description: "Clean /commit and PR helpers so your git history stays readable without the busywork.",
  },
];

/** Look up a subset by id, preserving the curated order. Unknown ids are
 * dropped (never fabricated). An empty/undefined selection means "all". */
export function selectPlugins(ids?: string[]): RecommendedPlugin[] {
  if (!ids || ids.length === 0) return RECOMMENDED_PLUGINS;
  const wanted = new Set(ids);
  return RECOMMENDED_PLUGINS.filter((p) => wanted.has(p.id));
}
