# DeskVault - Copyright (C) 2026 TCPeep - https://github.com/TCPeep/DeskVault
# Licensed under GPL-3.0 with attribution terms (keep the credit). See LICENSE and NOTICE.
# Lists Microsoft Store (MSIX/AppX) apps the current user can remove, as JSON. Used by Storage > Installed apps.
# Only apps with a Start menu entry are listed; frameworks, system and non-removable packages are skipped.
$ErrorActionPreference = 'SilentlyContinue'
$start = @{}
foreach ($s in Get-StartApps) {
  $fam = ($s.AppID -split '!')[0]
  if ($fam -and -not $start.ContainsKey($fam)) { $start[$fam] = $s.Name }
}
$out = foreach ($p in Get-AppxPackage) {
  if ($p.IsFramework -or $p.IsResourcePackage -or $p.NonRemovable -or $p.SignatureKind -eq 'System') { continue }
  if (-not $start.ContainsKey($p.PackageFamilyName)) { continue }
  $logo = $null; $pub = $null
  try {
    $m = [xml](Get-Content -LiteralPath (Join-Path $p.InstallLocation 'AppxManifest.xml') -Raw)
    $logo = $m.Package.Properties.Logo
    $pub = $m.Package.Properties.PublisherDisplayName
    if ($pub -like 'ms-resource:*') { $pub = $null }
  } catch {}
  $installed = $null
  try { $installed = (Get-Item -LiteralPath $p.InstallLocation).CreationTimeUtc.ToString('o') } catch {}
  [pscustomobject]@{
    name = $start[$p.PackageFamilyName]; full = $p.PackageFullName; family = $p.PackageFamilyName
    version = "$($p.Version)"; publisher = $pub; location = $p.InstallLocation; logo = $logo
    installed = $installed; kind = "$($p.SignatureKind)"
  }
}
ConvertTo-Json -InputObject @($out) -Compress -Depth 3
