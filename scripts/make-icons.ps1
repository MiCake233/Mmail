# Mmail · app / tray / launcher icon generator
# ---------------------------------------------------------------------------
# Builds every icon from assets/icon-source.jpg (the master artwork) with
# rounded, transparent corners:
#   assets/icon.png            512x512  window + notifications
#   assets/tray.png             64x64   tray (Electron scales to 16px)
#   assets/icon.ico                    Windows shortcut / installer
#   web/assets/icon-192.png    192x192  PWA manifest
#   web/assets/icon-512.png    512x512  PWA manifest
#   android/.../ic_launcher.png        only when android/ exists
#
# Run: npm run icons
# This file is ASCII-only: PowerShell 5.1 decodes non-BOM files as ANSI.

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$assets = Join-Path $root 'assets'
$webAssets = Join-Path $root 'web\assets'
$source = Join-Path $assets 'icon-source.jpg'

if (-not (Test-Path $source)) {
  throw "Master artwork not found: $source"
}

foreach ($dir in @($assets, $webAssets)) {
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
}

function New-RoundedPath {
  param([single]$X, [single]$Y, [single]$W, [single]$H, [single]$R)
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = [single]($R * 2)
  if ($d -gt $W) { $d = $W }
  if ($d -gt $H) { $d = $H }
  $path.AddArc($X, $Y, $d, $d, 180, 90)
  $path.AddArc($X + $W - $d, $Y, $d, $d, 270, 90)
  $path.AddArc($X + $W - $d, $Y + $H - $d, $d, $d, 0, 90)
  $path.AddArc($X, $Y + $H - $d, $d, $d, 90, 90)
  $path.CloseFigure()
  return $path
}

function New-IconBitmap {
  param([int]$Size)

  $canvas = New-Object System.Drawing.Bitmap($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($canvas)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)

  $radius = [single]($Size * 0.2237)
  $clip = New-RoundedPath -X 0 -Y 0 -W $Size -H $Size -R $radius
  $g.SetClip($clip, [System.Drawing.Drawing2D.CombineMode]::Replace)

  $image = [System.Drawing.Image]::FromFile($source)
  $g.DrawImage($image, (New-Object System.Drawing.Rectangle(0, 0, $Size, $Size)))
  $image.Dispose()

  $g.ResetClip()
  $clip.Dispose()
  $g.Dispose()
  return $canvas
}

function Save-Png {
  param([System.Drawing.Bitmap]$Bitmap, [string]$Path)
  $Bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
  Write-Host ('  wrote ' + $Path)
}

Write-Host 'Mmail icons'

$icon512 = New-IconBitmap -Size 512
Save-Png -Bitmap $icon512 -Path (Join-Path $assets 'icon.png')
Save-Png -Bitmap $icon512 -Path (Join-Path $webAssets 'icon-512.png')

$icon192 = New-IconBitmap -Size 192
Save-Png -Bitmap $icon192 -Path (Join-Path $webAssets 'icon-192.png')
$icon192.Dispose()

# Windows .ico for shortcut / installer; Explorer downscales as needed
$icoHandle = $icon512.GetHicon()
$ico = [System.Drawing.Icon]::FromHandle($icoHandle)
$stream = [System.IO.File]::Create((Join-Path $assets 'icon.ico'))
$ico.Save($stream)
$stream.Close()
$stream.Dispose()
$ico.Dispose()
Write-Host ('  wrote ' + (Join-Path $assets 'icon.ico'))
$icon512.Dispose()

$tray = New-IconBitmap -Size 64
Save-Png -Bitmap $tray -Path (Join-Path $assets 'tray.png')
$tray.Dispose()

# Android launcher icons (skipped when the Android project is absent)
$androidRes = Join-Path $root 'android\app\src\main\res'
if (Test-Path $androidRes) {
  $densities = @{
    'mipmap-mdpi' = 48
    'mipmap-hdpi' = 72
    'mipmap-xhdpi' = 96
    'mipmap-xxhdpi' = 144
    'mipmap-xxxhdpi' = 192
  }
  foreach ($name in $densities.Keys) {
    $dir = Join-Path $androidRes $name
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $bitmap = New-IconBitmap -Size $densities[$name]
    Save-Png -Bitmap $bitmap -Path (Join-Path $dir 'ic_launcher.png')
    $bitmap.Dispose()
  }
}

Write-Host 'done'
