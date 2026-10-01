# Fork sync runbook (upstream `multica-ai/multica` → this self-host fork)

Last sync: 2026-10-01 (`3a3159a14` → `ba30324e1`, branch `sync/upstream-2026-10-01`).

## Principles that keep the next sync cheap

- Fork code lives in **fork-owned files** wherever possible and touches upstream
  files through one-line hooks:
  - `server/internal/daemon/execenv/runtime_config_fork.go` — RTK, Workspace
    Knowledge, knowledge CLI, meeting-turn task kind (hooks in
    `runtime_config_sections.go` / `runtime_config_kind.go`).
  - `server/internal/handler/workspace_delete_manifest_fork_test.go` — registers
    fork tables (upstream's manifest test is otherwise untouched).
  - `scripts/fork-sync/` — one-shot DB fix-ups for existing databases.
- Do **not** track `apps/desktop/Anywhere-IOS-Container` (private repo, ignored in
  `.gitignore`). Keep it out of the project tree if you can: ESLint/Turbo scan it.

## Per-sync checklist

1. `git fetch --all --prune`; branch off `upstream/main`; replay fork commits
   (`git cherry-pick -x`). `git config rerere.enabled true` helps.
2. **Migrations**: renumber fork migrations above upstream's new maximum
   (`server/migrations`, upstream enforces unique numeric prefixes). Keep
   `*_issue_origin_clickup` **last** and refresh its CHECK list to upstream's
   latest `issue_origin_type_check` value set + `clickup_import`
   (`grep -l issue_origin_type_check server/migrations/*.up.sql`).
3. Existing databases: add/refresh a `scripts/fork-sync/pre-migrate-*.sql` that
   renames the applied fork rows in `schema_migrations` and stashes
   `clickup_import` rows (see `pre-migrate-2026-10.sql`).
4. Re-run `make sqlc`, `go build ./... && go vet ./...`, `go test ./...` against a
   **scratch** database (never the live one — handler tests write fixtures), then
   `pnpm typecheck && pnpm test && pnpm lint`.
5. Add new workspace pages to `packages/core/paths/route-icons.ts`,
   `packages/views/layout/route-icon-components.tsx`, the palette keywords in
   `packages/views/search/search-command.tsx`, diagnostics routes in
   `packages/core/diagnostics/diagnostic-context.ts`, and the `paths` mocks in
   `search-command.test.tsx` / `app-sidebar.test.tsx`; add every locale (en, fr,
   ja, ko, zh-Hans) — `locales/parity.test.ts` enforces it.
6. Nothing-lost check: diff the *added lines* of the previous fork tip against the
   new tip (see the sync note in Obsidian: "Multica upstream sync 2026-10-01").

## Existing database upgrade (one-time, 2026-10 sync)

Stop the **old** server first (the pre-migrate script renames applied fork rows, so
the old binary would otherwise fail its readiness check trying to re-apply
`149_workspace_knowledge`).

```bash
pg_dump -Fc "$DATABASE_URL" > multica-pre-sync-$(date +%F).dump
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/fork-sync/pre-migrate-2026-10.sql
make migrate-up          # applies ~410 upstream migrations + fork 566
```

Without the pre-migrate script and with any `origin_type='clickup_import'` row,
upstream migration `149_issue_origin_agent_create` aborts on the CHECK.

## Server env changes to review

- `JWT_SECRET` is required by compose and by the server in production.
- Telemetry is on by default (`DO_NOT_TRACK=1` turns it off).
- Plugin surfaces: keep `MULTICA_PLUGIN_SECRET_KEY` / `MULTICA_PLUGIN_SURFACE_ORIGIN`
  unset until the plugin-bridge path allowlist bypass is fixed upstream.

## Keep the daemon on the fork build

Meetings, Workspace Knowledge, RTK prompts and the self-correction retry live in
the **daemon binary**. An upstream release binary has none of them.

- Desktop-managed daemons are safe: the app bundles a CLI built from this tree
  (`apps/desktop/scripts/bundle-cli.mjs`) and refuses self-update.
- Standalone daemons (`make daemon`, `multica daemon start`): GitHub auto-update is
  off for self-hosted servers and for non-release (`git describe`) builds, but a
  **server-triggered runtime update** (the "update" action on a runtime in the UI)
  downloads the upstream release and restarts into it. There is no daemon flag that
  refuses it — do not trigger it on fork daemons; rebuild with `make daemon`
  instead. `--no-auto-update` / `--no-auto-reload` only cover the other two paths.

## Feature branches that only existed on `origin`

`origin/fix/autopilot-notifications` (1c9eeee1d) was never merged into `main` or
`dev-desktop-minio`; its inbox-for-autopilot-issues fix is ported here
(`origin_type: autopilot` + allowSelfNotify). Older `pre-rebase/round-*`,
`stash/*`, `backup/*`, `feature/working` branches are earlier snapshots of work
already in the tree.
