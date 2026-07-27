# scripts/release.ps1
#
# Fail-closed release pipeline for the Blubber Windows installer.
# Every step must pass or the release stops — no more "the last build
# happened to be correct". Run from the repo root:
#
#   powershell -ExecutionPolicy Bypass -File scripts\release.ps1
#
# Order: typecheck -> fresh production build -> scrub paths -> native rebuild
# for Electron ABI -> native load test -> package -> icon verification ->
# package hygiene scan -> checksum -> auto-update metadata.

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

function Step($name, [scriptblock]$body) {
    Write-Host "`n=== $name ===" -ForegroundColor Cyan
    try {
        & $body
        if ($LASTEXITCODE -ne $null -and $LASTEXITCODE -ne 0) {
            throw "command exited with code $LASTEXITCODE"
        }
    } catch {
        Write-Host "RELEASE FAILED at: $name" -ForegroundColor Red
        Write-Host "  $($_.Exception.Message)" -ForegroundColor Red
        exit 1
    }
}

Step "1/10 Typecheck" { npx tsc --noEmit }

Step "2/10 Fresh production build" {
    # `next build` runs under the SYSTEM node and loads better-sqlite3 during
    # page-data collection — if a previous release run left the native
    # modules on Electron's ABI, the build hard-fails (ERR_DLOPEN_FAILED).
    # Always flip to the system ABI first; step 3 flips to Electron's after.
    npm run rebuild:system-node
    if ($LASTEXITCODE -ne 0) { throw "system-node native rebuild failed" }
    if (Test-Path ".next-build") { Remove-Item -Recurse -Force ".next-build" }
    npm run build
}

Step "3/10 Scrub build-machine paths from Next output" {
    $global:LASTEXITCODE = 0
    # Next embeds the build machine's absolute project path in every compiled
    # route module (resolvedPagePath), the client-reference manifests, and
    # required-server-files.json. Those strings are identifiers/debug info —
    # never dereferenced at runtime in production — but a customer install
    # must not carry the developer's username. Rewrite them CONSISTENTLY
    # (same neutral path everywhere, so manifest keys still match) before
    # packaging. The trace file is pure build telemetry — deleted outright.
    $neutral = "C:\blubber-app"
    $plain = $repo
    $esc = $repo.Replace("\", "\\")
    $fwd = $repo.Replace("\", "/")
    $neutralEsc = $neutral.Replace("\", "\\")
    $neutralFwd = $neutral.Replace("\", "/")

    $trace = ".next-build\trace"
    if (Test-Path $trace) { Remove-Item $trace -Force }

    $textExt = @(".js", ".json", ".map", ".html", ".rsc", ".txt", ".meta", ".body")
    $scrubbed = 0
    Get-ChildItem ".next-build" -Recurse -File |
        Where-Object { $_.FullName -notmatch "\\cache\\" -and $textExt -contains $_.Extension } |
        ForEach-Object {
            $content = [System.IO.File]::ReadAllText($_.FullName)
            if ($content.Contains($plain) -or $content.Contains($esc) -or $content.Contains($fwd)) {
                $content = $content.Replace($esc, $neutralEsc).Replace($plain, $neutral).Replace($fwd, $neutralFwd)
                [System.IO.File]::WriteAllText($_.FullName, $content)
                $scrubbed++
            }
        }
    Write-Host "scrubbed $scrubbed file(s)"
}

Step "4/10 Rebuild native modules for Electron ABI" { npm run rebuild:electron }

Step "5/10 Native module load test (Electron-as-node)" {
    $env:ELECTRON_RUN_AS_NODE = "1"
    try {
        & ".\node_modules\electron\dist\electron.exe" -e "require('better-sqlite3'); require('node-pty'); console.log('native modules load OK')"
        if ($LASTEXITCODE -ne 0) { throw "native modules failed to load under Electron's Node ABI" }
    } finally {
        Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    }
}

Step "6/10 Package installer" { npm run electron:build }

Step "7/10 Packaged icon verification" {
    & "$PSScriptRoot\verify-icons.ps1"
}

Step "8/10 Package hygiene scan" {
    $global:LASTEXITCODE = 0
    $app = Join-Path $repo "dist-electron\win-unpacked\resources\app"
    if (-not (Test-Path $app)) { throw "unpacked app dir missing: $app" }

    # Files that must never ship
    $forbiddenPaths = @(".env.local", ".next-build\cache", "tools", "data", "music", "e2e", "scripts")
    foreach ($p in $forbiddenPaths) {
        if (Test-Path (Join-Path $app $p)) { throw "FORBIDDEN path shipped in package: $p" }
    }

    # Personal/developer paths that must never appear anywhere in the package.
    # node_modules is skipped (huge, third-party); the app's own code + build
    # output is what could have baked a developer path in.
    $hits = Get-ChildItem $app -Recurse -File |
        Where-Object { $_.FullName -notmatch "\\node_modules\\" } |
        Select-String -Pattern "Users[\\/]+jeffh" -List -ErrorAction SilentlyContinue
    if ($hits) {
        $sample = ($hits | Select-Object -First 5 | ForEach-Object { $_.Path }) -join "; "
        throw "developer path found in packaged files: $sample"
    }
    Write-Host "hygiene scan clean"
}

Step "9/10 Checksum" {
    $global:LASTEXITCODE = 0
    $installer = Get-ChildItem "dist-electron" -Filter "*.exe" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $installer) { throw "no installer produced" }
    $hash = (Get-FileHash $installer.FullName -Algorithm SHA256).Hash
    $sizeMb = [math]::Round($installer.Length / 1MB, 1)
    $line = "$($installer.Name)  SHA256=$hash  ($sizeMb MB)"
    $line | Out-File -FilePath "dist-electron\SHA256SUMS.txt" -Encoding utf8
    Write-Host $line
}

Step "10/10 Auto-update metadata" {
    $global:LASTEXITCODE = 0
    # electron-updater clients read latest.yml off the GitHub release, compare
    # its version to their own, then download the named file and verify it
    # against the sha512 recorded here. Every one of those fields is therefore
    # a silent-failure surface: a missing latest.yml means installed copies
    # never see the release at all, and a sha512 that does not match the real
    # .exe means they download the update and then refuse to install it. Both
    # look like a perfectly successful release from this machine, which is why
    # they are checked here instead of assumed.
    $meta = "dist-electron\latest.yml"
    if (-not (Test-Path $meta)) {
        throw "latest.yml was not produced - electron-updater clients would never see this release. Check the publish block in electron-builder.yml."
    }

    $yml = Get-Content $meta -Raw
    $pkgVersion = (Get-Content "package.json" -Raw | ConvertFrom-Json).version

    $verMatch = [regex]::Match($yml, '(?m)^version:\s*(\S+)\s*$')
    if (-not $verMatch.Success) { throw "latest.yml has no version field" }
    $metaVersion = $verMatch.Groups[1].Value.Trim("'`"")
    if ($metaVersion -ne $pkgVersion) {
        throw "latest.yml version ($metaVersion) does not match package.json ($pkgVersion)"
    }

    $pathMatch = [regex]::Match($yml, '(?m)^path:\s*(.+?)\s*$')
    if (-not $pathMatch.Success) { throw "latest.yml has no path field" }
    $artifact = $pathMatch.Groups[1].Value.Trim("'`"")
    $artifactPath = Join-Path "dist-electron" $artifact
    if (-not (Test-Path $artifactPath)) {
        throw "latest.yml points at '$artifact' but that file is not in dist-electron"
    }

    # The top-level sha512 is the one the client verifies the download against.
    $shaMatch = [regex]::Match($yml, '(?m)^sha512:\s*(\S+)\s*$')
    if (-not $shaMatch.Success) { throw "latest.yml has no top-level sha512" }
    $expected = $shaMatch.Groups[1].Value.Trim("'`"")

    $sha512 = [System.Security.Cryptography.SHA512]::Create()
    $stream = [System.IO.File]::OpenRead((Resolve-Path $artifactPath))
    try {
        $actual = [Convert]::ToBase64String($sha512.ComputeHash($stream))
    } finally {
        $stream.Dispose()
        $sha512.Dispose()
    }
    if ($actual -ne $expected) {
        throw "sha512 in latest.yml does not match the real installer - every client would reject this update"
    }

    # Differential updates need the blockmap published next to the installer.
    # Its absence is not fatal (clients fall back to a full ~190 MB download),
    # so this warns instead of throwing.
    $blockmap = "$artifactPath.blockmap"
    if (Test-Path $blockmap) {
        Write-Host "blockmap present (differential updates enabled)"
    } else {
        Write-Host "WARNING: no .blockmap - updates will download in full" -ForegroundColor Yellow
    }

    Write-Host "latest.yml OK: v$metaVersion -> $artifact, sha512 verified"
}

Write-Host "`nRELEASE BUILD COMPLETE - dist-electron\ holds the artifact + SHA256SUMS.txt" -ForegroundColor Green
Write-Host "Upload latest.yml AND the .blockmap with the .exe or auto-update will not work." -ForegroundColor Yellow
Write-Host "See docs/RELEASING.md for the exact command." -ForegroundColor Yellow
