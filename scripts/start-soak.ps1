# start-soak.ps1
#
# Launches soak-monitor.mjs as a TRULY DETACHED, hidden Windows process --
# NOT a background job or `&` in the current shell, both of which stay tied
# to the parent shell/tool-call's lifetime and die with it. Start-Process
# creates an independent process the OS keeps running regardless of what
# happens to the terminal/tool session that launched it.
#
# Usage:
#   powershell -File scripts/start-soak.ps1
#   powershell -File scripts/start-soak.ps1 -DurationHours 4.5 -SampleMinutes 5 -Port 3210
#
# Env vars consumed by soak-monitor.mjs (SOAK_PORT / SOAK_DURATION_MS /
# SOAK_SAMPLE_INTERVAL_MS) are set as PROCESS-scoped vars on THIS script's
# own process before Start-Process launches the child -- Start-Process's
# child inherits the calling process's environment by default, so this is
# enough to configure the detached run without touching machine/user env.

param(
    [double]$DurationHours = 4.5,
    [double]$SampleMinutes = 5,
    [int]$Port = 3210
)

$RepoRoot = Split-Path -Parent $PSScriptRoot

$env:SOAK_PORT = "$Port"
$env:SOAK_DURATION_MS = [int]($DurationHours * 60 * 60 * 1000)
$env:SOAK_SAMPLE_INTERVAL_MS = [int]($SampleMinutes * 60 * 1000)

Write-Host "Launching detached soak test: port=$Port durationHours=$DurationHours sampleMinutes=$SampleMinutes"
Write-Host "Repo root: $RepoRoot"

$proc = Start-Process -FilePath "node" `
    -ArgumentList "scripts/soak-monitor.mjs" `
    -WorkingDirectory $RepoRoot `
    -WindowStyle Hidden `
    -PassThru

Write-Host "Detached soak-monitor.mjs launched. OS PID: $($proc.Id)"
Write-Host "This process is independent of the current shell -- closing this terminal will NOT stop it."
Write-Host "Log file appears under $RepoRoot\logs\soak-<timestamp>.log within the first minute or two."
