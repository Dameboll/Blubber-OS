# Blubber OS — fresh-environment smoke test, phase 2 (post-install)
# Run INSIDE the sandbox after installing and walking the app.
# Ground-truths the claims the packaged build makes: self-contained Node,
# real DB on disk, free-shell (non-kit) flow, no system-node dependency.

$ErrorActionPreference = 'Continue'

# Same host-mapped log the phase-1 probe wrote to (see sandbox-probe.ps1).
$results = "$env:USERPROFILE\Desktop\results"
$log = if (Test-Path $results) { "$results\smoke-log.txt" } else { "$env:USERPROFILE\Desktop\smoke-log.txt" }
$fails = 0

function Say($msg, $color = 'Gray') { Write-Host $msg -ForegroundColor $color; Add-Content -Path $log -Value $msg -Encoding utf8 }
function Test-Gate($label, $ok, $detail) {
    $mark = if ($ok) { '[PASS]' } else { '[FAIL]' }
    $color = if ($ok) { 'Green' } else { 'Red' }
    if (-not $ok) { $script:fails++ }
    Say ("{0,-7} {1,-36} {2}" -f $mark, $label, $detail) $color
}

Say ""
Say "=== BLUBBER SMOKE TEST — PHASE 2: POST-INSTALL ===" Cyan
Say ("Checked: " + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
Say ""

# --- install layout -------------------------------------------------------
$installDir = "$env:LOCALAPPDATA\Programs\Blubber"
if (-not (Test-Path $installDir)) {
    $alt = Get-ChildItem "$env:ProgramFiles","${env:ProgramFiles(x86)}" -Filter 'Blubber*' -Directory -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($alt) { $installDir = $alt.FullName }
}
Test-Gate 'install dir exists' (Test-Path $installDir) $installDir

$appRoot = Join-Path $installDir 'resources\app'
Test-Gate 'resources\app unpacked (asar off)' (Test-Path (Join-Path $appRoot 'server.js')) "$appRoot\server.js"
Test-Gate 'no app.asar shipped' (-not (Test-Path (Join-Path $installDir 'resources\app.asar'))) 'asar:false honored'
Test-Gate 'production Next build present' (Test-Path (Join-Path $appRoot '.next-build')) '.next-build'

# The whole reason for the 223MB build: native modules must be present and
# must have been rebuilt against ELECTRON's ABI, not the system Node ABI.
$sqlite = Get-ChildItem (Join-Path $appRoot 'node_modules\better-sqlite3') -Recurse -Filter '*.node' -ErrorAction SilentlyContinue | Select-Object -First 1
Test-Gate 'better-sqlite3 .node present' ($null -ne $sqlite) $(if ($sqlite) { $sqlite.FullName.Replace($appRoot,'...') } else { 'MISSING' })
$pty = Get-ChildItem (Join-Path $appRoot 'node_modules\node-pty') -Recurse -Filter '*.node' -ErrorAction SilentlyContinue | Select-Object -First 1
Test-Gate 'node-pty .node present' ($null -ne $pty) $(if ($pty) { $pty.FullName.Replace($appRoot,'...') } else { 'MISSING' })

# --- runtime --------------------------------------------------------------
$procs = Get-Process -Name 'Blubber' -ErrorAction SilentlyContinue
Test-Gate 'Blubber running' ($null -ne $procs) $(if ($procs) { "$($procs.Count) process(es)" } else { 'not running — launch it first' })

# THE headline gate: no system node exists in this sandbox, so if the server
# is up, it can only be running on Electron's own bundled runtime.
$systemNode = Get-Command node -ErrorAction SilentlyContinue
Test-Gate 'still no system Node.js' (-not $systemNode) $(if ($systemNode) { "LEAKED: $($systemNode.Source)" } else { 'self-contained proven' })
$nodeProc = Get-Process -Name 'node' -ErrorAction SilentlyContinue
Test-Gate 'no stray node.exe process' (-not $nodeProc) $(if ($nodeProc) { "PID $($nodeProc.Id)" } else { 'server runs as Electron child' })

$listener = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
Test-Gate 'server listening on :3000' ($null -ne $listener) $(if ($listener) { "PID $($listener.OwningProcess)" } else { 'nothing bound' })

if ($listener) {
    try {
        $r = Invoke-WebRequest 'http://127.0.0.1:3000/api/prefs' -UseBasicParsing -TimeoutSec 10
        Test-Gate 'GET /api/prefs 200' ($r.StatusCode -eq 200) "HTTP $($r.StatusCode)"
    } catch { Test-Gate 'GET /api/prefs 200' $false $_.Exception.Message }
}

# --- state written on first run ------------------------------------------
$db = Join-Path $appRoot 'data\usage.db'
Test-Gate 'usage.db created on first run' (Test-Path $db) $(if (Test-Path $db) { "$([math]::Round((Get-Item $db).Length/1KB,1)) KB" } else { $db })

$userData = "$env:APPDATA\Blubber"
Test-Gate 'Electron userData created' (Test-Path $userData) $userData

# Free shell, not the paid kit flow. No marker should ever be auto-created.
$kitMarker = "$env:USERPROFILE\.claude\.blubber-kit.json"
Test-Gate 'kit marker still absent' (-not (Test-Path $kitMarker)) 'free flow confirmed'

Say ""
if ($fails -eq 0) { Say "RESULT: ALL GATES PASSED — clean-machine install is sound." Green }
else { Say "RESULT: $fails GATE(S) FAILED — see [FAIL] lines above." Red }
Say ""
Say "Log written to the host disk at tools\smoke-test\results\smoke-log.txt --"
Say "it already survived the sandbox. Nothing to copy out."
