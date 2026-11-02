#!/usr/bin/env bash
# playlistBookmark installer for macOS, Linux and WSL.
#   curl -fsSL https://raw.githubusercontent.com/adrianhruiz/playlistBookmark/main/install.sh | bash
# Optional: PLAYLISTBOOKMARK_DIR (target folder), PLAYLISTBOOKMARK_BRANCH (default: main).
set -euo pipefail

REPO_URL="${PLAYLISTBOOKMARK_REPO:-https://github.com/adrianhruiz/playlistBookmark.git}"
DIR="${PLAYLISTBOOKMARK_DIR:-playlistBookmark}"
BRANCH="${PLAYLISTBOOKMARK_BRANCH:-main}"
MIN_NODE_MAJOR=22

fail() { printf '\033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }
step() { printf '\033[36m→ %s\033[0m\n' "$1"; }

command -v git >/dev/null || fail "git is required: https://git-scm.com/downloads"
command -v node >/dev/null || fail "Node.js ${MIN_NODE_MAJOR}.12+ is required: https://nodejs.org"
command -v npm >/dev/null || fail "npm is required (it ships with Node.js)"
node_major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$node_major" -ge "$MIN_NODE_MAJOR" ] || fail "Node.js ${MIN_NODE_MAJOR}.12+ is required, found $(node -v)"
[ -e "$DIR" ] && fail "'$DIR' already exists. Remove it or set PLAYLISTBOOKMARK_DIR."

step "Cloning $REPO_URL ($BRANCH) into $DIR"
git clone --quiet --branch "$BRANCH" "$REPO_URL" "$DIR"
cd "$DIR"

step "Installing dependencies"
npm ci --no-audit --no-fund --loglevel=error

[ -f .dev.vars ] || cp .dev.vars.example .dev.vars

printf '\n\033[32m✓ Installed in %s\033[0m\n\n' "$(pwd)"
cat <<'NEXT'
Next steps (details in README.md → "Setup"):
  1. Fill in .dev.vars (Spotify Client ID/Secret, Telegram bot token, webhook secret, BASE_URL)
  2. npx wrangler login
  3. npx wrangler kv namespace create KV   # put the id in wrangler.jsonc
  4. Upload each secret: npx wrangler secret put <NAME>
  5. npm run deploy && npm run setup:telegram
NEXT
