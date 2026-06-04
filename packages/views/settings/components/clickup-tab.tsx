"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Download, Link2, Trash2 } from "lucide-react";
import { Button } from "@multica/ui/components/ui/button";
import { Card, CardContent } from "@multica/ui/components/ui/card";
import { Input } from "@multica/ui/components/ui/input";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@multica/ui/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@multica/ui/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@multica/ui/components/ui/select";
import { useAuthStore } from "@multica/core/auth";
import { useWorkspaceId } from "@multica/core/hooks";
import { memberListOptions } from "@multica/core/workspace/queries";
import { projectListOptions } from "@multica/core/projects/queries";
import {
  clickupInstallationOptions,
  clickupLinksOptions,
  clickupSpacesOptions,
  useSetClickUpKey,
  useConnectClickUp,
  useCreateClickUpLink,
  useDeleteClickUpLink,
  useDisconnectClickUp,
  useImportClickUpList,
} from "@multica/core/clickup";
import type { ClickUpLink, ClickUpList } from "@multica/core/types";
import { ApiError } from "@multica/core/api";
import { useT } from "../../i18n";

// ClickUpTab is the workspace settings panel for the ClickUp integration
// (Phase 1: connect, link project↔list, bulk import, push-create).
// Listing is member-visible; management is admin-only (backend enforces;
// the UI hides controls for non-admins to match). Design:
// docs/clickup-integration-rfc.md.
export function ClickUpTab() {
  const { t } = useT("settings");
  const wsId = useWorkspaceId();
  const user = useAuthStore((s) => s.user);

  const { data: members = [] } = useQuery(memberListOptions(wsId));
  const canManage = useMemo(() => {
    const me = members.find((m) => m.user_id === user?.id);
    return me?.role === "owner" || me?.role === "admin";
  }, [members, user]);

  const { data: installation, isLoading } = useQuery(clickupInstallationOptions(wsId));
  const connected = installation?.connected === true;
  const { data: links = [] } = useQuery(clickupLinksOptions(wsId, connected));

  const [token, setToken] = useState("");
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  const connect = useConnectClickUp();
  const disconnect = useDisconnectClickUp();

  if (isLoading) return null;

  // No encryption key on the server yet. Admins can activate the
  // integration right here: the key is validated, persisted server-side,
  // and the service is hot-swapped in — no .env edit, no restart.
  if (installation?.configured !== true) {
    return <ActivateCard canManage={canManage} />;
  }

  if (!connected) {
    return (
      <Card>
        <CardContent className="flex flex-col gap-3 p-4">
          <p className="text-sm text-muted-foreground">
            {t(($) => $.clickup.connect_hint)}
          </p>
          {canManage ? (
            <div className="flex gap-2">
              <Input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder={t(($) => $.clickup.token_placeholder)}
                className="max-w-sm"
              />
              <Button
                size="sm"
                disabled={token.trim() === "" || connect.isPending}
                onClick={() =>
                  connect.mutate(token.trim(), {
                    onSuccess: () => {
                      setToken("");
                      toast.success(t(($) => $.clickup.connected_toast));
                    },
                    onError: () => toast.error(t(($) => $.clickup.connect_failed_toast)),
                  })
                }
              >
                {t(($) => $.clickup.connect_button)}
              </Button>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              {t(($) => $.clickup.admin_only_hint)}
            </p>
          )}
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardContent className="flex items-center justify-between p-4">
          <div className="flex flex-col gap-0.5">
            <span className="text-sm font-medium">{installation.team_name}</span>
            <span className="text-xs text-muted-foreground">
              {t(($) => $.clickup.connected_as)}
            </span>
          </div>
          {canManage && (
            <Button
              size="sm"
              variant="outline"
              className="text-destructive"
              onClick={() => setConfirmDisconnect(true)}
            >
              {t(($) => $.clickup.disconnect_button)}
            </Button>
          )}
        </CardContent>
      </Card>

      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">{t(($) => $.clickup.links_title)}</h3>
        {canManage && (
          <Button size="sm" variant="outline" onClick={() => setPickerOpen(true)}>
            <Link2 className="size-3.5" />
            {t(($) => $.clickup.add_link_button)}
          </Button>
        )}
      </div>

      {links.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t(($) => $.clickup.no_links_hint)}
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {links.map((link) => (
            <LinkRow key={link.id} link={link} canManage={canManage} />
          ))}
        </div>
      )}

      <AlertDialog open={confirmDisconnect} onOpenChange={setConfirmDisconnect}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t(($) => $.clickup.disconnect_confirm_title)}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(($) => $.clickup.disconnect_confirm_description)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t(($) => $.clickup.cancel)}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                disconnect.mutate(undefined, {
                  onError: () => toast.error(t(($) => $.clickup.disconnect_failed_toast)),
                })
              }
            >
              {t(($) => $.clickup.disconnect_button)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {pickerOpen && <LinkPickerDialog onClose={() => setPickerOpen(false)} />}
    </div>
  );
}

// serverErrorMessage extracts the backend's human-readable error so
// toasts report the actual failure (404 from a stale backend, 409 for
// env-managed keys) instead of guessing at a cause.
function serverErrorMessage(err: unknown): string | null {
  if (err instanceof ApiError && err.body && typeof err.body === "object") {
    const msg = (err.body as Record<string, unknown>).error;
    if (typeof msg === "string" && msg !== "") return msg;
  }
  return null;
}

function ActivateCard({ canManage }: { canManage: boolean }) {
  const { t } = useT("settings");
  const [secretKey, setSecretKey] = useState("");
  const setKey = useSetClickUpKey();

  if (!canManage) {
    return (
      <p className="text-sm text-muted-foreground">
        {t(($) => $.clickup.not_configured)}
      </p>
    );
  }

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 p-4">
        <p className="text-sm text-muted-foreground">
          {t(($) => $.clickup.activate_hint)}
        </p>
        <div className="flex gap-2">
          <Input
            type="password"
            value={secretKey}
            onChange={(e) => setSecretKey(e.target.value)}
            placeholder={t(($) => $.clickup.activate_placeholder)}
            className="max-w-sm font-mono"
          />
          <Button
            size="sm"
            disabled={secretKey.trim() === "" || setKey.isPending}
            onClick={() =>
              setKey.mutate(secretKey.trim(), {
                onSuccess: () => {
                  setSecretKey("");
                  toast.success(t(($) => $.clickup.activated_toast));
                },
                onError: (err) =>
                  toast.error(
                    serverErrorMessage(err) ?? t(($) => $.clickup.activate_failed_toast),
                  ),
              })
            }
          >
            {t(($) => $.clickup.activate_button)}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          {t(($) => $.clickup.activate_generate_hint)}
        </p>
      </CardContent>
    </Card>
  );
}

function LinkRow({ link, canManage }: { link: ClickUpLink; canManage: boolean }) {
  const { t } = useT("settings");
  const wsId = useWorkspaceId();
  const { data: projects = [] } = useQuery(projectListOptions(wsId));
  const importList = useImportClickUpList();
  const deleteLink = useDeleteClickUpLink();

  const projectName =
    projects.find((p) => p.id === link.project_id)?.title ?? link.project_id;

  return (
    <Card>
      <CardContent className="flex items-center gap-3 p-3 text-sm">
        <span className="font-medium truncate">{projectName}</span>
        <span className="text-muted-foreground shrink-0">↔</span>
        <span className="truncate text-muted-foreground">
          {link.list_name !== "" ? link.list_name : link.list_id}
        </span>
        {link.last_error !== "" && (
          <span className="text-xs text-destructive truncate">{link.last_error}</span>
        )}
        <div className="ml-auto flex items-center gap-1.5 shrink-0">
          {canManage && (
            <>
              <Button
                size="sm"
                variant="outline"
                className="h-7"
                disabled={importList.isPending}
                onClick={() =>
                  importList.mutate(
                    { id: link.id, includeClosed: false },
                    {
                      onSuccess: (s) =>
                        toast.success(
                          t(($) => $.clickup.import_done_toast, {
                            created: s.created,
                            skipped: s.skipped,
                          }),
                        ),
                      onError: () => toast.error(t(($) => $.clickup.import_failed_toast)),
                    },
                  )
                }
              >
                <Download className="size-3.5" />
                {importList.isPending
                  ? t(($) => $.clickup.importing)
                  : t(($) => $.clickup.import_button)}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-muted-foreground hover:text-destructive"
                disabled={deleteLink.isPending}
                onClick={() => deleteLink.mutate(link.id)}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function LinkPickerDialog({ onClose }: { onClose: () => void }) {
  const { t } = useT("settings");
  const wsId = useWorkspaceId();
  const { data: projects = [] } = useQuery(projectListOptions(wsId));
  const { data: tree = [], isLoading } = useQuery(clickupSpacesOptions(wsId, true));
  const { data: links = [] } = useQuery(clickupLinksOptions(wsId));
  const createLink = useCreateClickUpLink();

  const [projectId, setProjectId] = useState("");
  const [listId, setListId] = useState("");

  const linkedProjects = useMemo(() => new Set(links.map((l) => l.project_id)), [links]);
  const linkedLists = useMemo(() => new Set(links.map((l) => l.list_id)), [links]);

  const allLists = useMemo(() => {
    const out: { list: ClickUpList; label: string }[] = [];
    for (const st of tree) {
      for (const list of st.lists ?? []) {
        out.push({ list, label: `${st.space.name} / ${list.name}` });
      }
      for (const folder of st.folders ?? []) {
        for (const list of folder.lists ?? []) {
          out.push({ list, label: `${st.space.name} / ${folder.name} / ${list.name}` });
        }
      }
    }
    return out.filter(({ list }) => !linkedLists.has(list.id));
  }, [tree, linkedLists]);

  const selectedList = allLists.find(({ list }) => list.id === listId);
  const canSubmit =
    projectId !== "" && selectedList !== undefined && !createLink.isPending;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t(($) => $.clickup.picker_title)}</DialogTitle>
          <DialogDescription>{t(($) => $.clickup.picker_description)}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <Select value={projectId} onValueChange={(v) => setProjectId(v ?? "")}>
            <SelectTrigger>
              <SelectValue placeholder={t(($) => $.clickup.picker_project_placeholder)} />
            </SelectTrigger>
            <SelectContent>
              {projects
                .filter((p) => !linkedProjects.has(p.id))
                .map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.title}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
          <Select value={listId} onValueChange={(v) => setListId(v ?? "")}>
            <SelectTrigger>
              <SelectValue
                placeholder={
                  isLoading
                    ? t(($) => $.clickup.picker_loading_lists)
                    : t(($) => $.clickup.picker_list_placeholder)
                }
              />
            </SelectTrigger>
            <SelectContent>
              {allLists.map(({ list, label }) => (
                <SelectItem key={list.id} value={list.id}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t(($) => $.clickup.cancel)}
          </Button>
          <Button
            disabled={!canSubmit}
            onClick={() =>
              createLink.mutate(
                {
                  project_id: projectId,
                  list_id: listId,
                  list_name: selectedList?.list.name ?? "",
                },
                {
                  onSuccess: () => {
                    toast.success(t(($) => $.clickup.link_created_toast));
                    onClose();
                  },
                  onError: () => toast.error(t(($) => $.clickup.link_failed_toast)),
                },
              )
            }
          >
            {t(($) => $.clickup.picker_submit)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
