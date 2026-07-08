import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { clickupKeys } from "./queries";
import { useWorkspaceId } from "../hooks";
import type { CreateClickUpLinkRequest } from "../types";

export function useSetClickUpKey() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: (secretKey: string) => api.setClickUpSecretKey(secretKey),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: clickupKeys.all(wsId) });
    },
  });
}

export function useConnectClickUp() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: (apiToken: string) => api.connectClickUp(apiToken),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: clickupKeys.all(wsId) });
    },
  });
}

export function useDisconnectClickUp() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: () => api.disconnectClickUp(),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: clickupKeys.all(wsId) });
    },
  });
}

export function useCreateClickUpLink() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: (data: CreateClickUpLinkRequest) => api.createClickUpLink(data),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: clickupKeys.links(wsId) });
    },
  });
}

export function useDeleteClickUpLink() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: (id: string) => api.deleteClickUpLink(id),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: clickupKeys.links(wsId) });
    },
  });
}

export function useImportClickUpList() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: ({
      id,
      includeClosed,
      taskIds,
    }: {
      id: string;
      includeClosed: boolean;
      taskIds?: string[];
    }) => api.importClickUpList(id, includeClosed, taskIds),
    onSettled: () => {
      // Imported issues land in the issues cache too.
      qc.invalidateQueries({ queryKey: clickupKeys.all(wsId) });
      qc.invalidateQueries({ queryKey: ["issues", wsId] });
    },
  });
}

export function usePushIssueToClickUp() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: (issueId: string) => api.pushIssueToClickUp(issueId),
    onSuccess: (link, issueId) => {
      qc.setQueryData(clickupKeys.issueLink(wsId, issueId), link);
    },
  });
}
