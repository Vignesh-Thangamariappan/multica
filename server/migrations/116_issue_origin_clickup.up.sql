-- Extend issue.origin_type so bulk-imported ClickUp tasks can be stamped
-- with origin_type='clickup_import' + origin_id=<clickup_list_link.id>
-- (house pattern: 060 autopilot, 111 lark_chat).
ALTER TABLE issue DROP CONSTRAINT IF EXISTS issue_origin_type_check;
ALTER TABLE issue ADD CONSTRAINT issue_origin_type_check
    CHECK (origin_type IN ('autopilot', 'quick_create', 'lark_chat', 'clickup_import'));
