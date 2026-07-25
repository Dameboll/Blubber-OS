# CODEX HANDOFF — Blubber OS v0.1.1 Launch Complete
# Updated: 2026-07-25 19:55 EDT by Codex
# Read this + docs/ai-context.md before touching anything.
#
# STATUS: LAUNCHED. The paid delivery gate, GitHub release, live Shopify theme,
# public policies, clean-profile app path, and final checkout rehearsal all passed.
# Do not repeat the launch sequence. See the completion block at the top of
# docs/ai-context.md for exact commits, hashes, order evidence, and deferred work.

## Historical pre-launch state (complete)

- Branch: `fix/launch-blockers-v0.1.1` (main branch: `main`). PR #1 already merged earlier; this branch has the follow-up fixes.
- Latest commits: `b3bb5dc` (survive missing Music known-folder + fail loudly on startup errors), `941fe14` (launch blockers 1-5 + fail-closed release pipeline), `da02dba` (clean-machine first-run path + smoke test harness).
- v0.1.0 was re-released as a 222.9MB self-contained Windows installer. Clean-env verify passed 17/17. Browser e2e passed 20/20. Typecheck clean.

## What is already DONE (do not redo)

1. All 5 launch blockers fixed: path dereferencing, auth guards, data-dir migration (idempotent), kit rollback, port/nonce.
2. 96 build-machine absolute paths scrubbed from the packaged output.
3. `electron/main.js` hardened — `app.getPath("music")` throws on fresh Windows accounts with no Music known-folder; now survives it and fails loudly on other startup errors.
4. First-run "Injecting…" hang fixed — log-indexer now async walk + slice (14.8s → 0.49s on a 2.17GB working copy).
5. Native installer defects fixed: install-claude route npm→native, `~/.local/` detection, onboarding UI wired + ungated, escape-hatch "Look around" button on the notfound path.
6. Release pipeline is fail-closed (`release.ps1`) — a failed step aborts the release instead of shipping a broken installer.
7. better-sqlite3 ABI toggle handled: the module builds for system Node OR Electron, never both. Rebuild order matters — wrong ABI 500s every route. E2e was green post-ABI-rebuild.

## Historical launch checklist (complete)

### 1. Commit / clean the stragglers on disk
- Modified: `docs/ai-context.md` (session log update — commit it).
- Untracked: `BLUBBER-LAUNCH-READINESS-AUDIT-AND-PLAN.md` (audit doc — commit to docs/ or keep local, your call), `docs/screenshots/*` (~25 verification screenshots — commit), `data/` (CHECK CONTENTS FIRST — likely local runtime state, probably belongs in .gitignore, do NOT blind-commit).

### 2. Shopify integration test — THE paid-launch blocker
- The kit-marker paywall gates paid features. Purchase flow runs through Shopify.
- Needed: end-to-end test of buy → kit delivery → kit marker unlock in the app. Nothing about this is verified yet.
- Until this passes, launch is free-tier only. Do not announce paid until buy-flow is proven on a clean machine.

### 3. Tag + release v0.1.1
- After Shopify test passes: merge branch to `main` (squash), tag `v0.1.1`, run `release.ps1` (fail-closed — let it abort if anything fails), verify installer output size ~223MB, run the clean-env smoke harness (`tools/smoke-test/`) one more time against the final artifact.

## Known gotchas (memory-backed, will bite you)

- **sqlite ABI**: rebuild for Electron before packaging, for system Node before running server-side tests. Wrong one = every API route 500s.
- **node-pty**: skipped in the installer build on purpose. Don't "fix" that.
- **asar is off** intentionally; installer bundles self-contained node. VS Build Tools required on the build machine.
- **Indexer**: `setImmediate` alone does NOT break up a sync block — the async walk+slice fix is load-bearing. Don't refactor it back.
- **3D Flubber model / FlubberHome / flubber3d host**: DO NOT TOUCH under any circumstances unless Dame explicitly asks.
- Fresh-profile Windows accounts: missing known-folders throw from `app.getPath` — that hardening in main.js is load-bearing too.
- Windows Sandbox harness: host-driven test works; sandbox-side boot marker never verified. Use the host clean-env path (15-17 checks) as the verification standard.

## Definition of done for launch

- Shopify buy flow verified end-to-end on a clean machine (real purchase test or Shopify test mode, full delivery to kit unlock).
- v0.1.1 tagged, installer built through fail-closed pipeline, clean-env smoke pass.
- Download page notes SmartScreen warning (unsigned .exe — known, accepted for v0.1.x).
- docs/ai-context.md updated at end of session.
