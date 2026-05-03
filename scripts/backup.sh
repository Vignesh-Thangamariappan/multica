#!/usr/bin/env bash
# backup.sh — Backup the Multica database and push to the versioned backup repo.
#
# Usage:
#   bash scripts/backup.sh
#
# Environment variables (can be set in .env or exported before running):
#   BACKUP_REPO_PATH   Path to the local clone of the backup git repo.
#                      Required — the script will exit if not set.
#   POSTGRES_CONTAINER Docker container name for PostgreSQL.
#                      Default: multica-postgres-1
#   POSTGRES_USER      PostgreSQL user. Default: multica
#   POSTGRES_DB        PostgreSQL database. Default: multica
#   BACKUP_UPLOADS     Set to "1" to also back up the uploads volume.
#                      Default: 0
#   UPLOADS_VOLUME     Docker volume name for uploads.
#                      Default: multica_backend_uploads
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
POSTGRES_CONTAINER="${POSTGRES_CONTAINER:-multica-postgres-1}"
POSTGRES_USER="${POSTGRES_USER:-multica}"
POSTGRES_DB="${POSTGRES_DB:-multica}"
BACKUP_UPLOADS="${BACKUP_UPLOADS:-0}"
UPLOADS_VOLUME="${UPLOADS_VOLUME:-multica_backend_uploads}"

# ---------- Validate ----------
if [ -z "$BACKUP_REPO_PATH" ]; then
  echo "✗ BACKUP_REPO_PATH is not set."
  echo "  Set it in your $ENV_FILE or export it before running:"
  echo "    export BACKUP_REPO_PATH=\$HOME/multica-backup"
  exit 1
fi

if [ ! -d "$BACKUP_REPO_PATH/.git" ]; then
  echo "✗ BACKUP_REPO_PATH=\"$BACKUP_REPO_PATH\" is not a git repository."
  echo "  Clone the backup repo there first:"
  echo "    git clone git@github.com:Vignesh-Thangamariappan/multica-backup.git \"$BACKUP_REPO_PATH\""
  exit 1
fi

command -v docker >/dev/null 2>&1 || { echo "✗ docker is required but not found."; exit 1; }
command -v git    >/dev/null 2>&1 || { echo "✗ git is required but not found.";    exit 1; }

# ---------- Check container ----------
if ! docker ps --format '{{.Names}}' | grep -q "^${POSTGRES_CONTAINER}$"; then
  echo "✗ PostgreSQL container \"$POSTGRES_CONTAINER\" is not running."
  echo "  Start the stack first: docker compose -f docker-compose.selfhost.yml up -d"
  exit 1
fi

# ---------- Backup ----------
TS=$(date +%Y%m%d-%H%M%S)
SQL_FILE="backup-${TS}.sql"

echo "==> Dumping database \"$POSTGRES_DB\" from container \"$POSTGRES_CONTAINER\"..."
docker exec "$POSTGRES_CONTAINER" pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" > "${BACKUP_REPO_PATH}/${SQL_FILE}"
cp "${BACKUP_REPO_PATH}/${SQL_FILE}" "${BACKUP_REPO_PATH}/latest.sql"
echo "✓ Database dump saved: ${SQL_FILE} ($(du -sh "${BACKUP_REPO_PATH}/${SQL_FILE}" | cut -f1))"

if [ "$BACKUP_UPLOADS" = "1" ]; then
  echo "==> Backing up uploads volume \"$UPLOADS_VOLUME\"..."
  UPLOADS_FILE="uploads-${TS}.tar.gz"
  docker run --rm \
    -v "${UPLOADS_VOLUME}:/data" \
    -v "${BACKUP_REPO_PATH}:/backup" \
    alpine tar czf "/backup/${UPLOADS_FILE}" /data 2>/dev/null
  echo "✓ Uploads saved: ${UPLOADS_FILE} ($(du -sh "${BACKUP_REPO_PATH}/${UPLOADS_FILE}" | cut -f1))"
fi

# ---------- Commit & push ----------
DATE=$(date +%Y-%m-%d)

cd "$BACKUP_REPO_PATH"
git add .

if git diff --cached --quiet; then
  echo "==> Nothing new to commit (backup unchanged)."
  exit 0
fi

git commit -m "backup: ${DATE}"
echo "==> Pushing to remote..."
git push
echo "✓ Backup committed and pushed. A GitHub Release will be created automatically."
echo "  Releases: $(git remote get-url origin | sed 's/git@github.com:/https:\/\/github.com\//' | sed 's/\.git$//')/releases"
