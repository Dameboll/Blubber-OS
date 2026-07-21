/**
 * Portable Development-root path, safe to import from CLIENT or server code.
 *
 * Server-side modules can compute this directly with
 * `path.join(os.homedir(), "Development")` (optionally overridden via the
 * BLUBBER_DEV_ROOT env var — see next.config.js). Client components ('use
 * client') can't call Node's `os.homedir()` at all, so they import this
 * constant instead: the real value is computed once, server-side, in
 * next.config.js and inlined into both bundles at build/start time via
 * `NEXT_PUBLIC_BLUBBER_DEV_ROOT` — never a hardcoded personal path.
 */
export const DEV_ROOT = process.env.NEXT_PUBLIC_BLUBBER_DEV_ROOT || 'Development';
