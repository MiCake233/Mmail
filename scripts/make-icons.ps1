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

function New-IconPngBytes {
  param([int]$Size)
  $bitmap = New-IconBitmap -Size $Size
  $memory = New-Object System.IO.MemoryStream
  $bitmap.Save($memory, [System.Drawing.Imaging.ImageFormat]::Png)
  $bitmap.Dispose()
  $bytes = $memory.ToArray()
  $memory.Dispose()
  # Wrap so PowerShell does not unroll the byte array into single bytes.
  return ,$bytes
}

# Assemble a multi-frame .ico with PNG-compressed frames.
# Do not derive the .ico from a 512px HICON: the ICO header stores dimensions
# in one byte, so 512 wraps to 0 and Explorer refuses to render the file.
function Write-IcoFile {
  param([string]$Path, [int[]]$Sizes)

  $blobs = New-Object System.Collections.Generic.List[byte[]]
  foreach ($size in $Sizes) {
    $blobs.Add((New-IconPngBytes -Size $size))
  }

  $count = $blobs.Count
  $headerLength = 6 + (16 * $count)
  $total = $headerLength
  foreach ($blob in $blobs) { $total += $blob.Length }

  $buffer = New-Object 'byte[]' $total
  $buffer[2] = 1                                    # resource type: icon
  $buffer[4] = [byte]($count -band 0xFF)            # image count, low byte
  $buffer[5] = [byte](($count -shr 8) -band 0xFF)   # image count, high byte

  $offset = $headerLength
  $entry = 6
  for ($index = 0; $index -lt $count; $index++) {
    $blob = $blobs[$index]
    $size = $Sizes[$index]
    $dimension = 0
    if ($size -lt 256) { $dimension = $size }

    $buffer[$entry] = [byte]$dimension
    $buffer[$entry + 1] = [byte]$dimension
    $buffer[$entry + 2] = 0
    $buffer[$entry + 3] = 0
    $buffer[$entry + 4] = 1                         # colour planes
    $buffer[$entry + 5] = 0
    $buffer[$entry + 6] = 32                        # bits per pixel
    $buffer[$entry + 7] = 0

    $length = $blob.Length
    $buffer[$entry + 8] = [byte]($length -band 0xFF)
    $buffer[$entry + 9] = [byte](($length -shr 8) -band 0xFF)
    $buffer[$entry + 10] = [byte](($length -shr 16) -band 0xFF)
    $buffer[$entry + 11] = [byte](($length -shr 24) -band 0xFF)
    $buffer[$entry + 12] = [byte]($offset -band 0xFF)
    $buffer[$entry + 13] = [byte](($offset -shr 8) -band 0xFF)
    $buffer[$entry + 14] = [byte](($offset -shr 16) -band 0xFF)
    $buffer[$entry + 15] = [byte](($offset -shr 24) -band 0xFF)

    [System.Array]::Copy($blob, 0, $buffer, $offset, $length)
    $offset += $length
    $entry += 16
  }

  [System.IO.File]::WriteAllBytes($Path, $buffer)
}

Write-Host 'Mmail icons'

$icon512 = New-IconBitmap -Size 512
Save-Png -Bitmap $icon512 -Path (Join-Path $assets 'icon.png')
Save-Png -Bitmap $icon512 -Path (Join-Path $webAssets 'icon-512.png')

$icon192 = New-IconBitmap -Size 192
Save-Png -Bitmap $icon192 -Path (Join-Path $webAssets 'icon-192.png')
$icon192.Dispose()

# Windows .ico for the shortcut and installer: 16/32/48/256 PNG frames
Write-IcoFile -Path (Join-Path $assets 'icon.ico') -Sizes @(16, 32, 48, 256)
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
