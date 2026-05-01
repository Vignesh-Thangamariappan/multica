#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

BACKEND_PID=""
BACKEND_STARTED="0"

cleanup() {
  local exit_code=$?
  trap - EXIT INT TERM

  if [ "$BACKEND_STARTED" = "1" ] && [ -n "$BACKEND_PID" ] && kill -0 "$BACKEND_PID" 2>/dev/null; then
    echo "==> Stopping backend..."
    kill "$BACKEND_PID" 2>/dev/null || true
    wait "$BACKEND_PID" 2>/dev/null || true
  fi

  if [ "${STOP_DAEMON_ON_EXIT:-0}" = "1" ]; then
    echo "==> Stopping daemon (STOP_DAEMON_ON_EXIT=1)..."
    if ! daemon_cli stop >/dev/null 2>&1; then
      echo "Warning: failed to stop daemon automatically."
    fi
  fi

  exit "$exit_code"
}

daemon_cli() {
  if command -v multica >/dev/null 2>&1; then
    multica daemon "$@"
  else
    (cd server && go run ./cmd/multica daemon "$@")
  fi
}

wait_for_backend() {
  local port="${PORT:-8080}"

  for _ in {1..60}; do
    if ! kill -0 "$BACKEND_PID" 2>/dev/null; then
      return 1
    fi
    if curl -fsS "http://localhost:${port}/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done

  return 1
}

trap cleanup EXIT INT TERM

# ---------- Check prerequisites ----------
missing=()
command -v node >/dev/null 2>&1 || missing+=("node")
command -v pnpm >/dev/null 2>&1 || missing+=("pnpm")
command -v go >/dev/null 2>&1 || missing+=("go")
command -v docker >/dev/null 2>&1 || missing+=("docker")
command -v curl >/dev/null 2>&1 || missing+=("curl")

if [ ${#missing[@]} -gt 0 ]; then
  echo "✗ Missing prerequisites: ${missing[*]}"
  echo "  Please install: Node.js v20+, pnpm v10.28+, Go v1.26+, Docker, curl"
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

# ---------- Install dependencies ----------
MODULES_STAMP="node_modules/.modules.yaml"
if [ ! -f "$MODULES_STAMP" ] || [ package.json -nt "$MODULES_STAMP" ] || [ pnpm-lock.yaml -nt "$MODULES_STAMP" ] || [ apps/desktop/package.json -nt "$MODULES_STAMP" ]; then
  echo "==> Installing dependencies..."
  pnpm install
fi

# ---------- Database ----------
bash scripts/ensure-postgres.sh "$ENV_FILE"

echo "==> Running migrations..."
(cd server && go run ./cmd/migrate up)

# ---------- Backend ----------
if curl -fsS "http://localhost:${PORT:-8080}/health" >/dev/null 2>&1; then
  echo "==> Backend already running at http://localhost:${PORT:-8080}; reusing existing process."
else
  echo "==> Starting backend..."
  (cd server && go run ./cmd/server) &
  BACKEND_PID=$!
  BACKEND_STARTED="1"

  if wait_for_backend; then
    echo "✓ Backend ready at http://localhost:${PORT:-8080}"
  else
    echo "✗ Backend failed to start. Check logs above."
    exit 1
  fi
fi

# ---------- Daemon ----------
echo "==> Starting daemon..."
if daemon_cli start; then
  echo "✓ Daemon started."
else
  if daemon_cli status >/dev/null 2>&1; then
    echo "✓ Daemon already running."
  else
    echo "✗ Failed to start daemon."
    echo "  Run 'multica login' (or equivalent profile login) and retry."
    exit 1
  fi
fi

# ---------- Desktop ----------
echo "==> Launching desktop app..."
echo "  Set STOP_DAEMON_ON_EXIT=1 if you want this script to stop the daemon on exit."
pnpm dev:desktop
