# Next Session Brief
Written: 2026-07-25 ~03:00 ET
For: next blubber-os session

---

## PICK UP HERE

### blubber-os — close the last unproven link in the first-run path
**Status:** Branch `chore/smoke-test-harness`, HEAD 9aa2c67, pushed, 4 commits, no PR. E2E 20/20.
Installer rebuilt 2026-07-25 at 222.9MB with all fixes packaged and confirmed inside the .exe.

**First action:** Launch the clean-profile copy and click "Install it for me" on the onboarding
screen. Everything about that flow is proven EXCEPT the installer actually completing, which was
deliberately never executed (it would have stomped Dame's real Claude Code setup).

```powershell
# clean profile, no ~/.claude, no node/npm on PATH — safe to actually install into
& "C:\Users\jeffh\Development\HOBBY\blubber-os\tools\smoke-test\cleanenv-run.ps1"
```
Then in the app window: "Install it for me". Watch the streamed output. On success it must land
on "Clean slate" — NOT back on the not-found screen.

**Context:** If it lands back on not-found, the installer wrote somewhere `hasInstalledBinary()`
doesn't probe (`src/app/api/onboarding/detect/route.ts` — currently `~/.local/bin/claude[.exe]`
and `~/.local/share/claude`). Check where the binary actually landed and widen the probe.

**Blocking issue:** None.

### Then: the actual launch gate
**Unsigned .exe.** Every buyer gets a SmartScreen "unrecognized app" warning on first install.
Needs an Authenticode cert (OV ~$200/yr, EV for instant reputation) wired via
`win.certificateFile` + `CSC_KEY_PASSWORD` in electron-builder.yml, or Azure Trusted Signing.
This is a purchase decision, not a code task.

---

## DECISIONS TO MAKE
1. **Buy a code-signing cert before launch, or ship unsigned and eat the SmartScreen warning?** OV ~$200/yr is the cheap path; EV costs more but skips the reputation-building period.
2. **Keep chasing Windows Sandbox, or call the host-side harness good enough?** The sandbox uniquely covers SmartScreen wording, installer branding, shortcut icon, 3D on a non-dev GPU, and uninstall. Diagnosing it needs someone to look at that desktop once and say whether a PowerShell window is even open.
3. **Open a PR for `chore/smoke-test-harness` or merge straight to main?**

## DON'T FORGET
- **NATIVE MODULE ABI IS A TOGGLE.** `rebuild:system-node` for build/tests/server, `rebuild:electron` for packaging. Wrong one and every API route 500s WHILE the server still prints "Blubber ready" — it looks up and isn't. Bit twice this session. Always `rebuild:electron` last before packaging. Currently on ELECTRON ABI (packaging-ready).
- The installer flow is deliberately NOT kit-gated and must stay that way — the kit marker lives inside `~/.claude`, so gating hides it from exactly the people who paid.
- Temp clean-env install still on disk. Cleanup when done:
  `Remove-Item C:\Users\jeffh\AppData\Local\Temp\claude\blubber-cleanenv -Recurse -Force`
- The sandbox results folder must stay OUTSIDE `tools/smoke-test/` — it's mapped ReadOnly, and nested mappings don't override.
- Slop hook blocks CSS layout-prop animation — transform/opacity/filter only.
- Never touch the in-app 3D Flubber without an explicit ask.

## FULL CONTEXT
- `docs/ai-context.md` — master context (architecture, systems, gotchas)
- `docs/sessions/2026-07-25-session.md` — this session's full summary
- `docs/decisions/blubber-os-decisions.md` — why the installer isn't kit-gated, why native over npm
- `tools/smoke-test/cleanenv-run.ps1` — the clean-machine harness that actually works
- `tools/smoke-test/CHECKLIST.md` — the eyes-only checks the scripts can't cover
