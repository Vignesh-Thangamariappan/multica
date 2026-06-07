#!/usr/bin/env bash
# Multica self-host — regenerate the migration bundle from THIS (old) machine.
# Run again right before switching laptops so the bundle carries fresh data:
#   ./backup.sh [repo-dir]            (default: ~/multica-selfhost)
# Output: ~/Documents/multica-migration-<date>.tar.gz
set -euo pipefail

REPO_DIR="${1:-$HOME/multica-selfhost}"
PG_CONTAINER="multica-postgres-1"
# Stage under $HOME, not mktemp: /var/folders is outside Docker Desktop's
# default file sharing, so volume-archive bind mounts there fail silently.
STAGE_ROOT="$(mktemp -d "$HOME/.multica-backup.XXXXXX")"
STAGE="$STAGE_ROOT/multica-migration"
OUT="$HOME/Documents/multica-migration-$(date +%Y-%m-%d).tar.gz"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

step() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

[ -f "$REPO_DIR/.env" ] || die "no .env in $REPO_DIR"
docker info >/dev/null 2>&1 || die "Docker daemon is not running"
docker exec "$PG_CONTAINER" pg_isready -U multica -q 2>/dev/null \
  || die "$PG_CONTAINER is not running — run 'make db-up' in $REPO_DIR first"

mkdir -p "$STAGE"

step "Dumping Postgres"
docker exec "$PG_CONTAINER" pg_dump -U multica -d multica -Fc -f /tmp/multica.dump
docker cp "$PG_CONTAINER:/tmp/multica.dump" "$STAGE/multica.dump"
docker exec "$PG_CONTAINER" rm /tmp/multica.dump

step "Archiving Docker volumes"
docker run --rm -v multica_miniodata:/data -v "$STAGE":/backup alpine \
  tar czf /backup/miniodata.tar.gz -C /data .
docker run --rm -v multica_backend_uploads:/data -v "$STAGE":/backup alpine \
  tar czf /backup/backend_uploads.tar.gz -C /data .
for f in miniodata.tar.gz backend_uploads.tar.gz; do
  [ -s "$STAGE/$f" ] || die "volume archive did not land on host: $f (Docker file-sharing issue?)"
done

step "Copying local files"
cp "$REPO_DIR/.env" "$STAGE/dotenv"
cp "$REPO_DIR/.claude/settings.local.json" "$STAGE/claude-settings.local.json"
tar czf "$STAGE/server-data-uploads.tar.gz" -C "$REPO_DIR/server" data/uploads
tar czf "$STAGE/multica-home.tar.gz" -C "$HOME" \
  --exclude='.multica/daemon.log' --exclude='.multica/daemon.pid' \
  --exclude='.multica/profiles/*/daemon.log' --exclude='.multica/profiles/*/daemon.pid' \
  .multica

# Desktop app persisted state (login session, tab layout, prefs, drafts) —
# everything else under these dirs is regenerable cache (Cache/, GPUCache/, ...)
step "Archiving desktop app persisted state"
APPDATA="$HOME/Library/Application Support"
electron_paths=()
for app in "Multica Canary" "@multica/desktop"; do
  for item in "Local Storage" "Session Storage" "IndexedDB" "Cookies" "Cookies-journal" "Preferences"; do
    # "./" prefix: bsdtar treats a bare leading "@" in a path as an archive reference
    [ -e "$APPDATA/$app/$item" ] && electron_paths+=("./$app/$item")
  done
done
if [ "${#electron_paths[@]}" -gt 0 ]; then
  tar czf "$STAGE/electron-appdata.tar.gz" -C "$APPDATA" "${electron_paths[@]}"
else
  echo "  no desktop app data found, skipping"
fi

# Global Claude Code config — applies to ALL projects, not just multica:
# CLAUDE.md/RTK.md instructions, settings.json (RTK hook), hooks, scheduled
# tasks, per-project memories, and ~/.claude.json (MCP servers, trusted
# projects). Excluded as regenerable: transcripts (projects/ minus memory),
# plugin checkouts (installed_plugins.json is enough to reinstall), caches.
step "Archiving global Claude Code config"
claude_paths=()
for p in .claude/CLAUDE.md .claude/RTK.md .claude/settings.json .claude/settings.local.json \
         .claude/keybindings.json .claude/hooks .claude/scheduled-tasks .claude/plans \
         .claude/agents .claude/skills .claude/commands .claude/workflows \
         .claude/plugins/installed_plugins.json .claude/plugins/known_marketplaces.json \
         .claude/plugins/blocklist.json .claude.json; do
  [ -e "$HOME/$p" ] && claude_paths+=("./$p")
done
while IFS= read -r d; do
  claude_paths+=("./${d#"$HOME"/}")
done < <(find "$HOME/.claude/projects" -maxdepth 2 -type d -name memory 2>/dev/null)
tar czf "$STAGE/claude-global.tar.gz" -C "$HOME" "${claude_paths[@]}"

cp "$SCRIPT_DIR/RESTORE.md" "$SCRIPT_DIR/restore.sh" "$SCRIPT_DIR/backup.sh" "$STAGE/"

step "Checking for unpushed git state"
cd "$REPO_DIR"
unpushed=0
while read -r b; do
  git rev-parse -q --verify "refs/remotes/origin/$b" >/dev/null || { echo "  ! branch not on origin: $b"; unpushed=1; }
done < <(git for-each-ref refs/heads --format='%(refname:short)')
while read -r ref; do
  [ -z "$ref" ] && continue
  if [ -z "$(git branch -r --contains "$ref" 2>/dev/null)" ]; then
    echo "  ! stash not preserved on any remote branch: $ref"; unpushed=1
  fi
done < <(git stash list --format='%H')
[ -n "$(git status --porcelain)" ] && { echo "  ! uncommitted changes in working tree"; unpushed=1; }
[ "$unpushed" = 0 ] && echo "  all branches pushed, no stashes, tree clean"

step "Sealing bundle"
mkdir -p "$HOME/Documents"
tar czf "$OUT" -C "$STAGE_ROOT" multica-migration
rm -rf "$STAGE_ROOT"
ls -lh "$OUT"

cat <<EOF

Bundle ready: $OUT
Transfer it directly (AirDrop / USB / Migration Assistant) — it contains
secrets and your database. Never upload it to GitHub or any public service.

On the new machine:
  tar xzf $(basename "$OUT") && cd multica-migration && ./restore.sh
EOF
