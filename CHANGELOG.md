# Changelog — fork-specific work

This file tracks what this fork (`Vignesh-Thangamariappan/multica`) adds on top of
[`multica-ai/multica`](https://github.com/multica-ai/multica) (`upstream`). It does not
duplicate upstream's own history — only work introduced here.

## RTK / daemon self-improvement

Token-optimized CLI proxy work and self-improving agent loop for the local daemon
(token usage tracking, retry/self-correction plumbing). Also the backend seed for the
Knowledge feature below (originally landed in the same commit).

## Daemon / agent bugfix chain

A run of daemon and agent fixes, several of which repair damage from an earlier
fork-internal rebase (a dropped `buildRetryPrompt`, a duplicated retry prompt):

- Gemini CLI invocations now set `GEMINI_CLI_TRUST_WORKSPACE=true` and pass `--skip-trust`.
- Self-correction retry calls pass the task slot through to `runTask`.
- Agents no longer redo completed work when re-triggered by a comment.
- Claim-task failures now log before responding.
- execenv sidecar manifest tracks Claude settings.

## MinIO / S3 backup infrastructure

- MinIO added to the dev `docker-compose.yml`; ports bound to `127.0.0.1` (loopback-only,
  mirrors upstream's own Postgres/backend/frontend loopback-binding fix).
- `S3_PUBLIC_URL` and AWS credential env vars added to `docker-compose.selfhost.yml`.
- Database backup script gzips dumps to stay under GitHub's 100MB file limit.
- Full DB restore / device-migration scripts.
- `scripts/migration/` — a verified, end-to-end laptop-migration kit (backup.sh,
  restore.sh, sandbox rehearsal mode, guarded old-machine decommission) that supersedes
  the older `migrate-export.sh` / `migrate-import.sh` (didn't cover on-disk attachments,
  desktop state, or Claude config, and had no rehearsal mode).

## Desktop build/deploy hardening

- Added desktop build and dev scripts.
- `scripts/build-desktop.sh` now seeds `~/.multica/desktop.json` for packaged builds, so
  a freshly packaged self-host build doesn't silently fall back to the cloud API endpoint
  when the config file doesn't exist yet.

## Knowledge Space

A page where agents can propose knowledge and admins review it, plus the runtime
plumbing that injects accepted entries into agent context:

- Backend: migration, handler, sqlc-generated queries.
- Frontend: sidebar page, agent avatars, per-tab counts, status color accents.
- Injected knowledge is framed as binding numbered rules (not just background info) in
  the agent's context.
- Boundary UUID inputs validated via `parseUUIDOrBadRequest` (handler convention).

## ClickUp integration

Phase 1 (import & push-create), gated by `MULTICA_CLICKUP_SECRET_KEY`, inert when unset:

- Backend: typed REST client (shared rate limiter, 429 retry), status-map heuristics,
  connect/disconnect/discover, idempotent list import, push-create with duplicate guard.
- CLI: `multica clickup push <issue-id>`, `multica clickup links`.
- Frontend: settings tab, issue pairing.
- UI-driven runtime secret-key activation — admins can paste the at-rest encryption key
  into Settings > Integrations > ClickUp; validated (base64, 32 bytes), persisted to
  `MULTICA_SECRETS_DIR` (default `./data/secrets`, `0600`), hot-swapped in with no
  restart. Refused (409) when the key is env-managed or already configured.
- Selective import: preview dialog with per-task selection instead of all-or-nothing.

## Views / schema bugfixes

Issue-detail, gantt view, and `start_date` handling fixes (`IssueSchema.start_date` made
optional, gantt view and null-coalescing updated to match), plus editor support for
relative URLs on local-storage file attachments. Several of these are fixes for fallout
from an earlier fork-internal rebase (duplicate/missing toast imports).

## Squad access

`CreateSquad` now allows any workspace member, not just owner/admin — matches the
pattern used by `CreateProject` and other handlers, which the owner/admin restriction
was inconsistent with.

## Security notes

A focused review of this fork's 44 custom commits (not upstream's) found two MEDIUM
findings, both fixed here (folded into the relevant cluster commits during the
upstream rebase, not as separate patch commits):

- **ClickUp secret-key activation was scoped wrong.** `PUT /api/clickup/secret-key`
  was gated by per-workspace owner/admin, but the key it sets is process-global — it
  encrypts every workspace's ClickUp token on the instance, present and future. On a
  multi-tenant deployment where the operator hasn't set `MULTICA_CLICKUP_SECRET_KEY`,
  any user could create a workspace, become its admin, and be first to set the
  instance-wide key. Fixed by requiring `DISABLE_WORKSPACE_CREATION=true`
  (single-tenant self-host) before the UI activation endpoint will accept a key;
  multi-tenant instances must set the key via the operator-controlled env var instead.
- **Knowledge-proposal attribution trusted unvalidated headers.** `POST
  /api/knowledge/propose` read `X-Agent-ID`/`X-Task-ID` directly, checking only UUID
  *format*, not that the task belonged to that agent or the agent belonged to the
  calling workspace. Any workspace member could forge a proposal's provenance to look
  like an agent-distilled lesson, which — once approved — gets injected verbatim into
  every future agent's system prompt as a binding rule. Fixed by routing attribution
  through the existing `resolveActor` helper (the same fix already applied elsewhere
  per the #2359 review), which only trusts the headers after verifying agent/task
  ownership.

Also reviewed and found not exploitable: the squad-creation permission change (every
use of a squad's private leader agent independently re-checks access), the Gemini CLI
`--skip-trust` flag (consistent with the pre-existing fully-autonomous `--yolo` mode,
not a new trust boundary), and the MinIO/AWS docker-compose changes (placeholder
credentials only, loopback-bound).

## Autopilot run-done inbox notifications (2026-09-08)

Autopilots that never create an issue (`run_only` mode) previously completed or
failed with no signal anywhere in the product — the only way to know was to check
the run manually. `create_issue` autopilots weren't much better: the created issue
is assigned to an agent, so the human owner had no subscriber path either.

- Backend: new `autopilot:run_done` event listener creates an inbox item
  (`autopilot_completed` / `autopilot_failed`) for the autopilot's owner —
  the creating member directly, or an agent-creator's human owner. `skipped`
  runs (offline-at-dispatch admission misses) stay silent by design; they're
  operational noise, not something the owner asked for. Failed runs carry the
  failure reason as the inbox item body. Recipient resolution
  (`resolveAutopilotPausedRecipients` → `resolveAutopilotOwnerRecipients`) is
  now shared between the paused-autopilot and run-done notification paths
  instead of being duplicated.
- `extractIssueFields` (the dual-payload normalizer for `handler.IssueResponse`
  struct vs. autopilot-service `map[string]any` — see the fork's earlier
  autopilot-notification bugfix) gained `title`/`status` extraction.
- Frontend: `autopilot_completed` / `autopilot_failed` added to `InboxItemType`,
  labels, detail rendering, and all four locales (en/ja/ko/zh-Hans).
- Backend test coverage: completed → notify, failed → carries reason, skipped →
  silent, agent-created → routes to the agent's human owner.

### Security review of this batch

Reviewed the actual pending diff (not the full fork history above): no
HIGH/MEDIUM findings. `extractIssueFields`'s new field extraction was checked
against `issueToMap`'s emitted types (`title`/`status` are plain `string`,
matching the assertion) — no silent-drop risk. The new inbox item write is
scoped by `autopilot.WorkspaceID` and `r.ID` resolved server-side from the
autopilot row, not from client input. `run.FailureReason` is rendered via
React (`<span>{item.body}</span>`), not `dangerouslySetInnerHTML`, so it can't
carry stored XSS even though its content originates from agent-run output.

**Unrelated but significant finding surfaced during this audit:**
`apps/desktop/Anywhere-IOS-Container` is tracked in this repo's history as an
unregistered git submodule pointer (mode `160000`, no `.gitmodules` entry)
whose actual remote is a private employer repo,
`git@github.com:Adaptavant/Anywhere-IOS-Container.git`. It was added in one
commit (`74d444bf5`, the ClickUp integration work) and is already pushed to
`origin/dev-desktop-minio` on `Vignesh-Thangamariappan/multica`, which is a
**public** GitHub repo. No source code is exposed (a gitlink is just a commit
SHA), but the private repo's name/path and a specific internal commit SHA are
now visible in public commit history. Flagged to the user; not yet remediated
— needs an explicit decision (drop from future commits vs. rewrite history).
