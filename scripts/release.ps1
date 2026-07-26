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
# package hygiene scan -> checksum.

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

Step "1/9 Typecheck" { npx tsc --noEmit }

Step "2/9 Fresh production build" {
    # `next build` runs under the SYSTEM node and loads better-sqlite3 during
    # page-data collection — if a previous release run left the native
    # modules on Electron's ABI, the build hard-fails (ERR_DLOPEN_FAILED).
    # Always flip to the system ABI first; step 3 flips to Electron's after.
    npm run rebuild:system-node
    if ($LASTEXITCODE -ne 0) { throw "system-node native rebuild failed" }
    if (Test-Path ".next-build") { Remove-Item -Recurse -Force ".next-build" }
    npm run build
}

Step "3/9 Scrub build-machine paths from Next output" {
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

Step "4/9 Rebuild native modules for Electron ABI" { npm run rebuild:electron }

Step "5/9 Native module load test (Electron-as-node)" {
    $env:ELECTRON_RUN_AS_NODE = "1"
    try {
        & ".\node_modules\electron\dist\electron.exe" -e "require('better-sqlite3'); require('node-pty'); console.log('native modules load OK')"
        if ($LASTEXITCODE -ne 0) { throw "native modules failed to load under Electron's Node ABI" }
    } finally {
        Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    }
}

Step "6/9 Package installer" { npm run electron:build }

Step "7/9 Packaged icon verification" {
    & "$PSScriptRoot\verify-icons.ps1"
}

Step "8/9 Package hygiene scan" {
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

Step "9/9 Checksum" {
    $global:LASTEXITCODE = 0
    $installer = Get-ChildItem "dist-electron" -Filter "*.exe" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $installer) { throw "no installer produced" }
    $hash = (Get-FileHash $installer.FullName -Algorithm SHA256).Hash
    $sizeMb = [math]::Round($installer.Length / 1MB, 1)
    $line = "$($installer.Name)  SHA256=$hash  ($sizeMb MB)"
    $line | Out-File -FilePath "dist-electron\SHA256SUMS.txt" -Encoding utf8
    Write-Host $line
}

Write-Host "`nRELEASE BUILD COMPLETE - dist-electron\ holds the artifact + SHA256SUMS.txt" -ForegroundColor Green
