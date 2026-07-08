-- ClickUp integration Phase 1 (docs/clickup-integration-rfc.md).
-- One connection per workspace; the personal API token is AES-256-GCM
-- ciphertext via util/secretbox — plaintext only ever lives in RAM
-- (mirrors lark_installation.app_secret_encrypted).
CREATE TABLE IF NOT EXISTS clickup_installation (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id    UUID NOT NULL UNIQUE REFERENCES workspace(id) ON DELETE CASCADE,
    team_id         TEXT NOT NULL,
    team_name       TEXT NOT NULL DEFAULT '',
    api_token_encrypted BYTEA NOT NULL,
    connected_by    UUID REFERENCES "user"(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Project <-> ClickUp List link. ClickUp statuses are defined per-List,
-- so this is the granularity where a status map stays coherent (ADR C2).
-- sync_cursor_ms / sync_enabled are Phase 2 fields, created now so the
-- poller lands without another migration.
CREATE TABLE IF NOT EXISTS clickup_list_link (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    installation_id UUID NOT NULL REFERENCES clickup_installation(id) ON DELETE CASCADE,
    workspace_id    UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    project_id      UUID NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    list_id         TEXT NOT NULL,
    list_name       TEXT NOT NULL DEFAULT '',
    sync_enabled    BOOLEAN NOT NULL DEFAULT false,
    sync_cursor_ms  BIGINT NOT NULL DEFAULT 0,
    last_polled_at  TIMESTAMPTZ,
    last_error      TEXT NOT NULL DEFAULT '',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (installation_id, list_id),
    UNIQUE (project_id)
);

-- Issue <-> Task pair. outbound_fence_ms is the echo fence: date_updated
-- returned by OUR last outbound write — inbound changes at or below it are
-- our own echo and are skipped (ADR D1).
CREATE TABLE IF NOT EXISTS clickup_task_link (
    issue_id        UUID NOT NULL REFERENCES issue(id) ON DELETE CASCADE,
    link_id         UUID NOT NULL REFERENCES clickup_list_link(id) ON DELETE CASCADE,
    task_id         TEXT NOT NULL,
    task_url        TEXT NOT NULL DEFAULT '',
    outbound_fence_ms BIGINT NOT NULL DEFAULT 0,
    last_synced_ms  BIGINT NOT NULL DEFAULT 0,
    created_by_type TEXT NOT NULL DEFAULT 'member',
    created_by_id   UUID,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (issue_id),
    UNIQUE (link_id, task_id)
);

-- Per-link status mapping (ClickUp status strings are arbitrary per-List).
CREATE TABLE IF NOT EXISTS clickup_status_map (
    link_id         UUID NOT NULL REFERENCES clickup_list_link(id) ON DELETE CASCADE,
    clickup_status  TEXT NOT NULL,
    multica_status  TEXT NOT NULL,
    PRIMARY KEY (link_id, clickup_status)
);

-- Non-content sync audit (Lark precedent: routing metadata only, never
-- task or comment content).
CREATE TABLE IF NOT EXISTS clickup_sync_audit (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    link_id         UUID NOT NULL REFERENCES clickup_list_link(id) ON DELETE CASCADE,
    direction       TEXT NOT NULL,
    task_id         TEXT NOT NULL,
    issue_id        UUID,
    action          TEXT NOT NULL,
    detail          TEXT NOT NULL DEFAULT '',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS clickup_sync_audit_link_idx
    ON clickup_sync_audit(link_id, created_at DESC);
