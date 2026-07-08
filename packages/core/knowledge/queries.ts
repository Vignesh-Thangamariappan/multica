import { queryOptions } from "@tanstack/react-query";
import { api } from "../api";

export const knowledgeKeys = {
  all: (wsId: string) => ["knowledge", wsId] as const,
  list: (wsId: string, status: string) =>
    [...knowledgeKeys.all(wsId), "list", status] as const,
};

export function knowledgeListOptions(wsId: string, status: string) {
  return queryOptions({
    queryKey: knowledgeKeys.list(wsId, status),
    queryFn: () => api.listKnowledge(status),
    enabled: Boolean(wsId),
  });
}
