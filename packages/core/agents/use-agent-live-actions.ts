import { useMemo } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import type { TaskMessagePayload } from "../types";
import { agentTaskSnapshotOptions } from "./queries";
import { taskMessagesOptions, isTaskMessageTaskId } from "../chat/queries";

/** What an agent is doing right now, derived from its running task's stream. */
export interface AgentLiveAction {
  /** Humanized label for a status chip, e.g. "Reading paths.ts". */
  label: string;
  /** Short tool token for a compact surface (a monitor), e.g. "Read". */
  tool: string;
}

/**
 * Live per-agent "current action" for the Office view: for every running task
 * it reads the most recent `task:message` (already streamed into the
 * task-messages query cache by useRealtimeSync) and turns the latest tool call
 * into a human label — "Reading", "Running command", "Update topic", etc.
 *
 * Returns a Map keyed by agent id. Agents with no live tool activity are
 * absent; callers fall back to a static label.
 */
export function useAgentLiveActions(wsId: string): Map<string, AgentLiveAction> {
  const { data: snapshot = [] } = useQuery(agentTaskSnapshotOptions(wsId));

  const runningTaskIds = useMemo(() => {
    const ids: { taskId: string; agentId: string }[] = [];
    const seen = new Set<string>();
    for (const t of snapshot) {
      if (t.status !== "running" || !isTaskMessageTaskId(t.id)) continue;
      if (seen.has(t.agent_id)) continue; // one running task per agent is enough
      seen.add(t.agent_id);
      ids.push({ taskId: t.id, agentId: t.agent_id });
    }
    return ids;
  }, [snapshot]);

  const results = useQueries({
    queries: runningTaskIds.map(({ taskId }) => taskMessagesOptions(taskId)),
  });

  // Recompute only when message data actually changes (not every render).
  const signature = results.map((r) => r.dataUpdatedAt).join(",");

  return useMemo(() => {
    const map = new Map<string, AgentLiveAction>();
    runningTaskIds.forEach(({ agentId }, i) => {
      const msgs = results[i]?.data as TaskMessagePayload[] | undefined;
      const action = msgs && msgs.length ? deriveAction(msgs) : null;
      if (action) map.set(agentId, action);
    });
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runningTaskIds, signature]);
}

// Walk the stream backwards and report the most recent meaningful step.
function deriveAction(msgs: readonly TaskMessagePayload[]): AgentLiveAction | null {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (!m) continue;
    if (m.type === "tool_use" && m.tool) return toolAction(m.tool, m.input);
    if (m.type === "thinking") return { label: "Thinking…", tool: "Thinking" };
    if (m.type === "text") return { label: "Writing response", tool: "Response" };
    // tool_result / error → keep scanning for the tool that produced it
  }
  return null;
}

// Friendly verbs for well-known agent tools; everything else (MCP tools,
// CLI commands like `update_topic`) is prettified from its raw name.
const TOOL_VERB: Record<string, string> = {
  Read: "Reading",
  Write: "Writing",
  Edit: "Editing",
  MultiEdit: "Editing",
  NotebookEdit: "Editing",
  Bash: "Running command",
  Glob: "Searching files",
  Grep: "Searching code",
  LS: "Listing files",
  WebFetch: "Browsing web",
  WebSearch: "Searching web",
  Task: "Delegating",
  Agent: "Delegating",
  TodoWrite: "Planning",
};

function toolAction(tool: string, input?: Record<string, unknown>): AgentLiveAction {
  const pretty = prettifyTool(tool);
  const verb = TOOL_VERB[tool] ?? pretty;
  const target = toolTarget(tool, input);
  return { label: target ? `${verb} ${target}` : verb, tool: pretty };
}

// "mcp__multica__update_topic" → "Update topic"; "update_topic" → "Update topic".
function prettifyTool(tool: string): string {
  let t = tool;
  const mcp = /^mcp__[^_]+__(.+)$/.exec(t) ?? /^mcp__(.+)$/.exec(t);
  if (mcp?.[1]) t = mcp[1];
  t = t.replace(/[_-]+/g, " ").trim();
  if (!t) return tool;
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function toolTarget(tool: string, input?: Record<string, unknown>): string {
  if (!input) return "";
  const i = input as Record<string, unknown>;
  // Commands are too long for a chip — the verb alone reads cleanly.
  if (tool === "Bash") return "";
  const fp = i.file_path ?? i.path;
  if (typeof fp === "string" && fp) return basename(fp);
  if (typeof i.pattern === "string" && i.pattern) return clip(i.pattern, 22);
  if (typeof i.query === "string" && i.query) return clip(i.query, 22);
  return "";
}

function basename(p: string): string {
  const parts = p.split(/[/\\]/).filter(Boolean);
  return clip(parts[parts.length - 1] ?? p, 22);
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
