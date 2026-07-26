param(
    [switch]$SourceOnly
)

$ErrorActionPreference = "Stop"

$repo = Split-Path -Parent $PSScriptRoot
$package = Get-Content (Join-Path $repo "package.json") -Raw | ConvertFrom-Json
$version = $package.version

Add-Type -AssemblyName System.Drawing

function Get-IconStats([string]$path, [int]$alphaThreshold = 16) {
    if (-not (Test-Path -LiteralPath $path)) {
        throw "missing icon: $path"
    }

    $bitmap = [System.Drawing.Bitmap]::FromFile($path)
    try {
        $minX = $bitmap.Width
        $minY = $bitmap.Height
        $maxX = -1
        $maxY = -1
        $visible = 0
        $transparent = 0

        for ($y = 0; $y -lt $bitmap.Height; $y++) {
            for ($x = 0; $x -lt $bitmap.Width; $x++) {
                $alpha = $bitmap.GetPixel($x, $y).A
                if ($alpha -eq 0) {
                    $transparent++
                }
                if ($alpha -ge $alphaThreshold) {
                    $visible++
                    if ($x -lt $minX) { $minX = $x }
                    if ($x -gt $maxX) { $maxX = $x }
                    if ($y -lt $minY) { $minY = $y }
                    if ($y -gt $maxY) { $maxY = $y }
                }
            }
        }

        if ($visible -eq 0) {
            throw "icon has no visible pixels: $path"
        }

        return [pscustomobject]@{
            Width = $bitmap.Width
            Height = $bitmap.Height
            VisibleWidth = $maxX - $minX + 1
            VisibleHeight = $maxY - $minY + 1
            VisiblePixels = $visible
            TransparentPixels = $transparent
            TopLeftAlpha = $bitmap.GetPixel(0, 0).A
            TopRightAlpha = $bitmap.GetPixel($bitmap.Width - 1, 0).A
            BottomLeftAlpha = $bitmap.GetPixel(0, $bitmap.Height - 1).A
            BottomRightAlpha = $bitmap.GetPixel($bitmap.Width - 1, $bitmap.Height - 1).A
        }
    } finally {
        $bitmap.Dispose()
    }
}

function Assert-TransparentSquareMaster([string]$path) {
    $stats = Get-IconStats $path
    if ($stats.Width -ne $stats.Height -or $stats.Width -lt 512) {
        throw "icon master must be square and at least 512px: $path ($($stats.Width)x$($stats.Height))"
    }
    if (
        $stats.TopLeftAlpha -ne 0 -or
        $stats.TopRightAlpha -ne 0 -or
        $stats.BottomLeftAlpha -ne 0 -or
        $stats.BottomRightAlpha -ne 0
    ) {
        throw "icon master corners are not transparent: $path"
    }
    if ($stats.TransparentPixels -lt ($stats.Width * $stats.Height * 0.25)) {
        throw "icon master does not have enough transparent canvas: $path"
    }
    if ($stats.VisibleHeight -le $stats.VisibleWidth) {
        throw "icon master is not the tall standalone BL composition: $path"
    }
}

function Export-AssociatedIcon([string]$exePath, [string]$pngPath) {
    if (-not (Test-Path -LiteralPath $exePath)) {
        throw "missing executable: $exePath"
    }

    $icon = [System.Drawing.Icon]::ExtractAssociatedIcon($exePath)
    if ($null -eq $icon) {
        throw "could not extract Windows icon: $exePath"
    }
    try {
        $bitmap = $icon.ToBitmap()
        try {
            $bitmap.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)
        } finally {
            $bitmap.Dispose()
        }
    } finally {
        $icon.Dispose()
    }
}

$builderIcon = Join-Path $repo "build\icon.png"
$favicon = Join-Path $repo "src\app\icon.png"

Assert-TransparentSquareMaster $builderIcon
Assert-TransparentSquareMaster $favicon

$builderHash = (Get-FileHash -LiteralPath $builderIcon -Algorithm SHA256).Hash
$faviconHash = (Get-FileHash -LiteralPath $favicon -Algorithm SHA256).Hash
if ($builderHash -ne $faviconHash) {
    throw "builder icon and app favicon are not the same master"
}

if ($SourceOnly) {
    Write-Host "source icon verification passed: transparent standalone BL is shared by builder and favicon"
    return
}

$packagedFavicon = Join-Path $repo "dist-electron\win-unpacked\resources\app\.next-build\server\app\icon.png.body"
if (-not (Test-Path -LiteralPath $packagedFavicon)) {
    throw "packaged Next favicon missing: $packagedFavicon"
}
$packagedFaviconHash = (Get-FileHash -LiteralPath $packagedFavicon -Algorithm SHA256).Hash
if ($packagedFaviconHash -ne $faviconHash) {
    throw "packaged Next favicon does not match src/app/icon.png"
}

$installer = Join-Path $repo "dist-electron\Blubber.Setup.$version.exe"
$appExe = Join-Path $repo "dist-electron\win-unpacked\Blubber.exe"
$installerPng = Join-Path ([System.IO.Path]::GetTempPath()) "blubber-installer-icon-$PID.png"
$appPng = Join-Path ([System.IO.Path]::GetTempPath()) "blubber-app-icon-$PID.png"

try {
    Export-AssociatedIcon $installer $installerPng
    Export-AssociatedIcon $appExe $appPng

    $installerStats = Get-IconStats $installerPng
    $appStats = Get-IconStats $appPng

    foreach ($entry in @(
        @{ Name = "installer"; Stats = $installerStats },
        @{ Name = "app"; Stats = $appStats }
    )) {
        $stats = $entry.Stats
        if ($stats.Width -ne 32 -or $stats.Height -ne 32) {
            throw "$($entry.Name) associated icon is not 32x32"
        }
        if ($stats.VisibleHeight -le $stats.VisibleWidth -or $stats.VisibleWidth -gt 26) {
            throw "$($entry.Name) embedded icon looks like a wide wordmark, not the standalone BL"
        }
        if (
            $stats.TopLeftAlpha -ne 0 -or
            $stats.TopRightAlpha -ne 0 -or
            $stats.BottomLeftAlpha -ne 0 -or
            $stats.BottomRightAlpha -ne 0
        ) {
            throw "$($entry.Name) embedded icon corners are not transparent"
        }
    }

    $installerIconHash = (Get-FileHash -LiteralPath $installerPng -Algorithm SHA256).Hash
    $appIconHash = (Get-FileHash -LiteralPath $appPng -Algorithm SHA256).Hash
    if ($installerIconHash -ne $appIconHash) {
        throw "installer and app executables embedded different icons"
    }
} finally {
    Remove-Item -LiteralPath $installerPng -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $appPng -Force -ErrorAction SilentlyContinue
}

Write-Host "icon verification passed: transparent standalone BL is consistent across source, favicon, installer, and app"
