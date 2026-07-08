import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { knowledgeKeys } from "./queries";
import { useWorkspaceId } from "../hooks";
import type { WorkspaceKnowledge, CreateKnowledgeRequest } from "../types";

/**
 * Optimistic review actions. Approve/reject remove the entry from the pending
 * list immediately (the reviewer is working down a queue — waiting a round-trip
 * per decision would make triage feel broken), snapshot for rollback, and
 * invalidate every knowledge list on settle so the target tab refreshes.
 */
function useReviewMutation(action: (id: string) => Promise<WorkspaceKnowledge>) {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: (id: string) => action(id),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: knowledgeKeys.all(wsId) });
      const pendingKey = knowledgeKeys.list(wsId, "pending");
      const prevPending = qc.getQueryData<WorkspaceKnowledge[]>(pendingKey);
      qc.setQueryData<WorkspaceKnowledge[]>(pendingKey, (old) =>
        old ? old.filter((k) => k.id !== id) : old,
      );
      return { prevPending };
    },
    onError: (_err, _id, ctx) => {
      if (ctx?.prevPending) {
        qc.setQueryData(knowledgeKeys.list(wsId, "pending"), ctx.prevPending);
      }
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: knowledgeKeys.all(wsId) });
    },
  });
}

export function useApproveKnowledge() {
  return useReviewMutation((id) => api.approveKnowledge(id));
}

export function useRejectKnowledge() {
  return useReviewMutation((id) => api.rejectKnowledge(id));
}

export function useCreateKnowledge() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: (data: CreateKnowledgeRequest) => api.createKnowledge(data),
    onSuccess: (entry) => {
      const activeKey = knowledgeKeys.list(wsId, "active");
      qc.setQueryData<WorkspaceKnowledge[]>(activeKey, (old) =>
        old && !old.some((k) => k.id === entry.id) ? [entry, ...old] : old,
      );
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: knowledgeKeys.all(wsId) });
    },
  });
}

export function useDeleteKnowledge() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: ({ id }: { id: string; status: string }) => api.deleteKnowledge(id),
    onMutate: async ({ id, status }) => {
      await qc.cancelQueries({ queryKey: knowledgeKeys.all(wsId) });
      const listKey = knowledgeKeys.list(wsId, status);
      const prevList = qc.getQueryData<WorkspaceKnowledge[]>(listKey);
      qc.setQueryData<WorkspaceKnowledge[]>(listKey, (old) =>
        old ? old.filter((k) => k.id !== id) : old,
      );
      return { prevList, status };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prevList) {
        qc.setQueryData(knowledgeKeys.list(wsId, ctx.status), ctx.prevList);
      }
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: knowledgeKeys.all(wsId) });
    },
  });
}
