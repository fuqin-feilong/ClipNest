$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$assets = Join-Path $root 'assets'
$temp = Join-Path $env:TEMP 'clipnest-icon-build'
New-Item -ItemType Directory -Force -Path $assets | Out-Null
if (Test-Path $temp) { Remove-Item -Recurse -Force $temp }
New-Item -ItemType Directory -Force -Path $temp | Out-Null

function New-RoundedPath {
    param(
        [float]$X,
        [float]$Y,
        [float]$Width,
        [float]$Height,
        [float]$Radius
    )
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $diameter = $Radius * 2
    $path.AddArc($X, $Y, $diameter, $diameter, 180, 90)
    $path.AddArc($X + $Width - $diameter, $Y, $diameter, $diameter, 270, 90)
    $path.AddArc($X + $Width - $diameter, $Y + $Height - $diameter, $diameter, $diameter, 0, 90)
    $path.AddArc($X, $Y + $Height - $diameter, $diameter, $diameter, 90, 90)
    $path.CloseFigure()
    return $path
}

function New-ClipNestIcon {
    param([int]$Size)

    $bitmap = [System.Drawing.Bitmap]::new($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $graphics.Clear([System.Drawing.Color]::Transparent)

    $s = [float]$Size
    $radius = [Math]::Max(2.4, $s * 0.235)
    $bgRect = [System.Drawing.RectangleF]::new(0, 0, $s, $s)
    $bgPath = New-RoundedPath 0 0 $s $s $radius

    $gradient = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
        $bgRect,
        [System.Drawing.Color]::FromArgb(255, 158, 139, 255),
        [System.Drawing.Color]::FromArgb(255, 85, 141, 247),
        [System.Drawing.Drawing2D.LinearGradientMode]::ForwardDiagonal
    )
    $graphics.FillPath($gradient, $bgPath)

    $highlightPath = New-RoundedPath ($s * 0.04) ($s * 0.035) ($s * 0.92) ($s * 0.44) ([Math]::Max(1.5, $s * 0.18))
    $highlight = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
        [System.Drawing.RectangleF]::new(0, 0, $s, $s * 0.5),
        [System.Drawing.Color]::FromArgb(72, 255, 255, 255),
        [System.Drawing.Color]::FromArgb(0, 255, 255, 255),
        [System.Drawing.Drawing2D.LinearGradientMode]::Vertical
    )
    $graphics.FillPath($highlight, $highlightPath)

    $backPath = New-RoundedPath ($s * 0.335) ($s * 0.155) ($s * 0.425) ($s * 0.60) ($s * 0.125)
    $backBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(105, 255, 255, 255))
    $graphics.FillPath($backBrush, $backPath)

    $frontX = $s * 0.215
    $frontY = $s * 0.255
    $frontW = $s * 0.50
    $frontH = $s * 0.585
    $frontPath = New-RoundedPath $frontX $frontY $frontW $frontH ($s * 0.135)

    if ($Size -ge 32) {
        $shadowPath = New-RoundedPath ($frontX + $s * 0.008) ($frontY + $s * 0.02) $frontW $frontH ($s * 0.135)
        $shadowBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(32, 42, 34, 120))
        $graphics.FillPath($shadowBrush, $shadowPath)
        $shadowBrush.Dispose()
        $shadowPath.Dispose()
    }

    $frontBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 255, 255, 255))
    $graphics.FillPath($frontBrush, $frontPath)

    if ($Size -ge 32) {
        $linePen = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(255, 111, 103, 236), [Math]::Max(1.1, $s * 0.052))
        $linePen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
        $linePen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
        $graphics.DrawLine($linePen, $s * 0.335, $s * 0.43, $s * 0.585, $s * 0.43)
        $graphics.DrawLine($linePen, $s * 0.335, $s * 0.535, $s * 0.625, $s * 0.535)
        $graphics.DrawLine($linePen, $s * 0.335, $s * 0.64, $s * 0.535, $s * 0.64)
        $linePen.Dispose()
    } else {
        $lineBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 111, 103, 236))
        $lineY = [Math]::Round($s * 0.47)
        $graphics.FillRectangle($lineBrush, [Math]::Round($s * 0.335), $lineY, [Math]::Round($s * 0.27), [Math]::Max(1, [Math]::Round($s * 0.07)))
        $lineBrush.Dispose()
    }

    $frontBrush.Dispose()
    $backBrush.Dispose()
    $highlight.Dispose()
    $gradient.Dispose()
    $frontPath.Dispose()
    $backPath.Dispose()
    $highlightPath.Dispose()
    $bgPath.Dispose()
    $graphics.Dispose()

    $file = Join-Path $temp "$Size.png"
    $bitmap.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
    $bitmap.Dispose()
    return $file
}

$sizes = @(16, 20, 24, 32, 40, 48, 64, 128, 256)
$pngFiles = @{}
foreach ($size in $sizes) {
    $pngFiles[$size] = New-ClipNestIcon -Size $size
}

Copy-Item $pngFiles[256] (Join-Path $assets 'icon.png') -Force

function Write-Ico {
    param(
        [string]$Output,
        [int[]]$Sizes
    )

    $images = [System.Collections.Generic.List[byte[]]]::new()
    foreach ($size in $Sizes) {
        $images.Add([System.IO.File]::ReadAllBytes($pngFiles[$size]))
    }

    $stream = [System.IO.File]::Open($Output, [System.IO.FileMode]::Create)
    $writer = [System.IO.BinaryWriter]::new($stream)
    try {
        $writer.Write([UInt16]0)
        $writer.Write([UInt16]1)
        $writer.Write([UInt16]$Sizes.Count)

        $offset = 6 + (16 * $Sizes.Count)
        for ($i = 0; $i -lt $Sizes.Count; $i++) {
            $size = $Sizes[$i]
            $byteSize = if ($size -ge 256) { 0 } else { $size }
            $writer.Write([byte]$byteSize)
            $writer.Write([byte]$byteSize)
            $writer.Write([byte]0)
            $writer.Write([byte]0)
            $writer.Write([UInt16]1)
            $writer.Write([UInt16]32)
            $writer.Write([UInt32]$images[$i].Length)
            $writer.Write([UInt32]$offset)
            $offset += $images[$i].Length
        }

        foreach ($image in $images) {
            $writer.Write($image)
        }
    } finally {
        $writer.Dispose()
        $stream.Dispose()
    }
}

Write-Ico (Join-Path $assets 'icon.ico') @(16, 24, 32, 48, 64, 128, 256)
Write-Ico (Join-Path $assets 'tray.ico') @(16, 20, 24, 32, 40, 48)

Remove-Item -Recurse -Force $temp
Write-Host "Generated icons in $assets"

