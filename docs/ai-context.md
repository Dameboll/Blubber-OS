# Blubber OS — AI Context
# Last sync: 2026-07-26 ~12:32 ET (v0.1.2 live; full website wordmark restored and re-verified)

## ===== v0.1.2 LAUNCH COMPLETE — CURRENT SOURCE OF TRUTH =====
# This block supersedes v0.1.1 icon/download references below. Do not rebuild or republish
# v0.1.2 unless a new change is intentionally requested.
#
# SAFETY / SCOPE
# - Preflight backup:
#   C:\Users\jeffh\Development\HOBBY\_backups\blubber-v012-icon-preflight-2026-07-26T10-19-52-04-00
# - The backup contains both repo bundles, exact v0.1.1 release artifacts, prior icons/config,
#   the previous disposable clean-env app, live-Shopify pre-push files, and v0.1.2 proof logs.
# - No protected project data was changed.
#
# APP / GITHUB
# - PR #3 squash-merged into main as 6cec28e784ac041a123a3f3b9a2435cdbe2f20da.
# - Tag v0.1.2 points to that exact source commit.
# - Release: https://github.com/Dameboll/Blubber-OS/releases/tag/v0.1.2
# - Installer: Blubber.Setup.0.1.2.exe, 198,701,230 bytes (189.5 MiB)
# - SHA256: 74430319B7A134BE576C7A90FD0C461D613C4F7147B1A30B584C354A1A5FD49D
# - The public GitHub asset was downloaded again after publication; byte count and SHA256
#   matched the local release exactly.
# - release.ps1 now has 9 fail-closed stages. Typecheck, fresh build, path scrub, Electron ABI
#   rebuild, native load, packaging, packaged-icon verification, hygiene, and checksum all passed.
#
# ICON PROOF
# - One approved 1024x1024 transparent standalone slime "BL" master drives build/icon.png and
#   src/app/icon.png. It has no dark tile, wordmark, subtitle, or clipped letter.
# - The release gate extracts the actual 32x32 associated icons from the NSIS installer and
#   packaged Blubber.exe. Both were transparent and byte-identical after extraction:
#   SHA256=5D600D7168F814E345CE4C9F8AEBD7FF40A171AA838508B42CD5181A7178BF3F.
# - Independent code review approved the release with 0 critical/high/medium/low findings.
#
# CLEAN-MACHINE / INSTALLER REHEARSAL
# - Host clean-profile run passed with no Node/npm/Claude/Git/prior profile. Server returned 200
#   in 9.5s; pet/quests/top-agents/recent APIs passed; free onboarding returned not-found + kit=false.
# - A separate Windows Sandbox rehearsal installed the exact public-checksum artifact silently on
#   a clean VM, verified app version 0.1.2, created a correctly targeted desktop shortcut, matched
#   installer/app icons, cold-launched to HTTP 200 in 2s, passed the same APIs and free-user path,
#   then uninstalled with exit 0 and removed the install directory. Result: PASS, 0 failures.
#
# LIVE STOREFRONT
# - Live theme: Blubber OS #188479111535 at https://flubberos.myshopify.com
# - The live theme was backed up file-by-file before the scoped 11-file push. Shopify's generated
#   templates/index.json warning header was detected and preserved.
# - Hero Download for Windows points directly to the v0.1.2 installer; View on GitHub remains beside it.
# - Branding split is deliberate: Windows installer/app/shortcut/in-app favicon, website favicon,
#   and tiny OS-mockup icons use the transparent square BL. The visible website header, footer,
#   and Organization JSON-LD use the full transparent BLUBBER wordmark.
# - Live desktop DOM plus 390x844 and 320x700 mobile were verified after the correction:
#   v0.1.2/189.5 MB copy, correct links, 0 broken images, 0 console errors, and no horizontal overflow.
#   Below 360px the redundant header CTA hides; the full wordmark, menu, and hero download remain.
# - Website wordmark correction source: blubber-site local main 3e659d5. Safety backup:
#   C:\Users\jeffh\Development\HOBBY\_backups\blubber-web-wordmark-restore-20260726-122713
#
# PAID / FREE PATHS
# - Community app/repo/installer remain free. The optional Starter Kit paid-delivery setup from
#   v0.1.1 remains unchanged and previously passed the Shopify order/delivery/download rehearsal.
#
# ACCEPTED EARLY-ACCESS LIMITATION
# - The installer remains unsigned. SmartScreen disclosure is present on GitHub, in the README,
#   and on the storefront. Code signing remains deferred.
## ===== END v0.1.2 LAUNCH COMPLETE =====

## ===== HISTORICAL v0.1.1 LAUNCH COMPLETE — DO NOT REPEAT =====
# Safety backup:
#   C:\Users\jeffh\Development\HOBBY\_backups\blubber-launch-preflight-20260725-174933
# Protected app data: all 12 files in data/ still match the preflight backup byte-for-byte.
#
# APP / GITHUB
# - PR #2 squash-merged into main as 01dce8e445a35094ce1a3f7d75d5367cd92300f3.
# - Tag v0.1.1 points to that merge commit. Original fix branch was not deleted.
# - Release: https://github.com/Dameboll/Blubber-OS/releases/tag/v0.1.1
# - Installer: Blubber.Setup.0.1.1.exe, 196,697,154 bytes (187.6 MB)
# - SHA256: 0A8DA228E3CA82A6937B078828C285FC031BE244A2CA382A70E2357CCAF0055B
# - Release asset HEAD followed to HTTP 200 with the exact expected byte count.
# - release.ps1 passed all 7 stages: typecheck, fresh build, path scrub, Electron ABI rebuild,
#   native load, packaging/hygiene, checksum.
# - Final clean-profile harness: all checks passed; cold server ready in 12.8s with no
#   Node/npm/Claude/Git or prior profile. The in-app official Claude installer then installed
#   Claude 2.1.220 inside the disposable profile, detect moved to "empty", the UI rendered
#   "Clean slate", and v0.1.1 opened. All disposable processes were closed afterward.
#
# SHOPIFY / PAID DELIVERY
# - Store: Blubber OS at https://flubberos.myshopify.com
# - Product: Blubber Starter Kit, $39.99, active, digital/no shipping.
# - Exact ZIP attached through Shopify Digital Products:
#   Blubber-Starter-Kit-1.1.0.zip, 84,427 bytes,
#   SHA256=225C8AC7642C1D3FAAB8BCABAD6A6E3372C24142D633E766883D7FFAE7B3AD45
# - No-charge full purchase rehearsal completed as order #1001. Shopify marked the order paid
#   and fulfilled; Digital Products reported the delivery email DELIVERED; the customer page
#   showed the exact file and the Download Now action started a download.
# - Temporary 100% test discount was expired immediately after its one use.
# - Refund, automated privacy, terms, and contact policies are public and linked in checkout.
# - Live theme Blubber OS #188479111535 was pushed successfully.
# - Final live checkout rehearsal reached the payment page at USD $39.99 with the exact product.
#
# STOREFRONT SOURCE
# - C:\Users\jeffh\Development\HOBBY\blubber-site is clean at local commit ff75d57
#   (feat: publish Blubber launch storefront). This repo currently has no Git remote.
# - Public collection Download for Windows points directly to the verified v0.1.1 asset.
# - Live copy/art/counts are accurate: 10 agents, 10 skills, 8 commands, 4 guides.
# - Footer says Apache-2.0; legacy MIT storefront badge and v0.1.0 link are gone.
#
# ACCEPTED EARLY-ACCESS LIMITATION
# - The Windows installer is not code-signed. SmartScreen may show "unrecognized app";
#   the README and GitHub release both explain More info -> Run anyway.
#
# DEFERRED POST-LAUNCH
# - Authenticode signing, auto-updater, waitlist outbox retry, GitHub Actions release gate,
#   CSP hardening, and the onboarding custom-folder issue remain post-launch work.
## ===== END v0.1.1 LAUNCH COMPLETE =====

## ===== HISTORICAL PRE-LAUNCH FREEZE (completed 2026-07-25) =====
# Engineering is DONE and verified. Nothing on the code side is half-finished.
# PR #2 open: https://github.com/Dameboll/Blubber-OS/pull/2
#   branch fix/launch-blockers-v0.1.1 (pushed), commits 941fe14 + b3bb5dc on top of main da02dba
# Installer READY: dist-electron\Blubber Setup 0.1.1.exe — 187.6MB
#   SHA256=A7CB1792BD7D6C1ACBFFCA5D2AADE26A03DE3D7B0D56979D131E60CC9021BA0B (also in dist-electron\SHA256SUMS.txt)
# Verified: tsc clean | e2e 20/20 | clean-env harness ALL PASS on packaged exe (8.3s boot,
#   DBs in userData\blubber-data, free-tier flow + kit gate correct on virgin profile)
#
# NEXT MOVES, IN ORDER (Dame's lane — no Claude needed for 1-4):
# 1. Shopify (CORRECT Blubber admin, NOT AI Won't Save You): attach kit ZIP to variant,
#    one real purchase -> download -> refund test.  <- ONLY remaining paid-launch blocker
# 2. Squash-merge PR #2 -> tag v0.1.1 on the merge commit -> GitHub release -> upload
#    installer + SHA256SUMS.txt
# 3. Shopify theme: publish cosmetics (footer Â© encoding, policy pages via Settings->Policies,
#    one brand name, MIT-vs-Apache wording). Flip download button ONLY after step 2 asset live.
# 4. README: 3 missing screenshots, dead '#' kit link, installer button up top.
# 5. Download-page copy (Early Access): "Blubber is in Windows Early Access. The installer
#    isn't code-signed yet, so Windows SmartScreen will warn you — click More info -> Run
#    anyway. Verify your download: SHA-256 checksum on the release page."
#
# DEFERRED POST-LAUNCH (on record, not forgotten): Authenticode signing, auto-updater,
#   waitlist outbox retry, GitHub Actions release gate, CSP hardening, onboarding
#   custom-folder flow ignoring chosen folder (audit high-priority, non-blocker).
#
# GOTCHAS FOR NEXT SESSION:
# - To rebuild a release: powershell -ExecutionPolicy Bypass -File scripts\release.ps1
#   (handles ABI both directions itself; never hand-run next build after rebuild:electron)
# - Dev work after a release build: npm run rebuild:system-node first or every route 500s
# - Untracked on purpose (public repo — do NOT commit): data/, docs/screenshots/,
#   BLUBBER-LAUNCH-READINESS-AUDIT-AND-PLAN.md
# - Clean-env harness pins PORT=3000 (packaged app otherwise picks a random free port)
## ===== END HISTORICAL PRE-LAUNCH FREEZE =====

## Current state (branch fix/launch-blockers-v0.1.1, commits 941fe14 + b3bb5dc, NOT yet pushed/merged)
All 5 launch blockers from BLUBBER-LAUNCH-READINESS-AUDIT-AND-PLAN.md fixed and verified:
1. Paths: client uses tilde tokens (src/lib/dev-root.ts = "~/Development"), server expands at
   spawn (src/server/resolve-path.ts). next.config.js env block DELETED — nothing personal bakes
   into bundles. Quick Chat model unpinned (CLI default), cwd falls back to existing ancestor.
2. Auth: server.js globally requires x-blubber-token header on every non-GET /api/* (same secret
   as WS token, shared via process.env.BLUBBER_AUTH_TOKEN) + Host/Origin validation on ALL
   requests and the WS upgrade. Client: src/lib/api-auth.ts patches window.fetch once (installed
   from page.tsx + SessionProvider module scope). e2e mutations go through authedPost (helpers.ts).
3. Data: src/server/app-dirs.ts is the single source for DATA_DIR/MUSIC_DIR. Packaged runs get
   BLUBBER_DATA_DIR=<userData>\blubber-data and BLUBBER_MUSIC_DIR=<Music>\Blubber from
   electron/main.js (resolveMusicDir has fallback chain — app.getPath('music') THROWS on
   profiles without a Music known-folder; that killed startup silently in clean-env test).
   Idempotent verified migration: src/server/data-migrate.ts, marker .blubber-migration.json.
4. Kit install (src/app/api/kit/install/route.ts): validate-all-before-write, path containment,
   conflict scan across CLAUDE.md/agents/skills/commands, backup to
   ~/.claude/.blubber-kit-backup-<ts> BEFORE first write, abort if backup fails, auto-restore on
   any later failure. Response reports conflicts + backupDir. Two-tier funnel untouched.
5. Startup: single-instance lock, dynamic free port when packaged (PORT env overrides — the
   clean-env harness pins PORT=3000), nonce identity handshake: window opens only when
   /__blubber-health returns {app:'blubber', nonce}. Startup throws now show an error dialog.

Release pipeline: scripts/release.ps1 (fail-closed, 7 steps: typecheck → system-ABI rebuild +
fresh build → scrub build-machine paths from .next-build (Next embeds resolvedPagePath in ~96
files) → Electron-ABI rebuild → native load test → package → hygiene scan (forbidden files +
jeffh grep) → checksum). electron-builder.yml now excludes .next-build/cache (~280MB),
.next-build/types, .env.local, tools/; publisher metadata = Dame Boll; version 0.1.1.

VERIFIED: tsc clean; e2e 20/20; clean-env harness ALL PASS against the packaged build
(8.3s cold boot, APIs 200, DBs written to userData\blubber-data, kit marker absent = free flow).
Installer: dist-electron\Blubber Setup 0.1.1.exe, 187.6MB,
SHA256=A7CB1792BD7D6C1ACBFFCA5D2AADE26A03DE3D7B0D56979D131E60CC9021BA0B

REMAINING (Dame's lane, blocks paid launch): correct Shopify admin + attach kit ZIP + one real
purchase/download/refund test; publish theme cosmetics (download button waits for v0.1.1 asset
live on GitHub); README screenshots + dead links; then push branch, PR, squash-merge, tag v0.1.1
from that exact commit, upload installer + SHA256SUMS.txt to the release. Ship label: Windows
Early Access (unsigned; SmartScreen instructions on download page). Deferred post-launch:
Authenticode signing, auto-updater, waitlist outbox retry, GitHub Actions release gate, CSP.

## Previous state (branch chore/smoke-test-harness, merged as da02dba)
Launch-shaped. E2E 20/20 green (was 17, +3 across two sessions). Installer rebuilt 2026-07-25
at 222.9MB with all of this session's fixes packaged and verified present inside the .exe.
Freeze tags: freeze-pre-launch-split, freeze-pre-polish-batch, freeze-pre-voice-settings.

## First-run path — rebuilt this session (2026-07-25)
The whole "buyer opens the app on a machine that isn't Dame's" path was broken in four
separate places. All four were found by actually simulating a clean machine, not by reading code.

- **npm→native installer.** /api/onboarding/install-claude ran `npm install -g
  @anthropic-ai/claude-code`, justified in its own comment by "node + npm are already present on
  any machine that can run this app". FALSE since the app went self-contained — the packaged
  build ships its own runtime, proven by launching it with node AND npm absent from PATH. So on
  exactly the clean machine that route exists for, it failed at step one. Now runs Anthropic's
  official native installer (irm .../install.ps1 | iex on Windows, curl|bash elsewhere), which
  has no Node dependency at all. Commands are passed whole in `cmd` with empty `args` because
  stream-command spawns with shell:true — splitting a `|` across argv breaks it.
- **detect was blind to a fresh install.** It only checked ~/.claude, which Claude Code creates
  on first RUN, not at install. The native installer writes ~/.local/bin/claude +
  ~/.local/share/claude. So a SUCCESSFUL install still reported 'not-found' and dumped the user
  back on the same screen. Now hasInstalledBinary() probes those paths and
  installed-but-never-run reads as 'empty'.
- **Nothing called the install route.** It was written as Starter-Kit-gated and wired to no UI,
  so kit buyers got the identical link-and-good-luck screen as free users. Now wired into the
  notfound branch for everyone, streaming the installer's real stdout/stderr into the card,
  cancellable, errors verbatim with a retry.
- **First index froze the app on "Injecting…"** — see next section.

## Indexer event-loop fix (2026-07-25, HEAD 9aa2c67)
Dame clicked "Inject my setup" on his own machine and the overlay hung forever. Not a hang —
a blocked event loop. ensureIndexed() wrapped the walk in setImmediate and its doc claimed it
"runs off the request path"; setImmediate only DEFERS a sync block, it does not break it up.
runIndexer is sync fs + sync JSON.parse + sync SQLite start to finish, so it pinned the single
Node thread for the entire walk and the server answered NOTHING. The overlay POSTs inject then
fetches /api/system before advancing — that second request couldn't be served.
Dame's history: 2284 transcripts / 2.17 GB.
- runIndexerYielding() drains the walk with yields; ensureIndexed calls it. All 8 callers are
  fire-and-forget so nothing else changed.
- indexFile() takes a byte cap + returns hadMoreBytes, so one huge transcript is consumed in
  bounded slices. Per-file yielding alone was NOT enough — a measured cold index still stalled
  one request 14.8s inside a lone 155MB file. Safe because the offset only ever advances to the
  end of the last FULL line, exactly what resuming a partial read needs; a line longer than the
  cap falls back to an uncapped read rather than spinning forever.
- Measured on the real 2.17GB, cold DB, production build, polling /api/system throughout:
  per-file yield = max 14.80s / median 0.13s; with slicing = **max 0.49s / median 0.14s**,
  0 failures both runs. Resulting usage.db 27.0MB in BOTH runs — same data, so slicing neither
  drops nor double-counts.

## Clean-machine testing (2026-07-25)
- **Windows Sandbox still UNPROVEN.** Three boots, zero bytes ever reached the host. Found and
  fixed one real bug: the writable results folder was tools/smoke-test/results, a CHILD of
  tools/smoke-test which is mapped ReadOnly — nested mappings do NOT override, the read-only
  parent wins and every write inside failed silently. Moved to tools/smoke-results (sibling) and
  added a boot marker so a future failure distinguishes "LogonCommand never fired" from "the
  probe ran and found problems". Still never reported after the fix. The host cannot execute
  inside a sandbox, so diagnosing further needs someone to LOOK at that desktop.
- **tools/smoke-test/cleanenv-run.ps1 is what actually worked.** Host-side: strips
  node/npm/claude/git from PATH, points USERPROFILE at an empty dir, silent-installs the real
  .exe to a temp dir, cold-launches, polls for HTTP 200, hits the core APIs, asserts the detect
  branch, dumps what landed in the fresh profile. 17/17 PASS on the shipped build; cold launch
  to 200 in 9.1s. Does NOT cover: SmartScreen, installer UX, shortcut icon, GPU/3D, uninstall.
- Verified on a virgin profile: detect → 'not-found', kit → false. That kit:false is the
  receipt for why the installer can't be kit-gated (below).

## Product architecture (LOCKED philosophy)
- ONE codebase, two tiers. Kit marker file (~/.claude/.blubber-kit.json) = the paywall switch.
- FREE/community = RAW SHELL: one onboarding card ("Scan my workspace"), one tip (drag ~/.claude or scan default). No demo mode (deleted), no tour, no installers, no guides. Placeholder stats (demo-dataset.ts) are the DEFAULT until workspace connects (connected-store, set by inject).
- STARTER KIT = detection finds marker → "Starter Kit detected" beat → guided tour (chat-bubble walkthrough, veil blur 0.68, 3D hidden during) → soul interview offer (8 questions, all skippable, writes ~/.claude/blubber-profile.md). Kit install copies CLAUDE.md/agents/skills/commands + writes marker. Recommended-plugins panel kit-gated in Settings.
- TRUE FRESH START: first connect moves stats baseline to NOW; history never counts; re-injects never re-zero.

## Key systems
- Static mascot everywhere pre-app: public/blubber-hero.png. 3D only inside app.
- Startup video: public/bg/startup-loop.mp4 (2.8MB compressed) behind onboarding; reactor.webp reduced-motion fallback.
- Voice: blubber-speak WebAudio synth (src/lib/blubber-voice.ts + voice-store + /api/voice). SHIPS MUTED by default. Speaks tour/interview/onboarding bubbles; celebration riff on quest claim/pet feed.
- Quests: 34 quests / 15 chains, all real SQLite metrics, baseline-relative (quest-store.ts).
- Music: Apple-Music Library (playlist CRUD, sortable table, hand-rolled ID3 cover extraction, uploads, /api/cover/[id]). Blurred studio.webp behind Library. Now Playing scroll fixed.
- Settings: all tabs real or cut (AI&Model cut). prefs-store /api/prefs, /api/meta. Accent color re-themes live.
- Project icons: deterministic keyword mapping (src/lib/project-icon.ts), replaced random folder-image thumbs.
- Academy: full-bleed key art (bg/academy-hero.png) + coming-soon waitlist strip.
- Electron: setWindowOpenHandler → external browser; before-quit taskkill /T (orphan-server fix); NEXT_DIST_DIR=.next-build packaged; electron-builder files excludes + npmRebuild:false. Installer built once OK.

## Optimization pass (2026-07-22, HEAD 859cc18)
Verified against a PRODUCTION build + real prod server, not dev (dev doesn't code-split; its
"stuck screen boot" is on-demand compilation, a dev-only artifact — ignore it).
- FONTS SELF-HOSTED: Syncopate/DM Sans/DM Mono now in public/fonts (18 woff2, 584KB) +
  src/app/fonts.css; globals.css @imports it locally. Was a remote fonts.googleapis @import —
  killed the cold-launch CDN round-trip + makes brand fonts render fully OFFLINE. Verified:
  document.fonts loads every weight, ZERO googleapis/gstatic requests at runtime.
- SCREEN CODE-SPLIT: 8 non-default screens + 3 first-run overlays are next/dynamic now
  (Dashboard stays static for first paint). Main route 146kB→70.5kB, First Load 406kB→331kB.
  All 8 verified mounting in prod. NOTE: AgentsScreen root class is `acc-workflow`, NOT
  `agents-screen` (bit a smoke probe).
- DEAD GL DELETED: Core3D.tsx + BackgroundField.tsx gone (each did `new WebGLRenderer` —
  landmine vs the one-shared-context rule in flubber3d/host.ts). e2e "one WebGL context" test
  still green. Inlined the one legacy type they fed FlubberCharacter (onBootEvent).
- academy-hero.png 2.0MB → .webp 148KB + explicit width/height.
- /api/system was double-polled (SessionProvider app-wide + DashboardScreen's own
  useSystemVitals). Dropped the local poll; Dashboard derives vitals from session.vitals.

## Activity-feed clear bug + Agents perf (2026-07-22)
- BUG FIXED (HEAD 8631dd4): the Activity Feed "Clear" button did nothing on a not-connected
  machine — i.e. the DEFAULT state for every new user. Clear writes a `recent_cleared_at`
  baseline, but GET /api/recent's not-connected branch returned the placeholder demo feed and
  never applied it; demo events are timestamped `now - minutesAgo` per request, so a timestamp
  filter could never hold them cleared. Fix: not-connected AND cleared → return []. Real feed
  (genuine baseline) takes over on connect. A fresh machine that never cleared still shows the
  demo feed.
- AGENTS SCREEN PERF: measured, HEALTHY — no problem. "suspect the check first" case:
  headless probe said 1fps (software-GL garbage, thrown out); headed-GPU avg 28fps (skewed by
  a one-time ~1.7s mount spike); CONTROLLED MEDIAN = 16.7ms/frame ≈ 60fps, identical to every
  other screen. One shared WebGL context (invariant holds), no steady-state JS jank. Only costs:
  the one mount spike (dynamic chunk + 3D warmup) and 3 poll loops (agents-live 2.5s heaviest —
  could back off when idle, not needed). Perf-measure how-to: headed chromium with
  --use-gl=angle, compare MEDIAN frame ms across screens (avg is noise), never trust headless fps
  for this 3D app.

## Polish pass — music/tour/projects/settings (2026-07-22, verified 15/15 headed-GPU)
- MUSIC LIBRARY backdrop now shows: `.mps-library` was missing `z-index`/`isolation` so the
  blurred studio.webp `::before` escaped its stacking context (the app's own `.mps-rail .panel`
  comment says this is mandatory). Added stacking context + made `.mps-library-rail` translucent
  so the room reads through.
- TOUR readable: veil was near-black `oklch(6%/0.68)` + 10px blur → dropped to `oklch(8%/0.40)`
  + 4px. App behind is dim-but-legible, spotlight ring + guide Flubber pop. (The app's 3D was
  already hidden via `body.tour-active [data-flubber-3d]`; that was never the darkness.)
- PROJECT ICONS: Dashboard mini (MiniProjects) still used the old random folder-image ProjectThumb
  → now uses the same deterministic `getProjectIcon()` type-icon the Projects screen grid uses.
  Deleted ProjectThumb (only renderer was the mini). Projects placeholders = the not-connected
  demo path (working as designed); real folders show when workspace_connected is set.
- SETTINGS TRUTH PASS (big): every visible control is now real. Removed Agents tab (no config
  layer) + Notifications tab (folded Blubber Tips into General). Cut all dead controls (Language,
  Startup/Auto-Launch/Tray, entire Token&Usage + System Integration panels, Sarcasm, Emote,
  Music Reactivity, Quest/Milestone notifs, Export/Clear Cache, Local Data Only). Final tabs:
  General/Appearance/Blubber/Shortcuts/Advanced. Voice moved under Blubber (with the mascot).
- NEW WIRING (a real settings knob = a consumer): app-wide PREFS APPLIER in AppShell applies from
  /api/prefs on load AND a unified `'blubber:prefs'` CustomEvent on change (fixed latent bug:
  accent/glow only applied while Settings was open). It drives: accent (--core-accent), glow
  (--blubber-glow multiplier on --glow-shadow in globals.css), animation speed
  (gsap.globalTimeline.timeScale + data-motion-speed), time format (src/lib/time-format.ts →
  live clock + terminal label), sound effects (blubber-voice setSoundEffectsEnabled gates the
  celebration riff). prefs-store UiPrefs trimmed to real fields + timeFormat('12h'/'24h').
  VERIFIED live: applier applies all app-wide, prefs round-trip persists timeFormat + drops dead
  fields, music backdrop renders, tour veil lightened, no old thumbnails.

## Favicon + glossy floating mascot (2026-07-22, verified headed-GPU)
- FAVICON: src/app/icon.png = the site's dripping slime "BL" (was a brighter balloon-BL). Next
  auto-serves it.
- FloatingBlubber (src/components/FloatingBlubber.tsx/.css): glossy transparent Blubber
  (public/blubber-glossy.png, bubbles+pool baked) animated by CSS transform/opacity only — bob +
  tilt + squash-stretch (transform-origin 50% 90%) + a breathing green glow puddle,
  prefers-reduced-motion guarded. Used STRICTLY in onboarding + tour (as <FloatingBlubber>) and the
  intro cinematic (asset swap + crop fix, keeps GSAP entrance).
- HARD RULE (Dame, emphatic): NEVER touch the in-app 3D Flubber (FlubberHome/Flubber3D/flubber3d
  host/dais/AgentPoolWorld/avatars/Virtual Pet) without explicit ask — it's hard-won. The glossy
  static mascot is ONLY for the pre-app/overlay spots where the 3D is absent. See memory
  dame-protective-of-3d-flubber. Soul-interview badge left on blubber-hero.png (not in scope).

## Launch decisions (locked)
- Free shell stays SILENT about the Starter Kit — no in-app upsell, ever. The landing page
  (blubber-site) is the funnel; all downloads route through it, so the kit pitch already
  happened before the app is ever opened. (Dame, 2026-07-22)
- **The in-app Claude Code installer is NOT kit-gated, and cannot be.** The kit marker lives at
  ~/.claude/.blubber-kit.json — INSIDE the directory whose absence defines the notfound branch.
  So `kit` is always false there and a gated button could never render on the one screen it
  exists for. This is a structural fact, not a pricing preference: gating it would hide it from
  exactly the people who paid. (2026-07-25)

## Known open items (pre-launch)
1. ~~E2E suite~~ DONE 2026-07-22: 17/17 green. Fixes were all spec-side: 05 clicks Advanced tab
   (Replay Setup moved there), 01+07 arm waitForResponse on the intro's fire-and-forget
   POST /api/intro before asserting persistence (was a race, 3 spots).
2. ~~Blubber Tips toggle~~ DONE 2026-07-22: AppShell seeds from /api/prefs + listens for
   'blubber:tips-pref' CustomEvent; SettingsScreen dispatches on toggle (prefsSync-guarded).
3. Drag-drop workspace folder = just triggers default scan (real path resolution needs Electron
   preload webUtils). DELIBERATELY DEFERRED — default-scan fallback is sane for launch.
4. ~~First-connect zero-out~~ VERIFIED end-to-end 2026-07-22 on a truly fresh data/ dir:
   pre-connect serves placeholder → inject sets baseline to NOW → 109,302 real historical
   events indexed, ALL excluded (0 post-baseline) → API serves real zeros → second inject
   does NOT move baseline. Ground-truthed via direct usage.db queries (table is `events`,
   not usage_events). Real data/ restored after.
5. Voice unheard-tested beyond Dame ("robot noises" — hence muted default).
7. **UNSIGNED .exe** — SmartScreen "unrecognized app" warning on every buyer's first install.
   Needs an Authenticode cert (OV ~$200/yr, or EV for instant reputation) wired via
   win.certificateFile + CSC_KEY_PASSWORD, or Azure Trusted Signing. Still the biggest open
   launch gate.
8. **Windows Sandbox harness never reported** (2026-07-25). Mapping bug fixed, still silent.
   Everything it uniquely covers (SmartScreen wording, installer UI branding, shortcut icon,
   3D on a non-dev GPU, uninstall) remains UNVERIFIED on a clean machine.
9. **"Install it for me" never clicked by a human.** The route, the stream, the detect flip and
   the UI are all proven, but the actual native installer was deliberately NOT executed — it
   would stomp Dame's working Claude Code setup. Needs one click in the temp/clean profile.
6. ~~Landing page URL for Academy~~ RESOLVED 2026-07-22 (Dame's call): no Academy exists yet,
   so there is no external link at all — the locked screen with the email waitlist IS the
   launch state. Verified: no dead/clickable-to-nowhere button anywhere in src.

## Gotchas
- **NATIVE MODULE ABI IS A TOGGLE, NOT A STATE.** better-sqlite3 can only be built for ONE
  runtime at a time. `npm run build` / `node server.js` / playwright need SYSTEM node
  (`npm run rebuild:system-node`); `npm run electron:build` and the packaged app need ELECTRON
  (`npm run rebuild:electron`). Wrong one = `NODE_MODULE_VERSION 148 vs 137` and every API route
  500s while the server still prints "Blubber ready" — so it LOOKS up and isn't. Cost real time
  this session twice. Always rebuild:electron as the LAST step before packaging.
- A readiness probe that hits an API route can't distinguish "server down" from "server up but
  every route 500s". Probe, then read the actual status code before concluding anything.
- Pre-write slop hook blocks CSS animating layout props — transform/opacity/filter only.
- Dame's machine has reduce-effects ON → intro skips instantly, onboarding video gated on OS pref only.
- First-run replay: delete app_meta keys onboarding_seen_v1/intro_seen_v1 (+workspace_connected_v1) in data/usage.db.
- Port 3000 orphans: fixed in main.js, but if launching via background tasks, check/kill listener first.
- Demo kit marker currently ON Dame's machine (~/.claude/.blubber-kit.json) — remove to see free flow.
