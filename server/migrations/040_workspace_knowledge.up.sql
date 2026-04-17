CREATE TABLE workspace_knowledge (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    agent_id UUID REFERENCES agent(id) ON DELETE SET NULL,
    content TEXT NOT NULL,
    source_task_id UUID REFERENCES agent_task_queue(id) ON DELETE SET NULL,
    -- 'active': injected into agent prompts (human-added or approved proposal)
    -- 'pending': proposed by an agent, awaiting human review
    -- 'rejected': rejected proposal, kept for audit
    status TEXT NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX workspace_knowledge_workspace_created_idx
    ON workspace_knowledge(workspace_id, created_at DESC);
CREATE INDEX workspace_knowledge_workspace_status_idx
    ON workspace_knowledge(workspace_id, status);
