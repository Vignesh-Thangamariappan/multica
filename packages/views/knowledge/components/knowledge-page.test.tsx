import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "@multica/core/i18n/react";
import enCommon from "../../locales/en/common.json";
import enKnowledge from "../../locales/en/knowledge.json";
import { KnowledgePage } from "./knowledge-page";

const TEST_RESOURCES = { en: { common: enCommon, knowledge: enKnowledge } };

const pendingRef = vi.hoisted(() => ({ current: [] as unknown[] }));
const activeRef = vi.hoisted(() => ({ current: [] as unknown[] }));
const membersRef = vi.hoisted(() => ({
  current: [{ user_id: "user-1", role: "owner" as "owner" | "admin" | "member" }],
}));
const mockApprove = vi.hoisted(() => vi.fn());
const mockReject = vi.hoisted(() => vi.fn());

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

vi.mock("@multica/core/knowledge/queries", () => ({
  knowledgeListOptions: (_wsId: string, status: string) => ({
    queryKey: ["knowledge", status],
  }),
}));

vi.mock("@multica/core/knowledge/mutations", () => ({
  useApproveKnowledge: () => ({ mutate: mockApprove, isPending: false }),
  useRejectKnowledge: () => ({ mutate: mockReject, isPending: false }),
  useCreateKnowledge: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteKnowledge: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@multica/core/workspace/queries", () => ({
  memberListOptions: () => ({ queryKey: ["members"] }),
  agentListOptions: () => ({ queryKey: ["agents"] }),
}));

vi.mock("@multica/core/workspace/hooks", () => ({
  useActorName: () => ({
    getAgentName: (id: string) => `Agent ${id}`,
    getMemberName: (id: string) => `Member ${id}`,
  }),
}));

// ActorAvatar drags in hover-cards, presence, and profile cards — irrelevant
// to page behavior under test.
vi.mock("../../common/actor-avatar", () => ({
  ActorAvatar: ({ actorId }: { actorId: string }) => (
    <span data-testid={`avatar-${actorId}`} />
  ),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: (opts: { queryKey: readonly unknown[] }) => {
    if (opts.queryKey[0] === "knowledge") {
      const status = opts.queryKey[1];
      const data = status === "pending" ? pendingRef.current : status === "active" ? activeRef.current : [];
      return { data, isLoading: false, isError: false, refetch: vi.fn() };
    }
    if (opts.queryKey[0] === "members") {
      return { data: membersRef.current, isLoading: false, isError: false, refetch: vi.fn() };
    }
    return { data: [], isLoading: false, isError: false, refetch: vi.fn() };
  },
}));

function entry(id: string, content: string, status: string) {
  return {
    id,
    workspace_id: "ws-1",
    agent_id: null,
    content,
    status,
    created_at: "2026-06-01T00:00:00Z",
  };
}

function renderPage() {
  return render(
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      <KnowledgePage />
    </I18nProvider>,
  );
}

beforeEach(() => {
  pendingRef.current = [];
  activeRef.current = [];
  membersRef.current = [{ user_id: "user-1", role: "owner" }];
  mockApprove.mockClear();
  mockReject.mockClear();
});

describe("KnowledgePage", () => {
  it("shows the pending empty state when there are no proposals", () => {
    renderPage();
    expect(screen.getByText("No pending proposals")).toBeTruthy();
  });

  it("lists pending proposals with approve/reject for admins", () => {
    pendingRef.current = [entry("k-1", "Always pin pr_url metadata.", "pending")];
    renderPage();
    expect(screen.getByText("Always pin pr_url metadata.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /approve/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /reject/i })).toBeTruthy();
  });

  it("calls the approve mutation with the entry id", async () => {
    pendingRef.current = [entry("k-1", "Always pin pr_url metadata.", "pending")];
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: /approve/i }));
    expect(mockApprove).toHaveBeenCalledWith("k-1");
  });

  it("hides review actions from non-admin members", () => {
    membersRef.current = [{ user_id: "user-1", role: "member" }];
    pendingRef.current = [entry("k-1", "Always pin pr_url metadata.", "pending")];
    renderPage();
    expect(screen.getByText("Always pin pr_url metadata.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /approve/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /reject/i })).toBeNull();
  });

  it("shows per-status counts in every tab label", () => {
    pendingRef.current = [
      entry("k-1", "A", "pending"),
      entry("k-2", "B", "pending"),
    ];
    renderPage();
    expect(screen.getByRole("tab", { name: /pending\s*2/i })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /active\s*0/i })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /rejected\s*0/i })).toBeTruthy();
  });
});
