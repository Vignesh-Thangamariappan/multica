"use client";

import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Play, X, Send, Bot, Sparkles } from "lucide-react";
import { toast } from "sonner";
import type { MeetingMessage } from "@multica/core/types";
import { api } from "@multica/core/api";
import { useWorkspaceId } from "@multica/core/hooks";
import { useWorkspacePaths } from "@multica/core/paths";
import { meetingDetailOptions, meetingKeys } from "@multica/core/meetings";
import { agentListOptions } from "@multica/core/workspace/queries";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { PageHeader } from "../../layout/page-header";
import { useNavigation } from "../../navigation";
import { MeetingStatusBadge, MeetingTypeBadge } from "./meeting-bits";

interface MeetingDetailPageProps {
  meetingId: string;
}

export function MeetingDetailPage({ meetingId }: MeetingDetailPageProps) {
  const wsId = useWorkspaceId();
  const navigation = useNavigation();
  const paths = useWorkspacePaths();
  const qc = useQueryClient();
  const { data: meeting, isLoading } = useQuery(meetingDetailOptions(wsId, meetingId));
  const { data: agents = [] } = useQuery(agentListOptions(wsId));
  const [busy, setBusy] = useState(false);

  const agentNames = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of agents) m.set(a.id, a.name);
    return m;
  }, [agents]);

  const refresh = () => qc.invalidateQueries({ queryKey: meetingKeys.detail(wsId, meetingId) });

  const start = async () => {
    setBusy(true);
    try {
      await api.startMeeting(meetingId);
      await refresh();
    } catch {
      toast.error("Failed to start meeting");
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    setBusy(true);
    try {
      await api.cancelMeeting(meetingId);
      await refresh();
    } catch {
      toast.error("Failed to cancel meeting");
    } finally {
      setBusy(false);
    }
  };

  if (isLoading || !meeting || !meeting.id) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground">
        {isLoading ? <Spinner /> : "Meeting not found"}
      </div>
    );
  }

  const scheduled = meeting.status === "scheduled";
  const running = meeting.status === "in_progress";

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      <PageHeader className="px-5">
        <div className="flex w-full items-center gap-2">
          <button
            onClick={() => navigation.push(paths.meetings())}
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted"
            aria-label="Back to meetings"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <h1 className="truncate text-sm font-medium">{meeting.title}</h1>
          <MeetingTypeBadge type={meeting.type} />
          <MeetingStatusBadge status={meeting.status} />
          <div className="ml-auto flex items-center gap-2">
            {scheduled && (
              <Button size="sm" onClick={start} disabled={busy}>
                <Play className="h-3.5 w-3.5" />
                Start
              </Button>
            )}
            {(scheduled || running) && (
              <Button size="sm" variant="ghost" onClick={cancel} disabled={busy}>
                <X className="h-3.5 w-3.5" />
                Cancel
              </Button>
            )}
          </div>
        </div>
      </PageHeader>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-5 py-4">
          {meeting.topic && (
            <p className="mb-4 rounded-lg border border-border/60 bg-muted/40 px-4 py-3 text-sm">
              <span className="font-medium">Topic:</span> {meeting.topic}
            </p>
          )}

          {meeting.summary && meeting.status === "completed" && (
            <div className="mb-4 rounded-lg border border-success/30 bg-success/10 px-4 py-3">
              <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-success">
                <Sparkles className="h-3.5 w-3.5" />
                Summary
              </div>
              <p className="whitespace-pre-wrap text-sm">{meeting.summary}</p>
            </div>
          )}

          <Transcript messages={meeting.messages} agentNames={agentNames} running={running} />
        </div>
      </div>

      {(scheduled || running) && (
        <ChimeIn meetingId={meetingId} onSent={refresh} />
      )}
    </div>
  );
}

function Transcript({
  messages,
  agentNames,
  running,
}: {
  messages: MeetingMessage[];
  agentNames: Map<string, string>;
  running: boolean;
}) {
  if (messages.length === 0) {
    return <p className="py-8 text-center text-sm text-muted-foreground">No discussion yet.</p>;
  }
  return (
    <div className="flex flex-col gap-3">
      {messages.map((msg) => (
        <TranscriptRow key={msg.id} msg={msg} agentNames={agentNames} />
      ))}
      {running && (
        <div className="flex items-center gap-2 py-1 pl-1 text-xs text-muted-foreground">
          <Spinner className="h-3 w-3" />
          An agent is taking their turn…
        </div>
      )}
    </div>
  );
}

function TranscriptRow({ msg, agentNames }: { msg: MeetingMessage; agentNames: Map<string, string> }) {
  if (msg.author_type === "system") {
    return (
      <div className="py-1 text-center text-xs text-muted-foreground">{msg.content}</div>
    );
  }
  const isMember = msg.author_type === "member";
  const name = isMember ? "You" : (msg.author_id && agentNames.get(msg.author_id)) || "Agent";
  return (
    <div className="flex gap-3">
      <div
        className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${
          isMember ? "bg-muted text-foreground" : "bg-brand/15 text-brand"
        }`}
      >
        {isMember ? name[0]?.toUpperCase() : <Bot className="h-3.5 w-3.5" />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-medium">{name}</span>
          {msg.round > 0 && (
            <span className="text-[10px] text-muted-foreground">round {msg.round}</span>
          )}
        </div>
        <p className="mt-0.5 whitespace-pre-wrap text-sm text-foreground/90">{msg.content}</p>
      </div>
    </div>
  );
}

function ChimeIn({ meetingId, onSent }: { meetingId: string; onSent: () => void }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);

  const send = async () => {
    const content = text.trim();
    if (!content || sending) return;
    setSending(true);
    try {
      await api.addMeetingMessage(meetingId, content);
      setText("");
      onSent();
    } catch {
      toast.error("Failed to send");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="border-t border-border/60 px-5 py-3">
      <div className="mx-auto flex max-w-3xl items-center gap-2">
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder="Add a note to the discussion…"
        />
        <Button size="sm" onClick={send} disabled={!text.trim() || sending}>
          <Send className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}
