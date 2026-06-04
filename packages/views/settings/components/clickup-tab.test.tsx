import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { I18nProvider } from "@multica/core/i18n/react";
import enCommon from "../../locales/en/common.json";
import enSettings from "../../locales/en/settings.json";
import { ClickUpTab } from "./clickup-tab";

const TEST_RESOURCES = { en: { common: enCommon, settings: enSettings } };

const installationRef = vi.hoisted(() => ({
  current: { configured: false, connected: false } as Record<string, unknown>,
}));
const linksRef = vi.hoisted(() => ({ current: [] as unknown[] }));
const membersRef = vi.hoisted(() => ({
  current: [{ user_id: "user-1", role: "owner" as "owner" | "admin" | "member" }],
}));

vi.mock("@multica/core/hooks", () => ({
  useWorkspaceId: () => "ws-1",
}));

vi.mock("@multica/core/auth", () => {
  const user = { id: "user-1", name: "Viggy" };
  const useAuthStore = Object.assign(
    (selector: (s: { user: typeof user }) => unknown) => selector({ user }),
    { getState: () => ({ user }) },
  );
  return { useAuthStore };
});

vi.mock("@multica/core/workspace/queries", () => ({
  memberListOptions: () => ({ queryKey: ["members"] }),
}));

vi.mock("@multica/core/projects/queries", () => ({
  projectListOptions: () => ({ queryKey: ["projects"] }),
}));

vi.mock("@multica/core/clickup", () => ({
  clickupInstallationOptions: () => ({ queryKey: ["clickup-installation"] }),
  clickupLinksOptions: () => ({ queryKey: ["clickup-links"] }),
  clickupSpacesOptions: () => ({ queryKey: ["clickup-spaces"] }),
  useConnectClickUp: () => ({ mutate: vi.fn(), isPending: false }),
  useDisconnectClickUp: () => ({ mutate: vi.fn(), isPending: false }),
  useCreateClickUpLink: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteClickUpLink: () => ({ mutate: vi.fn(), isPending: false }),
  useImportClickUpList: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: (opts: { queryKey: readonly unknown[] }) => {
    switch (opts.queryKey[0]) {
      case "clickup-installation":
        return { data: installationRef.current, isLoading: false };
      case "clickup-links":
        return { data: linksRef.current, isLoading: false };
      case "members":
        return { data: membersRef.current, isLoading: false };
      default:
        return { data: [], isLoading: false };
    }
  },
}));

function renderTab() {
  return render(
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      <ClickUpTab />
    </I18nProvider>,
  );
}

beforeEach(() => {
  installationRef.current = { configured: false, connected: false };
  linksRef.current = [];
  membersRef.current = [{ user_id: "user-1", role: "owner" }];
});

describe("ClickUpTab", () => {
  it("shows the server-disabled hint when not configured", () => {
    renderTab();
    expect(screen.getByText(/disabled on this server/i)).toBeTruthy();
  });

  it("shows the token connect form for admins when configured but not connected", () => {
    installationRef.current = { configured: true, connected: false };
    renderTab();
    expect(screen.getByPlaceholderText(/personal api token/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /^connect$/i })).toBeTruthy();
  });

  it("hides the connect form from non-admins", () => {
    installationRef.current = { configured: true, connected: false };
    membersRef.current = [{ user_id: "user-1", role: "member" }];
    renderTab();
    expect(screen.queryByPlaceholderText(/personal api token/i)).toBeNull();
    expect(screen.getByText(/only workspace admins/i)).toBeTruthy();
  });

  it("shows the connection card and links section when connected", () => {
    installationRef.current = {
      configured: true,
      connected: true,
      team_name: "Acme Team",
    };
    linksRef.current = [
      {
        id: "l-1",
        project_id: "p-1",
        list_id: "cl-1",
        list_name: "Sprint Board",
        sync_enabled: false,
        last_error: "",
        created_at: "2026-06-04T00:00:00Z",
      },
    ];
    renderTab();
    expect(screen.getByText("Acme Team")).toBeTruthy();
    expect(screen.getByText("Sprint Board")).toBeTruthy();
    expect(screen.getByRole("button", { name: /import/i })).toBeTruthy();
  });
});
