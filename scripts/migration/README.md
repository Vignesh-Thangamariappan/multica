# Laptop Migration Kit

Moves the **entire** Multica self-host setup to a new machine with zero data
loss — database, agents, knowledge space, attachments, daemon identity,
desktop login session, and global Claude Code config.

**End-to-end verified on 2026-06-07**: a bundle produced by `backup.sh` was
restored into a fully isolated sandbox on the same machine (fake `$HOME`,
dedicated Postgres, namespaced volumes) and the restored server booted and
served the API. Scorecard below.

> ⚠️ The bundle contains secrets (`.env`, tokens, cookies) and the full DB.
> Transfer it via AirDrop / USB / scp only. Never commit it or upload it to
> any cloud/git service. The scripts in this directory contain no secrets.

## Switch-day procedure

```bash
# OLD machine — produce a fresh bundle (~/Documents/multica-migration-<date>.tar.gz)
bash scripts/migration/backup.sh

# transfer the tarball directly (AirDrop / USB), then on the NEW machine:
tar xzf multica-migration-<date>.tar.gz
cd multica-migration
./restore.sh                      # or ./restore.sh /custom/repo/path
cd ~/multica-selfhost && make dev

# OLD machine — only after the new machine is verified working:
bash scripts/migration/clear-colima.sh   # guarded: recent bundle + typed "wipe"
```

## What the bundle carries

| Item | Contents |
|---|---|
| `multica.dump` | `pg_dump -Fc` of the whole DB — agents, agent skills, knowledge space (incl. pgvector embeddings), issues, comments, inbox, task messages, ClickUp installation/links, PATs, autopilots, squads — all tables |
| `miniodata.tar.gz` / `backend_uploads.tar.gz` | MinIO + uploads Docker volumes |
| `server-data-uploads.tar.gz` | On-disk attachments (`server/data/uploads`) |
| `dotenv` | Root `.env` (secrets) |
| `multica-home.tar.gz` | `~/.multica` — daemon identity (`daemon.id` → paired agents keep working), desktop config, runtime profiles. Logs excluded |
| `electron-appdata.tar.gz` | Desktop app persisted state — login session (Cookies), tab layout, prefs, drafts. Caches excluded |
| `claude-global.tar.gz` | `~/.claude` CLAUDE.md/RTK.md, settings.json + RTK hook, scheduled tasks, per-project memories, plugin manifests, `~/.claude.json` (MCP servers, trusted projects). Transcripts & plugin checkouts excluded |
| `claude-settings.local.json` | Project-local Claude settings |
| `RESTORE.md` + the scripts | Docs + automation travel inside the bundle |

`backup.sh` also audits git state before sealing: flags local branches missing
from origin, stashes not preserved on any remote branch, and uncommitted
changes. Stashes are preserved by pushing them as `stash/<name>` branches;
re-apply with `git stash apply origin/stash/<name>`.

## Rehearsal results (2026-06-07)

Restored from the sealed tarball into a sandbox while the live setup kept
running; live setup verified untouched afterwards.

| Check | Result |
|---|---|
| Clone from fork (all backup/stash/feature branches) | ✅ |
| DB row counts, all 64 tables vs live | ✅ identical |
| MinIO user objects (path-level hash) | ✅ identical (only live-instance `.minio.sys` bookkeeping differed) |
| Uploads volume + `server/data/uploads` | ✅ identical |
| `.env`, `daemon.id` | ✅ byte-identical |
| Claude global config, Electron state | ✅ present |
| Go server boots against restored DB | ✅ `/api/config` 200, `/api/issues` 401 unauth |
| Content spot-check (workspace, agents, knowledge) | ✅ readable |

## Rehearsing a restore yourself (sandbox mode)

`restore.sh` honors env overrides so the exact production script can be
rehearsed without touching the running setup:

```bash
tar xzf ~/Documents/multica-migration-<date>.tar.gz -C /tmp/rehearsal
cd /tmp/rehearsal/multica-migration
HOME=$HOME/restore-test-home \
RESTORE_SANDBOX=1 RESTORE_PG_CONTAINER=multica-test-postgres \
RESTORE_VOLUME_PREFIX=multicatest RESTORE_PG_PORT=55432 RESTORE_SKIP_PNPM=1 \
./restore.sh /tmp/rehearsal/repo
```

Teardown: `docker rm -f multica-test-postgres && docker volume rm
multicatest_pgdata multicatest_miniodata multicatest_backend_uploads`.

## Hard-won gotchas (already encoded in the scripts)

- **`mktemp -d` staging breaks Docker volume archiving on macOS** —
  `/var/folders` is outside Docker/Colima file sharing; bind-mounted `tar`
  output vanishes *silently*. Stage under `$HOME`; `backup.sh` hard-fails if
  a volume archive doesn't land.
- **bsdtar treats a leading `@` in a path as an archive reference** —
  archiving `@multica/...` needs a `./` prefix.
- **`--exclude='.multica/daemon.log'` does not match profile logs** —
  `~/.multica/profiles/*/daemon.log` needs its own exclude.
- Compose project name is pinned to `multica`, so volume names match on any
  machine regardless of clone path.
- Restore the DB from the dump **instead of** running fresh migrations
  (the dump carries `schema_migrations`); restore local files **before** the
  first `make` invocation so `make dev` can't generate a fresh `.env`.

## History

This kit supersedes `scripts/migrate-export.sh` / `migrate-import.sh`
(removed; see git history), which covered the DB, `.env`, `~/.multica` and the
two Docker volumes but not on-disk attachments, desktop app state, or Claude
Code config — and had no restore rehearsal mode. The DB-only backup flow
(`scripts/backup.sh` / `scripts/restore.sh`, versioned backup repo) is a
separate concern and remains.
