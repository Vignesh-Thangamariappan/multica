"use client";

import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Users, Plus, MessagesSquare } from "lucide-react";
import { toast } from "sonner";
import type { Meeting, MeetingType, CreateMeetingRequest } from "@multica/core/types";
import { api } from "@multica/core/api";
import { useWorkspaceId } from "@multica/core/hooks";
import { useWorkspacePaths } from "@multica/core/paths";
import { meetingListOptions, meetingKeys } from "@multica/core/meetings";
import { agentListOptions } from "@multica/core/workspace/queries";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { Label } from "@multica/ui/components/ui/label";
import { Textarea } from "@multica/ui/components/ui/textarea";
import { Checkbox } from "@multica/ui/components/ui/checkbox";
import { NativeSelect, NativeSelectOption } from "@multica/ui/components/ui/native-select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@multica/ui/components/ui/dialog";
import { PageHeader } from "../../layout/page-header";
import { useNavigation } from "../../navigation";
import {
  MEETING_TYPE_LABELS,
  MeetingStatusBadge,
  MeetingTypeBadge,
} from "./meeting-bits";

export function MeetingsPage() {
  const wsId = useWorkspaceId();
  const navigation = useNavigation();
  const paths = useWorkspacePaths();
  const { data: meetings = [] } = useQuery(meetingListOptions(wsId));
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      <PageHeader className="px-5">
        <div className="flex w-full items-center gap-2">
          <MessagesSquare className="h-4 w-4 text-muted-foreground" />
          <h1 className="text-sm font-medium">Meetings</h1>
          {meetings.length > 0 && (
            <span className="font-mono text-xs tabular-nums text-muted-foreground/70">
              {meetings.length}
            </span>
          )}
          <div className="ml-auto">
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus className="h-3.5 w-3.5" />
              New Meeting
            </Button>
          </div>
        </div>
      </PageHeader>

      <div className="flex-1 overflow-y-auto px-5 py-4">
        {meetings.length === 0 ? (
          <EmptyState onCreate={() => setCreateOpen(true)} />
        ) : (
          <div className="mx-auto flex max-w-3xl flex-col gap-2">
            {meetings.map((m) => (
              <MeetingRow
                key={m.id}
                meeting={m}
                onClick={() => navigation.push(paths.meetingDetail(m.id))}
              />
            ))}
          </div>
        )}
      </div>

      <NewMeetingDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="mx-auto mt-16 flex max-w-sm flex-col items-center text-center">
      <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
        <MessagesSquare className="h-6 w-6 text-muted-foreground" />
      </div>
      <h2 className="text-sm font-medium">No meetings yet</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Gather a few agents to debate an issue, run a standup, or plan a sprint.
      </p>
      <Button size="sm" className="mt-4" onClick={onCreate}>
        <Plus className="h-3.5 w-3.5" />
        New Meeting
      </Button>
    </div>
  );
}

function MeetingRow({ meeting, onClick }: { meeting: Meeting; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded-lg border border-border/60 bg-card px-4 py-3 text-left transition-colors hover:bg-accent/40"
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{meeting.title}</span>
          <MeetingTypeBadge type={meeting.type} />
        </div>
        {meeting.topic && (
          <p className="mt-0.5 truncate text-xs text-muted-foreground">{meeting.topic}</p>
        )}
      </div>
      <span className="flex items-center gap-1 text-xs text-muted-foreground">
        <Users className="h-3.5 w-3.5" />
        {meeting.participants.length}
      </span>
      <MeetingStatusBadge status={meeting.status} />
    </button>
  );
}

// ─── New Meeting dialog ──────────────────────────────────────────────────────

function NewMeetingDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const wsId = useWorkspaceId();
  const navigation = useNavigation();
  const paths = useWorkspacePaths();
  const qc = useQueryClient();
  const { data: agents = [] } = useQuery(agentListOptions(wsId));
  const activeAgents = useMemo(() => agents.filter((a) => !a.archived_at), [agents]);

  const [title, setTitle] = useState("");
  const [type, setType] = useState<MeetingType>("issue_discussion");
  const [topic, setTopic] = useState("");
  const [rounds, setRounds] = useState(2);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);

  const reset = () => {
    setTitle("");
    setType("issue_discussion");
    setTopic("");
    setRounds(2);
    setSelected(new Set());
  };

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const canCreate = title.trim().length > 0 && selected.size >= 2 && !submitting;

  const handleCreate = async () => {
    if (!canCreate) return;
    setSubmitting(true);
    try {
      const req: CreateMeetingRequest = {
        title: title.trim(),
        type,
        topic: topic.trim(),
        rounds,
        agent_ids: Array.from(selected),
      };
      const meeting = await api.createMeeting(req);
      await qc.invalidateQueries({ queryKey: meetingKeys.list(wsId) });
      onOpenChange(false);
      reset();
      navigation.push(paths.meetingDetail(meeting.id));
    } catch {
      toast.error("Failed to create meeting");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { onOpenChange(v); if (!v) reset(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New meeting</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="m-title">Title</Label>
            <Input
              id="m-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Approach for OAuth migration"
              autoFocus
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="m-type">Type</Label>
              <NativeSelect
                id="m-type"
                value={type}
                onChange={(e) => setType(e.target.value as MeetingType)}
              >
                {(Object.keys(MEETING_TYPE_LABELS) as MeetingType[]).map((t) => (
                  <NativeSelectOption key={t} value={t}>
                    {MEETING_TYPE_LABELS[t]}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="m-rounds">Rounds</Label>
              <NativeSelect
                id="m-rounds"
                value={String(rounds)}
                onChange={(e) => setRounds(Number(e.target.value))}
              >
                {[1, 2, 3, 4].map((r) => (
                  <NativeSelectOption key={r} value={String(r)}>
                    {r} {r === 1 ? "round" : "rounds"}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="m-topic">Topic / agenda</Label>
            <Textarea
              id="m-topic"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="What should the agents discuss?"
              rows={3}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>
              Participants
              <span className="ml-1 font-normal text-muted-foreground">
                (pick at least 2 — they debate in this order)
              </span>
            </Label>
            <div className="max-h-44 overflow-y-auto rounded-md border border-border/60 p-1">
              {activeAgents.length === 0 ? (
                <p className="px-2 py-3 text-sm text-muted-foreground">No agents in this workspace.</p>
              ) : (
                activeAgents.map((a) => (
                  <label
                    key={a.id}
                    className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent/40"
                  >
                    <Checkbox
                      checked={selected.has(a.id)}
                      onCheckedChange={() => toggle(a.id)}
                    />
                    <span className="truncate">{a.name}</span>
                  </label>
                ))
              )}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!canCreate} onClick={handleCreate}>
            Create meeting
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
