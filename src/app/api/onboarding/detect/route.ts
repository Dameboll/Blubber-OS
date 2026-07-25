// GET /api/onboarding/detect → { status: 'found' | 'empty' | 'not-found', kit: boolean }
//
// Real filesystem check on THIS machine — no fabrication, no network call:
//   'not-found' — no ~/.claude AND no installed Claude Code binary (never
//                 installed here, or this is a fresh sandbox/demo machine).
//   'empty'     — Claude Code is present but has nothing indexed yet: either
//                 ~/.claude exists with no non-empty project under
//                 ~/.claude/projects, OR the binary is installed but has never
//                 been run (see hasInstalledBinary below).
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

/**
 * True when Claude Code is installed on disk but may never have been run.
 *
 * ~/.claude is created by Claude Code on first RUN, not at install time, so it
 * is not a sound test for "is it installed". The native installer (the one
 * /api/onboarding/install-claude drives) lays down ~/.local/bin/claude plus
 * ~/.local/share/claude and nothing else. Without this check, a user who just
 * completed a successful in-app install hits "Scan again" and is told nothing
 * is there — the install worked and the app calls it a failure.
 *
 * Only the native install locations are probed: a PATH lookup would need a
 * child process on a hot path, and npm/Homebrew/WinGet installs all shim into
 * these same paths or get picked up once ~/.claude appears on first run.
 */
function hasInstalledBinary(): boolean {
  const home = os.homedir();
  const candidates = [
    path.join(home, '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude'),
    path.join(home, '.local', 'share', 'claude'),
  ];
  return candidates.some((p) => fs.existsSync(p));
}

function detectClaudeSetup(): DetectStatus {
  const claudeDir = path.join(os.homedir(), '.claude');
  // Installed-but-never-run reads as 'empty', matching that branch's copy
  // ("Claude Code is here, but there's nothing indexed yet").
  if (!fs.existsSync(claudeDir)) return hasInstalledBinary() ? 'empty' : 'not-found';

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
