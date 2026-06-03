#!/usr/bin/env bash
# migrate-import.sh — Rebuild a Multica self-host install on a new device
# from a bundle produced by migrate-export.sh.
#
# Restores, in order:
#   1. .env                  → repo root
#   2. ~/.multica            → daemon identity + CLI auth (skipped if already present)
#   3. Docker volumes        → backend_uploads (attachments), miniodata
#   4. Database              → fresh restore from the bundled dump
#   5. Full stack up         → docker compose -f docker-compose.selfhost.yml up -d
#
# Usage:
#   bash scripts/migrate-import.sh <bundle.tar.gz> [--yes]
#
# Prerequisites on the new device: docker (with compose), git.
# Run from the root of a fresh clone of the multica fork.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

COMPOSE_FILE="docker-compose.selfhost.yml"
BUNDLE="${1:-}"
ASSUME_YES="${2:-}"

[ -n "$BUNDLE" ] || { echo "Usage: bash scripts/migrate-import.sh <bundle.tar.gz> [--yes]"; exit 1; }
[ -f "$BUNDLE" ] || { echo "✗ Bundle not found: $BUNDLE"; exit 1; }
command -v docker >/dev/null 2>&1 || { echo "✗ docker is required but not found."; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "✗ docker compose v2 is required."; exit 1; }
[ -f "$COMPOSE_FILE" ] || { echo "✗ $COMPOSE_FILE not found — run from the repo root."; exit 1; }

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
echo "==> Extracting bundle..."
tar xzf "$BUNDLE" -C "$WORK"
[ -f "$WORK/MANIFEST" ] && { echo "--- MANIFEST ---"; cat "$WORK/MANIFEST"; echo "----------------"; }

# ---------- Guard against clobbering an existing install ----------
if [ -f .env ] && [ "$ASSUME_YES" != "--yes" ]; then
  echo
  echo "⚠️  A .env already exists here, and the import will overwrite local state"
  echo "    (.env, docker volumes, database). This is meant for a FRESH device."
  printf "    Continue anyway? [y/N] "
  read -r answer
  case "$answer" in
    y|Y|yes|YES) ;;
    *) echo "Aborted."; exit 1 ;;
  esac
fi

# ---------- 1. .env ----------
if [ -f "$WORK/env" ]; then
  cp "$WORK/env" .env
  echo "✓ .env restored"
fi

# ---------- 2. ~/.multica ----------
if [ -f "$WORK/multica-home.tar.gz" ]; then
  if [ -d "$HOME/.multica" ]; then
    echo "⚠ ~/.multica already exists — leaving it untouched (delete it and re-run to restore from bundle)"
  else
    tar xzf "$WORK/multica-home.tar.gz" -C "$HOME"
    echo "✓ ~/.multica restored (daemon identity + CLI auth)"
  fi
fi

# ---------- 3. Volumes (postgres up first so the compose project exists) ----------
echo "==> Starting postgres + minio..."
docker compose -f "$COMPOSE_FILE" up -d postgres minio >/dev/null

# Tar is streamed over stdin instead of a bind mount: Docker Desktop on
# macOS does not share mktemp's /var/folders/... paths into containers.
for VOL in backend_uploads miniodata; do
  ARCHIVE="$WORK/volume-${VOL}.tar.gz"
  FULL="multica_${VOL}"
  if [ -f "$ARCHIVE" ]; then
    docker volume create "$FULL" >/dev/null
    docker run --rm -i -v "${FULL}:/data" alpine \
      sh -c "rm -rf /data/* /data/..?* /data/.[!.]* 2>/dev/null; tar xzf - -C /" < "$ARCHIVE"
    echo "✓ volume ${FULL} restored"
  fi
done

# ---------- 4. Database ----------
if [ -f "$WORK/db.sql.gz" ]; then
  echo "==> Waiting for postgres to accept connections..."
  POSTGRES_USER_VAL=$(grep -E '^POSTGRES_USER=' .env | cut -d= -f2- || echo multica)
  POSTGRES_DB_VAL=$(grep -E '^POSTGRES_DB=' .env | cut -d= -f2- || echo multica)
  for _ in $(seq 1 30); do
    docker exec multica-postgres-1 pg_isready -U "${POSTGRES_USER_VAL:-multica}" >/dev/null 2>&1 && break
    sleep 1
  done
  bash scripts/restore.sh --file "$WORK/db.sql.gz" --yes
else
  echo "⚠ bundle has no db.sql.gz — skipping database restore"
fi

# ---------- 5. Full stack ----------
echo "==> Bringing up the full stack..."
docker compose -f "$COMPOSE_FILE" up -d

echo
echo "✓ Migration import complete."
echo "  Next steps:"
echo "    - Verify: docker compose -f $COMPOSE_FILE ps"
echo "    - Log in to the web UI and confirm your workspaces/issues are present"
echo "    - If you use the local daemon on this device: multica daemon status"
echo "    - Clone the backup repo for future backups:"
echo "        git clone git@github.com:Vignesh-Thangamariappan/multica-backup.git \$HOME/multica-backup"
