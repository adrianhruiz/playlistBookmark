# playlistBookmark installer for PowerShell (Windows PowerShell 5.1+ or PowerShell 7 on any OS).
#   irm https://raw.githubusercontent.com/adrianhruiz/playlistBookmark/main/install.ps1 | iex
# Optional: $env:PLAYLISTBOOKMARK_DIR (target folder), $env:PLAYLISTBOOKMARK_BRANCH (default: main).
$ErrorActionPreference = 'Stop'

$RepoUrl = 'https://github.com/adrianhruiz/playlistBookmark.git'
$Dir = if ($env:PLAYLISTBOOKMARK_DIR) { $env:PLAYLISTBOOKMARK_DIR } else { 'playlistBookmark' }
$Branch = if ($env:PLAYLISTBOOKMARK_BRANCH) { $env:PLAYLISTBOOKMARK_BRANCH } else { 'main' }
$MinNodeMajor = 22

function Fail([string]$Message) { Write-Host "x $Message" -ForegroundColor Red; throw $Message }
function Step([string]$Message) { Write-Host "-> $Message" -ForegroundColor Cyan }
function Require([string]$Command, [string]$Hint) {
  if (-not (Get-Command $Command -ErrorAction SilentlyContinue)) { Fail "$Command is required: $Hint" }
}

Require 'git' 'https://git-scm.com/downloads'
Require 'node' "Node.js $MinNodeMajor.12+ from https://nodejs.org"
Require 'npm' 'it ships with Node.js'
$nodeMajor = [int](node -p 'process.versions.node.split(".")[0]')
if ($nodeMajor -lt $MinNodeMajor) { Fail "Node.js $MinNodeMajor.12+ is required, found $(node -v)" }
if (Test-Path $Dir) { Fail "'$Dir' already exists. Remove it or set `$env:PLAYLISTBOOKMARK_DIR." }

Step "Cloning $RepoUrl ($Branch) into $Dir"
git clone --quiet --branch $Branch $RepoUrl $Dir
if ($LASTEXITCODE -ne 0) { Fail 'git clone failed' }
Push-Location $Dir
try {
  Step 'Installing dependencies'
  npm ci --no-audit --no-fund --loglevel=error
  if ($LASTEXITCODE -ne 0) { Fail 'npm ci failed' }
  if (-not (Test-Path '.dev.vars')) { Copy-Item '.dev.vars.example' '.dev.vars' }

  Write-Host "`nInstalled in $(Get-Location)`n" -ForegroundColor Green
  Write-Host @'
Next steps (details in README.md -> "Setup"):
  1. Fill in .dev.vars (Spotify Client ID/Secret, Telegram bot token, webhook secret, BASE_URL)
  2. npx wrangler login
  3. npx wrangler kv namespace create KV   # put the id in wrangler.jsonc
  4. Upload each secret: npx wrangler secret put <NAME>
  5. npm run deploy; npm run setup:telegram
'@
} finally {
  Pop-Location
}
