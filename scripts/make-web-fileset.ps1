param(
  [string]$Label = (Get-Date -Format 'yyyy-MM-dd_HHmm'),
  [string]$BasePath = '/',
  [ValidateSet('license','off')]
  [string]$AccessMode = 'license',
  [string]$LicenseProxyUrl = '',
  [switch]$SkipInstall,
  [switch]$SkipBuild,
  [switch]$IncludeOfflineTiles,
  [switch]$IncludeJsPayloads,
  [switch]$IncludeHelpers,
  [switch]$Zip,
  [ValidateSet('Optimal','Fastest','NoCompression')]
  [string]$CompressionLevel = 'Optimal'
)

$ErrorActionPreference = 'Stop'

$inner = Resolve-Path (Join-Path $PSScriptRoot '..\\xcom\\scripts\\make-web-fileset.ps1')
if (-not (Test-Path $inner)) {
  throw "Expected script not found: $inner"
}

& $inner @PSBoundParameters
