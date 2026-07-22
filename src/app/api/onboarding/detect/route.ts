// GET /api/onboarding/detect → { status: 'found' | 'empty' | 'not-found', kit: boolean }
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
// The SAME scan also looks for the Starter Kit (kit: true when the kit marker
// exists in ~/.claude — see src/server/kit-marker.ts). This is the trigger for
// the guided walkthrough: when Blubber scans for Claude Code on boot, it scans
// for the kit too, and the client fires the tour if the kit is detected.
//
// Read-only. Never writes anything.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { hasKitMarker } from '../../../../server/kit-marker';

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
    return NextResponse.json({ status: detectClaudeSetup(), kit: hasKitMarker() });
  } catch (err) {
    console.error('[api/onboarding/detect] GET failed:', err);
    return NextResponse.json({ error: 'Failed to detect Claude Code setup' }, { status: 500 });
  }
}
