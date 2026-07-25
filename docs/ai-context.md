# Blubber OS — AI Context
# Last sync: 2026-07-25 ~03:00 ET (session: clean-machine smoke test → 4 real first-run bugs fixed)

## Current state (branch chore/smoke-test-harness, pushed, HEAD 9aa2c67)
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
