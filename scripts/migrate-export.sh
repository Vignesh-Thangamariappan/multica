#!/usr/bin/env bash
# migrate-export.sh — Bundle the complete state of this Multica self-host
# install into a single tarball for moving to a new device.
#
# The bundle is SELF-CONTAINED: it carries a fresh database dump, so the
# new device does not depend on the backup repo being up to date.
#
# Contents:
#   db.sql.gz            Fresh pg_dump of the database
#   env                  The .env file (secrets! see warning below)
#   multica-home.tar.gz  ~/.multica (daemon identity, CLI token, profiles — logs excluded)
#   volume-backend_uploads.tar.gz   File attachments (local upload storage)
#   volume-miniodata.tar.gz         MinIO object storage
#   MANIFEST             What was captured, when, and from which git commit
#
# Usage:
#   bash scripts/migrate-export.sh [output-dir]    # default: ~/Desktop
#
# ⚠️  The bundle contains credentials (.env, CLI token) and the full DB.
#     Move it over AirDrop / USB / scp — do NOT upload it to cloud storage
#     or commit it to git.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# ---------- Load env ----------
ENV_FILE=".env"
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

POSTGRES_CONTAINER="${POSTGRES_CONTAINER:-multica-postgres-1}"
POSTGRES_USER="${POSTGRES_USER:-multica}"
POSTGRES_DB="${POSTGRES_DB:-multica}"
OUT_DIR="${1:-$HOME/Desktop}"
TS=$(date +%Y%m%d-%H%M%S)
BUNDLE="multica-migration-${TS}.tar.gz"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

command -v docker >/dev/null 2>&1 || { echo "✗ docker is required but not found."; exit 1; }

if ! docker ps --format '{{.Names}}' | grep -q "^${POSTGRES_CONTAINER}$"; then
  echo "✗ PostgreSQL container \"$POSTGRES_CONTAINER\" is not running."
  exit 1
fi

# ---------- 1. Database ----------
echo "==> Dumping database \"$POSTGRES_DB\"..."
docker exec "$POSTGRES_CONTAINER" pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" | gzip > "$WORK/db.sql.gz"
echo "   ✓ db.sql.gz ($(du -sh "$WORK/db.sql.gz" | cut -f1))"

# ---------- 2. .env ----------
if [ -f "$ENV_FILE" ]; then
  cp "$ENV_FILE" "$WORK/env"
  echo "   ✓ env"
else
  echo "   ⚠ no .env found — skipping"
fi

# ---------- 3. ~/.multica (daemon identity + CLI auth, logs excluded) ----------
if [ -d "$HOME/.multica" ]; then
  tar czf "$WORK/multica-home.tar.gz" -C "$HOME" \
    --exclude='.multica/*.log' --exclude='.multica/*.pid' .multica
  echo "   ✓ multica-home.tar.gz ($(du -sh "$WORK/multica-home.tar.gz" | cut -f1))"
else
  echo "   ⚠ no ~/.multica found — skipping"
fi

# ---------- 4. Docker volumes ----------
# Tar is streamed over stdout instead of a bind mount: Docker Desktop on
# macOS does not share mktemp's /var/folders/... paths into containers,
# which made the bind-mount variant silently produce empty archives.
for VOL in backend_uploads miniodata; do
  FULL="multica_${VOL}"
  if docker volume inspect "$FULL" >/dev/null 2>&1; then
    docker run --rm -v "${FULL}:/data:ro" alpine \
      tar czf - -C / data > "$WORK/volume-${VOL}.tar.gz"
    echo "   ✓ volume-${VOL}.tar.gz ($(du -sh "$WORK/volume-${VOL}.tar.gz" | cut -f1))"
  else
    echo "   ⚠ volume ${FULL} not found — skipping"
  fi
done

# ---------- 5. Manifest ----------
{
  echo "created:    $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "hostname:   $(hostname)"
  echo "git_commit: $(git rev-parse HEAD 2>/dev/null || echo unknown)"
  echo "git_branch: $(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
  echo "postgres:   $POSTGRES_DB @ $POSTGRES_CONTAINER"
  echo "contents:"
  ls -lh "$WORK" | tail -n +2 | awk '{print "  " $NF " (" $5 ")"}'
} > "$WORK/MANIFEST"

# ---------- 6. Bundle ----------
mkdir -p "$OUT_DIR"
tar czf "$OUT_DIR/$BUNDLE" -C "$WORK" .
echo
echo "✓ Migration bundle: $OUT_DIR/$BUNDLE ($(du -sh "$OUT_DIR/$BUNDLE" | cut -f1))"
echo
echo "⚠️  Contains secrets + full DB. Transfer via AirDrop / USB / scp only."
echo "   On the new device:"
echo "     1. git clone git@github.com:Vignesh-Thangamariappan/multica.git multica-selfhost"
echo "     2. cd multica-selfhost"
echo "     3. bash scripts/migrate-import.sh /path/to/$BUNDLE"
