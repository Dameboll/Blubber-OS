/**
 * humanizeSlug — presentation-only transform for kebab/snake-case identifiers
 * (real ~/.claude/agents/*.md `name:` frontmatter values, e.g. "a11y-architect",
 * "ankane-readme-writer") into a friendlier display label ("A11y Architect",
 * "Ankane Readme Writer") for read-only UI surfaces (sidebar lists, roster
 * cards).
 *
 * Deliberately display-only: callers keep using the real slug for anything
 * that matters functionally (hashing/seeding, launch invocation, the actual
 * "+ New" agent picker in TabBar) — this never renames or masks the
 * underlying identity, it just avoids showing raw tooling jargon in
 * friendly-facing chrome. Doesn't invent or guess at meaning; it's a pure
 * mechanical title-case + acronym-uppercase transform of the real name.
 */

// Small, common tech acronyms worth keeping fully uppercase rather than
// title-cased ("Ui" -> "UI"). Not exhaustive by design — anything not listed
// just falls back to normal title-casing, which reads fine either way.
const ACRONYMS = new Set([
  'ui', 'ux', 'api', 'seo', 'geo', 'qa', 'e2e', 'ci', 'cd', 'ai', 'ml',
  'css', 'html', 'sql', 'tdd', 'pr', 'db', 'ios', 'aws', 'gcp', 'cli',
  'sdk', 'rpc', 'http', 'json', 'yaml', 'os', 'rn', 'gtm', 'bmad',
]);

export function humanizeSlug(slug: string): string {
  const trimmed = slug.trim();
  if (!trimmed) return trimmed;
  return trimmed
    .replace(/\.[a-z0-9]+$/i, '') // drop a trailing file extension, if any slipped through
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => {
      const lower = word.toLowerCase();
      if (ACRONYMS.has(lower)) return lower.toUpperCase();
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(' ');
}
