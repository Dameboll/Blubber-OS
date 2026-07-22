/**
 * Portable ~/.claude path, safe to import from CLIENT or server code — the same
 * inline-at-build pattern as dev-root.ts. Server-side code can compute it
 * directly with `path.join(os.homedir(), ".claude")`; 'use client' components
 * can't call Node's os.homedir(), so they import this constant instead. The
 * real value is computed once in next.config.js and inlined into both bundles
 * via NEXT_PUBLIC_BLUBBER_CLAUDE_DIR — never a hardcoded personal path.
 *
 * Used by the Agent Synthesizer: it opens a `claude` authoring session cd'd
 * here so a newly-created agent/skill file is written straight into the user's
 * real ~/.claude/{agents,skills} tree.
 */
export const CLAUDE_DIR = process.env.NEXT_PUBLIC_BLUBBER_CLAUDE_DIR || '.claude';
