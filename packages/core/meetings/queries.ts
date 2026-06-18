import { queryOptions } from "@tanstack/react-query";
import { api } from "../api";

export const meetingKeys = {
  all: (wsId: string) => ["workspaces", wsId, "meetings"] as const,
  list: (wsId: string) => [...meetingKeys.all(wsId), "list"] as const,
  detail: (wsId: string, id: string) => [...meetingKeys.all(wsId), "detail", id] as const,
};

export function meetingListOptions(wsId: string) {
  return queryOptions({
    queryKey: meetingKeys.list(wsId),
    queryFn: () => api.listMeetings(),
    enabled: !!wsId,
  });
}

export function meetingDetailOptions(wsId: string, meetingId: string) {
  return queryOptions({
    queryKey: meetingKeys.detail(wsId, meetingId),
    queryFn: () => api.getMeeting(meetingId),
    enabled: !!wsId && !!meetingId,
  });
}
