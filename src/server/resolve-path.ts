/**
 * Server-side tilde-path expansion — the single choke point that turns the
 * client's portable path tokens into real absolute paths on THIS machine.
 *
 * Why: 'use client' components can't call os.homedir(), and baking the build
 * machine's home into the client bundle (the old NEXT_PUBLIC_* approach)
 * ships the developer's personal paths to every customer. So the client only
 * ever speaks in tilde paths ("~/Development", "~/.claude/...") and the
 * server expands them at the moment it actually touches the filesystem.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Expand a leading "~" to the current user's home directory and normalize
 * separators for the host OS. Absolute paths pass through untouched. */
export function expandTilde(p: string): string {
  if (!p) return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return path.normalize(p);
}

/** Expand a cwd for process spawning, falling back to the deepest existing
 * ancestor (ultimately the home directory) when the target doesn't exist —
 * a fresh machine has no ~/Development yet, and spawning into a missing cwd
 * hard-fails the PTY. */
export function resolveSpawnCwd(p: string | undefined | null): string {
  const home = os.homedir();
  if (!p) return home;
  let candidate = expandTilde(p);
  while (candidate && !fs.existsSync(candidate)) {
    const parent = path.dirname(candidate);
    if (parent === candidate) return home;
    candidate = parent;
  }
  return candidate || home;
}
