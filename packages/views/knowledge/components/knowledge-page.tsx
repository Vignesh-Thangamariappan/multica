"use client";

import { useMemo, useState } from "react";
import { AlertCircle, Bot, Check, Library, Trash2, User, X } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useAuthStore } from "@multica/core/auth";
import { useWorkspaceId } from "@multica/core/hooks";
import { knowledgeListOptions } from "@multica/core/knowledge/queries";
import {
  useApproveKnowledge,
  useCreateKnowledge,
  useDeleteKnowledge,
  useRejectKnowledge,
} from "@multica/core/knowledge/mutations";
import type { WorkspaceKnowledge } from "@multica/core/types";
import {
  agentListOptions,
  memberListOptions,
} from "@multica/core/workspace/queries";
import { Badge } from "@multica/ui/components/ui/badge";
import { Button } from "@multica/ui/components/ui/button";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@multica/ui/components/ui/tabs";
import { Textarea } from "@multica/ui/components/ui/textarea";
import { PageHeader } from "../../layout/page-header";
import { useT, useTimeAgo } from "../../i18n";

type StatusTab = "pending" | "active" | "rejected";

const STATUS_TABS: StatusTab[] = ["pending", "active", "rejected"];

function KnowledgeCard({
  entry,
  agentName,
  isAdmin,
  tab,
}: {
  entry: WorkspaceKnowledge;
  agentName: string | null;
  isAdmin: boolean;
  tab: StatusTab;
}) {
  const { t } = useT("knowledge");
  const timeAgo = useTimeAgo();
  const approve = useApproveKnowledge();
  const reject = useRejectKnowledge();
  const del = useDeleteKnowledge();

  return (
    <div className="rounded-lg border bg-card p-4 flex flex-col gap-3">
      <p className="text-sm whitespace-pre-wrap break-words">{entry.content}</p>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {entry.agent_id ? (
          <span className="inline-flex items-center gap-1">
            <Bot className="size-3.5" />
            {agentName ?? t(($) => $.card.agent)}
          </span>
        ) : (
          <span className="inline-flex items-center gap-1">
            <User className="size-3.5" />
            {t(($) => $.card.member)}
          </span>
        )}
        <span>·</span>
        <span>{timeAgo(entry.created_at)}</span>
        <div className="ml-auto flex items-center gap-2">
          {isAdmin && tab === "pending" && (
            <>
              <Button
                size="sm"
                variant="outline"
                className="h-7"
                disabled={approve.isPending}
                onClick={() => approve.mutate(entry.id)}
              >
                <Check className="size-3.5" />
                {t(($) => $.actions.approve)}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-destructive"
                disabled={reject.isPending}
                onClick={() => reject.mutate(entry.id)}
              >
                <X className="size-3.5" />
                {t(($) => $.actions.reject)}
              </Button>
            </>
          )}
          {isAdmin && tab !== "pending" && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-muted-foreground hover:text-destructive"
              disabled={del.isPending}
              onClick={() => del.mutate({ id: entry.id, status: tab })}
            >
              <Trash2 className="size-3.5" />
              {t(($) => $.actions.delete)}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function AddKnowledgeBox() {
  const { t } = useT("knowledge");
  const [content, setContent] = useState("");
  const create = useCreateKnowledge();
  const trimmed = content.trim();

  return (
    <div className="rounded-lg border border-dashed p-3 flex flex-col gap-2">
      <Textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder={t(($) => $.add.placeholder)}
        className="min-h-16 text-sm"
      />
      <div className="flex justify-end">
        <Button
          size="sm"
          disabled={trimmed === "" || create.isPending}
          onClick={() =>
            create.mutate(
              { content: trimmed },
              { onSuccess: () => setContent("") },
            )
          }
        >
          {t(($) => $.add.submit)}
        </Button>
      </div>
    </div>
  );
}

function TabBody({
  tab,
  isAdmin,
  agentNames,
}: {
  tab: StatusTab;
  isAdmin: boolean;
  agentNames: Map<string, string>;
}) {
  const { t } = useT("knowledge");
  const wsId = useWorkspaceId();
  const { data: entries, isLoading, isError, refetch } = useQuery(
    knowledgeListOptions(wsId, tab),
  );

  if (isLoading) {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex flex-col items-center gap-3 py-12 text-center">
        <AlertCircle className="size-6 text-destructive" />
        <p className="text-sm text-muted-foreground">
          {t(($) => $.page.load_failed)}
        </p>
        <Button size="sm" variant="outline" onClick={() => void refetch()}>
          {t(($) => $.page.try_again)}
        </Button>
      </div>
    );
  }

  const list = entries ?? [];
  return (
    <div className="flex flex-col gap-3">
      {isAdmin && tab === "active" && <AddKnowledgeBox />}
      {list.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-12 text-center">
          <Library className="size-6 text-muted-foreground" />
          <p className="text-sm font-medium">
            {t(($) => $.empty[tab].title)}
          </p>
          <p className="text-sm text-muted-foreground max-w-md">
            {t(($) => $.empty[tab].description)}
          </p>
        </div>
      ) : (
        list.map((entry) => (
          <KnowledgeCard
            key={entry.id}
            entry={entry}
            agentName={
              entry.agent_id ? (agentNames.get(entry.agent_id) ?? null) : null
            }
            isAdmin={isAdmin}
            tab={tab}
          />
        ))
      )}
    </div>
  );
}

export function KnowledgePage() {
  const { t } = useT("knowledge");
  const wsId = useWorkspaceId();
  const [tab, setTab] = useState<StatusTab>("pending");

  const { data: pendingEntries } = useQuery(knowledgeListOptions(wsId, "pending"));
  const pendingCount = pendingEntries?.length ?? 0;

  const { data: members = [] } = useQuery(memberListOptions(wsId));
  const currentUser = useAuthStore((s) => s.user);
  const myRole = useMemo(() => {
    if (!currentUser) return null;
    return members.find((m) => m.user_id === currentUser.id)?.role ?? null;
  }, [members, currentUser]);
  const isAdmin = myRole === "owner" || myRole === "admin";

  const { data: agents = [] } = useQuery(agentListOptions(wsId));
  const agentNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of agents) map.set(a.id, a.name);
    return map;
  }, [agents]);

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      <PageHeader>
        <div className="flex items-center gap-2">
          <Library className="size-4" />
          <h1 className="text-sm font-medium">{t(($) => $.page.title)}</h1>
          {pendingCount > 0 && (
            <Badge variant="secondary" className="h-5 px-1.5 text-xs">
              {pendingCount}
            </Badge>
          )}
        </div>
      </PageHeader>

      <div className="flex flex-1 min-h-0 flex-col gap-4 p-6 overflow-y-auto">
        <p className="text-sm text-muted-foreground">
          {t(($) => $.page.tagline)}
        </p>
        <Tabs value={tab} onValueChange={(v) => setTab(v as StatusTab)}>
          <TabsList>
            {STATUS_TABS.map((s) => (
              <TabsTrigger key={s} value={s}>
                {t(($) => $.tabs[s])}
                {s === "pending" && pendingCount > 0 ? ` (${pendingCount})` : ""}
              </TabsTrigger>
            ))}
          </TabsList>
          {STATUS_TABS.map((s) => (
            <TabsContent key={s} value={s} className="mt-4">
              <TabBody tab={s} isAdmin={isAdmin} agentNames={agentNames} />
            </TabsContent>
          ))}
        </Tabs>
      </div>
    </div>
  );
}
