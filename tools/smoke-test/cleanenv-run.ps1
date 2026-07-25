# Host-side clean-environment smoke test.
#
# Windows Sandbox is opaque to the host (no way to execute inside it), so this
# reproduces the parts of a virgin machine that the product actually depends on:
#   - no node / npm / claude / git anywhere on PATH  -> proves the 223MB build
#     really is self-contained and does not quietly borrow the dev box's toolchain
#   - empty APPDATA/USERPROFILE                       -> no ~/.claude, no kit
#     marker, no prior userData, so the free-shell onboarding path is exercised
# It does NOT replace the sandbox for install-UX/SmartScreen/GPU checks.

$root    = "C:\Users\jeffh\AppData\Local\Temp\claude\blubber-cleanenv"
$app     = "$root\app\Blubber.exe"
$profile = "$root\profile"
$log     = "$root\cleanenv-log.txt"

Remove-Item $profile -Recurse -Force -ErrorAction SilentlyContinue
foreach ($d in 'AppData\Roaming','AppData\Local','Desktop') {
    New-Item -ItemType Directory -Force -Path "$profile\$d" | Out-Null
}
Set-Content -Path $log -Value '' -Encoding utf8

function Say($m, $c = 'Gray') { Write-Host $m -ForegroundColor $c; Add-Content -Path $log -Value $m -Encoding utf8 }
function Check($label, $ok, $detail) {
    $mark = if ($ok) { '[PASS]' } else { '[FAIL]' }
    Say ("{0,-7} {1,-32} {2}" -f $mark, $label, $detail) $(if ($ok) { 'Green' } else { 'Red' })
}

Say "=== BLUBBER CLEAN-ENV TEST (host, scrubbed PATH + empty profile) ===" Cyan
Say ("Started: " + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
Say ""

# System32 only. Anything the app needs beyond this it must ship itself.
$cleanPath = "C:\Windows\system32;C:\Windows;C:\Windows\System32\Wbem;C:\Windows\System32\WindowsPowerShell\v1.0"
$env:PATH        = $cleanPath
$env:USERPROFILE = $profile
$env:APPDATA     = "$profile\AppData\Roaming"
$env:LOCALAPPDATA= "$profile\AppData\Local"
$env:HOME        = $profile
$env:HOMEPATH    = $profile
# Packaged Blubber now picks a random free loopback port unless PORT is set
# (see electron/main.js resolveFreePort) — pin it so this harness's fixed
# http://127.0.0.1:3000 probes keep working.
$env:PORT        = '3000'

foreach ($t in 'node','npm','claude','git') {
    $c = Get-Command $t -ErrorAction SilentlyContinue
    Check "$t absent from PATH" (-not $c) $(if ($c) { $c.Source } else { 'not on PATH' })
}
Check '~/.claude absent'  (-not (Test-Path "$profile\.claude"))                 "$profile\.claude"
Check 'userData absent'   (-not (Test-Path "$profile\AppData\Roaming\blubber-os")) 'fresh profile'
Check 'port 3000 free'    (-not (Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue)) 'pre-launch'

Say ""
Say "=== COLD LAUNCH ===" Cyan
$t0 = Get-Date
$proc = Start-Process -FilePath $app -PassThru -WorkingDirectory "$root\app"
Check 'process started' ($null -ne $proc) "PID $($proc.Id)"

# Poll for the embedded server instead of sleeping a fixed amount, and record
# how long the cold start actually took.
$ready = $false; $code = $null
for ($i = 0; $i -lt 90; $i++) {
    Start-Sleep -Seconds 2
    if ($proc.HasExited) { break }
    try {
        $r = Invoke-WebRequest -Uri 'http://127.0.0.1:3000' -UseBasicParsing -TimeoutSec 4
        $code = $r.StatusCode
        if ($code -eq 200) { $ready = $true; break }
    } catch { }
}
$elapsed = [math]::Round(((Get-Date) - $t0).TotalSeconds, 1)

Check 'process still alive' (-not $proc.HasExited) $(if ($proc.HasExited) { "exited code $($proc.ExitCode)" } else { "PID $($proc.Id)" })
Check 'server responded 200' $ready "after ${elapsed}s (HTTP $code)"

if ($ready) {
    foreach ($api in '/api/pet','/api/quests','/api/top-agents','/api/recent') {
        try {
            $r = Invoke-WebRequest -Uri "http://127.0.0.1:3000$api" -UseBasicParsing -TimeoutSec 10
            Check "GET $api" ($r.StatusCode -eq 200) "HTTP $($r.StatusCode), $($r.Content.Length) bytes"
        } catch {
            Check "GET $api" $false $_.Exception.Message
        }
    }

    # The branch a real buyer lands on. A virgin profile has neither ~/.claude
    # nor an installed binary, so this must be 'not-found' with kit=false --
    # which is exactly why the in-app installer cannot be kit-gated (the marker
    # lives inside ~/.claude). The overlay offers "Install it for me" here.
    try {
        $d = (Invoke-WebRequest -Uri 'http://127.0.0.1:3000/api/onboarding/detect' -UseBasicParsing -TimeoutSec 10).Content | ConvertFrom-Json
        Check 'detect -> not-found' ($d.status -eq 'not-found') "status '$($d.status)'"
        Check 'detect -> kit false'  (-not $d.kit)               "kit '$($d.kit)' (gate impossible here)"
    } catch {
        Check 'detect reachable' $false $_.Exception.Message
    }
}

Say ""
Say "=== STATE WRITTEN TO THE FRESH PROFILE ===" Cyan
$ud = "$profile\AppData\Roaming\blubber-os"
Check 'userData created' (Test-Path $ud) $ud
if (Test-Path $ud) {
    Get-ChildItem $ud -Recurse -File -ErrorAction SilentlyContinue |
        Select-Object -First 15 |
        ForEach-Object { Say ("   {0}  ({1} bytes)" -f $_.FullName.Replace($ud,''), $_.Length) }
}
# The kit marker must NOT appear on a virgin box - its absence is what puts the
# app into the free-shell flow instead of the paid starter-kit flow.
Check 'kit marker still absent' (-not (Test-Path "$profile\.claude\.blubber-kit.json")) 'free-shell flow expected'

Say ""
Say "Log: $log"
Say "App left RUNNING (PID $($proc.Id)) so the window can be eyeballed."
