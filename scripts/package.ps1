<#
.SYNOPSIS
  Package the extension into the zip the Chrome Web Store accepts.

.DESCRIPTION
  Writes youtube-mixer-v<version>.zip in the repo root, where <version> is read
  from manifest.json so the filename can never disagree with what is inside.

  WHAT SHIPS IS AN ALLOWLIST, not an exclusion list. A denylist silently ships
  every new file anyone adds later - a scratch note, a credential, the test
  profile - because nobody remembers to exclude it. This names the five things
  the store gets, and everything else in the repo stays out by default.

  Nothing is staged on disk: entries are written straight into the archive, so
  there is no temp directory to clean up and no partial copy to leave behind.

.PARAMETER Force
  Overwrite an existing zip of the same version. Without it, a version that has
  already been packaged is refused, because silently replacing it is how an
  uploaded artifact stops matching the one that was tested.

.OUTPUTS
  The path of the zip, plus the file list, so what shipped is visible rather
  than assumed.
#>
[CmdletBinding()]
param([switch]$Force)

$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot

# The store package, in full. Directories are taken whole.
$include = @('manifest.json', 'content', 'icons', 'popup', 'shared')

$manifest = Get-Content -LiteralPath (Join-Path $repo 'manifest.json') -Raw | ConvertFrom-Json
$version = $manifest.version
if (-not $version) { throw "manifest.json has no version" }

$zipPath = Join-Path $repo "youtube-mixer-v$version.zip"
if ((Test-Path -LiteralPath $zipPath) -and -not $Force) {
    throw "$zipPath already exists. Bump the version in manifest.json, or pass -Force to replace it."
}
if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }

# Collect (full path, archive path) pairs. Archive paths use forward slashes
# and are relative to the repo root, which is what the store expects.
$files = @()
foreach ($item in $include) {
    $source = Join-Path $repo $item
    if (-not (Test-Path -LiteralPath $source)) { throw "missing from the repo: $item" }
    if (Test-Path -LiteralPath $source -PathType Container) {
        foreach ($f in Get-ChildItem -LiteralPath $source -Recurse -File) {
            $rel = $f.FullName.Substring($repo.Length + 1).Replace('\', '/')
            $files += [pscustomobject]@{ Full = $f.FullName; Entry = $rel }
        }
    } else {
        $files += [pscustomobject]@{ Full = (Resolve-Path -LiteralPath $source).Path; Entry = $item }
    }
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::Open($zipPath, 'Create')
try {
    foreach ($f in ($files | Sort-Object Entry)) {
        [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
            $archive, $f.Full, $f.Entry, 'Optimal')
    }
} finally {
    $archive.Dispose()
}

Write-Output "packaged version $version -> $zipPath"
Write-Output "$($files.Count) files:"
$files | Sort-Object Entry | ForEach-Object { Write-Output "  $($_.Entry)" }
