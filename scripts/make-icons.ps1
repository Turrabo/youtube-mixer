# Generates the extension icons (a mini mixing desk: three fader tracks with
# knobs at different positions) at 16/32/48/128 px using System.Drawing.
# Run once: pwsh scripts/make-icons.ps1
Add-Type -AssemblyName System.Drawing

$outDir = Join-Path $PSScriptRoot '..\icons'
New-Item -ItemType Directory -Force $outDir | Out-Null

foreach ($size in 16, 32, 48, 128) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::FromArgb(255, 32, 33, 36))

    $pad = [Math]::Max(2, [int]($size * 0.16))
    $trackWidth = [Math]::Max(1, [single]($size * 0.07))
    $trackPen = New-Object System.Drawing.Pen(
        [System.Drawing.Color]::FromArgb(150, 255, 255, 255), $trackWidth)
    $knobBrush = New-Object System.Drawing.SolidBrush(
        [System.Drawing.Color]::FromArgb(255, 255, 0, 51))

    # Three faders at different positions, like a live mix.
    $ys = @(0.28, 0.50, 0.72)
    $positions = @(0.72, 0.35, 0.55)
    for ($i = 0; $i -lt 3; $i++) {
        $y = [single]($size * $ys[$i])
        $g.DrawLine($trackPen, [single]$pad, $y, [single]($size - $pad), $y)
        $x = [single]($pad + ($size - 2 * $pad) * $positions[$i])
        $r = [Math]::Max(1.5, $size * 0.10)
        $g.FillEllipse($knobBrush, [single]($x - $r), [single]($y - $r),
            [single](2 * $r), [single](2 * $r))
    }

    $g.Dispose()
    $bmp.Save((Join-Path $outDir "icon$size.png"),
        [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Host "wrote icons/icon$size.png"
}
