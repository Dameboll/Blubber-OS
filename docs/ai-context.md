# Blubber OS — AI Context
# Last sync: 2026-07-22 ~13:00 ET (session: e2e green + tips wire-up + fresh-start verify)

## Current state (branch fix/e2e-suite-green, all committed)
Launch-shaped. HEAD e5ce295 — E2E SUITE GREEN 17/17 (full clean pass, prod build passes). Freeze tags: freeze-pre-launch-split, freeze-pre-polish-batch, freeze-pre-voice-settings (rollback points).

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
6. ~~Landing page URL for Academy~~ RESOLVED 2026-07-22 (Dame's call): no Academy exists yet,
   so there is no external link at all — the locked screen with the email waitlist IS the
   launch state. Verified: no dead/clickable-to-nowhere button anywhere in src.

## Gotchas
- Pre-write slop hook blocks CSS animating layout props — transform/opacity/filter only.
- Dame's machine has reduce-effects ON → intro skips instantly, onboarding video gated on OS pref only.
- First-run replay: delete app_meta keys onboarding_seen_v1/intro_seen_v1 (+workspace_connected_v1) in data/usage.db.
- Port 3000 orphans: fixed in main.js, but if launching via background tasks, check/kill listener first.
- Demo kit marker currently ON Dame's machine (~/.claude/.blubber-kit.json) — remove to see free flow.
