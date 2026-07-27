# Fresh-Environment Smoke Test — Manual Checklist

Scripts cover what a script can prove. This covers what only eyes can.
Work top to bottom inside the sandbox. Mark FAIL the moment something looks
wrong — do not "well, it kind of worked".

## 0. Launch
```
C:\Users\jeffh\Development\HOBBY\blubber-os\tools\smoke-test\blubber-smoke.wsb
```
Double-click it on the host. Sandbox boots, phase-1 probe runs automatically.
Confirm every phase-1 line reads `[CLEAN]` before installing anything.

## 1. Install
- [ ] SmartScreen warning appears (expected — .exe is unsigned). Note the exact wording.
- [ ] "More info" → "Run anyway" proceeds
- [ ] Installer UI shows **Blubber**, not "blubber-os" or "Electron"
- [ ] Install-directory choice works
- [ ] Desktop shortcut created, correct icon (not the default Electron atom)
      NOTE: check `[Environment]::GetFolderPath('Desktop')`, NOT `$env:USERPROFILE\Desktop`.
      With OneDrive folder redirection (on by default on many Windows 11 boxes) the real
      Desktop is `%USERPROFILE%\OneDrive\Desktop`, and checking the raw path reports a
      missing shortcut that is actually there.
- [ ] Install completes without an error dialog

## 2. Cold first launch — the real test
- [ ] App window opens (no white screen, no "server failed to start")
- [ ] Time from double-click to visible UI: ______ seconds
- [ ] Intro cinematic plays (sandbox has no reduce-effects override, so unlike Dame's box it should NOT skip)
- [ ] Onboarding appears — **free shell**, no tour, no soul interview, no plugins
- [ ] Mascot renders (glossy 2D in onboarding)
- [ ] No devtools console errors visible if opened

## 3. Free-flow walk
- [ ] "Scan my workspace" button present and clickable
- [ ] Folder picker opens a real native Windows dialog
- [ ] Pick any folder (e.g. Desktop) — app accepts it without crashing
- [ ] Stats show placeholders/zeros pre-connect, not fake numbers
- [ ] Academy screen = locked + waitlist form, no dead link
- [ ] Settings opens; tabs are General/Appearance/Blubber/Shortcuts/Advanced
- [ ] Toggle accent colour — applies immediately app-wide
- [ ] Voice is MUTED by default

## 4. 3D Flubber (GPU reality check)
Sandbox vGPU is enabled, but it may still fall back to software rendering.
- [ ] 3D Flubber renders at all
- [ ] Frame rate subjectively OK / choppy / unusable  (circle one)

**If 3D is broken here, do NOT immediately treat it as a product bug.** Re-test
on a real second machine before touching the 3D code — see the hard rule about
never modifying Flubber without an explicit ask.

## 5. Restart persistence
- [ ] Close the app fully, relaunch
- [ ] Onboarding does NOT replay (state persisted)
- [ ] Previously chosen workspace still connected

## 6. Uninstall
- [ ] Uninstall from Settings → Apps works
- [ ] Install dir removed

## 7. Verify script
```
.\Desktop\smoke\verify-install.ps1
```
Run BEFORE uninstalling. Then copy the log to the host clipboard:
```
Get-Content $env:USERPROFILE\Desktop\smoke-log.txt | Set-Clipboard
```

---

## Recording results
Paste the log + your circled answers back into the session. Anything marked
FAIL becomes a launch gate. Sandbox is disposable — close it and everything
is gone, so capture the log before you close the window.

---

## v0.1.3 automated lifecycle rehearsal — 2026-07-26

Run against the **published** `Blubber.Setup.0.1.3.exe` downloaded from the GitHub
release (199,230,751 bytes, SHA256 verified against the published digest), on the
host with no prior Blubber install. Every gate passed:

- Silent install (`/S`) exit 0 → correct default dir `%LOCALAPPDATA%\Programs\Blubber`,
  ProductVersion 0.1.3.0, 724.5 MB, asar off, `.next-build` present, both native
  modules present, `app-update.yml` baked in.
- Desktop + Start Menu shortcuts created, both targeting the installed exe.
- Launch from the installed location: server ready in 12.1s, `/`, `/api/pet`,
  `/api/quests`, `/api/top-agents`, `/api/recent`, `/api/prefs` all 200.
- Auto-updater in the real install read the live GitHub feed and reported
  "latest version: 0.1.3 … already on the newest version".
- Scrubbed-PATH virgin profile (no node/npm/claude/git, no `~/.claude`): cold launch
  4.1s, APIs 200, free-user path `detect: not-found` / `kit: false`, kit marker absent.
- Uninstall exit 0 → install dir, both shortcuts, and the registry entry all gone;
  user data correctly preserved.

**Still eyes-only, NOT covered by that run** — these need a human in the sandbox:
SmartScreen wording, installer UI branding, the intro cinematic, onboarding visuals,
the native folder picker, 3D Flubber rendering and frame rate, accent-colour toggle,
voice muted by default, and restart persistence.

Gotcha found during the run: a stale uninstall registry entry from an earlier smoke
test made NSIS install into the old remembered path (a temp dir) instead of the
default. That is test residue, not a product defect — a real upgrade reuses the real
prior install dir, which is correct. But it means **a rehearsal must start from a
machine with no Blubber registry entry**, or it silently measures the wrong thing.
