#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# ---------- Check prerequisites ----------
missing=()
command -v node >/dev/null 2>&1 || missing+=("node")
command -v pnpm >/dev/null 2>&1 || missing+=("pnpm")
command -v go >/dev/null 2>&1 || missing+=("go")
command -v curl >/dev/null 2>&1 || missing+=("curl")

if [ ${#missing[@]} -gt 0 ]; then
  echo "✗ Missing prerequisites: ${missing[*]}"
  echo "  Please install: Node.js v20+, pnpm v10.28+, Go v1.26+, curl"
  exit 1
fi

# ---------- Environment file ----------
if [ -f .git ]; then
  # Inside a git worktree (.git is a file, not a directory)
  ENV_FILE=".env.worktree"
  if [ ! -f "$ENV_FILE" ]; then
    echo "==> Worktree detected. Generating $ENV_FILE..."
    bash scripts/init-worktree-env.sh "$ENV_FILE"
  fi
else
  ENV_FILE=".env"
  if [ ! -f "$ENV_FILE" ]; then
    echo "==> Creating $ENV_FILE from .env.example..."
    cp .env.example "$ENV_FILE"
  fi
fi

echo "==> Using $ENV_FILE"

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

# Map root .env variables to Vite variables for the desktop app.
# This ensures the build points to the self-hosted backend by default.
# We prioritize VITE_* if already set in the shell, then fallback to root .env values.
export VITE_API_URL="${VITE_API_URL:-http://localhost:${PORT:-8080}}"
export VITE_WS_URL="${VITE_WS_URL:-ws://localhost:${PORT:-8080}/ws}"
export VITE_APP_URL="${VITE_APP_URL:-${MULTICA_APP_URL:-http://localhost:3000}}"

echo "==> Building Desktop for self-host:"
echo "    API: $VITE_API_URL"
echo "    WS:  $VITE_WS_URL"
echo "    App: $VITE_APP_URL"

# ---------- Install dependencies ----------
MODULES_STAMP="node_modules/.modules.yaml"
if [ ! -f "$MODULES_STAMP" ] || [ package.json -nt "$MODULES_STAMP" ] || [ pnpm-lock.yaml -nt "$MODULES_STAMP" ] || [ apps/desktop/package.json -nt "$MODULES_STAMP" ]; then
  echo "==> Installing dependencies..."
  pnpm install
fi

# ---------- Self-host override ----------
# Vite inlines environment variables from .env.production during the build.
# To ensure the self-hosted URLs are used, we temporarily move .env.production
# so it doesn't override our exported environment variables.
if [ -f "apps/desktop/.env.production" ]; then
  echo "==> Temporarily moving apps/desktop/.env.production to avoid online overrides..."
  mv apps/desktop/.env.production apps/desktop/.env.production.bak
fi

trap 'if [ -f apps/desktop/.env.production.bak ]; then mv apps/desktop/.env.production.bak apps/desktop/.env.production; fi' EXIT

# ---------- Desktop Build ----------
echo "==> Packaging desktop app..."
# We use the package script from the desktop app which handles:
# 1. electron-vite build (renderer/main)
# 2. bundle-cli (Go CLI build from local source)
# 3. electron-builder (packaging)
(cd apps/desktop && pnpm run package "$@")

echo ""
echo "✓ Build complete. Check apps/desktop/dist/ for the launchable app."
