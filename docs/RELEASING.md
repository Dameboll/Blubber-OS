# Releasing Blubber

Every shipped Windows build goes through `scripts/release.ps1`. It is fail-closed:
any stage that fails aborts the release instead of producing a half-correct
installer.

```powershell
powershell -ExecutionPolicy Bypass -File scripts\release.ps1
```

Ten stages: typecheck, fresh production build, path scrub, Electron ABI rebuild,
native load test, packaging, packaged-icon verification, package hygiene scan,
checksum, auto-update metadata.

## Auto-update: what has to be on the release

Since v0.1.3 the app checks GitHub for updates on its own (`electron/updater.js`).
That only works if the release carries the update metadata, **not just the .exe**:

| File | Required | What breaks without it |
|---|---|---|
| `Blubber.Setup.<version>.exe` | yes | nothing to install |
| `latest.yml` | yes | installed copies never see the release — silently, forever |
| `Blubber.Setup.<version>.exe.blockmap` | no | updates download in full (~190 MB) instead of differentially |
| `SHA256SUMS.txt` | no | manual downloaders lose the published checksum |

`latest.yml` is the whole update feed: electron-updater reads the version from
it, downloads the file it names, and verifies that download against the sha512
it records. Stage 10 of the pipeline checks all three of those against the real
artifact before you upload anything, because a wrong or missing `latest.yml`
looks like a completely successful release from the build machine — the failure
only ever shows up as customers quietly staying on an old version.

Upload everything at once:

```powershell
gh release create v0.1.3 `
  dist-electron\Blubber.Setup.0.1.3.exe `
  dist-electron\latest.yml `
  dist-electron\Blubber.Setup.0.1.3.exe.blockmap `
  dist-electron\SHA256SUMS.txt `
  --repo Dameboll/Blubber-OS --title "Blubber v0.1.3" --notes-file notes.md
```

Adding files to a release that already exists:

```powershell
gh release upload v0.1.3 dist-electron\latest.yml --repo Dameboll/Blubber-OS
```

After publishing, confirm the asset list actually contains `latest.yml`:

```powershell
gh release view v0.1.3 --repo Dameboll/Blubber-OS --json assets
```

## Rules that keep updates working

- **Draft and prerelease releases are invisible to the updater.** That is a
  feature — a half-finished release can never reach customers — but it also
  means a release left in draft ships to nobody.
- **The version in `package.json` is the version customers compare against.**
  Bump it before running the pipeline; stage 10 fails if `latest.yml` and
  `package.json` disagree.
- **Never edit or hand-write `latest.yml`.** It is generated during packaging and
  its sha512 must match the exact bytes you upload.
- **Never re-upload a different .exe under an existing tag.** The published
  sha512 stops matching and every client rejects the download.

## Known limitation: pre-0.1.3 installs cannot self-update

v0.1.0 through v0.1.2 shipped without any updater code. Those installs will
never update themselves no matter what is published — they have nothing that
checks. Everyone on those versions has to download v0.1.3 by hand once; from
v0.1.3 onward updates are automatic.

Worth saying plainly on the download page and in the v0.1.3 release notes.

## Code signing

The installer is still unsigned, so SmartScreen warns on first run. This is
disclosed on GitHub, in the README, and on the storefront.

Signing is not required for auto-update to work — `publisherName` is
deliberately unset so electron-updater skips publisher verification, and update
integrity rests on the sha512 in `latest.yml` fetched over HTTPS, the same trust
chain as a manual download. Signing would raise the bar for both paths at once;
it remains a post-launch purchase, not a blocker.
