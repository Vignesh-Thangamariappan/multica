# RFC: ClickUp Integration — Design

> Status: Accepted (2026-06-04) — Phase 1 in progress; assignee handling dropped from all phases per review
> Last updated: 2026-06-04
> Decision record: [clickup-integration-adr.md](./clickup-integration-adr.md)

## TL;DR

Per-workspace ClickUp connection (personal API token, encrypted at rest), linked at
**Multica Project ↔ ClickUp List** granularity. Phase 1 ships **bulk import** and
**push-create**; Phase 2 adds **continuous cursor-polling sync** with last-writer-wins
and an echo fence; Phase 3 adds **signed webhooks** (when publicly reachable) and OAuth.
Everything is gated by `MULTICA_CLICKUP_SECRET_KEY` and lives in
`server/internal/integrations/clickup/` — inert and zero-surface when unset.

---

## 1. Goals / Non-goals

**Goals**
- G1: Import tasks from a ClickUp List into a Multica project as issues.
- G2: Create a ClickUp task from a Multica issue ("push-create"), keeping the pair linked.
- G3: Keep linked pairs in sync: title, description, status, due date; comments one-way (Multica → ClickUp).
- G4: Work on a non-public self-hosted instance (polling), get faster on a public one (webhooks).
- G5: Follow house integration patterns (Lark service boundary, GitHub link tables, secretbox, role gating).

**Non-goals (this RFC)**
- ClickUp custom fields, attachments, subtask hierarchies, time tracking.
- Two-way comment sync (inbound ClickUp comments are Phase 3+ at best).
- Assignee mapping beyond a best-effort email match (no per-member ClickUp identity binding in v1).
- Migrating *out* of ClickUp (bulk export).

## 2. ClickUp API primer (v2)

- **Hierarchy:** Team (= ClickUp Workspace) → Space → Folder? → **List** → **Task**. Statuses are defined **per List**; each status has `status` (string) and `type` (`open` | `custom` | `done` | `closed`).
- **Auth:** `Authorization: pk_<personal token>` header. Rate limit ≈100 req/min/token.
- **Key endpoints:**
  - `GET /api/v2/team` — teams visible to token (used to validate token at connect time)
  - `GET /api/v2/team/{team_id}/space`, `GET /api/v2/space/{id}/list`, `GET /api/v2/folder/{id}/list` — discovery for the link picker
  - `GET /api/v2/list/{list_id}/task?date_updated_gt=<ms>&include_closed=true&page=<n>` — incremental pull (the **cursor read**)
  - `POST /api/v2/list/{list_id}/task` — create task
  - `PUT /api/v2/task/{task_id}` — update task (returns new `date_updated`)
  - `POST /api/v2/task/{task_id}/comment` — mirror a comment
  - `POST /api/v2/team/{team_id}/webhook` — register webhook (`endpoint`, `events[]`); response carries webhook `id` + `secret`; deliveries signed `X-Signature: <hex hmac-sha256(secret, body)>`
- **Task fields used:** `id`, `name`, `description` (markdown-ish), `status.status`, `status.type`, `date_updated` (ms epoch), `due_date`, `assignees[].email`, `url`.

## 3. Data model (migrations 115+)

All tables follow Lark conventions: composite FKs pinning `workspace_id`, cascade deletes,
no plaintext secrets, audit without content.

### 115_clickup_integration.up.sql

```sql
-- One connection per workspace. The personal token is AES-256-GCM ciphertext
-- (util/secretbox); plaintext only in RAM. Mirrors lark_installation.
CREATE TABLE clickup_installation (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id    UUID NOT NULL UNIQUE REFERENCES workspace(id) ON DELETE CASCADE,
    team_id         TEXT NOT NULL,              -- ClickUp team (workspace) id
    team_name       TEXT NOT NULL DEFAULT '',
    api_token_encrypted BYTEA NOT NULL,
    connected_by    UUID REFERENCES "user"(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Project ↔ List link. One List syncs into one project (and vice versa).
-- sync_cursor_ms is the high-water date_updated (ms epoch) already ingested.
CREATE TABLE clickup_list_link (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    installation_id UUID NOT NULL REFERENCES clickup_installation(id) ON DELETE CASCADE,
    workspace_id    UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    project_id      UUID NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    list_id         TEXT NOT NULL,
    list_name       TEXT NOT NULL DEFAULT '',
    sync_enabled    BOOLEAN NOT NULL DEFAULT false,   -- Phase 2 switch; Phase 1 links are import/create only
    sync_cursor_ms  BIGINT NOT NULL DEFAULT 0,
    last_polled_at  TIMESTAMPTZ,
    last_error      TEXT NOT NULL DEFAULT '',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (installation_id, list_id),
    UNIQUE (project_id)                               -- a project syncs with at most one list
);

-- Issue ↔ Task pair. The heart of sync. Mirrors issue_pull_request + adds fence fields.
CREATE TABLE clickup_task_link (
    issue_id        UUID NOT NULL REFERENCES issue(id) ON DELETE CASCADE,
    link_id         UUID NOT NULL REFERENCES clickup_list_link(id) ON DELETE CASCADE,
    task_id         TEXT NOT NULL,
    task_url        TEXT NOT NULL DEFAULT '',
    -- Echo fence: date_updated returned by OUR last outbound write. Inbound
    -- changes with date_updated <= fence are our own echo — skip them.
    outbound_fence_ms BIGINT NOT NULL DEFAULT 0,
    last_synced_ms  BIGINT NOT NULL DEFAULT 0,        -- task.date_updated last applied inbound
    created_by_type TEXT NOT NULL DEFAULT 'member',   -- member | agent | import
    created_by_id   UUID,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (issue_id),
    UNIQUE (link_id, task_id)
);

-- Per-link status mapping (ClickUp statuses are per-List strings).
CREATE TABLE clickup_status_map (
    link_id         UUID NOT NULL REFERENCES clickup_list_link(id) ON DELETE CASCADE,
    clickup_status  TEXT NOT NULL,                    -- lowercase ClickUp status string
    multica_status  TEXT NOT NULL,                    -- backlog|todo|in_progress|in_review|done|cancelled
    PRIMARY KEY (link_id, clickup_status)
);

-- Non-content audit (Lark precedent): what moved, which direction, why dropped.
CREATE TABLE clickup_sync_audit (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    link_id         UUID NOT NULL REFERENCES clickup_list_link(id) ON DELETE CASCADE,
    direction       TEXT NOT NULL,                    -- inbound | outbound
    task_id         TEXT NOT NULL,
    issue_id        UUID,
    action          TEXT NOT NULL,                    -- created | updated | skipped_echo | skipped_stale | error
    detail          TEXT NOT NULL DEFAULT '',         -- never task content
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX clickup_sync_audit_link_idx ON clickup_sync_audit(link_id, created_at DESC);
```

### 116_issue_origin_clickup.up.sql

```sql
-- Extend issue origin tracking (house pattern: 060 autopilot, 111 lark_chat).
ALTER TABLE issue DROP CONSTRAINT IF EXISTS issue_origin_type_check;
ALTER TABLE issue ADD CONSTRAINT issue_origin_type_check
  CHECK (origin_type IN ('autopilot', 'quick_create', 'lark_chat', 'clickup_import'));
```

(Imported issues get `origin_type='clickup_import'`, `origin_id=clickup_list_link.id`.)

### 117_clickup_webhook.up.sql (Phase 3)

```sql
ALTER TABLE clickup_installation
  ADD COLUMN webhook_id TEXT NOT NULL DEFAULT '',
  ADD COLUMN webhook_secret_encrypted BYTEA;          -- HMAC secret, encrypted like the token
```

## 4. Service architecture

```
server/internal/integrations/clickup/
├── client.go          # typed ClickUp REST client (timeouts, 100 req/min limiter, retry w/ jitter)
├── installation.go    # connect (validate token via GET /team) / disconnect / token decrypt
├── links.go           # list discovery, link create/delete, status-map seeding
├── importer.go        # Phase 1 bulk import (paged GET /list/{id}/task)
├── pusher.go          # Phase 1 push-create + Phase 2 outbound updates (records fence)
├── poller.go          # Phase 2: per-link cursor loop, default 60s, jittered
├── ingest.go          # the ONE inbound pipeline (poll + webhook both call ApplyTask)
├── statusmap.go       # heuristics: type done/closed→done, "review"→in_review, "progress"→in_progress, open→todo
└── webhook.go         # Phase 3: register/verify (HMAC X-Signature), translate → ingest
```

Wiring in `cmd/server/router.go` (Lark pattern, one block):

```go
if key := os.Getenv("MULTICA_CLICKUP_SECRET_KEY"); key != "" {
    clickupSvc = clickup.NewService(queries, secretbox.New(key), logger)
    // poller only starts for links with sync_enabled = true
    go clickupSvc.RunPoller(ctx)
}
// handlers constructed either way; nil service ⇒ 503 "clickup not configured"
```

### Sync pipeline (Phase 2 core)

```
            ┌──────────────┐   tasks where date_updated > cursor
poll (60s) ─┤ ListTasks    ├──────────────┐
            └──────────────┘              ▼
webhook ───────────────────────────► ApplyTask(task)
(Phase 3, same pipeline)                  │
                                          ├─ no clickup_task_link?  → create issue (import rules) + link
                                          ├─ task.date_updated <= outbound_fence_ms? → skipped_echo
                                          ├─ task.date_updated <= last_synced_ms?    → skipped_stale
                                          └─ else apply: title/description/status(map)/due_date
                                             then last_synced_ms = task.date_updated
                                             advance link.sync_cursor_ms = max(seen)
```

Outbound (Multica → ClickUp), triggered by issue WS events on linked issues:

```
issue updated ─► debounce 2s ─► PUT /task/{id} ─► outbound_fence_ms = resp.date_updated
issue comment ─► POST /task/{id}/comment (one-way, prefixed "💬 <author> via Multica:")
```

The fence makes the loop safe: our own PUT bumps `date_updated`; the next poll sees the
task as changed, but `date_updated <= outbound_fence_ms` ⇒ `skipped_echo`. A *real*
ClickUp edit after our write has a strictly larger `date_updated` and passes.

**Deletion policy:** ClickUp task deleted → unlink + post system comment on the issue
(never delete the issue). Multica issue deleted → unlink only (never delete the task).

## 5. HTTP API

| Route | Method | Role | Purpose |
|---|---|---|---|
| `/api/clickup/installation` | GET | member | Connection status (never the token) |
| `/api/clickup/installation` | POST | owner/admin | Connect: `{api_token}` → validate via `GET /team`, encrypt, store |
| `/api/clickup/installation` | DELETE | owner/admin | Disconnect (cascades links) |
| `/api/clickup/spaces` | GET | owner/admin | Discovery tree for the link picker (spaces→folders→lists) |
| `/api/clickup/links` | GET | member | List project↔list links + cursor/health |
| `/api/clickup/links` | POST | owner/admin | Create link `{project_id, list_id}`; seeds status map |
| `/api/clickup/links/{id}` | DELETE | owner/admin | Unlink (task links cascade) |
| `/api/clickup/links/{id}/import` | POST | owner/admin | Phase 1 bulk import (async; returns job summary) |
| `/api/clickup/links/{id}/status-map` | GET/PUT | owner/admin | View/edit status mapping |
| `/api/issues/{id}/clickup` | POST | member | Push-create this issue as a task in the project's linked list |
| `/api/webhooks/clickup` | POST | HMAC | Phase 3 ingress (signature check before parse, 256 KiB cap) |

All UUID params via `parseUUIDOrBadRequest`. All responses consumed by the frontend go
through zod schemas with `parseWithFallback`; ClickUp status strings stay `z.string()`.

## 6. Frontend

- **Settings → ClickUp tab** (`packages/views/settings/components/clickup-tab.tsx`, mirrors
  `github-tab.tsx`): connect (token paste field, admin), connection card (team name,
  connected-by, disconnect), links table (project ↔ list, sync toggle, last poll, error
  badge), link picker dialog (space/folder/list tree), import button with progress toast.
- **Issue detail**: if the issue's project is linked and no task link exists →
  "Create in ClickUp" action (overflow menu); if linked → ClickUp chip with `task_url`
  (external link icon), mirroring the PR-chip pattern.
- i18n namespace `settings.clickup.*` + `issues.clickup.*` in en/zh-Hans/ko/ja.

## 7. Security

- Token + webhook secret encrypted via `util/secretbox` (AES-256-GCM, random nonce); key
  from `MULTICA_CLICKUP_SECRET_KEY` (base64, 32 bytes). Never returned by any endpoint.
- Webhook (Phase 3): constant-time HMAC compare before body parse; per-IP rate limit
  (autopilot limiter); body cap 256 KiB; unknown event types → 200 + audit row (never 5xx,
  ClickUp retries on failure and disables webhooks that keep failing).
- Imported task content is untrusted input: rendered through the existing markdown
  sanitizer path, same as user-authored descriptions (no new render surface).
- Audit table records routing metadata only — never task/comment content (Lark precedent).
- Self-host guidance: leave `MULTICA_CLICKUP_SECRET_KEY` unset ⇒ feature fully inert.

## 8. Phasing & estimates

| Phase | Scope | Est. |
|---|---|---|
| **1 — Import & push-create** | Migrations 115-116, client, installation+links+status-map, importer, push-create, settings tab, issue chip | 3-4 days |
| **2 — Continuous sync** | Poller, ingest pipeline + fence, outbound updater (debounced), comment mirroring, link health UI | 2-3 days |
| **3 — Webhooks + OAuth** | Migration 117, webhook register/verify/ingress, OAuth app (cloud) | 2 days |

Each phase is independently shippable; Phase 1 alone satisfies "import or create".

## 9. Test plan

- **Go:** client against `httptest` ClickUp stub (pagination, rate-limit 429 retry, malformed
  JSON); fence property test (our-echo skipped, real edit applied); status-map heuristics
  table test; importer idempotency (re-import creates no duplicates — keyed on `(link_id, task_id)`);
  handler boundary tests (invalid UUIDs → 400; unconfigured → 503; non-admin → 403);
  Phase 3: HMAC verification (bad sig → 401, replay within cap → dedup).
- **TS:** zod fallback tests (null/non-array/missing fields per house rule); settings tab
  (connect flow, admin gating); issue chip render.
- **E2E (optional):** settings → connect (stubbed) → link → import happy path.

## 10. Open questions (for review)

1. **Poll interval** — 60s default OK, or should it be per-link configurable from the UI?
2. **Import scope** — import *all* tasks in the list (incl. `closed`) or open-only by default
   with an "include closed" checkbox? (RFC assumes open-only default.)
3. **Assignees** — v1 does best-effort email match (ClickUp assignee email == member email).
   Acceptable, or drop assignee handling entirely from Phase 1?
4. **Priority mapping** — ClickUp priorities (urgent/high/normal/low) map 1:1 to Multica's.
   Include in Phase 1? (Cheap; RFC assumes yes.)
5. **Which Multica entity for `description` round-trip** — ClickUp `description` is
   markdown-ish but lossy (no Multica mentions/highlights). Outbound: strip platform-specific
   syntax. Acceptable?
