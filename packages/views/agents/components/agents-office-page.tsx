"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Building2 } from "lucide-react";
import {
  agentRunCounts30dOptions,
  agentTaskSnapshotOptions,
  useAgentLiveActions,
  useWorkspacePresenceMap,
} from "@multica/core/agents";
import { useWorkspaceId } from "@multica/core/hooks";
import { agentListOptions } from "@multica/core/workspace/queries";
import { PageHeader } from "../../layout/page-header";
import { AgentsOfficeView } from "./agents-office-view";
import type { DelegationEdge } from "./agents-office-view";
import type { AgentRow } from "./agent-columns";

export function AgentsOfficePage() {
  const wsId = useWorkspaceId();

  const { data: agents = [] } = useQuery(agentListOptions(wsId));
  const { data: taskSnapshot = [] } = useQuery(agentTaskSnapshotOptions(wsId));
  const { data: runCountsRaw = [] } = useQuery(agentRunCounts30dOptions(wsId));
  const { byAgent: presenceMap } = useWorkspacePresenceMap(wsId);
  const liveActions = useAgentLiveActions(wsId);

  const runCountsById = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of runCountsRaw) m.set(r.agent_id, r.run_count);
    return m;
  }, [runCountsRaw]);

  const runningTaskSummary = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of taskSnapshot) {
      if (t.status === "running" && t.trigger_summary && !m.has(t.agent_id)) {
        m.set(t.agent_id, t.trigger_summary);
      }
    }
    return m;
  }, [taskSnapshot]);

  const delegationEdges = useMemo<DelegationEdge[]>(() => {
    const taskById = new Map<string, string>(); // task id → agent id
    for (const t of taskSnapshot) taskById.set(t.id, t.agent_id);
    const seen = new Set<string>();
    const edges: DelegationEdge[] = [];
    for (const t of taskSnapshot) {
      if (!t.parent_task_id) continue;
      if (t.status !== "running" && t.status !== "queued" && t.status !== "dispatched") continue;
      const parentAgentId = taskById.get(t.parent_task_id);
      if (!parentAgentId || parentAgentId === t.agent_id) continue;
      const key = `${parentAgentId}>${t.agent_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ fromAgentId: parentAgentId, toAgentId: t.agent_id });
    }
    return edges;
  }, [taskSnapshot]);

  const activeAgents = useMemo(
    () => agents.filter((a) => !a.archived_at),
    [agents],
  );

  const rows = useMemo<AgentRow[]>(() =>
    activeAgents.map((agent) => ({
      agent,
      runtime: null,
      presence: presenceMap.get(agent.id) ?? null,
      activity: null,
      runCount: runCountsById.get(agent.id) ?? 0,
      ownerIdToShow: null,
      isOwnedByMe: false,
      canManage: false,
    })),
    [activeAgents, presenceMap, runCountsById],
  );

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      <PageHeader className="px-5">
        <div className="flex items-center gap-2">
          <Building2 className="h-4 w-4 text-muted-foreground" />
          <h1 className="text-sm font-medium">Office</h1>
          {activeAgents.length > 0 && (
            <span className="font-mono text-xs tabular-nums text-muted-foreground/70">
              {activeAgents.length}
            </span>
          )}
        </div>
      </PageHeader>
      <AgentsOfficeView
        rows={rows}
        runningTaskSummary={runningTaskSummary}
        liveActions={liveActions}
        delegationEdges={delegationEdges}
      />
    </div>
  );
}
