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
