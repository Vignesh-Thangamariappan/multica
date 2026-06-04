"use client";

import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { ExternalLink, Plus } from "lucide-react";
import { Button } from "@multica/ui/components/ui/button";
import { useWorkspaceId } from "@multica/core/hooks";
import {
  clickupInstallationOptions,
  clickupLinksOptions,
  issueClickUpLinkOptions,
  usePushIssueToClickUp,
} from "@multica/core/clickup";
import { useT } from "../../i18n";

// ClickUpSection renders the issue's ClickUp pairing in the detail
// sidebar (Phase 1): a link chip when paired, a push-create action when
// the issue's project is linked to a list, and nothing at all when the
// integration is unconfigured/disconnected — zero visual cost for
// self-hosts that never opt in. Design: docs/clickup-integration-rfc.md.
export function ClickUpSection({
  issueId,
  projectId,
}: {
  issueId: string;
  projectId: string | null;
}) {
  const { t } = useT("issues");
  const wsId = useWorkspaceId();

  const { data: installation } = useQuery(clickupInstallationOptions(wsId));
  const connected = installation?.connected === true;

  const { data: links = [] } = useQuery(clickupLinksOptions(wsId, connected));
  const projectLinked =
    projectId !== null && links.some((l) => l.project_id === projectId);

  const { data: taskLink } = useQuery(
    issueClickUpLinkOptions(wsId, issueId, connected),
  );
  const push = usePushIssueToClickUp();

  if (!connected) return null;
  if (taskLink === undefined && !projectLinked) return null;

  return (
    <div className="px-2">
      {taskLink !== undefined ? (
        <a
          href={taskLink.task_url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-accent/70 transition-colors"
        >
          <ExternalLink className="size-3" />
          {t(($) => $.clickup.linked_chip)}
        </a>
      ) : (
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs"
          disabled={push.isPending}
          onClick={() =>
            push.mutate(issueId, {
              onSuccess: (link) => {
                toast.success(t(($) => $.clickup.pushed_toast));
                if (link.task_url !== "") {
                  window.open(link.task_url, "_blank", "noreferrer");
                }
              },
              onError: () => toast.error(t(($) => $.clickup.push_failed_toast)),
            })
          }
        >
          <Plus className="size-3" />
          {t(($) => $.clickup.push_button)}
        </Button>
      )}
    </div>
  );
}
