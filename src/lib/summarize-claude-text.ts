// summarizeClaudeText — pure heuristic string transform, NO LLM call (LAW 1:
// cheap, instant, never fabricated). Takes the real tail of the current
// project's own Claude session (heroSession.lastAssistantText from
// GET /api/agents-live, itself already sourced live off the ~/.claude
// transcript by session-activity.ts) and reduces it to a short line that
// fits the hero's speech bubble: strips the markdown constructs that
// actually show up in Claude's own assistant text, collapses whitespace,
// keeps roughly the first complete sentence or clause, then hard-clamps to
// MAX_LENGTH with an ellipsis if anything was cut.
//
// Returns null for empty/whitespace-only input so the caller renders no
// bubble at all rather than a placeholder line (LAW 1 — never fabricated,
// never a fallback that pretends to be real).

const MAX_LENGTH = 140;
const ELLIPSIS = '…';

export function summarizeClaudeText(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = stripMarkdown(raw).replace(/\s+/g, ' ').trim();
  if (!cleaned) return null;
  return clamp(firstSentenceOrClause(cleaned), MAX_LENGTH);
}

/** Strips fenced/inline code, links/images, headers, bold/italic emphasis,
 * bullet/numbered list markers, and blockquote markers — the markdown
 * Claude's own prose actually uses. Leaves plain sentences untouched. */
function stripMarkdown(raw: string): string {
  return raw
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/^\s*[-*•]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/^>\s?/gm, '');
}

/** Roughly the first complete sentence/clause (stops at the first ., !, or ?
 * that's followed by whitespace or the end of the string, as long as that
 * isn't a suspiciously short abbreviation-like fragment). Falls back to the
 * whole cleaned string when nothing qualifies — clamp() still bounds it. */
function firstSentenceOrClause(text: string): string {
  const match = text.match(/^.{12,}?[.!?](?=\s|$)/);
  return match ? match[0].trim() : text;
}

function clamp(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const cut = text.slice(0, maxLength - 1);
  const trimmed = cut.replace(/\s+\S*$/, '');
  return `${trimmed || cut}${ELLIPSIS}`;
}
