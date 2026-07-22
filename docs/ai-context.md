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
