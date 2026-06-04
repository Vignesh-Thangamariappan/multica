-- ClickUp integration queries (Phase 1). Tables defined in
-- server/migrations/115_clickup_integration.up.sql; design in
-- docs/clickup-integration-rfc.md.
--
-- Scoping convention follows lark.sql: HTTP handlers use the
-- workspace-scoped variants; bare-PK lookups are reserved for internal
-- trusted callers (the Phase 2 poller).

-- =====================
-- clickup_installation
-- =====================

-- name: CreateClickUpInstallation :one
-- `api_token_encrypted` is secretbox ciphertext — never plaintext.
-- One installation per workspace (UNIQUE workspace_id).
INSERT INTO clickup_installation (workspace_id, team_id, team_name, api_token_encrypted, connected_by)
VALUES ($1, $2, $3, $4, $5)
RETURNING *;

-- name: GetClickUpInstallationByWorkspace :one
SELECT * FROM clickup_installation WHERE workspace_id = $1;

-- name: DeleteClickUpInstallation :execrows
DELETE FROM clickup_installation WHERE workspace_id = $1;

-- =====================
-- clickup_list_link
-- =====================

-- name: CreateClickUpListLink :one
INSERT INTO clickup_list_link (installation_id, workspace_id, project_id, list_id, list_name)
VALUES ($1, $2, $3, $4, $5)
RETURNING *;

-- name: ListClickUpListLinks :many
SELECT * FROM clickup_list_link WHERE workspace_id = $1 ORDER BY created_at DESC;

-- name: GetClickUpListLinkInWorkspace :one
SELECT * FROM clickup_list_link WHERE id = $1 AND workspace_id = $2;

-- name: GetClickUpListLinkByProject :one
SELECT * FROM clickup_list_link WHERE project_id = $1 AND workspace_id = $2;

-- name: DeleteClickUpListLink :execrows
DELETE FROM clickup_list_link WHERE id = $1 AND workspace_id = $2;

-- name: UpdateClickUpListLinkError :exec
UPDATE clickup_list_link SET last_error = $3 WHERE id = $1 AND workspace_id = $2;

-- =====================
-- clickup_task_link
-- =====================

-- name: CreateClickUpTaskLink :one
INSERT INTO clickup_task_link (issue_id, link_id, task_id, task_url, created_by_type, created_by_id)
VALUES ($1, $2, $3, $4, $5, $6)
ON CONFLICT (issue_id) DO NOTHING
RETURNING *;

-- name: GetClickUpTaskLinkByIssue :one
SELECT * FROM clickup_task_link WHERE issue_id = $1;

-- name: GetClickUpTaskLinkByTask :one
-- Import idempotency: a task already linked is skipped on re-import.
SELECT * FROM clickup_task_link WHERE link_id = $1 AND task_id = $2;

-- name: ListClickUpTaskLinksForIssues :many
SELECT * FROM clickup_task_link WHERE issue_id = ANY($1::uuid[]);

-- name: DeleteClickUpTaskLink :execrows
DELETE FROM clickup_task_link WHERE issue_id = $1;

-- =====================
-- clickup_status_map
-- =====================

-- name: UpsertClickUpStatusMap :exec
INSERT INTO clickup_status_map (link_id, clickup_status, multica_status)
VALUES ($1, $2, $3)
ON CONFLICT (link_id, clickup_status) DO UPDATE SET multica_status = EXCLUDED.multica_status;

-- name: ListClickUpStatusMap :many
SELECT * FROM clickup_status_map WHERE link_id = $1 ORDER BY clickup_status;

-- name: DeleteClickUpStatusMapForLink :exec
DELETE FROM clickup_status_map WHERE link_id = $1;

-- =====================
-- clickup_sync_audit
-- =====================

-- name: CreateClickUpSyncAudit :exec
INSERT INTO clickup_sync_audit (link_id, direction, task_id, issue_id, action, detail)
VALUES ($1, $2, $3, $4, $5, $6);
