/**
 * next.config.js
 *
 * reactStrictMode is off deliberately. Strict Mode's dev-only
 * mount -> cleanup -> remount double-invoke is safe for typical
 * effects, but TerminalPane's effect opens a real xterm.js Terminal
 * tied to a real PTY-backed `claude` process over a WebSocket -- the
 * double-invoke disposes the first Terminal instance while it can
 * still have an internally-scheduled refresh in flight (xterm
 * schedules that refresh itself via requestAnimationFrame, not
 * anything this app calls), and reading dimensions off the
 * already-torn-down renderer throws
 * "Cannot read properties of undefined (reading 'dimensions')".
 * This is a local desktop tool, not a shipped web product, so the
 * dev-only double-invoke safety check isn't worth the crash.
 */
/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false,
  // Isolated dist dir for production builds (see package.json "build" script).
  // Root cause of the recurring "whole dashboard unstyled/404s" breakage:
  // `next build` and `next dev` shared `.next`, so any verification build run
  // while the dev server was up clobbered the dev server's chunks out from
  // under it -- the running server then 404'd on its own layout.css/main-app.js
  // and the app rendered as raw unstyled HTML. Builds now write to .next-build;
  // the dev server's .next is never touched by a build again.
  distDir: process.env.NEXT_DIST_DIR || '.next',
};

module.exports = nextConfig;
