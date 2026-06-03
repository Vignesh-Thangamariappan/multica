// Workspace knowledge — lessons agents learn, gated by human review.
// Agents propose entries (status "pending"); admins approve ("active") or
// reject ("rejected"). Active entries are injected into agent prompts at
// task-claim time by the daemon.

/**
 * Server-driven string. Known values: "active" | "pending" | "rejected".
 * Typed as string so new server-side statuses degrade instead of crash
 * (see API Response Compatibility in CLAUDE.md).
 */
export type KnowledgeStatus = string;

export interface WorkspaceKnowledge {
  id: string;
  workspace_id: string;
  agent_id?: string | null;
  content: string;
  status: KnowledgeStatus;
  created_at: string;
}

export interface CreateKnowledgeRequest {
  content: string;
}
