# Build icon.ico + NSIS bitmaps from build/icon-source.png
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$build = Join-Path $root "build"
New-Item -ItemType Directory -Force -Path $build | Out-Null

$sourcePath = Join-Path $build "icon-source.png"
if (-not (Test-Path $sourcePath)) {
  throw "Missing build/icon-source.png"
}

$src = [System.Drawing.Image]::FromFile($sourcePath)

function Resize-Square([System.Drawing.Image]$img, [int]$size) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.Clear([System.Drawing.Color]::FromArgb(255, 0, 122, 255))
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.DrawImage($img, 0, 0, $size, $size)
  $g.Dispose()
  return $bmp
}

function New-SidebarFromLogo([System.Drawing.Image]$img, [int]$w, [int]$h) {
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.Clear([System.Drawing.Color]::FromArgb(255, 0, 122, 255))
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $side = [Math]::Min($w - 24, [int]($h * 0.42))
  $x = [int](($w - $side) / 2)
  $y = [int](($h - $side) / 2) - 20
  $g.DrawImage($img, $x, $y, $side, $side)
  $white = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
  $font = New-Object System.Drawing.Font "Segoe UI", 10, ([System.Drawing.FontStyle]::Bold)
  $sf = New-Object System.Drawing.StringFormat
  $sf.Alignment = [System.Drawing.StringAlignment]::Center
  $rect = New-Object System.Drawing.RectangleF 4, ($y + $side + 12), ($w - 8), 40
  $g.DrawString("Zalo Work Digest", $font, $white, $rect, $sf)
  $g.Dispose()
  return $bmp
}

function New-HeaderFromLogo([System.Drawing.Image]$img, [int]$w, [int]$h) {
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.Clear([System.Drawing.Color]::FromArgb(255, 0, 122, 255))
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $side = $h - 10
  $g.DrawImage($img, 8, 5, $side, $side)
  $white = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
  $font = New-Object System.Drawing.Font "Segoe UI", 11, ([System.Drawing.FontStyle]::Bold)
  $g.DrawString("Zalo Work Digest", $font, $white, ($side + 16), [int](($h - 18) / 2))
  $g.Dispose()
  return $bmp
}

$png256 = Resize-Square $src 256
$pngPath = Join-Path $build "icon.png"
$png256.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)

$sidebar = New-SidebarFromLogo $src 164 314
$sidebar.Save((Join-Path $build "installerSidebar.bmp"), [System.Drawing.Imaging.ImageFormat]::Bmp)
$sidebar.Dispose()

$header = New-HeaderFromLogo $src 150 57
$header.Save((Join-Path $build "installerHeader.bmp"), [System.Drawing.Imaging.ImageFormat]::Bmp)
$header.Dispose()

$icoPath = Join-Path $build "icon.ico"
$sizes = 16,32,48,64,128,256
$tmpDir = Join-Path $env:TEMP ("zalo-icons-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null
$pngFiles = @()
foreach ($s in $sizes) {
  $scaled = Resize-Square $src $s
  $f = Join-Path $tmpDir ("icon-$s.png")
  $scaled.Save($f, [System.Drawing.Imaging.ImageFormat]::Png)
  $scaled.Dispose()
  $pngFiles += $f
}
$png256.Dispose()
$src.Dispose()

function Write-IcoFromPngs([string]$outIco, [string[]]$files) {
  $streams = @()
  foreach ($f in $files) {
    $bytes = [System.IO.File]::ReadAllBytes($f)
    $img = [System.Drawing.Image]::FromFile($f)
    $streams += ,@($img.Width, $img.Height, $bytes)
    $img.Dispose()
  }
  $ms = New-Object System.IO.MemoryStream
  $bw = New-Object System.IO.BinaryWriter $ms
  $bw.Write([uint16]0)
  $bw.Write([uint16]1)
  $bw.Write([uint16]$streams.Count)
  $offset = 6 + (16 * $streams.Count)
  foreach ($entry in $streams) {
    $w = [int]$entry[0]; if ($w -ge 256) { $w = 0 }
    $h = [int]$entry[1]; if ($h -ge 256) { $h = 0 }
    $bw.Write([byte]$w)
    $bw.Write([byte]$h)
    $bw.Write([byte]0)
    $bw.Write([byte]0)
    $bw.Write([uint16]1)
    $bw.Write([uint16]32)
    $bw.Write([uint32]$entry[2].Length)
    $bw.Write([uint32]$offset)
    $offset += $entry[2].Length
  }
  foreach ($entry in $streams) { $bw.Write($entry[2]) }
  $bw.Flush()
  [System.IO.File]::WriteAllBytes($outIco, $ms.ToArray())
  $bw.Dispose(); $ms.Dispose()
}

Write-IcoFromPngs $icoPath $pngFiles
Remove-Item -Recurse -Force $tmpDir
Write-Host "OK icon.ico icon.png installer bitmaps"
