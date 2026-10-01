-- Extend issue.origin_type so bulk-imported ClickUp tasks can be stamped
-- with origin_type='clickup_import' + origin_id=<clickup_list_link.id>.
--
-- FORK MIGRATION — must stay the LAST migration that rewrites
-- issue_origin_type_check. Every upstream migration that widens the CHECK
-- (149, 259, 263, 366, ...) re-creates it from scratch and would silently drop
-- 'clickup_import'. After each upstream sync, renumber this file above the new
-- upstream maximum and update the list below to upstream's latest value set
-- plus 'clickup_import' (see docs/fork-sync-runbook.md).
--
-- Existing databases: scripts/fork-sync/pre-migrate-2026-10.sql stashes the
-- clickup_import rows before upstream's validating ADD CONSTRAINT runs; they
-- are restored here once 'clickup_import' is allowed again.
ALTER TABLE issue DROP CONSTRAINT IF EXISTS issue_origin_type_check;
ALTER TABLE issue ADD CONSTRAINT issue_origin_type_check
    CHECK (origin_type IN ('autopilot', 'quick_create', 'lark_chat', 'slack_chat', 'agent_create', 'dingtalk_chat', 'wecom_chat', 'telegram_chat', 'clickup_import'))
    NOT VALID;

DO $$
BEGIN
    IF to_regclass('public.fork_clickup_origin_stash') IS NOT NULL THEN
        UPDATE issue i
           SET origin_type = s.origin_type,
               origin_id   = s.origin_id
          FROM fork_clickup_origin_stash s
         WHERE i.id = s.id;
        DROP TABLE fork_clickup_origin_stash;
    END IF;
END $$;

ALTER TABLE issue VALIDATE CONSTRAINT issue_origin_type_check;
