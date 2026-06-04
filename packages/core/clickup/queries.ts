import { queryOptions } from "@tanstack/react-query";
import { api } from "../api";

export const clickupKeys = {
  all: (wsId: string) => ["clickup", wsId] as const,
  installation: (wsId: string) => [...clickupKeys.all(wsId), "installation"] as const,
  links: (wsId: string) => [...clickupKeys.all(wsId), "links"] as const,
  spaces: (wsId: string) => [...clickupKeys.all(wsId), "spaces"] as const,
  issueLink: (wsId: string, issueId: string) =>
    [...clickupKeys.all(wsId), "issue", issueId] as const,
};

export function clickupInstallationOptions(wsId: string) {
  return queryOptions({
    queryKey: clickupKeys.installation(wsId),
    queryFn: () => api.getClickUpInstallation(),
    enabled: Boolean(wsId),
  });
}

export function clickupLinksOptions(wsId: string, enabled = true) {
  return queryOptions({
    queryKey: clickupKeys.links(wsId),
    queryFn: () => api.listClickUpLinks(),
    enabled: Boolean(wsId) && enabled,
  });
}

export function clickupSpacesOptions(wsId: string, enabled: boolean) {
  return queryOptions({
    queryKey: clickupKeys.spaces(wsId),
    queryFn: () => api.discoverClickUpLists(),
    enabled: Boolean(wsId) && enabled,
    staleTime: 60_000, // picker tree; cheap to keep briefly
  });
}

export function issueClickUpLinkOptions(wsId: string, issueId: string, enabled: boolean) {
  return queryOptions({
    queryKey: clickupKeys.issueLink(wsId, issueId),
    queryFn: () => api.getIssueClickUpLink(issueId),
    enabled: Boolean(wsId) && Boolean(issueId) && enabled,
    retry: false, // 404 = not linked, a normal state
  });
}
