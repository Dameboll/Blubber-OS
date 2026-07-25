/**
 * Portable Development-root path token, safe to import from CLIENT or server
 * code.
 *
 * This is a TILDE PATH, not a real filesystem path. Client components can't
 * call os.homedir(), and baking a real home path into the client bundle at
 * build time (the old NEXT_PUBLIC_BLUBBER_DEV_ROOT approach) shipped the
 * BUILD machine's personal paths to every customer. Instead the client only
 * ever passes this token around; the server expands "~" to the current
 * user's real home at the moment it touches the filesystem (see
 * src/server/resolve-path.ts, consumed by pty-manager.ts's spawnSession).
 */
export const DEV_ROOT = "~/Development";
