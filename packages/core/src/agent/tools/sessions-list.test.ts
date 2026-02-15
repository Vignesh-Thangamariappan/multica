import { describe, it, expect, beforeEach } from "vitest";
import type { SubagentRunRecord } from "../subagent/types.js";
import { resetSubagentRegistryForTests, seedSubagentRunForTests } from "../subagent/registry.js";
import { createSessionsListTool } from "./sessions-list.js";

function makeRecord(overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
  return {
    runId: "run-001",
    childSessionId: "child-001",
    requesterSessionId: "parent-001",
    task: "Test task",
    cleanup: "delete",
    createdAt: 1700000000000,
    ...overrides,
  };
}

describe("sessions_list tool", () => {
  beforeEach(() => {
    resetSubagentRegistryForTests();
  });

  it("returns empty message when no runs exist", async () => {
    const tool = createSessionsListTool({ sessionId: "parent-001" });
    const result = await tool.execute("call-1", {});

    expect(result.content[0]).toEqual({
      type: "text",
      text: "No subagent runs for this session.",
    });
    expect(result.details).toEqual({ runs: [] });
  });

  it("lists multiple runs with correct status mapping", async () => {
    const now = Date.now();
    seedSubagentRunForTests(
      makeRecord({
        runId: "run-aaa",
        label: "Code Review",
        startedAt: now - 45000,
      }),
    );
    seedSubagentRunForTests(
      makeRecord({
        runId: "run-bbb",
        label: "Test Analysis",
        startedAt: now - 60000,
        endedAt: now - 30000,
        outcome: { status: "ok" },
        findings: "All tests passed successfully.",
        findingsCaptured: true,
      }),
    );
    seedSubagentRunForTests(
      makeRecord({
        runId: "run-ccc",
        label: "Lint Check",
        startedAt: now - 60000,
        endedAt: now,
        outcome: { status: "error", error: "timeout" },
        findings: "Lint check timed out.",
        findingsCaptured: true,
      }),
    );

    const tool = createSessionsListTool({ sessionId: "parent-001" });
    const result = await tool.execute("call-1", {});

    const text = result.content[0]!;
    expect(text.type).toBe("text");
    expect((text as { text: string }).text).toContain("3 total");
    expect((text as { text: string }).text).toContain("[RUNNING]");
    expect((text as { text: string }).text).toContain("[OK]");
    expect((text as { text: string }).text).toContain("[ERROR]");
    expect((text as { text: string }).text).toContain("Code Review");
    expect((text as { text: string }).text).toContain("Test Analysis");
    expect((text as { text: string }).text).toContain("Lint Check");
    // Verify full runId is shown for completed runs
    expect((text as { text: string }).text).toContain("id:run-aaa");
    expect((text as { text: string }).text).toContain("id:run-bbb");
    expect((text as { text: string }).text).toContain("id:run-ccc");
    // Verify findings are shown for completed runs
    expect((text as { text: string }).text).toContain("All tests passed successfully.");
    expect((text as { text: string }).text).toContain("Lint check timed out.");

    expect(result.details!.runs).toHaveLength(3);
    expect(result.details!.runs[0]!.status).toBe("running");
    expect(result.details!.runs[1]!.status).toBe("ok");
    expect(result.details!.runs[2]!.status).toBe("error");
  });

  it("returns detail for a specific runId", async () => {
    const now = Date.now();
    seedSubagentRunForTests(
      makeRecord({
        runId: "run-detail",
        label: "Deep Analysis",
        task: "Analyze the authentication module thoroughly",
        startedAt: now - 90000,
        endedAt: now - 10000,
        outcome: { status: "ok" },
        findings: "Found 2 potential issues in token validation.",
        findingsCaptured: true,
      }),
    );

    const tool = createSessionsListTool({ sessionId: "parent-001" });
    const result = await tool.execute("call-1", { runId: "run-detail" });

    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Run: run-detail");
    expect(text).toContain("Label: Deep Analysis");
    expect(text).toContain("Status: ok");
    expect(text).toContain("Found 2 potential issues");
    expect(text).toContain("Duration:");

    expect(result.details!.runs).toHaveLength(1);
    expect(result.details!.runs[0]!.runId).toBe("run-detail");
  });

  it("returns not found for unknown runId", async () => {
    const tool = createSessionsListTool({ sessionId: "parent-001" });
    const result = await tool.execute("call-1", { runId: "nonexistent" });

    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Run not found");
    expect(result.details).toEqual({ runs: [] });
  });

  it("rejects runId belonging to a different requester", async () => {
    seedSubagentRunForTests(
      makeRecord({
        runId: "run-other",
        requesterSessionId: "other-parent",
      }),
    );

    const tool = createSessionsListTool({ sessionId: "parent-001" });
    const result = await tool.execute("call-1", { runId: "run-other" });

    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Run not found");
    expect(result.details).toEqual({ runs: [] });
  });

  it("handles missing sessionId gracefully", async () => {
    const tool = createSessionsListTool({});
    const result = await tool.execute("call-1", {});

    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("No session ID available");
    expect(result.details).toEqual({ runs: [] });
  });

  it("shows findings for grouped completed runs", async () => {
    const now = Date.now();
    const groupId = "group-001";
    seedSubagentRunForTests(
      makeRecord({
        runId: "run-g1",
        label: "Bull Case Research",
        startedAt: now - 60000,
        endedAt: now - 10000,
        outcome: { status: "ok" },
        findings: "AI infrastructure capex growing 40% YoY.",
        findingsCaptured: true,
        groupId,
      }),
    );
    seedSubagentRunForTests(
      makeRecord({
        runId: "run-g2",
        label: "Bear Case Research",
        startedAt: now - 60000,
        endedAt: now - 5000,
        outcome: { status: "ok" },
        findings: "Valuation risk: forward P/E above historical average.",
        findingsCaptured: true,
        groupId,
      }),
    );

    const tool = createSessionsListTool({ sessionId: "parent-001" });
    const result = await tool.execute("call-1", {});

    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("id:run-g1");
    expect(text).toContain("id:run-g2");
    expect(text).toContain("AI infrastructure capex growing 40% YoY.");
    expect(text).toContain("Valuation risk: forward P/E above historical average.");
  });

  it("shows findings status for running task", async () => {
    const now = Date.now();
    seedSubagentRunForTests(
      makeRecord({
        runId: "run-running",
        label: "Still Running",
        startedAt: now - 30000,
        // no endedAt
      }),
    );

    const tool = createSessionsListTool({ sessionId: "parent-001" });
    const result = await tool.execute("call-1", { runId: "run-running" });

    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Status: running");
    expect(text).toContain("Findings: (still running)");
  });
});
