-- name: CreateWorkspaceKnowledge :one
INSERT INTO workspace_knowledge (workspace_id, agent_id, content, source_task_id, status)
VALUES ($1, $2, $3, $4, $5)
RETURNING *;

-- name: ListWorkspaceKnowledgeByStatus :many
SELECT * FROM workspace_knowledge
WHERE workspace_id = $1 AND status = $2
ORDER BY created_at DESC
LIMIT $3;

-- name: ListActiveWorkspaceKnowledge :many
SELECT * FROM workspace_knowledge
WHERE workspace_id = $1 AND status = 'active'
ORDER BY created_at DESC
LIMIT $2;

-- name: GetWorkspaceKnowledge :one
SELECT * FROM workspace_knowledge
WHERE id = $1 AND workspace_id = $2;

-- name: UpdateWorkspaceKnowledgeStatus :one
UPDATE workspace_knowledge
SET status = $3
WHERE id = $1 AND workspace_id = $2
RETURNING *;

-- name: DeleteWorkspaceKnowledge :exec
DELETE FROM workspace_knowledge
WHERE id = $1 AND workspace_id = $2;
