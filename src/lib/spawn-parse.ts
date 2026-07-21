/**
 * spawn-parse.ts — turns what the user types into the hero's spawn ask ("audit my
 * auth flow", "2 game devs and 3 UI experts") into a list of REAL roster agents
 * to put on standby. No fabricated slime names anymore: every spawn resolves to
 * an actual ~/.claude/agents/*.md agent (name + file), matched by the words in
 * the request. Multi-spawn (counts + several roles in one line) is parsed here.
 *
 * Pure logic, no React. `roster` is the real GET /api/agents list.
 */

import { resolveOutfit } from './agent-outfits';

export interface RosterAgent {
  name: string;
  description: string;
  file: string;
}

export interface SpawnRequest {
  agent: RosterAgent;
  purpose: string;
  count: number;
}

const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

// Words that carry no role signal — dropped before scoring so "I need a security
// guy" scores on "security", not "need"/"guy".
const STOP = new Set([
  'the', 'a', 'an', 'for', 'to', 'of', 'my', 'me', 'some', 'please', 'need',
  'want', 'get', 'got', 'with', 'and', 'agent', 'agents', 'expert', 'experts',
  'dev', 'devs', 'developer', 'developers', 'pro', 'guy', 'guys', 'that', 'can',
  'who', 'help', 'on', 'in', 'up', 'is', 'it', 'give', 'set', 'put', 'work',
]);

// Only explicit numeric intent (a digit or a number-word ≥ two) turns a single
// request into a multi-spawn parse. "a"/"an"/"one" stay single so "one that
// audits the api" isn't torn apart.
const EXPLICIT_COUNT = /\b(\d+|two|three|four|five|six|seven|eight|nine|ten)\b/i;

// Hard ceiling per role segment so a fat-fingered "50 testers" can't flood the
// grid or hammer the store with 50 POSTs.
const MAX_PER_SEGMENT = 8;

function tokenize(value: string): string[] {
  return value.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

/** Overlap score between a request phrase and one roster agent's name +
 *  description. Exact token hits weigh more than substring hits. */
function scoreAgent(phraseTokens: string[], agent: RosterAgent): number {
  const hay = tokenize(`${agent.name} ${agent.description}`);
  const haySet = new Set(hay);
  let score = 0;
  for (const token of phraseTokens) {
    if (token.length < 3 || STOP.has(token)) continue;
    if (haySet.has(token)) score += 2;
    else if (hay.some((h) => h.length >= 4 && (h.includes(token) || token.includes(h)))) score += 1;
  }
  return score;
}

/** The single best real roster agent for a phrase, or null if nothing plausibly
 *  matches (caller surfaces an honest "couldn't match" rather than inventing). */
export function matchAgent(phrase: string, roster: RosterAgent[]): RosterAgent | null {
  if (roster.length === 0) return null;
  const tokens = tokenize(phrase).filter((t) => !STOP.has(t));

  let best: RosterAgent | null = null;
  let bestScore = 0;
  for (const agent of roster) {
    const s = scoreAgent(tokens, agent);
    if (s > bestScore) {
      bestScore = s;
      best = agent;
    }
  }
  if (best && bestScore > 0) return best;

  // No direct word overlap — fall back to the role the phrase reads as (via the
  // shared outfit rules) and find a roster agent that reads as the same role.
  // Still real: it picks an actual agent file, just by role affinity.
  const wantedRole = resolveOutfit(phrase).role;
  const byRole = roster.find((a) => resolveOutfit(a.name, a.description).role === wantedRole);
  return byRole ?? null;
}

export interface RankedAgent {
  agent: RosterAgent;
  score: number;
}

/** Every roster agent that shares any word-signal with the phrase, best first.
 *  Empty when nothing overlaps (caller falls back to role affinity). */
export function rankAgents(phrase: string, roster: RosterAgent[]): RankedAgent[] {
  const tokens = tokenize(phrase).filter((t) => !STOP.has(t));
  return roster
    .map((agent) => ({ agent, score: scoreAgent(tokens, agent) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);
}

/** The outcome of resolving a single free-text spawn ask:
 *  - confident: one agent clearly wins → spawn it.
 *  - multi: explicit counts/roles ("2 game devs, 3 UI") → spawn the batch.
 *  - ambiguous: several plausible agents, no clear winner → let the user pick.
 *  - none: nothing in the roster plausibly fits → say so honestly. */
export type SpawnResolution =
  | { kind: 'confident'; agent: RosterAgent; purpose: string }
  | { kind: 'multi'; requests: SpawnRequest[] }
  | { kind: 'ambiguous'; candidates: RosterAgent[]; purpose: string }
  | { kind: 'none'; purpose: string };

const MIN_CONFIDENT_SCORE = 2; // at least one exact word hit
const CONFIDENT_LEAD = 2; // top must clear the runner-up by this much
const MAX_CANDIDATES = 4;

/** Confidence-aware resolution for a spawn ask. Explicit-count asks stay
 *  auto (the user was specific); a single vague brief either wins clearly, offers
 *  a short pick-list, or honestly finds nothing. Never invents an agent. */
export function resolveSpawn(text: string, roster: RosterAgent[]): SpawnResolution {
  const trimmed = text.trim();
  if (!trimmed || roster.length === 0) return { kind: 'none', purpose: trimmed };

  if (EXPLICIT_COUNT.test(trimmed)) {
    const requests = parseSpawnRequest(trimmed, roster);
    return requests.length > 0 ? { kind: 'multi', requests } : { kind: 'none', purpose: trimmed };
  }

  const ranked = rankAgents(trimmed, roster);
  if (ranked.length === 0) {
    // No shared words — offer agents that READ as the requested role.
    const wantedRole = resolveOutfit(trimmed).role;
    const byRole = roster.filter((a) => resolveOutfit(a.name, a.description).role === wantedRole);
    if (byRole.length === 1) return { kind: 'confident', agent: byRole[0], purpose: trimmed };
    if (byRole.length > 1) return { kind: 'ambiguous', candidates: byRole.slice(0, MAX_CANDIDATES), purpose: trimmed };
    return { kind: 'none', purpose: trimmed };
  }

  const top = ranked[0];
  const lead = ranked.length > 1 ? top.score - ranked[1].score : Infinity;
  if (top.score >= MIN_CONFIDENT_SCORE && lead >= CONFIDENT_LEAD) {
    return { kind: 'confident', agent: top.agent, purpose: trimmed };
  }
  return { kind: 'ambiguous', candidates: ranked.slice(0, MAX_CANDIDATES).map((r) => r.agent), purpose: trimmed };
}

/** Parse a free-text spawn ask into concrete real-agent spawn requests.
 *  - No explicit count → one request for the whole brief (best-matched agent).
 *  - Explicit count(s) → split on commas / "and" and resolve each segment,
 *    honoring its leading count ("2 game devs, 3 ui experts"). */
export function parseSpawnRequest(text: string, roster: RosterAgent[]): SpawnRequest[] {
  const trimmed = text.trim();
  if (!trimmed || roster.length === 0) return [];

  if (!EXPLICIT_COUNT.test(trimmed)) {
    const agent = matchAgent(trimmed, roster);
    return agent ? [{ agent, purpose: trimmed, count: 1 }] : [];
  }

  const segments = trimmed
    .split(/[,;\n]+|\band\b|\bplus\b/i)
    .map((s) => s.trim())
    .filter(Boolean);

  const out: SpawnRequest[] = [];
  for (const segment of segments) {
    let count = 1;
    const m = segment.match(/^\s*(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten)\b/i);
    if (m) {
      const word = m[1].toLowerCase();
      count = /^\d+$/.test(word) ? parseInt(word, 10) : NUMBER_WORDS[word] ?? 1;
    }
    count = Math.min(Math.max(count, 1), MAX_PER_SEGMENT);
    const agent = matchAgent(segment, roster);
    if (agent) out.push({ agent, purpose: segment, count });
  }

  // Every segment failed to resolve — try the whole line as one brief.
  if (out.length === 0) {
    const agent = matchAgent(trimmed, roster);
    if (agent) out.push({ agent, purpose: trimmed, count: 1 });
  }
  return out;
}
