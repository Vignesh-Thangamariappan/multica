"use client";

import type { MeetingType, MeetingStatus } from "@multica/core/types";
import { Badge } from "@multica/ui/components/ui/badge";

export const MEETING_TYPE_LABELS: Record<MeetingType, string> = {
  issue_discussion: "Issue discussion",
  standup: "Standup",
  planning: "Planning",
  retro: "Retro",
  general: "General",
};

export function meetingTypeLabel(type: string): string {
  return MEETING_TYPE_LABELS[type as MeetingType] ?? "Meeting";
}

const STATUS_LABELS: Record<MeetingStatus, string> = {
  scheduled: "Scheduled",
  in_progress: "In progress",
  completed: "Completed",
  cancelled: "Cancelled",
  failed: "Failed",
};

// Semantic tokens only (no hardcoded Tailwind palette per CSS rules).
const STATUS_CLASS: Record<MeetingStatus, string> = {
  scheduled: "bg-muted text-muted-foreground",
  in_progress: "bg-brand/15 text-brand",
  completed: "bg-success/15 text-success",
  cancelled: "bg-muted text-muted-foreground",
  failed: "bg-warning/15 text-warning",
};

export function MeetingTypeBadge({ type }: { type: string }) {
  return (
    <Badge variant="secondary" className="shrink-0 text-[10px] font-normal">
      {meetingTypeLabel(type)}
    </Badge>
  );
}

export function MeetingStatusBadge({ status }: { status: string }) {
  const s = status as MeetingStatus;
  const label = STATUS_LABELS[s] ?? status;
  const cls = STATUS_CLASS[s] ?? "bg-muted text-muted-foreground";
  return (
    <span className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${cls}`}>
      {s === "in_progress" && (
        <span className="mr-1 h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
      )}
      {label}
    </span>
  );
}
