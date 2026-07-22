# Next Session Brief
Written: 2026-07-22 ~05:10 ET
For: next blubber-os session

---

## PICK UP HERE

### blubber-os — the launch gate
**Status:** Launch-shaped, all committed (HEAD d93fbc4, branch fix/e2e-suite-green). E2e suite NOT re-run since the launch-split rewrote onboarding flow.
**First action:** Run `npx playwright test` (dev server must be up on port 3000 first — check for orphan listeners: `netstat -ano | findstr :3000`). Specs 02/03/06 were updated for the new copy ("Scan my workspace", academy coming-soon); 04-demo-mode.spec.ts was deleted. Expect possible failures around onboarding steps — flow changed from demo-mode to raw-shell.
**Context:** Kit marker on Dame's machine (`~/.claude/.blubber-kit.json`) will make detection return kit:true — some specs may need it removed or mocked for the free-flow assertions.
**Blocking issue:** None — this IS the launch blocker.

### Quick follow-up (after suite green)
Wire Blubber Tips toggle: prefs persist but AppShell tip card doesn't read the flag yet. ~5 min.

---

## DECISIONS TO MAKE
1. Academy button destination — landing page URL (Dame supplies) vs keep waitlist form.
2. Voice style default — Dame to ear-test 4 styles (bubbly/deep/squeaky/robo), currently bubbly + muted.

## DON'T FORGET
- Drag-drop workspace = default-scan only; real path needs Electron preload webUtils (post-launch OK).
- First-connect zero-out never verified on truly fresh data/ dir.
- Freeze tags exist for rollback: freeze-pre-launch-split, freeze-pre-polish-batch, freeze-pre-voice-settings.
- Slop hook blocks CSS layout-prop animation — transform/opacity/filter only.
- Dame's machine: reduce-effects ON (intro skips instantly).

## FULL CONTEXT
- `docs/ai-context.md` — master context (architecture, systems, gotchas)
- `docs/sessions/2026-07-22-session.md` — this session's full summary
