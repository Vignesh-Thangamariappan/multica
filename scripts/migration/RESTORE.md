# Multica Self-Host — New Machine Restore

Created 2026-06-07 from the old laptop. Everything git-trackable is on the fork
(`https://github.com/Vignesh-Thangamariappan/multica.git`); this bundle holds the
rest: secrets, DB data, file storage, and daemon/desktop config.

## Bundle contents

| File | What it is | Restores to |
|---|---|---|
| `multica.dump` | `pg_dump -Fc` of the `multica` database (all workspaces/issues) | Postgres container |
| `miniodata.tar.gz` | MinIO object storage volume | Docker volume `multica_miniodata` |
| `backend_uploads.tar.gz` | Backend uploads volume | Docker volume `multica_backend_uploads` |
| `server-data-uploads.tar.gz` | On-disk workspace attachments | `<repo>/server/data/uploads` |
| `dotenv` | Root `.env` (DB creds, secrets, ClickUp keys) | `<repo>/.env` |
| `claude-settings.local.json` | Claude Code local project settings | `<repo>/.claude/settings.local.json` |
| `multica-home.tar.gz` | `~/.multica` (daemon id/config, desktop.json, profiles) — logs excluded | `~/.multica` |
| `electron-appdata.tar.gz` | Desktop app persisted state: login session, tab layout, prefs, drafts (caches excluded) | `~/Library/Application Support/` |
| `claude-global.tar.gz` | Global Claude Code config: CLAUDE.md/RTK.md, settings.json (RTK hook), hooks, scheduled tasks, per-project memories, plugin list, `~/.claude.json` (MCP servers, trusted projects). Transcripts & plugin checkouts excluded | `~/.claude*` |

## Prerequisites on the new machine

Docker Desktop (or OrbStack), git, Go 1.26+, Node 22, pnpm. Optionally `rtk`.

## Quick path (recommended)

```bash
tar xzf multica-migration-*.tar.gz
cd multica-migration
./restore.sh                  # or ./restore.sh /custom/repo/path
```

`restore.sh` automates every step below and is safe to re-run (existing files
are backed up, not clobbered). `backup.sh` is the inverse — run it on the OLD
machine right before switching to regenerate this bundle with fresh data
(writes to `~/Documents/multica-migration-<date>.tar.gz`).

## Manual steps (what restore.sh does)

```bash
# 1. Clone + remotes (all branches incl. backups & stashes are on the fork)
git clone https://github.com/Vignesh-Thangamariappan/multica.git multica-selfhost
cd multica-selfhost
git remote add upstream https://github.com/multica-ai/multica.git

# 2. Restore local files BEFORE any make target (make dev would generate a fresh .env)
cp /path/to/bundle/dotenv .env
mkdir -p .claude && cp /path/to/bundle/claude-settings.local.json .claude/settings.local.json
tar xzf /path/to/bundle/server-data-uploads.tar.gz -C server/
tar xzf /path/to/bundle/multica-home.tar.gz -C "$HOME"

# 3. Pre-seed Docker volumes (compose project name is pinned to "multica",
#    so these names match what docker compose will look for)
docker volume create multica_miniodata
docker volume create multica_backend_uploads
docker run --rm -v multica_miniodata:/data -v /path/to/bundle:/backup alpine \
  tar xzf /backup/miniodata.tar.gz -C /data
docker run --rm -v multica_backend_uploads:/data -v /path/to/bundle:/backup alpine \
  tar xzf /backup/backend_uploads.tar.gz -C /data

# 4. Start Postgres only, then restore the dump (instead of running fresh migrations —
#    the dump already contains schema + schema_migrations state)
make db-up
docker cp /path/to/bundle/multica.dump multica-postgres-1:/tmp/multica.dump
docker exec multica-postgres-1 pg_restore -U multica -d multica \
  --clean --if-exists --no-owner /tmp/multica.dump
docker exec multica-postgres-1 rm /tmp/multica.dump

# 5. Install deps and start everything
pnpm install
make dev          # will detect existing DB; migrate-up is a no-op on a restored dump

# 6. (optional) Restore the two stashes — preserved as branches on the fork
git stash apply origin/stash/start-date-fix          # start_date null coalescing WIP
git stash apply origin/stash/copilot-rebase-untracked
```

## Notes

- `~/.multica/daemon.id` is restored, so the daemon keeps its identity — agents
  paired to this daemon keep working without re-pairing.
- `desktop.json` is restored, so the packaged desktop app still targets the
  self-host server.
- Old machine's `daemon.log` (92MB) was deliberately not carried over.
- If the desktop app was installed via a packaged build, reinstall the `.dmg`
  on the new machine (or run `pnpm dev:desktop`).
