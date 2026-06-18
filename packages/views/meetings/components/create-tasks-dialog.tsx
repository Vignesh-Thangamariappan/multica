"use client";

import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { Meeting } from "@multica/core/types";
import { api } from "@multica/core/api";
import { useWorkspaceId } from "@multica/core/hooks";
import { useWorkspacePaths } from "@multica/core/paths";
import { issueKeys } from "@multica/core/issues/queries";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { Checkbox } from "@multica/ui/components/ui/checkbox";
import { Badge } from "@multica/ui/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@multica/ui/components/ui/dialog";

export interface ActionItem {
  owner?: string;
  text: string;
}

// Pull discrete action items out of the meeting's recorded outcome. Lenient on
// format: accepts a "## Action items" heading or a "**Action items:**" bold
// line, then collects the bullet list under it (each "- **Owner** — task").
export function parseActionItems(summary: string): ActionItem[] {
  if (!summary) return [];
  const lines = summary.split("\n");
  const items: ActionItem[] = [];
  let inSection = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!inSection) {
      if (/^#{1,6}\s*action\s*items?/i.test(line) || /^\*\*\s*action\s*items?\s*:?\s*\*\*\s*:?$/i.test(line)) {
        inSection = true;
      }
      continue;
    }
    // Stop at the next section header (## … or a standalone **Heading** line).
    if (/^#{1,6}\s/.test(line) || /^\*\*[^*]+\*\*\s*:?\s*$/.test(line)) break;
    const bullet = line.match(/^[-*]\s+(.*)$/);
    if (!bullet) continue;
    let text = (bullet[1] ?? "").trim();
    let owner: string | undefined;
    const om = text.match(/^\*\*(.+?)\*\*\s*[—:–-]\s*(.*)$/);
    if (om) {
      owner = (om[1] ?? "").trim();
      text = (om[2] ?? "").trim();
    }
    text = text.replace(/\*\*/g, "").trim();
    if (text) items.push({ owner, text });
  }
  return items;
}

interface Row extends ActionItem {
  selected: boolean;
  title: string;
}

export function CreateTasksDialog({
  meeting,
  open,
  onOpenChange,
}: {
  meeting: Meeting;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const wsId = useWorkspaceId();
  const paths = useWorkspacePaths();
  const qc = useQueryClient();
  const [rows, setRows] = useState<Row[]>([]);
  const [submitting, setSubmitting] = useState(false);

  // (Re)parse whenever the dialog opens or the outcome changes.
  useEffect(() => {
    if (!open) return;
    setRows(
      parseActionItems(meeting.summary).map((it) => ({
        ...it,
        selected: true,
        title: it.text.length > 140 ? it.text.slice(0, 139) + "…" : it.text,
      })),
    );
  }, [open, meeting.summary]);

  const selectedCount = rows.filter((r) => r.selected).length;
  const isSubIssue = !!meeting.issue_id;

  const update = (i: number, patch: Partial<Row>) =>
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  const create = async () => {
    const chosen = rows.filter((r) => r.selected && r.title.trim());
    if (chosen.length === 0) return;
    setSubmitting(true);
    const ref = `\n\n— From meeting: [${meeting.title}](${paths.meetingDetail(meeting.id)})`;
    let ok = 0;
    for (const r of chosen) {
      const ownerNote = r.owner ? `\n\nSuggested owner: ${r.owner}` : "";
      try {
        await api.createIssue({
          title: r.title.trim(),
          description: r.text + ownerNote + ref,
          ...(meeting.issue_id ? { parent_issue_id: meeting.issue_id } : {}),
        });
        ok++;
      } catch {
        // keep going; report the shortfall at the end
      }
    }
    await qc.invalidateQueries({ queryKey: issueKeys.all(wsId) });
    setSubmitting(false);
    onOpenChange(false);
    if (ok === chosen.length) toast.success(`Created ${ok} ${isSubIssue ? "sub-issue" : "issue"}${ok === 1 ? "" : "s"}`);
    else toast.error(`Created ${ok} of ${chosen.length} — some failed`);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Create tasks from meeting</DialogTitle>
          <DialogDescription>
            Pick the action items to turn into {isSubIssue ? "sub-issues of the linked issue" : "issues"}. Each links back to “{meeting.title}”.
          </DialogDescription>
        </DialogHeader>

        {rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No action items found in this meeting’s outcome.
          </p>
        ) : (
          <div className="flex max-h-80 flex-col gap-2 overflow-y-auto">
            {rows.map((r, i) => (
              <div key={i} className="flex items-start gap-2 rounded-md border border-border/60 p-2">
                <Checkbox
                  className="mt-1.5"
                  checked={r.selected}
                  onCheckedChange={(v) => update(i, { selected: !!v })}
                />
                <div className="min-w-0 flex-1">
                  <Input
                    value={r.title}
                    onChange={(e) => update(i, { title: e.target.value })}
                    disabled={!r.selected}
                    className="h-8"
                  />
                  {r.owner && (
                    <Badge variant="secondary" className="mt-1 text-[10px] font-normal">
                      suggested: {r.owner}
                    </Badge>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={selectedCount === 0 || submitting} onClick={create}>
            Create {selectedCount > 0 ? selectedCount : ""} {isSubIssue ? "sub-issue" : "issue"}{selectedCount === 1 ? "" : "s"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
