// GET /api/onboarding/detect → { status: 'found' | 'empty' | 'not-found' }
//
// Real filesystem check on THIS machine — no fabrication, no network call:
//   'not-found' — ~/.claude does not exist at all (Claude Code has never run
//                 here, or this is a fresh sandbox/demo machine).
//   'empty'     — ~/.claude exists but ~/.claude/projects has no project
//                 subdirectory with any files in it yet (installed, unused).
//   'found'     — at least one real project subdirectory under
//                 ~/.claude/projects has content (transcripts, memory, etc.) —
//                 the same directory src/server/log-indexer.ts walks.
//
// Read-only. Never writes anything.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export type DetectStatus = 'found' | 'empty' | 'not-found';

function isNonEmptyDir(dirPath: string): boolean {
  try {
    return fs.readdirSync(dirPath).length > 0;
  } catch {
    // Unreadable (permissions, race with deletion, etc.) — treat as empty
    // rather than crashing the whole detect pass over one bad entry.
    return false;
  }
}

function detectClaudeSetup(): DetectStatus {
  const claudeDir = path.join(os.homedir(), '.claude');
  if (!fs.existsSync(claudeDir)) return 'not-found';

  const projectsDir = path.join(claudeDir, 'projects');
  if (!fs.existsSync(projectsDir)) return 'empty';

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return 'empty';
  }

  const hasRealProject = entries.some(
    (entry) => entry.isDirectory() && isNonEmptyDir(path.join(projectsDir, entry.name)),
  );

  return hasRealProject ? 'found' : 'empty';
}

export async function GET() {
  try {
    return NextResponse.json({ status: detectClaudeSetup() });
  } catch (err) {
    console.error('[api/onboarding/detect] GET failed:', err);
    return NextResponse.json({ error: 'Failed to detect Claude Code setup' }, { status: 500 });
  }
}
