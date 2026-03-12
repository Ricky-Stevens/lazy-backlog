import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { KnowledgeBase } from "../lib/db.js";
import { JiraClient, type JiraSchema } from "../lib/jira.js";
import { registerSprintsTool } from "../tools/sprints.js";
import { createMockServer } from "./helpers/mock-server.js";

// ── Fetch mock ───────────────────────────────────────────────────────────────

const originalFetch = globalThis.fetch;
let fetchMock: Mock;

function mockFetchResponse(body: unknown, status = 200) {
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }),
  );
}

beforeAll(() => {
  fetchMock = vi.fn(() => Promise.resolve(new Response("{}")));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  fetchMock.mockClear();
});

// ── Test data ────────────────────────────────────────────────────────────────

const testSchema: JiraSchema = {
  projectKey: "BP",
  projectName: "Backlog",
  boardId: "266",
  issueTypes: [{ id: "1", name: "Task", subtask: false, fields: [], requiredFields: [] }],
  priorities: [{ id: "1", name: "Medium" }],
  statuses: [],
};

// ── Env helpers ──────────────────────────────────────────────────────────────

const envSnapshot: Record<string, string | undefined> = {};
const ENV_KEYS = ["ATLASSIAN_SITE_URL", "ATLASSIAN_EMAIL", "ATLASSIAN_API_TOKEN", "JIRA_PROJECT_KEY", "JIRA_BOARD_ID"];

function setTestEnv() {
  for (const key of ENV_KEYS) envSnapshot[key] = process.env[key];
  process.env.ATLASSIAN_SITE_URL = "https://test.atlassian.net";
  process.env.ATLASSIAN_EMAIL = "test@example.com";
  process.env.ATLASSIAN_API_TOKEN = "tok_123";
  process.env.JIRA_PROJECT_KEY = "BP";
  process.env.JIRA_BOARD_ID = "266";
}

function restoreEnv() {
  for (const key of ENV_KEYS) {
    if (envSnapshot[key] === undefined) delete process.env[key];
    else process.env[key] = envSnapshot[key];
  }
}

// ── Helper to make sprint issues ─────────────────────────────────────────────

function makeSprintIssues(statuses: string[], points: (number | undefined)[], options?: { issueTypes?: string[] }) {
  return statuses.map((status, idx) => ({
    key: `BP-${idx + 1}`,
    id: String(idx + 1),
    fields: {
      summary: `Issue ${idx + 1}`,
      issuetype: { name: options?.issueTypes?.[idx] ?? "Task" },
      status: { name: status },
      priority: { name: "Medium" },
      assignee: null,
      story_points: points[idx],
    },
  }));
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("registerSprintsTool", () => {
  let kb: KnowledgeBase;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "lb-sprint-test-"));
    kb = new KnowledgeBase(join(tmpDir, "test.db"));
    setTestEnv();
    JiraClient.saveSchemaToDb(kb, testSchema);
  });

  afterEach(() => {
    kb.close();
    rmSync(tmpDir, { recursive: true, force: true });
    restoreEnv();
  });

  it("registers single 'sprints' tool", () => {
    const { server, toolNames } = createMockServer();
    registerSprintsTool(server, () => kb);
    expect(toolNames()).toEqual(["sprints"]);
  });

  describe("action=list", () => {
    it("returns sprint list", async () => {
      const { server, getTool } = createMockServer();
      registerSprintsTool(server, () => kb);

      // active sprints
      mockFetchResponse({
        values: [
          {
            id: 1,
            name: "Sprint 1",
            state: "active",
            startDate: "2026-03-01T00:00:00Z",
            endDate: "2026-03-14T00:00:00Z",
            goal: "Ship v2",
          },
        ],
        isLast: true,
        maxResults: 50,
        startAt: 0,
      });
      // future sprints
      mockFetchResponse({
        values: [{ id: 2, name: "Sprint 2", state: "future" }],
        isLast: true,
        maxResults: 50,
        startAt: 0,
      });

      const sprints = getTool("sprints");
      const result = await sprints({ action: "list" });
      const text = result.content[0]?.text ?? "";
      expect(text).toContain("Sprint 1");
      expect(text).toContain("Sprint 2");
      expect(text).toContain("active");
      expect(text).toContain("future");
    });

    it("filters by state", async () => {
      const { server, getTool } = createMockServer();
      registerSprintsTool(server, () => kb);

      mockFetchResponse({
        values: [
          {
            id: 1,
            name: "Sprint 1",
            state: "active",
            startDate: "2026-03-01T00:00:00Z",
            endDate: "2026-03-14T00:00:00Z",
          },
        ],
        isLast: true,
        maxResults: 50,
        startAt: 0,
      });

      const sprints = getTool("sprints");
      const result = await sprints({ action: "list", state: "active" });
      const text = result.content[0]?.text ?? "";
      expect(text).toContain("Sprint 1");
      expect(text).toContain("active");
      // Should have called fetch once (not twice for active+future)
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("action=get", () => {
    it("returns sprint with issue breakdown", async () => {
      const { server, getTool } = createMockServer();
      registerSprintsTool(server, () => kb);

      // GET sprint
      mockFetchResponse({
        id: 10,
        name: "Sprint 10",
        state: "active",
        startDate: "2026-03-01T00:00:00Z",
        endDate: "2026-03-14T00:00:00Z",
        goal: "Deliver MVP",
      });
      // GET sprint details
      mockFetchResponse({
        id: 10,
        name: "Sprint 10",
        state: "active",
        startDate: "2026-03-01T00:00:00Z",
        endDate: "2026-03-14T00:00:00Z",
        goal: "Deliver MVP",
      });
      // GET sprint issues
      mockFetchResponse({
        issues: [
          {
            key: "BP-1",
            fields: {
              summary: "Task A",
              status: { name: "Done" },
              issuetype: { name: "Task" },
              priority: { name: "High" },
              assignee: { displayName: "Alice" },
              story_points: 3,
            },
          },
          {
            key: "BP-2",
            fields: {
              summary: "Task B",
              status: { name: "In Progress" },
              issuetype: { name: "Task" },
              priority: { name: "Medium" },
              assignee: { displayName: "Bob" },
              story_points: 5,
            },
          },
          {
            key: "BP-3",
            fields: {
              summary: "Task C",
              status: { name: "To Do" },
              issuetype: { name: "Task" },
              priority: { name: "Low" },
              assignee: null,
            },
          },
        ],
        total: 3,
        maxResults: 50,
      });

      const sprints = getTool("sprints");
      const result = await sprints({ action: "get", sprintId: "10" });
      const text = result.content[0]?.text ?? "";
      expect(text).toContain("Sprint 10");
      expect(text).toContain("Deliver MVP");
      expect(text).toContain("BP-1");
      expect(text).toContain("BP-2");
      expect(text).toContain("Done");
      expect(text).toContain("In Progress");
      expect(text).toContain("Alice");
      expect(text).toContain("Unassigned");
    });

    it("returns error without sprintId", async () => {
      const { server, getTool } = createMockServer();
      registerSprintsTool(server, () => kb);

      const sprints = getTool("sprints");
      const result = await sprints({ action: "get" });
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("sprintId is required");
    });

    it("displays sprint goal from getSprintDetails", async () => {
      const { server, getTool } = createMockServer();
      registerSprintsTool(server, () => kb);

      // GET sprint (no goal in basic endpoint)
      mockFetchResponse({
        id: 10,
        name: "Sprint 10",
        state: "active",
        startDate: "2026-03-01T00:00:00Z",
        endDate: "2026-03-14T00:00:00Z",
      });
      // GET sprint details (has goal)
      mockFetchResponse({
        id: 10,
        name: "Sprint 10",
        state: "active",
        startDate: "2026-03-01T00:00:00Z",
        endDate: "2026-03-14T00:00:00Z",
        goal: "Ship the auth module",
      });
      // GET sprint issues
      mockFetchResponse({
        issues: [],
        total: 0,
        maxResults: 50,
      });

      const sprints = getTool("sprints");
      const result = await sprints({ action: "get", sprintId: "10" });
      const text = result.content[0]?.text ?? "";
      expect(text).toContain("Ship the auth module");
    });
  });

  describe("action=create", () => {
    it("creates sprint", async () => {
      const { server, getTool } = createMockServer();
      registerSprintsTool(server, () => kb);

      mockFetchResponse({ id: 99, name: "Sprint 99", state: "future", goal: "Test goal" });

      const sprints = getTool("sprints");
      const result = await sprints({ action: "create", name: "Sprint 99", goal: "Test goal" });
      const text = result.content[0]?.text ?? "";
      expect(text).toContain("Sprint Created");
      expect(text).toContain("Sprint 99");
      expect(text).toContain("Test goal");
    });

    it("creates sprint with goal and calls updateSprint", async () => {
      const { server, getTool } = createMockServer();
      registerSprintsTool(server, () => kb);

      // POST create sprint
      mockFetchResponse({ id: 100, name: "Sprint 100", state: "future" });
      // PUT updateSprint (goal)
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

      const sprints = getTool("sprints");
      const result = await sprints({ action: "create", name: "Sprint 100", goal: "Deliver API v2" });
      const text = result.content[0]?.text ?? "";
      expect(text).toContain("Sprint Created");
      expect(text).toContain("Sprint 100");
      expect(text).toContain("Deliver API v2");
      // Should have called fetch twice: createSprint + updateSprint
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("returns error without name", async () => {
      const { server, getTool } = createMockServer();
      registerSprintsTool(server, () => kb);

      const sprints = getTool("sprints");
      const result = await sprints({ action: "create" });
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("name is required");
    });

    it("creates sprint without goal (no updateSprint call)", async () => {
      const { server, getTool } = createMockServer();
      registerSprintsTool(server, () => kb);

      mockFetchResponse({
        id: 101,
        name: "Sprint 101",
        state: "future",
        startDate: "2026-04-01T00:00:00Z",
        endDate: "2026-04-14T00:00:00Z",
      });

      const sprints = getTool("sprints");
      const result = await sprints({
        action: "create",
        name: "Sprint 101",
        startDate: "2026-04-01T00:00:00Z",
        endDate: "2026-04-14T00:00:00Z",
      });
      const text = result.content[0]?.text ?? "";
      expect(text).toContain("Sprint Created");
      expect(text).toContain("Sprint 101");
      expect(text).toContain("future");
      expect(text).toContain("**Start:**");
      expect(text).toContain("**End:**");
      // No goal provided, so only 1 fetch (createSprint) — no updateSprint
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("returns error when boardId is missing", async () => {
      const { server, getTool } = createMockServer();
      // Clear JIRA_BOARD_ID and save schema without boardId
      delete process.env.JIRA_BOARD_ID;
      const noBoardSchema = { ...testSchema, boardId: "" };
      JiraClient.saveSchemaToDb(kb, noBoardSchema);

      registerSprintsTool(server, () => kb);

      const sprints = getTool("sprints");
      const result = await sprints({ action: "create", name: "Sprint X" });
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("board");
    });

    it("shows goal from created response when no params.goal", async () => {
      const { server, getTool } = createMockServer();
      registerSprintsTool(server, () => kb);

      mockFetchResponse({
        id: 102,
        name: "Sprint 102",
        state: "future",
        goal: "Server-set goal",
      });

      const sprints = getTool("sprints");
      const result = await sprints({ action: "create", name: "Sprint 102" });
      const text = result.content[0]?.text ?? "";
      expect(text).toContain("Sprint Created");
      // The created.goal should show even though params.goal was not set
      expect(text).toContain("Server-set goal");
    });
  });

  describe("action=move-issues", () => {
    it("moves issues to sprint", async () => {
      const { server, getTool } = createMockServer();
      registerSprintsTool(server, () => kb);

      // POST move returns 204
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

      const sprints = getTool("sprints");
      const result = await sprints({ action: "move-issues", sprintId: "10", issueKeys: ["BP-1", "BP-2"] });
      const text = result.content[0]?.text ?? "";
      expect(text).toContain("Moved 2 issues");
      expect(text).toContain("BP-1");
      expect(text).toContain("BP-2");
    });

    it("returns error without sprintId", async () => {
      const { server, getTool } = createMockServer();
      registerSprintsTool(server, () => kb);

      const sprints = getTool("sprints");
      const result = await sprints({ action: "move-issues", issueKeys: ["BP-1"] });
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("sprintId is required");
    });

    it("returns error without issueKeys", async () => {
      const { server, getTool } = createMockServer();
      registerSprintsTool(server, () => kb);

      const sprints = getTool("sprints");
      const result = await sprints({ action: "move-issues", sprintId: "10" });
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("issueKeys is required");
    });

    it("returns error with empty issueKeys array", async () => {
      const { server, getTool } = createMockServer();
      registerSprintsTool(server, () => kb);

      const sprints = getTool("sprints");
      const result = await sprints({ action: "move-issues", sprintId: "10", issueKeys: [] });
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("issueKeys is required");
    });

    it("uses singular 'issue' for single item", async () => {
      const { server, getTool } = createMockServer();
      registerSprintsTool(server, () => kb);

      fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

      const sprints = getTool("sprints");
      const result = await sprints({ action: "move-issues", sprintId: "10", issueKeys: ["BP-1"] });
      const text = result.content[0]?.text ?? "";
      expect(text).toContain("Moved 1 issue ");
      expect(text).not.toContain("issues");
    });
  });

  describe("action=health", () => {
    it("returns health check for active sprint", async () => {
      const { server, getTool } = createMockServer();
      registerSprintsTool(server, () => kb);

      // list active sprints
      mockFetchResponse({
        values: [{ id: 20, name: "Sprint 20", state: "active" }],
        isLast: true,
        maxResults: 50,
        startAt: 0,
      });
      // GET sprint
      mockFetchResponse({
        id: 20,
        name: "Sprint 20",
        state: "active",
        startDate: "2026-03-01T00:00:00Z",
        endDate: "2026-12-14T00:00:00Z",
      });
      // GET sprint issues
      mockFetchResponse({
        issues: [
          {
            key: "BP-30",
            fields: {
              summary: "Done A",
              status: { name: "Done" },
              issuetype: { name: "Task" },
              priority: { name: "High" },
              assignee: null,
              story_points: 5,
            },
          },
          {
            key: "BP-31",
            fields: {
              summary: "WIP B",
              status: { name: "In Progress" },
              issuetype: { name: "Task" },
              priority: { name: "Medium" },
              assignee: null,
              story_points: 3,
            },
          },
          {
            key: "BP-32",
            fields: {
              summary: "Todo C",
              status: { name: "To Do" },
              issuetype: { name: "Task" },
              priority: { name: "Low" },
              assignee: null,
              story_points: 2,
            },
          },
        ],
        total: 3,
        maxResults: 50,
      });
      // list closed sprints (for capacity computation)
      mockFetchResponse({
        values: [{ id: 10, name: "Sprint 10", state: "closed" }],
        isLast: true,
        maxResults: 50,
        startAt: 0,
      });
      // Closed sprint issues (for velocity computation)
      mockFetchResponse({
        issues: makeSprintIssues(["Done", "Done"], [5, 3]),
        total: 2,
        maxResults: 50,
      });

      const sprints = getTool("sprints");
      const result = await sprints({ action: "health" });
      const text = result.content[0]?.text ?? "";
      expect(text).toContain("Sprint Health");
      expect(text).toContain("Sprint 20");
      expect(text).toContain("Total SP:");
      expect(text).toContain("Done:");
      expect(text).toContain("In Progress:");
      expect(text).toContain("To Do:");
      expect(text).toContain("Blockers:");
      expect(text).toContain("Overall:");
      // Capacity section
      expect(text).toContain("Capacity");
      expect(text).toContain("Committed:");
      expect(text).toContain("Avg Velocity:");
      expect(text).toContain("Capacity Ratio:");
      expect(text).toContain("Per-Assignee Breakdown");
    });

    it("includes items-by-status breakdown for standup", async () => {
      const { server, getTool } = createMockServer();
      registerSprintsTool(server, () => kb);

      // list active sprints
      mockFetchResponse({
        values: [{ id: 20, name: "Sprint 20", state: "active" }],
        isLast: true,
        maxResults: 50,
        startAt: 0,
      });
      // GET sprint
      mockFetchResponse({
        id: 20,
        name: "Sprint 20",
        state: "active",
        startDate: "2026-03-01T00:00:00Z",
        endDate: "2026-12-14T00:00:00Z",
      });
      // GET sprint issues
      mockFetchResponse({
        issues: [
          {
            key: "BP-30",
            fields: {
              summary: "Done A",
              status: { name: "Done" },
              issuetype: { name: "Task" },
              priority: { name: "High" },
              assignee: null,
              story_points: 5,
              updated: new Date().toISOString(),
            },
          },
          {
            key: "BP-31",
            fields: {
              summary: "WIP B",
              status: { name: "In Progress" },
              issuetype: { name: "Task" },
              priority: { name: "Medium" },
              assignee: null,
              story_points: 3,
              updated: new Date().toISOString(),
            },
          },
          {
            key: "BP-32",
            fields: {
              summary: "Todo C",
              status: { name: "To Do" },
              issuetype: { name: "Task" },
              priority: { name: "Low" },
              assignee: null,
              story_points: 2,
              updated: new Date().toISOString(),
            },
          },
        ],
        total: 3,
        maxResults: 50,
      });
      // list closed sprints (for capacity)
      mockFetchResponse({
        values: [],
        isLast: true,
        maxResults: 50,
        startAt: 0,
      });

      const sprints = getTool("sprints");
      const result = await sprints({ action: "health" });
      const text = result.content[0]?.text ?? "";
      expect(text).toContain("Items by Status");
      expect(text).toContain("Done (1)");
      expect(text).toContain("In Progress (1)");
      expect(text).toContain("To Do (1)");
      expect(text).toContain("BP-30");
      expect(text).toContain("BP-31");
      expect(text).toContain("BP-32");
    });

    it("shows stale items when in-progress issues have old updated dates", async () => {
      const { server, getTool } = createMockServer();
      registerSprintsTool(server, () => kb);

      const staleDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(); // 5 days ago

      // list active sprints
      mockFetchResponse({
        values: [{ id: 20, name: "Sprint 20", state: "active" }],
        isLast: true,
        maxResults: 50,
        startAt: 0,
      });
      // GET sprint
      mockFetchResponse({
        id: 20,
        name: "Sprint 20",
        state: "active",
        startDate: "2026-03-01T00:00:00Z",
        endDate: "2026-12-14T00:00:00Z",
      });
      // GET sprint issues
      mockFetchResponse({
        issues: [
          {
            key: "BP-40",
            fields: {
              summary: "Stale WIP",
              status: { name: "In Progress" },
              issuetype: { name: "Task" },
              priority: { name: "Medium" },
              assignee: null,
              story_points: 3,
              updated: staleDate,
            },
          },
          {
            key: "BP-41",
            fields: {
              summary: "Fresh WIP",
              status: { name: "In Progress" },
              issuetype: { name: "Task" },
              priority: { name: "Medium" },
              assignee: null,
              story_points: 2,
              updated: new Date().toISOString(),
            },
          },
        ],
        total: 2,
        maxResults: 50,
      });
      // list closed sprints
      mockFetchResponse({
        values: [],
        isLast: true,
        maxResults: 50,
        startAt: 0,
      });

      const sprints = getTool("sprints");
      const result = await sprints({ action: "health" });
      const text = result.content[0]?.text ?? "";
      expect(text).toContain("Stale Items");
      expect(text).toContain("BP-40");
      expect(text).not.toContain("BP-41: Fresh WIP (last updated:");
    });

    it("shows recently completed items from last 24 hours", async () => {
      const { server, getTool } = createMockServer();
      registerSprintsTool(server, () => kb);

      const recentDate = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2 hours ago
      const oldDate = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(); // 3 days ago

      // list active sprints
      mockFetchResponse({
        values: [{ id: 20, name: "Sprint 20", state: "active" }],
        isLast: true,
        maxResults: 50,
        startAt: 0,
      });
      // GET sprint
      mockFetchResponse({
        id: 20,
        name: "Sprint 20",
        state: "active",
        startDate: "2026-03-01T00:00:00Z",
        endDate: "2026-12-14T00:00:00Z",
      });
      // GET sprint issues
      mockFetchResponse({
        issues: [
          {
            key: "BP-50",
            fields: {
              summary: "Just finished",
              status: { name: "Done" },
              issuetype: { name: "Task" },
              priority: { name: "High" },
              assignee: null,
              story_points: 5,
              updated: recentDate,
            },
          },
          {
            key: "BP-51",
            fields: {
              summary: "Finished long ago",
              status: { name: "Done" },
              issuetype: { name: "Task" },
              priority: { name: "Medium" },
              assignee: null,
              story_points: 3,
              updated: oldDate,
            },
          },
        ],
        total: 2,
        maxResults: 50,
      });
      // list closed sprints
      mockFetchResponse({
        values: [],
        isLast: true,
        maxResults: 50,
        startAt: 0,
      });

      const sprints = getTool("sprints");
      const result = await sprints({ action: "health" });
      const text = result.content[0]?.text ?? "";
      expect(text).toContain("Recently Completed");
      expect(text).toContain("BP-50");
      expect(text).toContain("Just finished");
      // BP-51 should not appear in recently completed (older than 24h)
      expect(text).not.toMatch(/Recently Completed[\s\S]*BP-51/);
    });

    it("shows at-risk items with no story points", async () => {
      const { server, getTool } = createMockServer();
      registerSprintsTool(server, () => kb);

      // list active sprints
      mockFetchResponse({
        values: [{ id: 20, name: "Sprint 20", state: "active" }],
        isLast: true,
        maxResults: 50,
        startAt: 0,
      });
      // GET sprint — already >75% elapsed
      const startDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
      const endDate = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
      mockFetchResponse({
        id: 20,
        name: "Sprint 20",
        state: "active",
        startDate,
        endDate,
      });
      // GET sprint issues
      mockFetchResponse({
        issues: [
          {
            key: "BP-60",
            fields: {
              summary: "No points task",
              status: { name: "To Do" },
              issuetype: { name: "Task" },
              priority: { name: "Medium" },
              assignee: null,
              updated: new Date().toISOString(),
              // no story_points
            },
          },
          {
            key: "BP-61",
            fields: {
              summary: "WIP late in sprint",
              status: { name: "In Progress" },
              issuetype: { name: "Task" },
              priority: { name: "High" },
              assignee: null,
              story_points: 5,
              updated: new Date().toISOString(),
            },
          },
          {
            key: "BP-62",
            fields: {
              summary: "Already done",
              status: { name: "Done" },
              issuetype: { name: "Task" },
              priority: { name: "Low" },
              assignee: null,
              story_points: 3,
              updated: new Date().toISOString(),
            },
          },
        ],
        total: 3,
        maxResults: 50,
      });
      // list closed sprints
      mockFetchResponse({
        values: [],
        isLast: true,
        maxResults: 50,
        startAt: 0,
      });

      const sprints = getTool("sprints");
      const result = await sprints({ action: "health" });
      const text = result.content[0]?.text ?? "";
      expect(text).toContain("At Risk");
      expect(text).toContain("BP-60");
      expect(text).toContain("no story points");
      expect(text).toContain("BP-61");
      expect(text).toContain("sprint");
      expect(text).toContain("elapsed");
      // Done items should not be at risk
      expect(text).not.toMatch(/At Risk[\s\S]*BP-62/);
    });

    it("returns health without capacity when no closed sprints", async () => {
      const { server, getTool } = createMockServer();
      registerSprintsTool(server, () => kb);

      // list active sprints
      mockFetchResponse({
        values: [{ id: 20, name: "Sprint 20", state: "active" }],
        isLast: true,
        maxResults: 50,
        startAt: 0,
      });
      // GET sprint
      mockFetchResponse({
        id: 20,
        name: "Sprint 20",
        state: "active",
        startDate: "2026-03-01T00:00:00Z",
        endDate: "2026-12-14T00:00:00Z",
      });
      // GET sprint issues
      mockFetchResponse({
        issues: makeSprintIssues(["Done", "In Progress"], [5, 3]),
        total: 2,
        maxResults: 50,
      });
      // list closed sprints (none)
      mockFetchResponse({
        values: [],
        isLast: true,
        maxResults: 50,
        startAt: 0,
      });

      const sprints = getTool("sprints");
      const result = await sprints({ action: "health" });
      const text = result.content[0]?.text ?? "";
      expect(text).toContain("Sprint Health");
      expect(text).toContain("Sprint 20");
      // No capacity section when no historical data
      expect(text).not.toContain("Capacity Ratio:");
    });
  });

  describe("action=goal", () => {
    it("reads sprint goal", async () => {
      const { server, getTool } = createMockServer();
      registerSprintsTool(server, () => kb);

      // GET sprint details
      mockFetchResponse({
        id: 50,
        name: "Sprint 50",
        state: "active",
        goal: "Complete onboarding flow",
      });

      const sprints = getTool("sprints");
      const result = await sprints({ action: "goal", sprintId: "50" });
      const text = result.content[0]?.text ?? "";
      expect(text).toContain("Sprint Goal");
      expect(text).toContain("Sprint 50");
      expect(text).toContain("Complete onboarding flow");
    });

    it("sets sprint goal", async () => {
      const { server, getTool } = createMockServer();
      registerSprintsTool(server, () => kb);

      // PUT updateSprint
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

      const sprints = getTool("sprints");
      const result = await sprints({ action: "goal", sprintId: "50", goal: "New sprint goal" });
      const text = result.content[0]?.text ?? "";
      expect(text).toContain("Sprint Goal Updated");
      expect(text).toContain("New sprint goal");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("returns error without sprintId", async () => {
      const { server, getTool } = createMockServer();
      registerSprintsTool(server, () => kb);

      const sprints = getTool("sprints");
      const result = await sprints({ action: "goal" });
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("sprintId is required");
    });

    it("shows '(no goal set)' when sprint has no goal", async () => {
      const { server, getTool } = createMockServer();
      registerSprintsTool(server, () => kb);

      mockFetchResponse({
        id: 60,
        name: "Sprint 60",
        state: "active",
      });

      const sprints = getTool("sprints");
      const result = await sprints({ action: "goal", sprintId: "60" });
      const text = result.content[0]?.text ?? "";
      expect(text).toContain("Sprint Goal");
      expect(text).toContain("(no goal set)");
    });
  });
});
