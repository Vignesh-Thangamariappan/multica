-- One-shot fix-up for EXISTING fork databases, run BEFORE the first server /
-- `make migrate` after the 2026-10 upstream sync (sync/upstream-2026-10-01).
-- Fresh databases do not need it.
--
-- TAKE A pg_dump FIRST. Usage:
--   pg_dump -Fc "$DATABASE_URL" > multica-pre-sync-$(date +%F).dump
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/fork-sync/pre-migrate-2026-10.sql
--
-- What it does (all in one transaction, safe to re-run):
--  1. Renames the fork's already-applied schema_migrations rows to their new
--     numbers (fork migrations moved above upstream's 563). Without this the
--     migrator would re-run them and fail on "table already exists".
--  2. Retires 151_issue_origin_clickup. It is replaced by
--     566_issue_origin_clickup, which carries upstream's full origin list plus
--     'clickup_import'. (The old 151 also dropped 'slack_chat' from the CHECK,
--     a latent bug this sync fixes.)
--  3. Stashes issues stamped origin_type='clickup_import' and clears the stamp
--     so upstream's validating `ADD CONSTRAINT issue_origin_type_check`
--     (migration 149) does not fail on rows its list does not know. Migration
--     566 restores them from the stash and drops it.
--
-- Upstream's own renames of 145..148 chat migrations need no action: it
-- rewrote them as idempotent (IF NOT EXISTS) so re-running is safe.

BEGIN;

DO $$
BEGIN
    IF to_regclass('public.schema_migrations') IS NULL THEN
        RAISE EXCEPTION 'schema_migrations not found; run this against the Multica database';
    END IF;
END $$;

UPDATE schema_migrations SET version = '564_workspace_knowledge' WHERE version = '149_workspace_knowledge';
UPDATE schema_migrations SET version = '565_clickup_integration' WHERE version = '150_clickup_integration';
UPDATE schema_migrations SET version = '567_meetings'            WHERE version = '152_meetings';
DELETE FROM schema_migrations WHERE version = '151_issue_origin_clickup';

DO $$
BEGIN
    IF to_regclass('public.fork_clickup_origin_stash') IS NULL THEN
        CREATE TABLE fork_clickup_origin_stash AS
            SELECT id, origin_type, origin_id FROM issue WHERE origin_type = 'clickup_import';
    ELSE
        -- Re-run: merge anything stamped since the first run.
        INSERT INTO fork_clickup_origin_stash
            SELECT id, origin_type, origin_id FROM issue WHERE origin_type = 'clickup_import';
    END IF;
END $$;

UPDATE issue SET origin_type = NULL, origin_id = NULL WHERE origin_type = 'clickup_import';

SELECT version FROM schema_migrations
 WHERE version IN ('564_workspace_knowledge','565_clickup_integration','567_meetings','149_workspace_knowledge','150_clickup_integration','151_issue_origin_clickup','152_meetings')
 ORDER BY version;
SELECT count(*) AS stashed_clickup_issues FROM fork_clickup_origin_stash;

COMMIT;
