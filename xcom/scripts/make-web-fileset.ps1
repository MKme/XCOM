param(
  # A label used in the output folder name (version, date, etc.)
  # Examples: '1.0.18', '2026-02-05', 'dev'
  [string]$Label = (Get-Date -Format 'yyyy-MM-dd_HHmm'),

  # Included for parity with XTOC. XCOM uses relative paths so it can be hosted from any subfolder.
  # Use '/' for root hosting, or '/xcom/' for https://example.com/xcom/
  [string]$BasePath = '/',

  # Access gating mode:
  # - license: forced activation screen (recommended for public builds)
  # - off: no gate (internal / local builds)
  [ValidateSet('license','off')]
  [string]$AccessMode = 'license',

  # Optional override for the license proxy URL.
  # Default is to host it next to the app: /xcom/license.php
  [string]$LicenseProxyUrl = '',

  # If set, skip `npm install` (useful if deps are already installed)
  [switch]$SkipInstall,

  # If set, skip `npm run build` and just package the latest existing release under releases/.
  # Useful if a previous build already created releases/xcom-<version>/ and you only want to re-package.
  [switch]$SkipBuild,

  # If set, skip running unit tests (faster packaging, not recommended for release builds).
  [switch]$SkipTests,

  # If set, include the pre-generated offline basemap tile pack under assets/tiles/.
  # Note: this can be thousands+ of PNGs and can slow down zipping significantly.
  [switch]$IncludeOfflineTiles,

  # If set, include JS payload wrappers for large datasets (callsigns.js, world-cities.js).
  # For hosted/PWA use, JSON/GeoJSON is preferred and smaller/faster to package.
  [switch]$IncludeJsPayloads,

  # If set, include helper files alongside the web build:
  # - server-side license proxy files (license.php/.htaccess/README)
  # - standalone MANET bridge helper (halow-bridge/) if available
  [switch]$IncludeHelpers,

  # If set, also create a .zip file in releases/ containing the entire fileset folder contents.
  [switch]$Zip,

  # Zip compression level (only used when -Zip is set).
  [ValidateSet('Optimal','Fastest','NoCompression')]
  [string]$CompressionLevel = 'Optimal'
)

$ErrorActionPreference = 'Stop'

function Invoke-ExternalOk {
  param(
    [Parameter(Mandatory = $true)]
    [ScriptBlock]$Command,
    [Parameter(Mandatory = $true)]
    [string]$ErrorMessage
  )

  # Windows PowerShell 5.1 may treat stderr output from native commands as a
  # non-terminating error record. Temporarily relax error handling and rely on
  # $LASTEXITCODE instead.
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & $Command
  }
  finally {
    $ErrorActionPreference = $prev
  }

  if ($LASTEXITCODE -ne 0) {
    throw ("{0} (exit code {1})" -f $ErrorMessage, $LASTEXITCODE)
  }
}

function Get-SafeBaseName([string]$basePath) {
  if ($null -eq $basePath) { $basePath = '' }
  $safe = $basePath.Trim('/').Replace('/', '-')
  if (-not $safe) { $safe = 'root' }
  return $safe
}

function Get-JsonValue([string]$path) {
  try {
    $raw = Get-Content -Path $path -Raw -Encoding UTF8
    return $raw | ConvertFrom-Json
  }
  catch {
    return $null
  }
}

$root = Resolve-Path (Join-Path $PSScriptRoot '..')         # .../xcom
$repoRoot = Resolve-Path (Join-Path $root '..')             # .../XCOM
$outDir = Join-Path $root 'releases'

$safeBase = Get-SafeBaseName $BasePath

Write-Host "Preparing webserver fileset..." -ForegroundColor Cyan
Write-Host "BASE_PATH=$BasePath" -ForegroundColor Cyan
Write-Host "ACCESS_MODE=$AccessMode" -ForegroundColor Cyan
if ($LicenseProxyUrl) { Write-Host "LICENSE_PROXY_URL=$LicenseProxyUrl" -ForegroundColor Cyan }

Push-Location $root
try {
  if (-not $SkipBuild) {
    if (-not $SkipInstall) {
      Invoke-ExternalOk -Command { npm install } -ErrorMessage 'npm install failed'
    }

    if (-not $SkipTests) {
      Invoke-ExternalOk -Command { npm run test-trusted-mode } -ErrorMessage 'npm run test-trusted-mode failed'
    }

    # XCOM's `npm run build` creates releases/xcom-<version>/ and bumps the patch version.
    Invoke-ExternalOk -Command { npm run build } -ErrorMessage 'npm run build failed'
  } else {
    Write-Host "SkipBuild set: packaging latest existing release under releases/ (no npm install/build)" -ForegroundColor Cyan
  }
}
finally {
  Pop-Location
}

New-Item -ItemType Directory -Force -Path $outDir | Out-Null

# Find the release folder we just built.
$pkg = Get-JsonValue (Join-Path $root 'package.json')
$xcomVersion = ''
$releaseDir = ''
if ($pkg -and $pkg.version) {
  $xcomVersion = [string]$pkg.version
  $candidate = Join-Path $outDir ("xcom-{0}" -f $xcomVersion)
  if (Test-Path $candidate) { $releaseDir = $candidate }
}
if (-not $releaseDir) {
  $latest = Get-ChildItem -Path $outDir -Directory -Filter 'xcom-*' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($latest) { $releaseDir = $latest.FullName }
}
if (-not $releaseDir) {
  throw "No release folders found under $outDir. Run `npm run build` first."
}

# If we packaged a different release folder than package.json indicates (common when -SkipBuild is used),
# prefer the release folder version for naming so the fileset directory reflects what was actually copied.
try {
  $leaf = Split-Path $releaseDir -Leaf
  if ($leaf -match '^xcom-(\d+\.\d+\.\d+.*)$') {
    $xcomVersion = [string]$Matches[1]
  }
} catch { }

# Include the app version in the output folder name, unless the label already contains one.
# Examples:
# - Label=dev, Version=1.0.28 -> xcom-web-fileset-1.0.28-dev-xcom
# - Label=1.0.28-license -> xcom-web-fileset-1.0.28-license-xcom (no duplication)
$labelHasVersion = $false
if ($Label -match '(?<!\d)\d+\.\d+\.\d+(?!\d)') { $labelHasVersion = $true }

$nameParts = @('xcom-web-fileset')
if (($xcomVersion) -and (-not $labelHasVersion)) {
  $nameParts += $xcomVersion
}
if ($Label) {
  $nameParts += $Label
}
$nameParts += $safeBase

$filesetDir = Join-Path $outDir ($nameParts -join '-')

Write-Host "Building webserver fileset: $filesetDir" -ForegroundColor Cyan

if (Test-Path $filesetDir) {
  Remove-Item $filesetDir -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $filesetDir | Out-Null

Write-Host "Copying $releaseDir/* -> $filesetDir" -ForegroundColor Cyan
Copy-Item -Path (Join-Path $releaseDir '*') -Destination $filesetDir -Recurse -Force

# Fix common trademark mojibake / encoding issues in older builds.
# We prefer ASCII-safe JS escapes so the app name renders correctly regardless of server charset headers.
try {
  $appMainPath = Join-Path $filesetDir 'app-main.js'
  if (Test-Path $appMainPath) {
    $js = Get-Content -Path $appMainPath -Raw -Encoding UTF8

    # "â„¢" is a common mojibake form of "™" when UTF-8 bytes were decoded as Windows-1252.
    $tmMojibake = ([string][char]0x00E2) + ([string][char]0x201E) + ([string][char]0x00A2)
    $tmChar = [string][char]0x2122

    $fixed = $js
      .Replace("XCOM$tmMojibake", 'XCOM\u2122')
      .Replace("XCOM$tmChar", 'XCOM\u2122')

    if ($fixed -ne $js) {
      Set-Content -Path $appMainPath -Value $fixed -Encoding UTF8
    }
  }
} catch {
  # Non-fatal
}

# Inject a tiny runtime config file into the fileset so hosting can be customized without rebuilding.
# This relies on app-main.js checking globalThis.XCOM_ACCESS_MODE (added for parity with XTOC builds).
$cfgPath = Join-Path $filesetDir 'xcom-config.js'
$escapedProxy = $LicenseProxyUrl.Replace('\', '\\').Replace("'", "\'")

$cfgLines = @()
$cfgLines += ';(function () {'
$cfgLines += "  try { globalThis.XCOM_ACCESS_MODE = '$AccessMode' } catch (_) {}"
if ($LicenseProxyUrl) {
  $cfgLines += "  try { globalThis.XCOM_LICENSE_PROXY_URL = '$escapedProxy' } catch (_) {}"
}
$cfgLines += '})();'
$cfgOut = ($cfgLines | Where-Object { $_ -ne '' }) -join "`r`n"
Set-Content -Path $cfgPath -Value $cfgOut -Encoding UTF8

# Ensure index.html loads xcom-config.js before app-main.js (fileset only).
$indexPath = Join-Path $filesetDir 'index.html'
if (Test-Path $indexPath) {
  $html = Get-Content -Path $indexPath -Raw -Encoding UTF8
  if ($html -notmatch 'xcom-config\.js') {
    if ($html -match '<script\s+src="app-main\.js') {
      $html = $html.Replace('<script src="app-main.js', '<script src="xcom-config.js"></script>' + "`r`n    " + '<script src="app-main.js')
    } else {
      # Fallback: insert before </body>
      $html = $html.Replace('</body>', "    <script src=`"xcom-config.js`"></script>`r`n</body>")
    }
    Set-Content -Path $indexPath -Value $html -Encoding UTF8
  }
}

# Optional: include server-side helper files used for license validation (and deployment checklist).
# If AccessMode is license, include these by default so /xcom/license.php exists after upload.
$includeServerHelpers = $IncludeHelpers -or ($AccessMode -eq 'license')
if ($includeServerHelpers) {
  $serverDir = Join-Path $repoRoot 'site\xcom\keys etc NOGIT'
  if (Test-Path $serverDir) {
    Write-Host "Including server license proxy files -> $filesetDir" -ForegroundColor Cyan
    $toCopy = @(
      'license.php',
      '.htaccess',
      'README.md'
    )
    foreach ($f in $toCopy) {
      $src = Join-Path $serverDir $f
      if (Test-Path $src) {
        if ($f -eq '.htaccess') {
          $ht = Get-Content -Path $src -Raw -Encoding UTF8
          $base = $BasePath
          if (-not $base) { $base = '/' }
          if (-not $base.StartsWith('/')) { $base = '/' + $base }
          if (-not $base.EndsWith('/')) { $base = $base + '/' }
          $indexPath = $base + 'index.html'
          $ht = $ht -replace 'RewriteRule\s+\.\s+/[^ \t\r\n]+/index\.html\s+\[L\]', ("RewriteRule . {0} [L]" -f $indexPath)
          $dest = Join-Path $filesetDir $f
          # Write UTF-8 without BOM to avoid Apache 500s on some hosts.
          [System.IO.File]::WriteAllText($dest, $ht, (New-Object System.Text.UTF8Encoding($false)))
        } else {
          Copy-Item -Path $src -Destination (Join-Path $filesetDir $f) -Force
        }
      }
    }
  }
}

# Record build metadata to help debug "old version" issues.
$commit = ''
if (Test-Path (Join-Path $repoRoot '.git')) {
  try {
    Invoke-ExternalOk -Command { git -C $repoRoot rev-parse --short HEAD } -ErrorMessage 'git rev-parse failed'
    $commit = (git -C $repoRoot rev-parse --short HEAD | Out-String).Trim()
  }
  catch {
    $commit = ''
  }
}

$buildInfo = @(
  "label=$Label",
  "basePath=$BasePath",
  "safeBase=$safeBase",
  "accessMode=$AccessMode",
  ("licenseProxyUrl={0}" -f ($(if ($LicenseProxyUrl) { $LicenseProxyUrl } else { '(default)' }))),
  ("xcomVersion={0}" -f ($(if ($xcomVersion) { $xcomVersion } else { '(unknown)' }))),
  ("sourceReleaseDir={0}" -f (Split-Path $releaseDir -Leaf)),
  "gitCommit=$commit",
  ("builtAt={0}" -f (Get-Date).ToString('o'))
) -join "`r`n"

$buildInfoPath = Join-Path $filesetDir 'BUILD_INFO.txt'
Set-Content -Path $buildInfoPath -Value $buildInfo -Encoding UTF8

function Remove-PythonJunk([string]$dir) {
  if (-not $dir) { return }
  try { Remove-Item -Path (Join-Path $dir '__pycache__') -Recurse -Force -ErrorAction SilentlyContinue } catch {}
  try { Remove-Item -Path (Join-Path $dir '.venv') -Recurse -Force -ErrorAction SilentlyContinue } catch {}
  try { Remove-Item -Path (Join-Path $dir '.pytest_cache') -Recurse -Force -ErrorAction SilentlyContinue } catch {}
  try { Remove-Item -Path (Join-Path $dir '.mypy_cache') -Recurse -Force -ErrorAction SilentlyContinue } catch {}
  try { Remove-Item -Path (Join-Path $dir '.ruff_cache') -Recurse -Force -ErrorAction SilentlyContinue } catch {}
}

# Optional: include standalone helper tool folders (ship these in downloadable release zips).
if ($IncludeHelpers) {
  $repoParent = $null
  try { $repoParent = Resolve-Path (Join-Path $repoRoot '..') } catch { $repoParent = $null }

  $halowCandidates = @(
    (Join-Path $repoRoot 'halow-bridge'),
    (Join-Path $repoRoot 'helpers\\halow-bridge'),
    ($(if ($repoParent) { Join-Path $repoParent 'XTOC\\halow-bridge' } else { '' }))
  ) | Where-Object { $_ -and (Test-Path $_) }

  $halowBridgeSrc = $halowCandidates | Select-Object -First 1
  if ($halowBridgeSrc) {
    Write-Host "Including halow-bridge -> $filesetDir" -ForegroundColor Cyan
    Copy-Item -Path $halowBridgeSrc -Destination (Join-Path $filesetDir 'halow-bridge') -Recurse -Force
    Remove-PythonJunk (Join-Path $filesetDir 'halow-bridge')
  } else {
    $msg = "IncludeHelpers set, but halow-bridge was not found. Expected one of: XCOM\\halow-bridge, XCOM\\helpers\\halow-bridge, or a sibling repo at ..\\XTOC\\halow-bridge."
    if ($Zip) { throw $msg } else { Write-Warning $msg }
  }
}

function Remove-IfExists([string]$p) {
  if (-not $p) { return }
  if (Test-Path -LiteralPath $p) {
    try {
      Remove-Item -LiteralPath $p -Recurse -Force
    } catch {
      try { Remove-Item -LiteralPath $p -Force } catch { }
    }
  }
}

# Slim the fileset by default: remove redundant JS payloads and optional offline tile packs.
if (-not $IncludeJsPayloads) {
  Remove-IfExists (Join-Path $filesetDir 'assets\data\callsigns.js')
  Remove-IfExists (Join-Path $filesetDir 'assets\data\world-cities.js')
}
if (-not $IncludeOfflineTiles) {
  Remove-IfExists (Join-Path $filesetDir 'assets\tiles')
}

# Quick audit summary before zipping (helps catch accidental huge folders).
try {
  $allFiles = Get-ChildItem -Path $filesetDir -Recurse -File -ErrorAction Stop
  $totalBytes = ($allFiles | Measure-Object -Sum Length).Sum
  Write-Host ("Fileset size: {0:N1} MB across {1} files" -f ($totalBytes / 1MB), $allFiles.Count) -ForegroundColor Cyan
  Write-Host "Largest files:" -ForegroundColor Cyan
  $allFiles | Sort-Object Length -Descending | Select-Object -First 8 | ForEach-Object {
    $rel = $_.FullName.Substring($filesetDir.Length + 1)
    Write-Host ("  {0,8:N1} MB  {1}" -f ($_.Length / 1MB), $rel) -ForegroundColor Cyan
  }
} catch {
  # Non-fatal
}

if ($Zip) {
  $zipPath = Join-Path $outDir ("{0}.zip" -f (Split-Path $filesetDir -Leaf))
  if (Test-Path $zipPath) { Remove-Item $zipPath -Force }

  Write-Host "Zipping fileset -> $zipPath" -ForegroundColor Cyan
  # Zip the CONTENTS of the fileset folder (not the parent folder)
  Compress-Archive -Path (Join-Path $filesetDir '*') -DestinationPath $zipPath -CompressionLevel $CompressionLevel
}

Write-Host "Done." -ForegroundColor Green
Write-Host "Upload the CONTENTS of this folder to your web server docroot:" -ForegroundColor Green
Write-Host "  $filesetDir" -ForegroundColor Green
