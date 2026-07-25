/**
 * Portable ~/.claude path token, safe to import from CLIENT or server code —
 * the same tilde-path pattern as dev-root.ts. This is never a real machine
 * path: the server expands "~" at spawn time (src/server/resolve-path.ts),
 * so no personal path is ever baked into the client bundle.
 *
 * Used by the Agent Synthesizer: it opens a `claude` authoring session cd'd
 * here so a newly-created agent/skill file is written straight into the
 * user's real ~/.claude/{agents,skills} tree.
 */
export const CLAUDE_DIR = "~/.claude";
