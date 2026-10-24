# DeskVault - Copyright (C) 2026 TCPeep - https://github.com/TCPeep/DeskVault
# Licensed under GPL-3.0 with attribution terms (keep the credit). See LICENSE and NOTICE.
# Renders native\vault.ico (PNG-compressed entries). Only needed if you want to change the icon.
Add-Type -AssemblyName System.Drawing
$out = Join-Path $PSScriptRoot 'vault.ico'
$sizes = 16, 24, 32, 48, 64, 128, 256
$pngs = @()
foreach ($s in $sizes) {
  $bmp = New-Object System.Drawing.Bitmap $s, $s
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.Clear([System.Drawing.Color]::Transparent)
  $r = [single]($s * 0.22)
  $rect = New-Object System.Drawing.RectangleF 0, 0, ($s - 1), ($s - 1)
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.AddArc($rect.X, $rect.Y, $r * 2, $r * 2, 180, 90)
  $path.AddArc($rect.Right - $r * 2, $rect.Y, $r * 2, $r * 2, 270, 90)
  $path.AddArc($rect.Right - $r * 2, $rect.Bottom - $r * 2, $r * 2, $r * 2, 0, 90)
  $path.AddArc($rect.X, $rect.Bottom - $r * 2, $r * 2, $r * 2, 90, 90)
  $path.CloseFigure()
  $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush $rect, ([System.Drawing.Color]::FromArgb(255, 99, 102, 241)), ([System.Drawing.Color]::FromArgb(255, 168, 85, 247)), 45
  $g.FillPath($brush, $path)
  # vault door: ring + hub + three spokes
  $c = $s / 2.0
  $ringR = $s * 0.30
  $w = [single][Math]::Max(1.5, $s * 0.075)
  $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::White), $w
  $g.DrawEllipse($pen, [single]($c - $ringR), [single]($c - $ringR), [single]($ringR * 2), [single]($ringR * 2))
  if ($s -ge 24) {
    $hub = $s * 0.075
    $g.FillEllipse([System.Drawing.Brushes]::White, [single]($c - $hub), [single]($c - $hub), [single]($hub * 2), [single]($hub * 2))
    $pen2 = New-Object System.Drawing.Pen ([System.Drawing.Color]::White), ([single][Math]::Max(1, $s * 0.05))
    foreach ($deg in 90, 210, 330) {
      $rad = $deg * [Math]::PI / 180
      $g.DrawLine($pen2, [single]($c + [Math]::Cos($rad) * $hub), [single]($c - [Math]::Sin($rad) * $hub), [single]($c + [Math]::Cos($rad) * ($ringR - $w)), [single]($c - [Math]::Sin($rad) * ($ringR - $w)))
    }
  } else {
    $hub = $s * 0.1
    $g.FillEllipse([System.Drawing.Brushes]::White, [single]($c - $hub), [single]($c - $hub), [single]($hub * 2), [single]($hub * 2))
  }
  $g.Dispose()
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $pngs += , $ms.ToArray()
  $bmp.Dispose()
}
$fs = [System.IO.File]::Create($out)
$bw = New-Object System.IO.BinaryWriter $fs
$bw.Write([UInt16]0); $bw.Write([UInt16]1); $bw.Write([UInt16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $s = $sizes[$i]; $d = $pngs[$i]
  $bw.Write([byte]($(if ($s -ge 256) { 0 } else { $s }))); $bw.Write([byte]($(if ($s -ge 256) { 0 } else { $s })))
  $bw.Write([byte]0); $bw.Write([byte]0); $bw.Write([UInt16]1); $bw.Write([UInt16]32)
  $bw.Write([UInt32]$d.Length); $bw.Write([UInt32]$offset)
  $offset += $d.Length
}
foreach ($d in $pngs) { $bw.Write($d) }
$bw.Close()
"wrote $out"
