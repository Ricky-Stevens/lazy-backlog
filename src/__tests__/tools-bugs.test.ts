import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { KnowledgeBase } from "../lib/db.js";
import { JiraClient, type JiraIssueDetail, type JiraSchema } from "../lib/jira.js";
import { assessCompleteness, inferSeverity, registerBugsTool } from "../tools/bugs.js";
import { createMockServer } from "./helpers/mock-server.js";

// ── Fetch mock ───────────────────────────────────────────────────────────────

const originalFetch = globalThis.fetch;
let fetchMock: Mock;

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

// ── Helpers ──────────────────────────────────────────────────────────────────

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

// ── Tests ────────────────────────────────────────────────────────────────────

describe("registerBugsTool", () => {
  let kb: KnowledgeBase;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "lb-bugs-test-"));
    kb = new KnowledgeBase(join(tmpDir, "test.db"));
    setTestEnv();
  });

  afterEach(() => {
    kb.close();
    rmSync(tmpDir, { recursive: true, force: true });
    restoreEnv();
  });

  function getText(result: { content: { type: string; text: string }[] }): string {
    return (result.content[0] as { type: string; text: string }).text;
  }

  function makeIssueDetail(key: string, overrides: Record<string, unknown> = {}): JiraIssueDetail {
    return {
      key,
      id: key.split("-")[1] ?? "1",
      summary: (overrides.summary as string) ?? `${key} summary`,
      description: (overrides.description as string) ?? "",
      issueType: "Bug",
      status: (overrides.status as string) ?? "To Do",
      priority: (overrides.priority as string) ?? "Medium",
      labels: (overrides.labels as string[]) ?? [],
      components: (overrides.components as string[]) ?? [],
      assignee: (overrides.assignee as string) ?? "",
      reporter: (overrides.reporter as string) ?? "",
      created: (overrides.created as string) ?? "2025-01-01",
      updated: (overrides.updated as string) ?? "2025-06-01",
      url: `https://test.atlassian.net/browse/${key}`,
      comments: [],
      attachments: [],
    };
  }

  // ── action=triage ────────────────────────────────────────────────────────

  describe("action=triage", () => {
    it("returns error when issueKeys missing", async () => {
      const { server, getTool } = createMockServer();
      registerBugsTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const bugs = getTool("bugs");
      const result = await bugs({ action: "triage" });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("issueKeys required");
    });

    it("returns error when issueKeys is empty array", async () => {
      const { server, getTool } = createMockServer();
      registerBugsTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const bugs = getTool("bugs");
      const result = await bugs({ action: "triage", issueKeys: [] });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("issueKeys required");
    });

    it("single issue: infers critical severity and recommends active sprint", async () => {
      const { server, getTool } = createMockServer();
      registerBugsTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const getIssueSpy = vi
        .spyOn(JiraClient.prototype, "getIssue")
        .mockResolvedValue(makeIssueDetail("BP-1", { summary: "Production outage crash" }));
      const listSprintsSpy = vi
        .spyOn(JiraClient.prototype, "listSprints")
        .mockResolvedValue([{ id: 5, name: "Sprint 5", state: "active" }]);
      const getSprintIssuesSpy = vi
        .spyOn(JiraClient.prototype, "getSprintIssues")
        .mockResolvedValue({ issues: [], total: 0 });

      const bugs = getTool("bugs");
      const result = await bugs({ action: "triage", issueKeys: ["BP-1"] });
      const text = getText(result);
      expect(text).toContain("Severity");
      expect(text).toContain("critical");
      expect(text).toContain("Recommendation");
      expect(text).toContain("Sprint 5");

      getIssueSpy.mockRestore();
      listSprintsSpy.mockRestore();
      getSprintIssuesSpy.mockRestore();
    });

    it("single issue: infers medium severity when no keywords match", async () => {
      const { server, getTool } = createMockServer();
      registerBugsTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const getIssueSpy = vi
        .spyOn(JiraClient.prototype, "getIssue")
        .mockResolvedValue(makeIssueDetail("BP-1", { summary: "Button color is wrong" }));
      const listSprintsSpy = vi
        .spyOn(JiraClient.prototype, "listSprints")
        .mockResolvedValue([{ id: 10, name: "Sprint 10", state: "future" }]);

      const bugs = getTool("bugs");
      const result = await bugs({ action: "triage", issueKeys: ["BP-1"] });
      const text = getText(result);
      expect(text).toContain("medium");
      expect(text).toContain("no specific keywords");

      getIssueSpy.mockRestore();
      listSprintsSpy.mockRestore();
    });

    it("single issue: auto-updates priority when autoUpdate=true", async () => {
      const { server, getTool } = createMockServer();
      registerBugsTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const getIssueSpy = vi
        .spyOn(JiraClient.prototype, "getIssue")
        .mockResolvedValue(makeIssueDetail("BP-1", { summary: "Security vulnerability in auth", priority: "Low" }));
      const updateIssueSpy = vi.spyOn(JiraClient.prototype, "updateIssue").mockResolvedValue(undefined);
      const listSprintsSpy = vi
        .spyOn(JiraClient.prototype, "listSprints")
        .mockResolvedValue([{ id: 5, name: "Sprint 5", state: "active" }]);
      const getSprintIssuesSpy = vi
        .spyOn(JiraClient.prototype, "getSprintIssues")
        .mockResolvedValue({ issues: [], total: 0 });

      const bugs = getTool("bugs");
      await bugs({ action: "triage", issueKeys: ["BP-1"], autoUpdate: true });

      expect(updateIssueSpy).toHaveBeenCalledWith(expect.objectContaining({ issueKey: "BP-1", priority: "critical" }));

      getIssueSpy.mockRestore();
      updateIssueSpy.mockRestore();
      listSprintsSpy.mockRestore();
      getSprintIssuesSpy.mockRestore();
    });

    it("single issue with autoAssign: moves to sprint and comments", async () => {
      const { server, getTool } = createMockServer();
      registerBugsTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const getIssueSpy = vi
        .spyOn(JiraClient.prototype, "getIssue")
        .mockResolvedValue(makeIssueDetail("BP-1", { summary: "Production crash" }));
      const listSprintsSpy = vi
        .spyOn(JiraClient.prototype, "listSprints")
        .mockResolvedValue([{ id: 5, name: "Sprint 5", state: "active" }]);
      const getSprintIssuesSpy = vi
        .spyOn(JiraClient.prototype, "getSprintIssues")
        .mockResolvedValue({ issues: [], total: 0 });
      const moveToSprintSpy = vi.spyOn(JiraClient.prototype, "moveIssuesToSprint").mockResolvedValue(undefined);
      const addCommentSpy = vi.spyOn(JiraClient.prototype, "addComment").mockResolvedValue(undefined);

      const bugs = getTool("bugs");
      await bugs({ action: "triage", issueKeys: ["BP-1"], autoAssign: true });

      expect(moveToSprintSpy).toHaveBeenCalledWith("5", ["BP-1"]);
      expect(addCommentSpy).toHaveBeenCalledWith("BP-1", expect.stringContaining("Sprint 5"));

      getIssueSpy.mockRestore();
      listSprintsSpy.mockRestore();
      getSprintIssuesSpy.mockRestore();
      moveToSprintSpy.mockRestore();
      addCommentSpy.mockRestore();
    });

    it("multiple issues: generates report with severity and status distributions", async () => {
      const { server, getTool } = createMockServer();
      registerBugsTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const getIssueSpy = vi
        .spyOn(JiraClient.prototype, "getIssue")
        .mockResolvedValueOnce(makeIssueDetail("BP-1", { summary: "crash data loss", status: "To Do" }))
        .mockResolvedValueOnce(makeIssueDetail("BP-2", { summary: "outage problem", status: "To Do" }))
        .mockResolvedValueOnce(makeIssueDetail("BP-3", { summary: "normal thing", status: "In Progress" }));

      const bugs = getTool("bugs");
      const result = await bugs({ action: "triage", issueKeys: ["BP-1", "BP-2", "BP-3"] });
      const text = getText(result);
      expect(text).toContain("Triage Report");
      expect(text).toContain("Severity Distribution");
      expect(text).toContain("Status Distribution");

      getIssueSpy.mockRestore();
    });

    it("multiple issues: lists incomplete bugs (score < 60)", async () => {
      const { server, getTool } = createMockServer();
      registerBugsTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const getIssueSpy = vi
        .spyOn(JiraClient.prototype, "getIssue")
        .mockResolvedValueOnce(makeIssueDetail("BP-1", { description: "short", labels: [], components: [] }))
        .mockResolvedValueOnce(makeIssueDetail("BP-2", { description: "short", labels: [], components: [] }));

      const bugs = getTool("bugs");
      const result = await bugs({ action: "triage", issueKeys: ["BP-1", "BP-2"] });
      const text = getText(result);
      expect(text).toContain("Incomplete Bugs (2)");

      getIssueSpy.mockRestore();
    });

    it("multiple issues: omits incomplete section when all bugs are complete", async () => {
      const { server, getTool } = createMockServer();
      registerBugsTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const fullDescription =
        "This is a detailed description that is definitely longer than fifty characters. " +
        "Steps to reproduce: 1. Open app 2. Click button. " +
        "Expected: It works. Actual: It crashes. " +
        "Environment: Chrome 120, macOS 14.";

      const getIssueSpy = vi
        .spyOn(JiraClient.prototype, "getIssue")
        .mockResolvedValueOnce(
          makeIssueDetail("BP-1", { description: fullDescription, labels: ["bug"], components: ["fe"] }),
        )
        .mockResolvedValueOnce(
          makeIssueDetail("BP-2", { description: fullDescription, labels: ["bug"], components: ["be"] }),
        );

      const bugs = getTool("bugs");
      const result = await bugs({ action: "triage", issueKeys: ["BP-1", "BP-2"] });
      const text = getText(result);
      expect(text).not.toContain("Incomplete Bugs");

      getIssueSpy.mockRestore();
    });

    it("multiple issues: counts severity distribution correctly", async () => {
      const { server, getTool } = createMockServer();
      registerBugsTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const getIssueSpy = vi
        .spyOn(JiraClient.prototype, "getIssue")
        .mockResolvedValueOnce(makeIssueDetail("BP-1", { summary: "crash data loss" }))
        .mockResolvedValueOnce(makeIssueDetail("BP-2", { summary: "outage" }))
        .mockResolvedValueOnce(makeIssueDetail("BP-3", { summary: "normal thing" }));

      const bugs = getTool("bugs");
      const result = await bugs({ action: "triage", issueKeys: ["BP-1", "BP-2", "BP-3"] });
      const text = getText(result);
      expect(text).toContain("**critical:** 2");
      expect(text).toContain("**medium:** 1");

      getIssueSpy.mockRestore();
    });

    it("single issue: infers high severity for blocking keywords", async () => {
      const { server, getTool } = createMockServer();
      registerBugsTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const getIssueSpy = vi
        .spyOn(JiraClient.prototype, "getIssue")
        .mockResolvedValue(makeIssueDetail("BP-1", { summary: "This regression blocks all users" }));
      const listSprintsSpy = vi
        .spyOn(JiraClient.prototype, "listSprints")
        .mockResolvedValue([{ id: 10, name: "Sprint 10", state: "future" }]);

      const bugs = getTool("bugs");
      const result = await bugs({ action: "triage", issueKeys: ["BP-1"] });
      const text = getText(result);
      expect(text).toContain("high");
      expect(text).toContain("Sprint 10");

      getIssueSpy.mockRestore();
      listSprintsSpy.mockRestore();
    });

    it("single issue: infers low severity for cosmetic issues", async () => {
      const { server, getTool } = createMockServer();
      registerBugsTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const getIssueSpy = vi
        .spyOn(JiraClient.prototype, "getIssue")
        .mockResolvedValue(makeIssueDetail("BP-1", { summary: "Minor typo in footer" }));
      const listSprintsSpy = vi.spyOn(JiraClient.prototype, "listSprints").mockResolvedValue([
        { id: 10, name: "Sprint 10", state: "future" },
        { id: 11, name: "Sprint 11", state: "future" },
      ]);

      const bugs = getTool("bugs");
      const result = await bugs({ action: "triage", issueKeys: ["BP-1"] });
      const text = getText(result);
      expect(text).toContain("low");
      // Low severity goes to last future sprint
      expect(text).toContain("Sprint 11");

      getIssueSpy.mockRestore();
      listSprintsSpy.mockRestore();
    });

    it("single issue: handles no active sprint for critical severity", async () => {
      const { server, getTool } = createMockServer();
      registerBugsTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const getIssueSpy = vi
        .spyOn(JiraClient.prototype, "getIssue")
        .mockResolvedValue(makeIssueDetail("BP-1", { summary: "Production crash" }));
      const listSprintsSpy = vi.spyOn(JiraClient.prototype, "listSprints").mockResolvedValue([]);

      const bugs = getTool("bugs");
      const result = await bugs({ action: "triage", issueKeys: ["BP-1"] });
      const text = getText(result);
      expect(text).toContain("No active sprint found");

      getIssueSpy.mockRestore();
      listSprintsSpy.mockRestore();
    });

    it("single issue: handles no future sprint for high severity", async () => {
      const { server, getTool } = createMockServer();
      registerBugsTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const getIssueSpy = vi
        .spyOn(JiraClient.prototype, "getIssue")
        .mockResolvedValue(makeIssueDetail("BP-1", { summary: "Blocking regression" }));
      const listSprintsSpy = vi.spyOn(JiraClient.prototype, "listSprints").mockResolvedValue([]);

      const bugs = getTool("bugs");
      const result = await bugs({ action: "triage", issueKeys: ["BP-1"] });
      const text = getText(result);
      expect(text).toContain("No future sprints found");

      getIssueSpy.mockRestore();
      listSprintsSpy.mockRestore();
    });

    it("single issue: handles no future sprint for low severity", async () => {
      const { server, getTool } = createMockServer();
      registerBugsTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const getIssueSpy = vi
        .spyOn(JiraClient.prototype, "getIssue")
        .mockResolvedValue(makeIssueDetail("BP-1", { summary: "Minor cosmetic typo" }));
      const listSprintsSpy = vi.spyOn(JiraClient.prototype, "listSprints").mockResolvedValue([]);

      const bugs = getTool("bugs");
      const result = await bugs({ action: "triage", issueKeys: ["BP-1"] });
      const text = getText(result);
      expect(text).toContain("No future sprints available");

      getIssueSpy.mockRestore();
      listSprintsSpy.mockRestore();
    });

    it("single issue: high severity with autoAssign moves to future sprint", async () => {
      const { server, getTool } = createMockServer();
      registerBugsTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const getIssueSpy = vi
        .spyOn(JiraClient.prototype, "getIssue")
        .mockResolvedValue(makeIssueDetail("BP-1", { summary: "Blocking all users" }));
      const listSprintsSpy = vi
        .spyOn(JiraClient.prototype, "listSprints")
        .mockResolvedValue([{ id: 20, name: "Sprint 20", state: "future" }]);
      const moveToSprintSpy = vi.spyOn(JiraClient.prototype, "moveIssuesToSprint").mockResolvedValue(undefined);
      const addCommentSpy = vi.spyOn(JiraClient.prototype, "addComment").mockResolvedValue(undefined);

      const bugs = getTool("bugs");
      await bugs({ action: "triage", issueKeys: ["BP-1"], autoAssign: true });

      expect(moveToSprintSpy).toHaveBeenCalledWith("20", ["BP-1"]);
      expect(addCommentSpy).toHaveBeenCalledWith("BP-1", expect.stringContaining("Sprint 20"));

      getIssueSpy.mockRestore();
      listSprintsSpy.mockRestore();
      moveToSprintSpy.mockRestore();
      addCommentSpy.mockRestore();
    });

    it("single issue: low severity with autoAssign moves to last future sprint", async () => {
      const { server, getTool } = createMockServer();
      registerBugsTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const getIssueSpy = vi
        .spyOn(JiraClient.prototype, "getIssue")
        .mockResolvedValue(makeIssueDetail("BP-1", { summary: "Cosmetic edge case" }));
      const listSprintsSpy = vi.spyOn(JiraClient.prototype, "listSprints").mockResolvedValue([
        { id: 10, name: "Sprint 10", state: "future" },
        { id: 11, name: "Sprint 11", state: "future" },
      ]);
      const moveToSprintSpy = vi.spyOn(JiraClient.prototype, "moveIssuesToSprint").mockResolvedValue(undefined);
      const addCommentSpy = vi.spyOn(JiraClient.prototype, "addComment").mockResolvedValue(undefined);

      const bugs = getTool("bugs");
      await bugs({ action: "triage", issueKeys: ["BP-1"], autoAssign: true });

      expect(moveToSprintSpy).toHaveBeenCalledWith("11", ["BP-1"]);
      expect(addCommentSpy).toHaveBeenCalledWith("BP-1", expect.stringContaining("Sprint 11"));

      getIssueSpy.mockRestore();
      listSprintsSpy.mockRestore();
      moveToSprintSpy.mockRestore();
      addCommentSpy.mockRestore();
    });
  });

  // ── Triage with team conventions + rework warnings ─────────────────────

  describe("action=triage (conventions + rework)", () => {
    it("exercises formatConventions branch when team rules exist (even if no conventions triggered)", async () => {
      const { server, getTool } = createMockServer();
      registerBugsTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      // Store a team rule so getTeamRules() returns non-empty
      kb.upsertTeamRule({
        category: "naming_convention",
        rule_key: "prefix",
        issue_type: "Bug",
        rule_value: "[BUG]",
        confidence: 0.8,
        sample_size: 25,
      });

      const getIssueSpy = vi
        .spyOn(JiraClient.prototype, "getIssue")
        .mockResolvedValue(
          makeIssueDetail("BP-1", { summary: "Production crash", labels: ["bug"], components: ["api"] }),
        );
      const listSprintsSpy = vi
        .spyOn(JiraClient.prototype, "listSprints")
        .mockResolvedValue([{ id: 5, name: "Sprint 5", state: "active" }]);
      const getSprintIssuesSpy = vi
        .spyOn(JiraClient.prototype, "getSprintIssues")
        .mockResolvedValue({ issues: [], total: 0 });

      const bugs = getTool("bugs");
      const result = await bugs({ action: "triage", issueKeys: ["BP-1"] });
      const text = getText(result);
      // The triage completes successfully regardless of whether conventions produce output
      expect(text).toContain("Triage: BP-1");
      expect(text).toContain("Severity");

      getIssueSpy.mockRestore();
      listSprintsSpy.mockRestore();
      getSprintIssuesSpy.mockRestore();
    });

    it("shows rework risk warning when component has high reopen rate", async () => {
      const { server, getTool } = createMockServer();
      registerBugsTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      // Store pattern insights with high rework rate
      kb.upsertInsight(
        "patterns",
        "global",
        {
          priorityDistribution: {},
          labelCooccurrence: [],
          reworkRates: [{ component: "payments", reopenRate: 0.25, reopenedTickets: 5, totalTickets: 20 }],
        },
        20,
        0.9,
      );

      const getIssueSpy = vi
        .spyOn(JiraClient.prototype, "getIssue")
        .mockResolvedValue(makeIssueDetail("BP-1", { summary: "Payment crash", components: ["payments"] }));
      const listSprintsSpy = vi
        .spyOn(JiraClient.prototype, "listSprints")
        .mockResolvedValue([{ id: 5, name: "Sprint 5", state: "active" }]);
      const getSprintIssuesSpy = vi
        .spyOn(JiraClient.prototype, "getSprintIssues")
        .mockResolvedValue({ issues: [], total: 0 });

      const bugs = getTool("bugs");
      const result = await bugs({ action: "triage", issueKeys: ["BP-1"] });
      const text = getText(result);
      expect(text).toContain("Risk Warning");
      expect(text).toContain("payments");
      expect(text).toContain("25%");

      getIssueSpy.mockRestore();
      listSprintsSpy.mockRestore();
      getSprintIssuesSpy.mockRestore();
    });

    it("multi-issue triage shows risky components from rework rates", async () => {
      const { server, getTool } = createMockServer();
      registerBugsTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      kb.upsertInsight(
        "patterns",
        "global",
        {
          priorityDistribution: {},
          labelCooccurrence: [],
          reworkRates: [{ component: "auth", reopenRate: 0.2, reopenedTickets: 4, totalTickets: 20 }],
        },
        20,
        0.9,
      );

      const getIssueSpy = vi
        .spyOn(JiraClient.prototype, "getIssue")
        .mockResolvedValueOnce(makeIssueDetail("BP-1", { summary: "Auth crash", components: ["auth"] }))
        .mockResolvedValueOnce(makeIssueDetail("BP-2", { summary: "Normal bug", components: [] }));

      const bugs = getTool("bugs");
      const result = await bugs({ action: "triage", issueKeys: ["BP-1", "BP-2"] });
      const text = getText(result);
      expect(text).toContain("Risk Warning");
      expect(text).toContain("auth");
      expect(text).toContain("20%");

      getIssueSpy.mockRestore();
    });

    it("auto-comments on incomplete bugs when autoUpdate is true and score < 60", async () => {
      const { server, getTool } = createMockServer();
      registerBugsTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const getIssueSpy = vi
        .spyOn(JiraClient.prototype, "getIssue")
        .mockResolvedValue(
          makeIssueDetail("BP-1", { summary: "Bad bug", description: "short", labels: [], components: [] }),
        );
      const addCommentSpy = vi.spyOn(JiraClient.prototype, "addComment").mockResolvedValue(undefined);
      const addLabelsSpy = vi.spyOn(JiraClient.prototype, "addLabels").mockResolvedValue(undefined);
      const listSprintsSpy = vi
        .spyOn(JiraClient.prototype, "listSprints")
        .mockResolvedValue([{ id: 5, name: "Sprint 5", state: "future" }]);

      const bugs = getTool("bugs");
      const result = await bugs({ action: "triage", issueKeys: ["BP-1"], autoUpdate: true });
      const text = getText(result);

      expect(addCommentSpy).toHaveBeenCalledWith("BP-1", expect.stringContaining("incomplete"));
      expect(addLabelsSpy).toHaveBeenCalledWith("BP-1", ["needs-info"]);
      expect(text).toContain("needs-info");

      getIssueSpy.mockRestore();
      addCommentSpy.mockRestore();
      addLabelsSpy.mockRestore();
      listSprintsSpy.mockRestore();
    });

    it("returns error response when triage throws", async () => {
      const { server, getTool } = createMockServer();
      registerBugsTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const getIssueSpy = vi.spyOn(JiraClient.prototype, "getIssue").mockRejectedValue(new Error("Network timeout"));

      const bugs = getTool("bugs");
      const result = await bugs({ action: "triage", issueKeys: ["BP-1"] });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("Triage error");
      expect(getText(result)).toContain("Network timeout");

      getIssueSpy.mockRestore();
    });
  });
});

// ── inferSeverity (unit tests) ────────────────────────────────────────────

describe("inferSeverity", () => {
  it("returns critical for data loss keyword", () => {
    const result = inferSeverity("There was data loss in the migration");
    expect(result.severity).toBe("critical");
    expect(result.matches[0]).toContain("data loss");
  });

  it("returns critical for security keyword", () => {
    const result = inferSeverity("Security vulnerability found in auth");
    expect(result.severity).toBe("critical");
    expect(result.matches[0]).toContain("security");
  });

  it("returns high for blocking keyword", () => {
    const result = inferSeverity("This is blocking all users from login");
    expect(result.severity).toBe("high");
    expect(result.matches[0]).toContain("blocking");
  });

  it("returns high for regression keyword", () => {
    const result = inferSeverity("This is a regression from last release");
    expect(result.severity).toBe("high");
    expect(result.matches[0]).toContain("regression");
  });

  it("returns low for cosmetic keyword", () => {
    const result = inferSeverity("Cosmetic issue with button alignment");
    expect(result.severity).toBe("low");
    expect(result.matches[0]).toContain("cosmetic");
  });

  it("returns low for typo keyword", () => {
    const result = inferSeverity("Fix typo in the header");
    expect(result.severity).toBe("low");
    expect(result.matches[0]).toContain("typo");
  });

  it("returns low for workaround keyword", () => {
    const result = inferSeverity("There is a workaround available");
    expect(result.severity).toBe("low");
    expect(result.matches[0]).toContain("workaround");
  });

  it("returns low for edge case keyword", () => {
    const result = inferSeverity("Only affects an edge case scenario");
    expect(result.severity).toBe("low");
    expect(result.matches[0]).toContain("edge case");
  });

  it("returns medium when no keywords match", () => {
    const result = inferSeverity("Button color is slightly off");
    expect(result.severity).toBe("medium");
    expect(result.matches).toContain("no specific keywords found");
  });

  it("is case-insensitive", () => {
    const result = inferSeverity("PRODUCTION DOWN since morning");
    expect(result.severity).toBe("critical");
  });

  it("critical takes precedence over high", () => {
    const result = inferSeverity("crash that blocks all users");
    expect(result.severity).toBe("critical");
  });
});

// ── assessCompleteness (unit tests) ───────────────────────────────────────

describe("assessCompleteness", () => {
  it("returns 0 for empty description, no labels, no components", () => {
    const { score, missing } = assessCompleteness("", [], []);
    expect(score).toBe(0);
    expect(missing).toHaveLength(5);
  });

  it("returns 100 for fully complete bug", () => {
    const desc =
      "This is a detailed description exceeding fifty characters easily. " +
      "Steps to reproduce: 1. Open app. " +
      "Expected: It works. Actual: It crashes. " +
      "Environment: Chrome 120";
    const { score, missing } = assessCompleteness(desc, ["bug"], []);
    expect(score).toBe(100);
    expect(missing).toHaveLength(0);
  });

  it("accepts 'steps to repro' as alternative to 'steps to reproduce'", () => {
    const desc = "A sufficiently long description that passes the fifty char threshold. Steps to repro: click button.";
    const { score } = assessCompleteness(desc, [], []);
    // 25 (desc) + 25 (steps) = 50
    expect(score).toBe(50);
  });

  it("accepts 'version' keyword for environment check", () => {
    const desc = "A sufficiently long description that passes the fifty char threshold." + " Version: 2.0.1";
    const { score } = assessCompleteness(desc, [], []);
    // 25 (desc) + 15 (env) = 40
    expect(score).toBe(40);
  });

  it("accepts 'browser' keyword for environment check", () => {
    const desc = "A sufficiently long description that passes the fifty char threshold." + " Browser: Firefox 120";
    const { score } = assessCompleteness(desc, [], []);
    expect(score).toBe(40);
  });

  it("gives 15 points for components even without labels", () => {
    const { score } = assessCompleteness("short", [], ["frontend"]);
    expect(score).toBe(15);
  });

  it("scores 25 for description only", () => {
    const desc = "This is a fairly long description that definitely exceeds fifty characters in total length.";
    const { score, missing } = assessCompleteness(desc, [], []);
    expect(score).toBe(25);
    expect(missing).toContain("Steps to reproduce");
    expect(missing).toContain("Expected vs actual behavior");
    expect(missing).toContain("Environment/version info");
    expect(missing).toContain("Labels or components");
  });

  it("handles undefined description", () => {
    const { score, missing } = assessCompleteness(undefined, [], []);
    expect(score).toBe(0);
    expect(missing).toContain("Detailed description (>50 chars)");
  });
});
