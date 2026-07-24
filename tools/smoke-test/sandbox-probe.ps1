# Blubber OS — fresh-environment smoke test, phase 1 (pre-install)
# Runs automatically at sandbox logon. Proves the box is genuinely clean
# BEFORE the installer touches it, so a later pass/fail means something.

$ErrorActionPreference = 'Continue'
$log = "$env:USERPROFILE\Desktop\smoke-log.txt"

function Say($msg, $color = 'Gray') { Write-Host $msg -ForegroundColor $color; Add-Content -Path $log -Value $msg -Encoding utf8 }
function Check($label, $isClean, $detail) {
    $mark = if ($isClean) { '[CLEAN]' } else { '[DIRTY]' }
    $color = if ($isClean) { 'Green' } else { 'Red' }
    Say ("{0,-9} {1,-34} {2}" -f $mark, $label, $detail) $color
}

Say "=== BLUBBER SMOKE TEST — PHASE 1: PRE-INSTALL ===" Cyan
Say ("Sandbox time: " + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
Say ""

# The whole point of the 223MB self-contained build is that NONE of these exist.
$node   = Get-Command node -ErrorAction SilentlyContinue
$npm    = Get-Command npm -ErrorAction SilentlyContinue
$claude = Get-Command claude -ErrorAction SilentlyContinue
$git    = Get-Command git -ErrorAction SilentlyContinue

Check 'Node.js absent'      (-not $node)   $(if ($node)   { $node.Source }   else { 'not on PATH' })
Check 'npm absent'          (-not $npm)    $(if ($npm)    { $npm.Source }    else { 'not on PATH' })
Check 'Claude Code absent'  (-not $claude) $(if ($claude) { $claude.Source } else { 'not on PATH' })
Check 'git absent'          (-not $git)    $(if ($git)    { $git.Source }    else { 'not on PATH' })

$claudeDir = "$env:USERPROFILE\.claude"
$kitMarker = "$claudeDir\.blubber-kit.json"
Check '~/.claude absent'    (-not (Test-Path $claudeDir)) $claudeDir
Check 'kit marker absent'   (-not (Test-Path $kitMarker)) 'free-shell flow expected'

$userData = "$env:APPDATA\blubber-os"
Check 'app userData absent' (-not (Test-Path $userData))  $userData

$port3000 = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
Check 'port 3000 free'      (-not $port3000) $(if ($port3000) { "PID $($port3000.OwningProcess)" } else { 'no listener' })

Say ""
Say "=== INSTALLER ===" Cyan
$exe = Get-ChildItem "$env:USERPROFILE\Desktop\installer\*.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
if ($exe) {
    $sizeMB = [math]::Round($exe.Length / 1MB, 1)
    Say ("Found: {0} ({1} MB, built {2})" -f $exe.Name, $sizeMB, $exe.LastWriteTime) Green
    $sig = Get-AuthenticodeSignature $exe.FullName
    Say ("Signature: {0}" -f $sig.Status) $(if ($sig.Status -eq 'Valid') { 'Green' } else { 'Yellow' })
    if ($sig.Status -ne 'Valid') { Say "  -> expect a SmartScreen 'unrecognized app' warning. Click More info > Run anyway." Yellow }
} else {
    Say "NO .exe FOUND in mapped folder — check the .wsb HostFolder path." Red
}

Say ""
Say "=== NEXT ===" Cyan
Say "1. Double-click the installer on the Desktop (installer folder)."
Say "2. Walk the app: onboarding -> scan workspace -> dashboard."
Say "3. Back here, run:  .\Desktop\smoke\verify-install.ps1"
Say ""
Say "Log: $log"
