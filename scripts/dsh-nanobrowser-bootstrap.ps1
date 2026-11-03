# Build the DSH x Nanobrowser bridge extension on a fresh machine.
# Run this in a normal terminal: WXT/SWC needs %LOCALAPPDATA%\swc and child processes, which the DSH file sandbox blocks.
[CmdletBinding()]
param(
  [string]$RepoRoot,
  [switch]$SkipInstall,
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'

function Write-Step([string]$Text) {
  Write-Host "`n==> $Text" -ForegroundColor Cyan
}

function Invoke-Checked([string]$Label, [scriptblock]$Command) {
  & $Command
  if ($LASTEXITCODE -ne 0) { throw "$Label failed with exit code $LASTEXITCODE" }
}

if (-not $RepoRoot) {
  $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
} else {
  $RepoRoot = (Resolve-Path $RepoRoot).Path
}
Write-Step "Repository: $RepoRoot"

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw 'Node.js 24 LTS (>= 24.22.1) is required.' }
Write-Host "node $(& node --version)"

$pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
if (-not $pnpm) {
  Write-Step 'pnpm is not on PATH; enabling Corepack'
  & corepack enable
  $pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
  if (-not $pnpm) { throw 'pnpm is unavailable; install pnpm 10.34.7 or enable Corepack.' }
}
Write-Host "pnpm $(& pnpm --version)"

if (-not $SkipInstall) {
  Write-Step 'Installing dependencies'
  Push-Location $RepoRoot
  try {
    Invoke-Checked 'pnpm install' { pnpm install }
  } finally {
    Pop-Location
  }
}

if (-not $SkipBuild) {
  Write-Step 'Building the bridge extension (WXT_BRIDGE=1)'
  $env:npm_config_engine_strict = 'false'
  $env:WXT_BRIDGE = '1'
  $env:WXT_BRIDGE_PORT = '8790'
  $env:WXT_BRIDGE_TOKEN = 'dev-token'
  Push-Location $RepoRoot
  try {
    Invoke-Checked 'pnpm build' { pnpm build }
  } finally {
    Pop-Location
  }
}

$dist = Join-Path $RepoRoot 'dist'
if (-not (Test-Path (Join-Path $dist 'manifest.json'))) {
  throw "Build output is missing: $dist\manifest.json"
}
Write-Step "Extension ready: $dist"
Write-Host 'Load it in Chrome: chrome://extensions -> Developer mode -> Load unpacked -> the folder above.'
Write-Host ''
Write-Host 'Then install the two bundles in the new DSH (Creator mode):'
Write-Host "  plugin_manager install_bundle `"$(Join-Path $RepoRoot 'dsh-plugin\nanobrowser')`" enabled:true"
Write-Host "  plugin_manager install_bundle `"$(Join-Path $RepoRoot 'dsh-plugin\nanobrowser-ui')`" enabled:true"
Write-Host '  plugin_manager set_plugin include:mcp-nanobrowser enabled:false   # only if that row exists'
Write-Host ''
Write-Host 'Optional fixture server for the sample skills:'
$url = $RepoRoot.Replace('\', '/')
Write-Host "  `$env:npm_config_engine_strict='false'; node -e `"import('file:///$url/fixtures/server.mjs').then(m => m.startServer())`""
Write-Host ''
Write-Host 'Then ask the agent to verify: nanobrowser_status, browser_skill_list, nanobrowser_attach.'
