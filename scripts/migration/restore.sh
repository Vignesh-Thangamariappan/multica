#!/usr/bin/env bash
# Multica self-host — new machine restore.
# Run from inside the extracted bundle directory:
#   ./restore.sh [target-repo-dir]    (default: ~/multica-selfhost)
# Automates RESTORE.md. Safe to re-run; existing files are backed up, not clobbered.
set -euo pipefail

BUNDLE_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="${1:-$HOME/multica-selfhost}"
REPO_URL="https://github.com/Vignesh-Thangamariappan/multica.git"
UPSTREAM_URL="https://github.com/multica-ai/multica.git"

# Sandbox mode (RESTORE_SANDBOX=1): namespaces every Docker resource and uses
# a dedicated Postgres container, so the restore can be rehearsed on a machine
# that is still running the real setup. Defaults = production restore.
SANDBOX="${RESTORE_SANDBOX:-0}"
PG_CONTAINER="${RESTORE_PG_CONTAINER:-multica-postgres-1}"
VOL_PREFIX="${RESTORE_VOLUME_PREFIX:-multica}"
PG_PORT="${RESTORE_PG_PORT:-55432}"   # host port for the sandbox Postgres

step() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m  ! %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

# --- 0. Preflight ------------------------------------------------------------
step "Checking prerequisites"
for cmd in git docker tar; do
  command -v "$cmd" >/dev/null || die "$cmd is not installed"
done
docker info >/dev/null 2>&1 || die "Docker daemon is not running — start Docker Desktop / OrbStack first"
command -v pnpm >/dev/null || warn "pnpm not found — install it before 'make dev' (npm i -g pnpm)"
command -v go   >/dev/null || warn "go not found — install Go 1.26+ before 'make dev'"

for f in dotenv multica.dump miniodata.tar.gz backend_uploads.tar.gz server-data-uploads.tar.gz multica-home.tar.gz claude-settings.local.json; do
  [ -f "$BUNDLE_DIR/$f" ] || die "bundle file missing: $f (run this script from inside the extracted bundle)"
done

# --- 1. Clone repo -----------------------------------------------------------
step "Repo: $REPO_DIR"
if [ -d "$REPO_DIR/.git" ]; then
  echo "  already cloned, skipping clone"
else
  git clone "$REPO_URL" "$REPO_DIR"
fi
cd "$REPO_DIR"
git remote get-url upstream >/dev/null 2>&1 || git remote add upstream "$UPSTREAM_URL"

# --- 2. Local files (BEFORE any make target — make dev would generate a fresh .env)
step "Restoring .env, Claude settings, server uploads, ~/.multica"
restore_file() { # src dst
  if [ -f "$2" ] && ! cmp -s "$1" "$2"; then
    cp "$2" "$2.bak.$(date +%s)"; warn "existing $2 backed up"
  fi
  cp "$1" "$2"
}
restore_file "$BUNDLE_DIR/dotenv" "$REPO_DIR/.env"
mkdir -p "$REPO_DIR/.claude"
restore_file "$BUNDLE_DIR/claude-settings.local.json" "$REPO_DIR/.claude/settings.local.json"
tar xzf "$BUNDLE_DIR/server-data-uploads.tar.gz" -C "$REPO_DIR/server/"
[ -d "$HOME/.multica" ] && warn "~/.multica already exists — bundle contents will overlay it"
tar xzf "$BUNDLE_DIR/multica-home.tar.gz" -C "$HOME"

# Desktop app persisted state (login session, tab layout, prefs, drafts).
# Restore BEFORE first launch of the desktop app on this machine.
if [ -f "$BUNDLE_DIR/electron-appdata.tar.gz" ]; then
  step "Restoring desktop app persisted state"
  mkdir -p "$HOME/Library/Application Support"
  tar xzf "$BUNDLE_DIR/electron-appdata.tar.gz" -C "$HOME/Library/Application Support"
fi

# Global Claude Code config (instructions, RTK hook, memories, MCP servers).
# If Claude Code already ran on this machine, its fresh ~/.claude.json is
# backed up before the old one overlays it.
if [ -f "$BUNDLE_DIR/claude-global.tar.gz" ]; then
  step "Restoring global Claude Code config"
  if [ -f "$HOME/.claude.json" ]; then
    cp "$HOME/.claude.json" "$HOME/.claude.json.bak.$(date +%s)"
    warn "existing ~/.claude.json backed up"
  fi
  tar xzf "$BUNDLE_DIR/claude-global.tar.gz" -C "$HOME"
  echo "  note: plugin checkouts not carried — Claude Code reinstalls them from installed_plugins.json"
fi

# --- 3. Docker volumes (names match the pinned compose project "multica") ----
step "Seeding Docker volumes"
for vol in "${VOL_PREFIX}_miniodata" "${VOL_PREFIX}_backend_uploads"; do
  docker volume create "$vol" >/dev/null
done
docker run --rm -v "${VOL_PREFIX}_miniodata":/data -v "$BUNDLE_DIR":/backup alpine \
  tar xzf /backup/miniodata.tar.gz -C /data
docker run --rm -v "${VOL_PREFIX}_backend_uploads":/data -v "$BUNDLE_DIR":/backup alpine \
  tar xzf /backup/backend_uploads.tar.gz -C /data

# --- 4. Postgres -------------------------------------------------------------
step "Starting Postgres and restoring database"
if [ "$SANDBOX" = 1 ]; then
  pg_pass="$(sed -n 's/^POSTGRES_PASSWORD=//p' "$BUNDLE_DIR/dotenv")"
  docker run -d --name "$PG_CONTAINER" \
    -e POSTGRES_USER=multica -e POSTGRES_PASSWORD="${pg_pass:-multica}" -e POSTGRES_DB=multica \
    -p "127.0.0.1:$PG_PORT:5432" -v "${VOL_PREFIX}_pgdata":/var/lib/postgresql/data \
    pgvector/pgvector:pg17 >/dev/null
else
  make db-up
fi
echo -n "  waiting for postgres"
for _ in $(seq 1 30); do
  if docker exec "$PG_CONTAINER" pg_isready -U multica -q 2>/dev/null; then ok=1; break; fi
  echo -n "."; sleep 1
done
echo
[ "${ok:-}" = 1 ] || die "postgres ($PG_CONTAINER) did not become ready"

docker cp "$BUNDLE_DIR/multica.dump" "$PG_CONTAINER:/tmp/multica.dump"
docker exec "$PG_CONTAINER" pg_restore -U multica -d multica \
  --clean --if-exists --no-owner /tmp/multica.dump
docker exec "$PG_CONTAINER" rm /tmp/multica.dump

# --- 5. Frontend deps --------------------------------------------------------
if [ "${RESTORE_SKIP_PNPM:-0}" = 1 ]; then
  warn "skipping pnpm install (RESTORE_SKIP_PNPM=1)"
elif command -v pnpm >/dev/null; then
  step "Installing frontend dependencies"
  pnpm install
fi

step "Done"
cat <<EOF

Next steps:
  cd $REPO_DIR
  make dev                  # migrate-up is a no-op on the restored dump

Optional — restore the two WIP stashes (preserved as branches on the fork):
  git stash apply origin/stash/start-date-fix
  git stash apply origin/stash/copilot-rebase-untracked

The daemon identity (~/.multica/daemon.id) was restored, so paired agents
keep working without re-pairing.
EOF
