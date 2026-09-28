# Draws Taskyard's app icon (build/icon.png 512 px + build/icon.ico with 16–256 px PNG frames).
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/make-icon.ps1
#
# The mark: four glass "fences" in a 2 x 2 grid on the dark Flux navy, the top-left one lit in the
# cyan → blue accent gradient (tokens.css). GDI+ draws each size natively, so the small frames
# stay crisp instead of being scaled down from 256 px. build/icon.ico is the exe, installer,
# Start menu, notification and tray icon.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$build = Join-Path $root 'build'

function New-RoundedPath([single]$x, [single]$y, [single]$w, [single]$h, [single]$r) {
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = [Math]::Max(1, 2 * $r)
  $path.AddArc($x, $y, $d, $d, 180, 90)
  $path.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $path.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $path.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $path.CloseFigure()
  return $path
}

function New-IconBitmap([int]$size) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.PixelOffsetMode = 'HighQuality'
  $g.Clear([System.Drawing.Color]::Transparent)
  $s = [single]$size

  # Background: rounded square, navy gradient.
  $bg = New-RoundedPath 0 0 $s $s ($s * 0.22)
  $bgBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush (New-Object System.Drawing.PointF 0, 0), (New-Object System.Drawing.PointF $s, $s), ([System.Drawing.Color]::FromArgb(255, 16, 28, 52)), ([System.Drawing.Color]::FromArgb(255, 6, 11, 22))
  $g.FillPath($bgBrush, $bg)

  # Four fences.
  $margin = $s * 0.19
  $gap = $s * 0.08
  $tile = ($s - 2 * $margin - $gap) / 2
  $radius = [Math]::Max(1, $s * 0.07)
  $lit = New-Object System.Drawing.Drawing2D.LinearGradientBrush (New-Object System.Drawing.PointF $margin, $margin), (New-Object System.Drawing.PointF ($margin + $tile), ($margin + $tile)), ([System.Drawing.Color]::FromArgb(255, 0, 229, 255)), ([System.Drawing.Color]::FromArgb(255, 0, 119, 255))
  $glass = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(70, 170, 220, 255))
  $edge = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(150, 0, 229, 255)), ([Math]::Max(1, $s / 64))
  for ($i = 0; $i -lt 4; $i++) {
    $x = $margin + ($i % 2) * ($tile + $gap)
    $y = $margin + [Math]::Floor($i / 2) * ($tile + $gap)
    $path = New-RoundedPath $x $y $tile $tile $radius
    if ($i -eq 0) { $g.FillPath($lit, $path) } else { $g.FillPath($glass, $path); $g.DrawPath($edge, $path) }
    $path.Dispose()
  }
  $g.Dispose()
  return $bmp
}

function Get-PngBytes([System.Drawing.Bitmap]$bmp) {
  $stream = New-Object System.IO.MemoryStream
  $bmp.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
  return , $stream.ToArray()
}

# 512 px PNG (README, electron-builder fallback).
$big = New-IconBitmap 512
$big.Save((Join-Path $build 'icon.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$big.Dispose()

# ICO: header, one directory entry per size, then the PNG frames.
$sizes = 16, 20, 24, 32, 40, 48, 64, 128, 256
$frames = foreach ($size in $sizes) { $b = New-IconBitmap $size; , (Get-PngBytes $b); $b.Dispose() }
$out = New-Object System.IO.MemoryStream
$w = New-Object System.IO.BinaryWriter $out
$w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $dim = if ($sizes[$i] -ge 256) { 0 } else { $sizes[$i] }
  $w.Write([byte]$dim); $w.Write([byte]$dim); $w.Write([byte]0); $w.Write([byte]0)
  $w.Write([uint16]1); $w.Write([uint16]32)
  $w.Write([uint32]$frames[$i].Length); $w.Write([uint32]$offset)
  $offset += $frames[$i].Length
}
foreach ($frame in $frames) { $w.Write($frame) }
$w.Flush()
[System.IO.File]::WriteAllBytes((Join-Path $build 'icon.ico'), $out.ToArray())
Write-Output "make-icon: wrote build/icon.png and build/icon.ico ($($sizes -join ', ') px)"
