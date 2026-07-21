# Contributing to Blubber-OS

PRs are welcome. This is a small, opinionated codebase; here's what keeps a PR mergeable.

## Before you open a PR

1. **Type check passes.**

   ```bash
   npm run typecheck
   ```

2. **Production build passes.**

   ```bash
   npm run build
   ```

3. **The e2e suite passes.** It's a Playwright suite that runs against the real dev server and the real local SQLite state (this is a single-user desktop app, so that's the honest way to test it). It starts its own server on port 3100.

   ```bash
   npx playwright test
   ```

   The suite is serial on purpose (one shared SQLite file, one shared server). Don't parallelize it, and don't renumber the spec files: the master-reset spec runs last for a reason.

## Ground rules

- **Don't touch brand assets.** Everything in `public/brand/` (and the Blubber character design generally) is off-limits for changes and isn't covered by the code license. See the license section of the README.
- **Real data only.** A core rule of this app: nothing on screen is fabricated. No decorative fake numbers, no placeholder stats presented as live. If there's no data, show an honest empty state.
- **Keep PRs focused.** One change per PR. A bug fix doesn't need a drive-by refactor.
- **Match the codebase style.** Files carry header comments explaining what they own and why; if you add a file, do the same. TypeScript strict mode stays on.
- **Windows is the primary target.** If your change touches the PTY layer, the server, or native modules (better-sqlite3, node-pty), test on Windows.

## Bugs and ideas

Use the [issue templates](https://github.com/Dameboll/Blubber-OS/issues/new/choose). A minimal reproduction beats a long description every time.
