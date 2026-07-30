# Next Session Brief
Written: 2026-07-30 ~13:10 ET
For: next Blubber OS / Claude session

---

## PICK UP HERE

**v0.1.4 is the live GitHub release. Project folders are durable, metadata scans no
longer freeze the app, and the terminal can expand to the full workspace.**

- Tag `v0.1.4` = `f76ba2f`. `Blubber.Setup.0.1.4.exe`, 199,245,146 bytes.
- SHA256 `47E11A5A98B73ECA69666C19707E6D9B7F093CF530A87ABEA0E1A7F6287CC47A`.
- Installer, `latest.yml`, `.blockmap`, and `SHA256SUMS.txt` were downloaded back from
  GitHub and matched the local release byte-for-byte.
- Release: https://github.com/Dameboll/Blubber-OS/releases/tag/v0.1.4
- Playwright 25/25, all 10 release stages, three review gates, and the exact
  install/virgin-profile boot/API/uninstall lifecycle passed.
- The live Shopify storefront was updated to v0.1.4 through blubber-site PR #2 and a
  scoped four-file push to theme `188479111535`. A full 421-file backup was taken;
  post-push still had 421 files with exactly four changed. Rendered production has
  two v0.1.4 installer links, zero v0.1.3 references, and the installer returns 206.

### First action next time

Read the top block of `docs/ai-context.md` and confirm the exact requested scope. Do **not**
re-release v0.1.4, reopen the v0.1.0–v0.1.3 launch plans, or rebuild anything unless Dame
explicitly asks for a new change.

---

## WHAT IS ACTUALLY VERIFIED (and what is not)

Verified end-to-end on 2026-07-30:

- Every asset was downloaded from the public v0.1.4 release and hash-matched. The public
  updater metadata says 0.1.4 and its sha512 matches the downloaded installer.
- The exact installer landed in the default directory, created both shortcuts and the
  uninstall registry entry, then the installed app cold-launched in 4 seconds under a
  scrubbed-PATH virgin profile with all tested APIs returning 200.
- Silent uninstall removed the install directory, shortcuts, and registry entry.
- Playwright 25/25, production build, 10-stage release pipeline, and code/React/security
  review gates all passed.
- **A real 0.1.3 → 0.1.4 auto-update swap** was separately proven before publication:
  750 KB differential download, sha512 verification, NSIS swap, updated APIs 200, and
  clean uninstall. The public release now carries those exact required metadata surfaces.

**NOT verified — do not claim these:**

1. **The paid path has never taken a real card.** Order #1001 was a 100% discount and the
   live checkout only reached the payment page. Delivery is proven; capture is not.
2. Eyes-only sandbox items — SmartScreen wording, installer UI branding, intro cinematic,
   onboarding visuals, native folder picker, 3D Flubber rendering and frame rate, accent
   toggle, voice-muted default, restart persistence. Listed in `tools/smoke-test/CHECKLIST.md`.

---

## RELEASE RULES — READ BEFORE ANY NEW VERSION

Every release from v0.1.3 on **MUST** upload `latest.yml` and the `.blockmap` alongside the
`.exe`. Without `latest.yml`, every installed copy silently finds no update forever and the
release looks perfect from the build machine. `release.ps1` stage 10 catches metadata problems
locally but cannot check what you actually uploaded. Full procedure: `docs/RELEASING.md`.

The `.blockmap` is worth uploading: with it, the 0.1.3 → 0.1.4 update was 750 KB instead of
190 MB. Without it, updates still work but download in full.

Draft and prerelease releases are invisible to the updater by design.

**Install timing trap:** silent install-on-quit takes ~45s and `Blubber.exe` reports the new
version *before* `node_modules` finishes writing. Launching in that window fails with a
missing-module error and the registry entry looks absent. Both resolve on their own. Do not
mistake it for a broken update.

---

## STOREFRONT RULES

Always push **scoped**: `shopify theme push --store ... --theme 188479111535 --allow-live
--force --only <file>`. 75 files differ between local and live purely because Shopify
normalizes locale and template JSON on upload; a blanket push overwrites all of them.

Back the whole theme up with `shopify theme pull` first, re-pull afterwards, and confirm the
file count is unchanged and only your files moved. Then check the **rendered page** — correct
theme files do not prove correct output.

Liquid sections carry `default:` fallback URLs AND `templates/index.json` carries the live
setting. Update both or the live value silently wins.

---

## BRAND SPLIT — DO NOT REGRESS

- Transparent standalone slime `BL`: Windows installer, installed app, shortcut, in-app
  favicon, website favicon, and tiny OS-mockup icons.
- Full transparent `BLUBBER` wordmark: visible website header, footer, and Organization JSON-LD.
- Do not replace the visible website wordmark with the square BL again.

## ACCEPTED LIMITATION

The Windows installer is unsigned, so SmartScreen may warn. Disclosed on GitHub, in the README,
and on the storefront. Signing is a purchase, not a launch blocker — and it is **not** required
for auto-update to work.

## SAFE POST-LAUNCH OPTIONS

Only start one of these when Dame requests it:

1. A real $39.99 purchase on Dame's own card, refunded after — closes the last unproven link
   in the money path.
2. Authenticode / Azure Trusted Signing.
3. Eyes-only sandbox pass against `tools/smoke-test/CHECKLIST.md`.
4. GitHub Actions release gate.
5. Waitlist outbox retry.
6. CSP hardening.
7. Onboarding custom-folder follow-up.

## DON'T FORGET

- Native-module ABI is a toggle: system Node for server tests, Electron ABI last for packaging.
  Leave the repo on system Node when you finish or `npm run dev` breaks.
- `node-pty` is skipped in the installer build intentionally.
- Never touch the in-app 3D Flubber without an explicit request.
- Preserve user/project data and make a preflight backup before any release work.
- Batch release fixes, then run one final expensive package/install verification cycle.
- A rehearsal must start from a machine with **no** Blubber uninstall registry entry, or NSIS
  reuses the remembered path and you silently measure the wrong install.
- On OneDrive-redirected machines the real Desktop is `%USERPROFILE%\OneDrive\Desktop`. Use
  `[Environment]::GetFolderPath('Desktop')`.

## FULL CONTEXT

- `docs/ai-context.md` — canonical current state plus historical record.
- `docs/CODEX-HANDOFF.md` — compact handoff and launch proof.
- `docs/RELEASING.md` — release procedure and auto-update rules.
- `docs/decisions/blubber-os-decisions.md` — durable product/installer decisions.
- `tools/smoke-test/` — clean-machine verification harness + v0.1.3 rehearsal results.
