# Next Session Brief
Written: 2026-07-26 ~13:00 ET
For: next Blubber OS / Claude session

---

## PICK UP HERE

### Launch state

**Blubber OS v0.1.2 Windows Early Access is live and verified. There is no remaining launch blocker.**

- App repo `main` includes the post-release context sync; release source/tag:
  `6cec28e` / `v0.1.2`.
- Release: https://github.com/Dameboll/Blubber-OS/releases/tag/v0.1.2
- Installer: `Blubber.Setup.0.1.2.exe`, 198,701,230 bytes.
- SHA256: `74430319B7A134BE576C7A90FD0C461D613C4F7147B1A30B584C354A1A5FD49D`.
- The public asset was downloaded and hash-matched after publication.
- The nine-stage release pipeline, host clean profile, and separate Windows Sandbox
  install/launch/shortcut/free-user/uninstall rehearsal all passed.
- Shopify live theme: Blubber OS `#188479111535` at https://flubberos.myshopify.com
- Both the homepage hero and Community Edition pricing card now offer:
  1. `Download for Windows — Free` directly to the v0.1.2 installer.
  2. `View on GitHub` separately to the public repo.
- Current storefront source: `blubber-site` `main` at `46de809`, pushed 2026-07-26 to the
  private repo https://github.com/Dameboll/blubber-site. No longer local-only.
- Desktop plus 390x844 and 320x700 checks passed with correct links, no console errors,
  and no horizontal overflow.
- Paid Starter Kit delivery was previously rehearsed successfully through Shopify
  Digital Products. The app/repo/installer remain free; the Kit is optional.

### First action next time

Read the current block at the top of `docs/ai-context.md` and confirm the exact requested
scope. Do **not** reopen the historical v0.1.0/v0.1.1 launch plan or rebuild/re-release v0.1.2
unless Dame explicitly asks for a new app change.

## BRAND SPLIT — DO NOT REGRESS

- Transparent standalone slime `BL`: Windows installer, installed app, shortcut, in-app
  favicon, website favicon, and tiny OS-mockup icons.
- Full transparent `BLUBBER` wordmark: visible website header, footer, and Organization JSON-LD.
- Do not replace the visible website wordmark with the square BL again.

## ACCEPTED LIMITATION

The Windows installer is unsigned, so SmartScreen may warn. This is disclosed on GitHub,
in the README, and on the storefront. Code signing is a post-launch purchase/engineering task,
not a launch blocker.

## SAFE POST-LAUNCH OPTIONS

Only start one of these when Dame requests it:

1. Authenticode/Azure Trusted Signing.
2. Auto-updater.
3. GitHub Actions release gate.
4. Waitlist outbox retry.
5. CSP hardening.
6. Onboarding custom-folder follow-up.

## DON'T FORGET

- Native-module ABI is a toggle: system Node for server tests, Electron ABI last for packaging.
- `node-pty` is skipped in the installer build intentionally.
- Never touch the in-app 3D Flubber without an explicit request.
- Preserve user/project data and make a preflight backup before any release work.
- Batch release fixes, then run one final expensive package/install verification cycle.

## FULL CONTEXT

- `docs/ai-context.md` — canonical current state plus historical record.
- `docs/CODEX-HANDOFF.md` — compact handoff and launch proof.
- `docs/decisions/blubber-os-decisions.md` — durable product/installer decisions.
- `tools/smoke-test/` — clean-machine verification harness.
