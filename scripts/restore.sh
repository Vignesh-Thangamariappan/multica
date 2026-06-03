#!/usr/bin/env bash
# restore.sh — Restore the Multica database from a backup produced by backup.sh.
#
# Usage:
#   bash scripts/restore.sh                       # restore $BACKUP_REPO_PATH/latest.sql.gz
#   bash scripts/restore.sh --file <dump>         # restore a specific .sql / .sql.gz file
#   bash scripts/restore.sh --release [tag]       # download from GitHub release (latest if no tag)
#   bash scripts/restore.sh --yes                 # skip the confirmation prompt
#
# Environment variables (can be set in .env or exported before running):
#   BACKUP_REPO_PATH   Path to the local clone of the backup git repo.
#   BACKUP_GH_REPO     GitHub repo for --release mode.
#                      Default: Vignesh-Thangamariappan/multica-backup
#   POSTGRES_CONTAINER Docker container name for PostgreSQL.
#                      Default: multica-postgres-1
#   POSTGRES_USER      PostgreSQL user. Default: multica
#   POSTGRES_DB        PostgreSQL database. Default: multica
#
# The restore DROPS and recreates the database, so the backend/frontend
# containers are stopped for the duration and restarted afterwards.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# ---------- Load env ----------
if [ -f .git ]; then
  ENV_FILE=".env.worktree"
else
  ENV_FILE=".env"
fi

if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

# ---------- Config ----------
BACKUP_REPO_PATH="${BACKUP_REPO_PATH:-}"
BACKUP_GH_REPO="${BACKUP_GH_REPO:-Vignesh-Thangamariappan/multica-backup}"
POSTGRES_CONTAINER="${POSTGRES_CONTAINER:-multica-postgres-1}"
POSTGRES_USER="${POSTGRES_USER:-multica}"
POSTGRES_DB="${POSTGRES_DB:-multica}"
COMPOSE_FILE="docker-compose.selfhost.yml"

# ---------- Parse args ----------
DUMP_FILE=""
RELEASE_TAG=""
USE_RELEASE=0
ASSUME_YES=0

while [ $# -gt 0 ]; do
  case "$1" in
    --file)    DUMP_FILE="$2"; shift 2 ;;
    --release) USE_RELEASE=1; [ $# -gt 1 ] && [[ "$2" != --* ]] && { RELEASE_TAG="$2"; shift; }; shift ;;
    --yes|-y)  ASSUME_YES=1; shift ;;
    *) echo "✗ Unknown argument: $1"; exit 1 ;;
  esac
done

command -v docker >/dev/null 2>&1 || { echo "✗ docker is required but not found."; exit 1; }

# ---------- Resolve dump file ----------
if [ "$USE_RELEASE" = "1" ]; then
  command -v gh >/dev/null 2>&1 || { echo "✗ gh CLI required for --release mode."; exit 1; }
  TMP_DIR=$(mktemp -d)
  echo "==> Downloading backup from GitHub release ${RELEASE_TAG:-latest} (${BACKUP_GH_REPO})..."
  if [ -n "$RELEASE_TAG" ]; then
    gh release download "$RELEASE_TAG" --repo "$BACKUP_GH_REPO" --pattern 'backup-*.sql*' --dir "$TMP_DIR"
  else
    gh release download --repo "$BACKUP_GH_REPO" --pattern 'backup-*.sql*' --dir "$TMP_DIR"
  fi
  DUMP_FILE=$(ls -t "$TMP_DIR"/backup-*.sql* | head -1)
elif [ -z "$DUMP_FILE" ]; then
  if [ -z "$BACKUP_REPO_PATH" ]; then
    echo "✗ No --file given and BACKUP_REPO_PATH is not set."
    exit 1
  fi
  for candidate in "$BACKUP_REPO_PATH/latest.sql.gz" "$BACKUP_REPO_PATH/latest.sql"; do
    [ -f "$candidate" ] && { DUMP_FILE="$candidate"; break; }
  done
  if [ -z "$DUMP_FILE" ]; then
    echo "✗ No latest.sql.gz / latest.sql found in $BACKUP_REPO_PATH."
    exit 1
  fi
fi

[ -f "$DUMP_FILE" ] || { echo "✗ Dump file not found: $DUMP_FILE"; exit 1; }
echo "==> Restoring from: $DUMP_FILE ($(du -sh "$DUMP_FILE" | cut -f1))"

# ---------- Check container ----------
if ! docker ps --format '{{.Names}}' | grep -q "^${POSTGRES_CONTAINER}$"; then
  echo "✗ PostgreSQL container \"$POSTGRES_CONTAINER\" is not running."
  echo "  Start it first: docker compose -f $COMPOSE_FILE up -d postgres"
  exit 1
fi

# ---------- Confirm ----------
if [ "$ASSUME_YES" != "1" ]; then
  echo
  echo "⚠️  This will DROP and recreate database \"$POSTGRES_DB\" in container \"$POSTGRES_CONTAINER\"."
  echo "    All current data in that database will be replaced by the backup."
  printf "    Continue? [y/N] "
  read -r answer
  case "$answer" in
    y|Y|yes|YES) ;;
    *) echo "Aborted."; exit 1 ;;
  esac
fi

# ---------- Stop app containers (they hold DB connections) ----------
echo "==> Stopping backend/frontend containers..."
docker compose -f "$COMPOSE_FILE" stop backend frontend >/dev/null 2>&1 || true

# ---------- Drop & recreate ----------
echo "==> Recreating database \"$POSTGRES_DB\"..."
docker exec "$POSTGRES_CONTAINER" psql -U "$POSTGRES_USER" -d postgres \
  -c "DROP DATABASE IF EXISTS \"$POSTGRES_DB\" WITH (FORCE);" \
  -c "CREATE DATABASE \"$POSTGRES_DB\" OWNER \"$POSTGRES_USER\";"

# ---------- Restore ----------
echo "==> Importing dump..."
case "$DUMP_FILE" in
  *.gz) gunzip -c "$DUMP_FILE" | docker exec -i "$POSTGRES_CONTAINER" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -q ;;
  *)    docker exec -i "$POSTGRES_CONTAINER" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -q < "$DUMP_FILE" ;;
esac

# ---------- Restart stack ----------
echo "==> Restarting stack..."
docker compose -f "$COMPOSE_FILE" up -d >/dev/null

ISSUES=$(docker exec "$POSTGRES_CONTAINER" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT count(*) FROM issue;" 2>/dev/null || echo "?")
echo "✓ Restore complete. issue table rows: ${ISSUES}"
