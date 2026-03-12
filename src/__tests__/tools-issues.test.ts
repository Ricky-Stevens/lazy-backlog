import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { PageSummary } from "../lib/db.js";
import { KnowledgeBase } from "../lib/db.js";
import { JiraClient, type JiraIssueDetail, type JiraSchema } from "../lib/jira.js";
import { registerIssuesTool } from "../tools/issues.js";
import {
  boolPreprocess,
  buildKbContextSection,
  buildSchemaGuidance,
  extractKeywords,
  formatBoardInfo,
  formatFieldsList,
  formatSampleTickets,
  formatSummaries,
  jsonPreprocess,
  STOP_WORDS,
} from "../tools/issues-helpers.js";
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

describe("registerIssuesTool", () => {
  let kb: KnowledgeBase;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "lb-issues-test-"));
    kb = new KnowledgeBase(join(tmpDir, "test.db"));
    setTestEnv();
  });

  afterEach(() => {
    kb.close();
    rmSync(tmpDir, { recursive: true, force: true });
    restoreEnv();
  });

  it("registers single issues tool", () => {
    const { server, toolNames } = createMockServer();
    registerIssuesTool(server, () => kb);
    expect(toolNames()).toContain("issues");
    expect(toolNames()).toHaveLength(1);
  });

  describe("action=get", () => {
    it("fetches and formats ticket", async () => {
      const { server, getTool } = createMockServer();
      registerIssuesTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      mockFetchResponse({
        key: "BP-1",
        id: "10001",
        fields: {
          summary: "Test ticket",
          issuetype: { name: "Task" },
          priority: { name: "Medium" },
          status: { name: "To Do" },
          labels: [],
          components: [],
          created: "2025-01-01",
          updated: "2025-06-01",
          comment: { comments: [] },
        },
      });

      const issues = getTool("issues");
      const result = await issues({ action: "get", issueKey: "BP-1" });
      expect(result.content[0]?.text).toContain("BP-1");
      expect(result.content[0]?.text).toContain("Test ticket");
    });
  });

  describe("action=create", () => {
    it("returns preview when confirmed is not set", async () => {
      const { server, getTool } = createMockServer();
      registerIssuesTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const issues = getTool("issues");
      const result = await issues({ action: "create", summary: "New feature ticket" });
      const text = result.content[0]?.text;
      expect(text).toContain("Ticket Preview");
      expect(text).toContain("New feature ticket");
      expect(text).toContain("confirmed=true");
    });

    it("creates ticket via Jira API when confirmed", async () => {
      const { server, getTool } = createMockServer();
      registerIssuesTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      mockFetchResponse({ id: "1", key: "BP-200", self: "" });

      const issues = getTool("issues");
      const result = await issues({ action: "create", summary: "New feature ticket", confirmed: true });
      expect(result.content[0]?.text).toContain("BP-200");
    });

    it("creates ticket with parent epic when confirmed", async () => {
      const { server, getTool } = createMockServer();
      registerIssuesTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const createSpy = vi.spyOn(JiraClient.prototype, "createIssue").mockResolvedValue({
        id: "1",
        key: "BP-201",
        self: "",
      });

      const issues = getTool("issues");
      const result = await issues({ action: "create", summary: "Child task", parent: "BP-100", confirmed: true });
      expect(result.content[0]?.text).toContain("BP-201");
      expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({ parentKey: "BP-100" }));

      createSpy.mockRestore();
    });

    it("returns error when summary is missing", async () => {
      const { server, getTool } = createMockServer();
      registerIssuesTool(server, () => kb);

      const issues = getTool("issues");
      const result = await issues({ action: "create" });
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("summary is required");
    });

    it("preview includes labels when provided", async () => {
      const { server, getTool } = createMockServer();
      registerIssuesTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const issues = getTool("issues");
      const result = await issues({
        action: "create",
        summary: "Labeled ticket",
        labels: ["tech-debt", "infra"],
      });
      const text = result.content[0]?.text ?? "";
      expect(text).toContain("Labels");
      expect(text).toContain("tech-debt, infra");
    });

    it("preview omits labels row when labels not provided", async () => {
      const { server, getTool } = createMockServer();
      registerIssuesTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const issues = getTool("issues");
      const result = await issues({
        action: "create",
        summary: "No labels ticket",
      });
      const text = result.content[0]?.text ?? "";
      expect(text).toContain("Ticket Preview");
      expect(text).not.toMatch(/\| Labels \|/);
    });

    it("preview includes components when provided", async () => {
      const { server, getTool } = createMockServer();
      registerIssuesTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const issues = getTool("issues");
      const result = await issues({
        action: "create",
        summary: "With components",
        components: ["backend", "api"],
      });
      const text = result.content[0]?.text ?? "";
      expect(text).toContain("Components");
      expect(text).toContain("backend, api");
    });

    it("preview omits components row when not provided", async () => {
      const { server, getTool } = createMockServer();
      registerIssuesTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const issues = getTool("issues");
      const result = await issues({
        action: "create",
        summary: "No components",
      });
      const text = result.content[0]?.text ?? "";
      expect(text).not.toMatch(/\| Components \|/);
    });

    it("preview includes story points when provided", async () => {
      const { server, getTool } = createMockServer();
      registerIssuesTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const issues = getTool("issues");
      const result = await issues({
        action: "create",
        summary: "Pointed ticket",
        storyPoints: 5,
      });
      const text = result.content[0]?.text ?? "";
      expect(text).toContain("Story Points");
      expect(text).toContain("5");
    });

    it("preview omits story points row when not provided", async () => {
      const { server, getTool } = createMockServer();
      registerIssuesTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const issues = getTool("issues");
      const result = await issues({
        action: "create",
        summary: "Unpointed ticket",
      });
      const text = result.content[0]?.text ?? "";
      expect(text).not.toMatch(/\| Story Points \|/);
    });

    it("preview includes parent when parentKey is provided", async () => {
      const { server, getTool } = createMockServer();
      registerIssuesTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const issues = getTool("issues");
      const result = await issues({
        action: "create",
        summary: "Child via parentKey",
        parentKey: "BP-50",
      });
      const text = result.content[0]?.text ?? "";
      expect(text).toContain("Parent");
      expect(text).toContain("BP-50");
    });

    it("preview includes custom fields when namedFields provided", async () => {
      const { server, getTool } = createMockServer();
      registerIssuesTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const issues = getTool("issues");
      const result = await issues({
        action: "create",
        summary: "Custom fields ticket",
        namedFields: { Team: "Platform", Environment: "Production" },
      });
      const text = result.content[0]?.text ?? "";
      expect(text).toContain("Custom Fields");
      expect(text).toContain("Team: Platform");
      expect(text).toContain("Environment: Production");
    });

    it("preview includes description section when provided", async () => {
      const { server, getTool } = createMockServer();
      registerIssuesTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const issues = getTool("issues");
      const result = await issues({
        action: "create",
        summary: "Described ticket",
        description: "## Context\nThis is the description.",
      });
      const text = result.content[0]?.text ?? "";
      expect(text).toContain("## Description");
      expect(text).toContain("This is the description.");
    });

    it("preview omits description section when not provided", async () => {
      const { server, getTool } = createMockServer();
      registerIssuesTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const issues = getTool("issues");
      const result = await issues({
        action: "create",
        summary: "No description",
      });
      const text = result.content[0]?.text ?? "";
      expect(text).not.toMatch(/^## Description$/m);
    });

    it("preview uses default issue type and priority", async () => {
      const { server, getTool } = createMockServer();
      registerIssuesTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const issues = getTool("issues");
      const result = await issues({
        action: "create",
        summary: "Default fields",
      });
      const text = result.content[0]?.text ?? "";
      expect(text).toContain("| **Type** | Task |");
      expect(text).toContain("Medium (default)");
    });

    it("preview uses custom issue type and priority when provided", async () => {
      const { server, getTool } = createMockServer();
      registerIssuesTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const issues = getTool("issues");
      const result = await issues({
        action: "create",
        summary: "Bug ticket",
        issueType: "Bug",
        priority: "High",
      });
      const text = result.content[0]?.text ?? "";
      expect(text).toContain("| **Type** | Bug |");
      expect(text).toContain("| **Priority** | High |");
    });

    it("preview lists available epics when no parent specified", async () => {
      const { server, getTool } = createMockServer();
      registerIssuesTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const searchSpy = vi.spyOn(JiraClient.prototype, "searchIssues").mockResolvedValue({
        issues: [
          {
            key: "BP-10",
            id: "10",
            fields: {
              summary: "Epic A",
              status: { name: "In Progress" },
            },
          },
        ],
        total: 1,
      });

      const issues = getTool("issues");
      const result = await issues({
        action: "create",
        summary: "Orphan ticket",
      });
      const text = result.content[0]?.text ?? "";
      expect(text).toContain("Available Epics");
      expect(text).toContain("BP-10");
      expect(text).toContain("Epic A");
      expect(text).toContain("In Progress");

      searchSpy.mockRestore();
    });

    it("preview skips epic listing when parent is specified", async () => {
      const { server, getTool } = createMockServer();
      registerIssuesTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const searchSpy = vi.spyOn(JiraClient.prototype, "searchIssues");

      const issues = getTool("issues");
      const result = await issues({
        action: "create",
        summary: "Child ticket",
        parent: "BP-10",
      });
      const text = result.content[0]?.text ?? "";
      expect(text).not.toContain("Available Epics");
      // searchIssues may be called for duplicate detection, but not for epic listing
      const epicCalls = searchSpy.mock.calls.filter((c) => String(c[0]).includes("type = Epic"));
      expect(epicCalls).toHaveLength(0);

      searchSpy.mockRestore();
    });

    it("preview handles epic listing failure gracefully", async () => {
      const { server, getTool } = createMockServer();
      registerIssuesTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const searchSpy = vi.spyOn(JiraClient.prototype, "searchIssues").mockRejectedValue(new Error("Jira unavailable"));

      const issues = getTool("issues");
      const result = await issues({
        action: "create",
        summary: "Ticket with failed epic listing",
      });
      // Should not error — epic listing is best-effort
      expect(result.isError).toBeUndefined();
      const text = result.content[0]?.text ?? "";
      expect(text).toContain("Ticket Preview");
      expect(text).not.toContain("Available Epics");

      searchSpy.mockRestore();
    });

    it("preview shows epic status dash when status is missing", async () => {
      const { server, getTool } = createMockServer();
      registerIssuesTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const searchSpy = vi.spyOn(JiraClient.prototype, "searchIssues").mockResolvedValue({
        issues: [
          {
            key: "BP-10",
            id: "10",
            fields: {
              summary: "Epic no status",
            },
          },
        ],
        total: 1,
      });

      const issues = getTool("issues");
      const result = await issues({
        action: "create",
        summary: "Ticket with statusless epic",
      });
      const text = result.content[0]?.text ?? "";
      expect(text).toContain("| BP-10 | Epic no status | - |");

      searchSpy.mockRestore();
    });

    it("confirmed create passes all optional fields to createIssue", async () => {
      const { server, getTool } = createMockServer();
      registerIssuesTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const createSpy = vi.spyOn(JiraClient.prototype, "createIssue").mockResolvedValue({
        id: "1",
        key: "BP-300",
        self: "",
      });

      const issues = getTool("issues");
      await issues({
        action: "create",
        summary: "Full ticket",
        description: "Detailed desc",
        issueType: "Bug",
        priority: "High",
        labels: ["tech-debt"],
        storyPoints: 8,
        parentKey: "BP-10",
        components: ["backend"],
        namedFields: { Team: "Platform" },
        confirmed: true,
      });

      expect(createSpy).toHaveBeenCalledWith({
        summary: "Full ticket",
        description: "Detailed desc",
        issueType: "Bug",
        priority: "High",
        labels: ["tech-debt"],
        storyPoints: 8,
        parentKey: "BP-10",
        components: ["backend"],
        namedFields: { Team: "Platform" },
      });

      createSpy.mockRestore();
    });

    it("confirmed create defaults issueType to Task", async () => {
      const { server, getTool } = createMockServer();
      registerIssuesTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const createSpy = vi.spyOn(JiraClient.prototype, "createIssue").mockResolvedValue({
        id: "1",
        key: "BP-301",
        self: "",
      });

      const issues = getTool("issues");
      await issues({
        action: "create",
        summary: "Default type ticket",
        confirmed: true,
      });

      expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({ issueType: "Task" }));

      createSpy.mockRestore();
    });

    it("confirmed create prefers parent over parentKey", async () => {
      const { server, getTool } = createMockServer();
      registerIssuesTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const createSpy = vi.spyOn(JiraClient.prototype, "createIssue").mockResolvedValue({
        id: "1",
        key: "BP-302",
        self: "",
      });

      const issues = getTool("issues");
      await issues({
        action: "create",
        summary: "Parent precedence",
        parent: "BP-10",
        parentKey: "BP-20",
        confirmed: true,
      });

      expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({ parentKey: "BP-10" }));

      createSpy.mockRestore();
    });

    it("confirmed create returns error on API failure", async () => {
      const { server, getTool } = createMockServer();
      registerIssuesTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const createSpy = vi.spyOn(JiraClient.prototype, "createIssue").mockRejectedValue(new Error("Permission denied"));

      const issues = getTool("issues");
      const result = await issues({
        action: "create",
        summary: "Failing ticket",
        confirmed: true,
      });
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("Failed to create issue");
      expect(result.content[0]?.text).toContain("Permission denied");

      createSpy.mockRestore();
    });

    it("confirmed create returns error for non-Error throws", async () => {
      const { server, getTool } = createMockServer();
      registerIssuesTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const createSpy = vi.spyOn(JiraClient.prototype, "createIssue").mockRejectedValue("string error");

      const issues = getTool("issues");
      const result = await issues({
        action: "create",
        summary: "Failing ticket string",
        confirmed: true,
      });
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("string error");

      createSpy.mockRestore();
    });
  });

  describe("action=bulk-create", () => {
    it("returns preview when confirmed is not set", async () => {
      const { server, getTool } = createMockServer();
      registerIssuesTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const issues = getTool("issues");
      const result = await issues({
        action: "bulk-create",
        tickets: [
          {
            summary: "Ticket one",
            issueType: "Task",
            description: "Test",
            labels: [],
            priority: "Medium",
            components: [],
          },
        ],
      });
      const text = result.content[0]?.text;
      expect(text).toContain("Bulk Preview");
      expect(text).toContain("confirmed=true");
    });

    it("creates tickets when confirmed", async () => {
      const { server, getTool } = createMockServer();
      registerIssuesTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      mockFetchResponse({ id: "1", key: "BP-300", self: "" });

      const issues = getTool("issues");
      const result = await issues({
        action: "bulk-create",
        confirmed: true,
        tickets: [{ summary: "Bulk ticket", description: "## Context\nTest" }],
      });
      expect(result.content[0]?.text).toContain("BP-300");
    });

    it("returns error when tickets array is missing", async () => {
      const { server, getTool } = createMockServer();
      registerIssuesTool(server, () => kb);

      const issues = getTool("issues");
      const result = await issues({ action: "bulk-create" });
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("tickets array is required");
    });

    it("returns error when tickets array is empty", async () => {
      const { server, getTool } = createMockServer();
      registerIssuesTool(server, () => kb);

      const issues = getTool("issues");
      const result = await issues({ action: "bulk-create", tickets: [] });
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("tickets array is required");
    });

    it("creates multiple tickets and reports results", async () => {
      const { server, getTool } = createMockServer();
      registerIssuesTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const batchSpy = vi.spyOn(JiraClient.prototype, "createIssuesBatch").mockResolvedValue({
        issues: [
          { id: "1", key: "BP-301", self: "" },
          { id: "2", key: "BP-302", self: "" },
        ],
        errors: [],
      });

      const issues = getTool("issues");
      const result = await issues({
        action: "bulk-create",
        confirmed: true,
        tickets: [
          {
            summary: "Ticket A",
            issueType: "Task",
            labels: [],
            priority: "Medium",
            components: [],
          },
          {
            summary: "Ticket B",
            issueType: "Bug",
            labels: ["infra"],
            priority: "High",
            components: ["backend"],
          },
        ],
      });
      expect(result.isError).toBeUndefined();
      const text = result.content[0]?.text ?? "";
      expect(text).toContain("Created 2/2 tickets");
      expect(text).toContain("BP-301");
      expect(text).toContain("BP-302");

      batchSpy.mockRestore();
    });

    it("reports partial failures from bulk create", async () => {
      const { server, getTool } = createMockServer();
      registerIssuesTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const batchSpy = vi.spyOn(JiraClient.prototype, "createIssuesBatch").mockResolvedValue({
        issues: [{ id: "1", key: "BP-400", self: "" }],
        errors: ["Failed to create ticket 2: Invalid issue type"],
      });

      const issues = getTool("issues");
      const result = await issues({
        action: "bulk-create",
        confirmed: true,
        tickets: [
          {
            summary: "Good ticket",
            issueType: "Task",
            labels: [],
            priority: "Medium",
            components: [],
          },
          {
            summary: "Bad ticket",
            issueType: "InvalidType",
            labels: [],
            priority: "Medium",
            components: [],
          },
        ],
      });
      expect(result.isError).toBe(true);
      const text = result.content[0]?.text ?? "";
      expect(text).toContain("Created 1/2 tickets");
      expect(text).toContain("BP-400");
      expect(text).toContain("Errors (1)");
      expect(text).toContain("Invalid issue type");

      batchSpy.mockRestore();
    });

    it("confirmed bulk-create returns error when project key is missing", async () => {
      const { server, getTool } = createMockServer();
      registerIssuesTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      // Remove the project key from env
      delete process.env.JIRA_PROJECT_KEY;
      // Also remove from db config (resolveConfig checks db too)
      // resolveConfig should still succeed but return empty projectKey

      const issues = getTool("issues");
      const result = await issues({
        action: "bulk-create",
        confirmed: true,
        tickets: [
          {
            summary: "No project",
            issueType: "Task",
            labels: [],
            priority: "Medium",
            components: [],
          },
        ],
      });
      expect(result.isError).toBe(true);
      const text = result.content[0]?.text ?? "";
      expect(text).toContain("project key");
    });

    it("preview shows ticket metadata including storyPoints and parentKey", async () => {
      const { server, getTool } = createMockServer();
      registerIssuesTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const issues = getTool("issues");
      const result = await issues({
        action: "bulk-create",
        tickets: [
          {
            summary: "Full ticket",
            description: "Full desc",
            issueType: "Story",
            labels: ["auth"],
            storyPoints: 5,
            priority: "High",
            parentKey: "BP-10",
            components: ["frontend"],
          },
        ],
      });
      const text = result.content[0]?.text ?? "";
      expect(text).toContain("| **Story Points** | 5 |");
      expect(text).toContain("| **Parent** | BP-10 |");
      expect(text).toContain("| **Components** | frontend |");
      expect(text).toContain("| **Labels** | auth |");
      expect(text).toContain("| **Type** | Story |");
      expect(text).toContain("| **Priority** | High |");
    });

    it("preview shows (no description) when ticket lacks description", async () => {
      const { server, getTool } = createMockServer();
      registerIssuesTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const issues = getTool("issues");
      const result = await issues({
        action: "bulk-create",
        tickets: [
          {
            summary: "No desc ticket",
            issueType: "Task",
            labels: [],
            priority: "Medium",
            components: [],
          },
        ],
      });
      const text = result.content[0]?.text ?? "";
      expect(text).not.toContain("**Description:**");
    });

    it("preview uses singular 'ticket' for single ticket", async () => {
      const { server, getTool } = createMockServer();
      registerIssuesTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const issues = getTool("issues");
      const result = await issues({
        action: "bulk-create",
        tickets: [
          {
            summary: "Only one",
            issueType: "Task",
            labels: [],
            priority: "Medium",
            components: [],
          },
        ],
      });
      const text = result.content[0]?.text ?? "";
      expect(text).toContain("1 ticket)");
      expect(text).not.toContain("1 tickets");
    });

    it("preview uses plural 'tickets' for multiple tickets", async () => {
      const { server, getTool } = createMockServer();
      registerIssuesTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const issues = getTool("issues");
      const result = await issues({
        action: "bulk-create",
        tickets: [
          {
            summary: "First",
            issueType: "Task",
            labels: [],
            priority: "Medium",
            components: [],
          },
          {
            summary: "Second",
            issueType: "Task",
            labels: [],
            priority: "Medium",
            components: [],
          },
        ],
      });
      const text = result.content[0]?.text ?? "";
      expect(text).toContain("2 tickets");
    });

    it("confirmed creates single ticket with singular output", async () => {
      const { server, getTool } = createMockServer();
      registerIssuesTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const batchSpy = vi.spyOn(JiraClient.prototype, "createIssuesBatch").mockResolvedValue({
        issues: [{ id: "1", key: "BP-500", self: "" }],
        errors: [],
      });

      const issues = getTool("issues");
      const result = await issues({
        action: "bulk-create",
        confirmed: true,
        tickets: [
          {
            summary: "Solo",
            issueType: "Task",
            labels: [],
            priority: "Medium",
            components: [],
          },
        ],
      });
      const text = result.content[0]?.text ?? "";
      expect(text).toContain("Created 1/1 ticket\n");
      expect(text).not.toContain("1 tickets");

      batchSpy.mockRestore();
    });

    it("passes namedFields through to batch create", async () => {
      const { server, getTool } = createMockServer();
      registerIssuesTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const batchSpy = vi.spyOn(JiraClient.prototype, "createIssuesBatch").mockResolvedValue({
        issues: [{ id: "1", key: "BP-501", self: "" }],
        errors: [],
      });

      const issues = getTool("issues");
      await issues({
        action: "bulk-create",
        confirmed: true,
        tickets: [
          {
            summary: "Custom fields ticket",
            issueType: "Task",
            labels: [],
            priority: "Medium",
            components: [],
            namedFields: { Team: "Platform" },
          },
        ],
      });

      expect(batchSpy).toHaveBeenCalledWith([
        expect.objectContaining({
          namedFields: { Team: "Platform" },
        }),
      ]);

      batchSpy.mockRestore();
    });

    it("preview shows project key as (not set) when missing", async () => {
      const { server, getTool } = createMockServer();
      registerIssuesTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      delete process.env.JIRA_PROJECT_KEY;

      const issues = getTool("issues");
      const result = await issues({
        action: "bulk-create",
        tickets: [
          {
            summary: "No project key",
            issueType: "Task",
            labels: [],
            priority: "Medium",
            components: [],
          },
        ],
      });
      const text = result.content[0]?.text ?? "";
      // Preview still renders without a project key
      expect(text).toContain("Bulk Preview");
      expect(text).toContain("No project key");
    });
  });

  describe("action=update", () => {
    it("updates ticket", async () => {
      const { server, getTool } = createMockServer();
      registerIssuesTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      // GET issue type
      mockFetchResponse({ fields: { issuetype: { name: "Task" } } });
      // PUT update
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

      const issues = getTool("issues");
      const result = await issues({ action: "update", issueKey: "BP-1", summary: "Updated title" });
      expect(result.content[0]?.text).toContain("BP-1");
      expect(result.content[0]?.text).toContain("Updated title");
    });

    it("updates ticket with parent", async () => {
      const { server, getTool } = createMockServer();
      registerIssuesTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const updateSpy = vi.spyOn(JiraClient.prototype, "updateIssue").mockResolvedValue(undefined);

      const issues = getTool("issues");
      const result = await issues({ action: "update", issueKey: "BP-1", parent: "BP-50" });
      expect(result.isError).toBeUndefined();
      expect(getText(result)).toContain("Parent: BP-50");
      expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({ issueKey: "BP-1", parentKey: "BP-50" }));

      updateSpy.mockRestore();
    });

    it("updates ticket with rankBefore", async () => {
      const { server, getTool } = createMockServer();
      registerIssuesTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const rankSpy = vi.fn().mockResolvedValue(undefined);
      (vi.spyOn as (...args: unknown[]) => ReturnType<typeof vi.spyOn>)(
        JiraClient.prototype,
        "rankIssue",
      ).mockImplementation(rankSpy);

      const issues = getTool("issues");
      const result = await issues({ action: "update", issueKey: "BP-1", rankBefore: "BP-2" });
      expect(result.isError).toBeUndefined();
      expect(getText(result)).toContain("Ranked: before BP-2");
      expect(rankSpy).toHaveBeenCalledWith("BP-1", { rankBefore: "BP-2" });

      vi.restoreAllMocks();
    });

    it("updates ticket with status transition", async () => {
      const { server, getTool } = createMockServer();
      registerIssuesTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const getTransitionsSpy = vi.spyOn(JiraClient.prototype, "getTransitions").mockResolvedValue([
        { id: "21", name: "In Progress", to: { name: "In Progress" } },
        { id: "31", name: "Done", to: { name: "Done" } },
      ]);
      const transitionSpy = vi.spyOn(JiraClient.prototype, "transitionIssue").mockResolvedValue(undefined);

      const issues = getTool("issues");
      const result = await issues({ action: "update", issueKey: "BP-1", status: "In Progress" });
      expect(result.isError).toBeUndefined();
      expect(getText(result)).toContain('transitioned via "In Progress"');
      expect(getTransitionsSpy).toHaveBeenCalledWith("BP-1");
      expect(transitionSpy).toHaveBeenCalledWith("BP-1", "21");

      getTransitionsSpy.mockRestore();
      transitionSpy.mockRestore();
    });

    it("returns error when status transition not found", async () => {
      const { server, getTool } = createMockServer();
      registerIssuesTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const getTransitionsSpy = vi
        .spyOn(JiraClient.prototype, "getTransitions")
        .mockResolvedValue([{ id: "21", name: "In Progress", to: { name: "In Progress" } }]);

      const issues = getTool("issues");
      const result = await issues({ action: "update", issueKey: "BP-1", status: "Nonexistent" });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('No transition matching "Nonexistent"');
      expect(getText(result)).toContain("Available: In Progress");

      getTransitionsSpy.mockRestore();
    });

    it("updates ticket with assignee", async () => {
      const { server, getTool } = createMockServer();
      registerIssuesTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const assignSpy = vi.spyOn(JiraClient.prototype, "assignIssue").mockResolvedValue(undefined);

      const issues = getTool("issues");
      const result = await issues({ action: "update", issueKey: "BP-1", assignee: "abc123" });
      expect(result.isError).toBeUndefined();
      expect(getText(result)).toContain("Assignee: abc123");
      expect(assignSpy).toHaveBeenCalledWith("BP-1", "abc123");

      assignSpy.mockRestore();
    });

    it("clears assignee with 'unassigned'", async () => {
      const { server, getTool } = createMockServer();
      registerIssuesTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const assignSpy = vi.spyOn(JiraClient.prototype, "assignIssue").mockResolvedValue(undefined);

      const issues = getTool("issues");
      const result = await issues({ action: "update", issueKey: "BP-1", assignee: "unassigned" });
      expect(result.isError).toBeUndefined();
      expect(getText(result)).toContain("Assignee: cleared");
      expect(assignSpy).toHaveBeenCalledWith("BP-1", null);

      assignSpy.mockRestore();
    });

    it("updates ticket with links", async () => {
      const { server, getTool } = createMockServer();
      registerIssuesTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const linkSpy = vi.spyOn(JiraClient.prototype, "linkIssues").mockResolvedValue(undefined);

      const issues = getTool("issues");
      const result = await issues({
        action: "update",
        issueKey: "BP-1",
        links: [
          { targetKey: "BP-2", linkType: "Blocks", direction: "outward" as const },
          { targetKey: "BP-3", linkType: "Relates", direction: "inward" as const },
        ],
      });
      expect(result.isError).toBeUndefined();
      expect(getText(result)).toContain("2 link(s) created");
      expect(linkSpy).toHaveBeenCalledTimes(2);
      // outward: inward=target, outward=issueKey
      expect(linkSpy).toHaveBeenCalledWith("BP-2", "BP-1", "Blocks");
      // inward: inward=issueKey, outward=target
      expect(linkSpy).toHaveBeenCalledWith("BP-1", "BP-3", "Relates");

      linkSpy.mockRestore();
    });

    it("updates ticket with status, assignee, and links combined", async () => {
      const { server, getTool } = createMockServer();
      registerIssuesTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      // GET issue type for field update
      mockFetchResponse({ fields: { issuetype: { name: "Task" } } });
      // PUT update
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

      const getTransitionsSpy = vi
        .spyOn(JiraClient.prototype, "getTransitions")
        .mockResolvedValue([{ id: "21", name: "In Progress", to: { name: "In Progress" } }]);
      const transitionSpy = vi.spyOn(JiraClient.prototype, "transitionIssue").mockResolvedValue(undefined);
      const assignSpy = vi.spyOn(JiraClient.prototype, "assignIssue").mockResolvedValue(undefined);
      const linkSpy = vi.spyOn(JiraClient.prototype, "linkIssues").mockResolvedValue(undefined);

      const issues = getTool("issues");
      const result = await issues({
        action: "update",
        issueKey: "BP-1",
        summary: "Updated",
        status: "In Progress",
        assignee: "user123",
        links: [{ targetKey: "BP-5", linkType: "Blocks", direction: "outward" as const }],
      });
      expect(result.isError).toBeUndefined();
      const text = getText(result);
      expect(text).toContain("Summary: Updated");
      expect(text).toContain('transitioned via "In Progress"');
      expect(text).toContain("Assignee: user123");
      expect(text).toContain("1 link(s) created");

      expect(transitionSpy).toHaveBeenCalledWith("BP-1", "21");
      expect(assignSpy).toHaveBeenCalledWith("BP-1", "user123");
      // outward: inward=target, outward=issueKey
      expect(linkSpy).toHaveBeenCalledWith("BP-5", "BP-1", "Blocks");

      getTransitionsSpy.mockRestore();
      transitionSpy.mockRestore();
      assignSpy.mockRestore();
      linkSpy.mockRestore();
    });
  });

  describe("action=search", () => {
    it("returns formatted JQL results", async () => {
      const { server, getTool } = createMockServer();
      registerIssuesTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      mockFetchResponse({
        issues: [
          {
            key: "BP-10",
            fields: {
              summary: "Search result ticket",
              status: { name: "In Progress" },
              priority: { name: "High" },
              assignee: { displayName: "Alice" },
            },
          },
        ],
        total: 1,
      });

      const issues = getTool("issues");
      const result = await issues({ action: "search", jql: "project = BP" });
      expect(result.content[0]?.text).toContain("BP-10");
      expect(result.content[0]?.text).toContain("Search result ticket");
      expect(result.content[0]?.text).toContain("In Progress");
      expect(result.content[0]?.text).toContain("Alice");
    });

    it("handles empty results", async () => {
      const { server, getTool } = createMockServer();
      registerIssuesTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      mockFetchResponse({ issues: [], total: 0 });

      const issues = getTool("issues");
      const result = await issues({ action: "search", jql: "project = EMPTY" });
      expect(result.content[0]?.text).toContain("No issues found");
    });

    it("returns error when jql is missing", async () => {
      const { server, getTool } = createMockServer();
      registerIssuesTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const issues = getTool("issues");
      const result = await issues({ action: "search" });
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("jql is required");
    });

    it("auto-scopes JQL to configured project when no project clause", async () => {
      const { server, getTool } = createMockServer();
      registerIssuesTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const searchSpy = vi.spyOn(JiraClient.prototype, "searchBoardIssues").mockResolvedValue({
        issues: [
          {
            key: "BP-20",
            id: "20",
            fields: {
              summary: "Scoped ticket",
              status: { name: "Open" },
              priority: { name: "Low" },
              assignee: undefined,
            },
          },
        ],
        total: 1,
      });

      const issues = getTool("issues");
      const result = await issues({ action: "search", jql: "status = Open" });
      expect(result.content[0]?.text).toContain("BP-20");
      // Verify project was prepended to JQL
      expect(searchSpy).toHaveBeenCalledWith(
        "266",
        expect.stringContaining("project = BP AND (status = Open)"),
        undefined,
      );

      searchSpy.mockRestore();
    });

    it("uses searchIssues instead of board search for epic queries", async () => {
      const { server, getTool } = createMockServer();
      registerIssuesTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const searchIssuesSpy = vi.spyOn(JiraClient.prototype, "searchIssues").mockResolvedValue({
        issues: [
          {
            key: "BP-50",
            id: "50",
            fields: {
              summary: "Epic ticket",
              status: { name: "To Do" },
              priority: { name: "High" },
              assignee: { displayName: "Bob" },
            },
          },
        ],
        total: 1,
      });

      const issues = getTool("issues");
      const result = await issues({ action: "search", jql: "type = Epic" });
      expect(result.content[0]?.text).toContain("BP-50");
      expect(result.content[0]?.text).toContain("Epic ticket");
      // Should have used searchIssues (not searchBoardIssues) for epic queries
      expect(searchIssuesSpy).toHaveBeenCalled();

      searchIssuesSpy.mockRestore();
    });
  });

  // ── Triage actions (find-bugs, assess, triage) ─────────────────────────────

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
    };
  }

  describe("action=get — error and bulk paths", () => {
    it("returns error when issueKey is missing", async () => {
      const { server, getTool } = createMockServer();
      registerIssuesTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const issues = getTool("issues");
      const result = await issues({ action: "get" });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("issueKey or issueKeys is required");
    });

    it("returns error when fetch fails", async () => {
      const { server, getTool } = createMockServer();
      registerIssuesTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const getIssueSpy = vi.spyOn(JiraClient.prototype, "getIssue").mockRejectedValue(new Error("Network timeout"));

      const issues = getTool("issues");
      const result = await issues({ action: "get", issueKey: "BP-999" });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("Failed to fetch issues");
      expect(getText(result)).toContain("Network timeout");

      getIssueSpy.mockRestore();
    });

    it("bulk-fetches multiple issues with issueKeys", async () => {
      const { server, getTool } = createMockServer();
      registerIssuesTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const getIssueSpy = vi
        .spyOn(JiraClient.prototype, "getIssue")
        .mockResolvedValueOnce(makeIssueDetail("BP-1", { summary: "First issue" }))
        .mockResolvedValueOnce(makeIssueDetail("BP-2", { summary: "Second issue" }));
      const getDevStatusSpy = vi
        .spyOn(JiraClient.prototype, "getDevStatus")
        .mockResolvedValue({ pullRequests: 0, commits: 0, builds: 0, reviews: 0 });

      const issues = getTool("issues");
      const result = await issues({ action: "get", issueKeys: ["BP-1", "BP-2"] });
      expect(result.isError).toBeUndefined();
      const text = getText(result);
      expect(text).toContain("Bulk Fetch (2 issues)");
      expect(text).toContain("BP-1");
      expect(text).toContain("First issue");
      expect(text).toContain("BP-2");
      expect(text).toContain("Second issue");
      expect(text).toContain("No Dev Activity (2)");

      getIssueSpy.mockRestore();
      getDevStatusSpy.mockRestore();
    });
  });

  describe("action=get with links", () => {
    it("shows issue links in output", async () => {
      const { server, getTool } = createMockServer();
      registerIssuesTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const getIssueSpy = vi
        .spyOn(JiraClient.prototype, "getIssue")
        .mockResolvedValue(makeIssueDetail("BP-1", { summary: "Test ticket" }));
      const getLinksSpy = vi.fn().mockResolvedValue([
        {
          direction: "outward",
          linkType: "blocks",
          issueKey: "BP-456",
          status: "In Progress",
          summary: "Some summary",
        },
        {
          direction: "inward",
          linkType: "is blocked by",
          issueKey: "BP-123",
          status: "Done",
          summary: "Other summary",
        },
      ]);
      (vi.spyOn as (...args: unknown[]) => ReturnType<typeof vi.spyOn>)(
        JiraClient.prototype,
        "getIssueLinks",
      ).mockImplementation(getLinksSpy);

      const issues = getTool("issues");
      const result = await issues({ action: "get", issueKey: "BP-1" });
      expect(result.isError).toBeUndefined();
      const text = getText(result);
      expect(text).toContain("**Links:**");
      expect(text).toContain("blocks \u2192 BP-456 (In Progress): Some summary");
      expect(text).toContain("is blocked by \u2190 BP-123 (Done): Other summary");

      getIssueSpy.mockRestore();
      vi.restoreAllMocks();
    });
  });

  // ── handleGetAction — additional branch coverage ───────────────────────────

  describe("action=get (dev-status + comment branches)", () => {
    it("renders dev status with PRs, commits, and builds", async () => {
      const { server, getTool } = createMockServer();
      registerIssuesTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const getIssueSpy = vi.spyOn(JiraClient.prototype, "getIssue").mockResolvedValue({
        ...makeIssueDetail("BP-30", { summary: "Active ticket", description: "Has description" }),
        assignee: "Alice",
        reporter: "Bob",
        parentKey: "BP-1",
        labels: ["frontend", "urgent"],
        components: ["UI", "API"],
        storyPoints: 8,
      });
      const devStatusSpy = vi
        .spyOn(JiraClient.prototype, "getDevStatus")
        .mockResolvedValue({ pullRequests: 3, commits: 12, builds: 2, reviews: 0 });
      const linksSpy = (vi.spyOn as (...args: unknown[]) => ReturnType<typeof vi.spyOn>)(
        JiraClient.prototype,
        "getIssueLinks",
      ).mockImplementation(vi.fn().mockResolvedValue([]));

      const issues = getTool("issues");
      const result = await issues({ action: "get", issueKey: "BP-30" });
      const text = getText(result);
      expect(text).toContain("3 PR(s)");
      expect(text).toContain("12 commit(s)");
      expect(text).toContain("2 build(s)");
      expect(text).toContain("**Story Points:** 8");
      expect(text).toContain("**Assignee:** Alice");
      expect(text).toContain("**Reporter:** Bob");
      expect(text).toContain("**Parent:** BP-1");
      expect(text).toContain("**Labels:** frontend, urgent");
      expect(text).toContain("**Components:** UI, API");
      expect(text).toContain("## Description");

      getIssueSpy.mockRestore();
      devStatusSpy.mockRestore();
      linksSpy.mockRestore();
    });

    it("renders No PRs / No commits when dev status is zero and hides builds", async () => {
      const { server, getTool } = createMockServer();
      registerIssuesTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const getIssueSpy = vi.spyOn(JiraClient.prototype, "getIssue").mockResolvedValue(makeIssueDetail("BP-31"));
      const devStatusSpy = vi
        .spyOn(JiraClient.prototype, "getDevStatus")
        .mockResolvedValue({ pullRequests: 0, commits: 0, builds: 0, reviews: 0 });
      const linksSpy = (vi.spyOn as (...args: unknown[]) => ReturnType<typeof vi.spyOn>)(
        JiraClient.prototype,
        "getIssueLinks",
      ).mockImplementation(vi.fn().mockResolvedValue([]));

      const issues = getTool("issues");
      const result = await issues({ action: "get", issueKey: "BP-31" });
      const text = getText(result);
      expect(text).toContain("No PRs");
      expect(text).toContain("No commits");
      // builds=0 should be filtered out (null from filter)
      expect(text).not.toContain("build(s)");

      getIssueSpy.mockRestore();
      devStatusSpy.mockRestore();
      linksSpy.mockRestore();
    });

    it("renders comments section when comments exist", async () => {
      const { server, getTool } = createMockServer();
      registerIssuesTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const detail: JiraIssueDetail = {
        ...makeIssueDetail("BP-32"),
        comments: [
          { author: "Carol", created: "2025-06-10", body: "Looks good to me" },
          { author: "Dave", created: "2025-06-11", body: "Approved" },
        ],
      };
      const getIssueSpy = vi.spyOn(JiraClient.prototype, "getIssue").mockResolvedValue(detail);
      const devStatusSpy = vi
        .spyOn(JiraClient.prototype, "getDevStatus")
        .mockResolvedValue({ pullRequests: 0, commits: 0, builds: 0, reviews: 0 });
      const linksSpy = (vi.spyOn as (...args: unknown[]) => ReturnType<typeof vi.spyOn>)(
        JiraClient.prototype,
        "getIssueLinks",
      ).mockImplementation(vi.fn().mockResolvedValue([]));

      const issues = getTool("issues");
      const result = await issues({ action: "get", issueKey: "BP-32" });
      const text = getText(result);
      expect(text).toContain("## Recent Comments (2)");
      expect(text).toContain("**Carol** (2025-06-10)");
      expect(text).toContain("Looks good to me");
      expect(text).toContain("**Dave** (2025-06-11)");
      expect(text).toContain("Approved");

      getIssueSpy.mockRestore();
      devStatusSpy.mockRestore();
      linksSpy.mockRestore();
    });
  });

  describe("action=get — bulk with error and condensed details", () => {
    it("handles mixed success/failure in bulk fetch with comment truncation", async () => {
      const { server, getTool } = createMockServer();
      registerIssuesTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const longComment = "A".repeat(250);
      const getIssueSpy = vi
        .spyOn(JiraClient.prototype, "getIssue")
        .mockResolvedValueOnce({
          ...makeIssueDetail("BP-40", { summary: "Good ticket", description: "Ticket desc" }),
          comments: [{ author: "Eve", created: "2025-07-01", body: longComment }],
        })
        .mockRejectedValueOnce(new Error("Issue not found"));
      const devStatusSpy = vi
        .spyOn(JiraClient.prototype, "getDevStatus")
        .mockResolvedValue({ pullRequests: 1, commits: 3, builds: 0, reviews: 0 });

      const issues = getTool("issues");
      const result = await issues({ action: "get", issueKeys: ["BP-40", "BP-404"] });
      const text = getText(result);
      expect(text).toContain("Bulk Fetch (2 issues)");
      expect(text).toContain("BP-40");
      expect(text).toContain("Good ticket");
      expect(text).toContain("ERROR");
      // Dev activity present — should NOT be in "No Dev Activity" section
      expect(text).not.toContain("No Dev Activity");
      // Condensed details
      expect(text).toContain("Ticket desc");
      // Comment truncation at 200 chars
      expect(text).toContain("Eve");
      expect(text).toContain("...");

      getIssueSpy.mockRestore();
      devStatusSpy.mockRestore();
    });
  });

  // ── handleSearchAction — additional branch coverage ───────────────────────

  describe("action=search (field fallback branches)", () => {
    it("shows Unknown status and None priority when fields are null", async () => {
      const { server, getTool } = createMockServer();
      registerIssuesTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const searchSpy = vi.spyOn(JiraClient.prototype, "searchBoardIssues").mockResolvedValue({
        issues: [
          {
            key: "BP-60",
            id: "60",
            fields: {
              summary: "Bare ticket",
              status: undefined as unknown as { name: string },
              priority: undefined as unknown as { name: string },
              assignee: undefined,
            },
          },
        ],
        total: 1,
      });

      const issues = getTool("issues");
      const result = await issues({ action: "search", jql: "key = BP-60" });
      const text = getText(result);
      expect(text).toContain("Unknown");
      expect(text).toContain("None");
      expect(text).toContain("Unassigned");

      searchSpy.mockRestore();
    });

    it("uses searchIssues for queries with history operators", async () => {
      const { server, getTool } = createMockServer();
      registerIssuesTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const searchSpy = vi.spyOn(JiraClient.prototype, "searchIssues").mockResolvedValue({
        issues: [
          {
            key: "BP-70",
            id: "70",
            fields: {
              summary: "Was open",
              status: { name: "Done" },
              priority: { name: "Medium" },
              assignee: { displayName: "Frank" },
            },
          },
        ],
        total: 1,
      });

      const issues = getTool("issues");
      const result = await issues({ action: "search", jql: "status was Open" });
      const text = getText(result);
      expect(text).toContain("BP-70");
      expect(searchSpy).toHaveBeenCalled();

      searchSpy.mockRestore();
    });

    it("uses searchIssues for closedSprints operator", async () => {
      const { server, getTool } = createMockServer();
      registerIssuesTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const searchSpy = vi.spyOn(JiraClient.prototype, "searchIssues").mockResolvedValue({
        issues: [],
        total: 0,
      });

      const issues = getTool("issues");
      await issues({ action: "search", jql: "sprint in closedSprints()" });
      expect(searchSpy).toHaveBeenCalled();

      searchSpy.mockRestore();
    });

    it("preserves ORDER BY when auto-scoping JQL without order clause", async () => {
      const { server, getTool } = createMockServer();
      registerIssuesTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const searchSpy = vi.spyOn(JiraClient.prototype, "searchBoardIssues").mockResolvedValue({
        issues: [],
        total: 0,
      });

      const issues = getTool("issues");
      await issues({ action: "search", jql: "status = Open" });
      // Should wrap with project = BP AND (...) without ORDER BY
      expect(searchSpy).toHaveBeenCalledWith("266", "project = BP AND (status = Open)", undefined);

      searchSpy.mockRestore();
    });

    it("returns error when search API throws", async () => {
      const { server, getTool } = createMockServer();
      registerIssuesTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const searchSpy = vi
        .spyOn(JiraClient.prototype, "searchBoardIssues")
        .mockRejectedValue(new Error("Bad JQL syntax"));

      const issues = getTool("issues");
      const result = await issues({ action: "search", jql: "invalid %%%" });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("Search failed");
      expect(getText(result)).toContain("Bad JQL syntax");

      searchSpy.mockRestore();
    });
  });

  // ── action=update — error catch branch (line 230) ──────────────────────────

  describe("action=update (error branch)", () => {
    it("returns error when update throws", async () => {
      const { server, getTool } = createMockServer();
      registerIssuesTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const updateSpy = vi.spyOn(JiraClient.prototype, "updateIssue").mockRejectedValue(new Error("Permission denied"));

      const issues = getTool("issues");
      const result = await issues({ action: "update", issueKey: "BP-1", summary: "Try update" });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("Failed to update BP-1");
      expect(getText(result)).toContain("Permission denied");

      updateSpy.mockRestore();
    });

    it("returns error when issueKey missing for update", async () => {
      const { server, getTool } = createMockServer();
      registerIssuesTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const issues = getTool("issues");
      const result = await issues({ action: "update" });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("issueKey is required");
    });
  });

  // ── action=decompose — branches (lines 339, 373-376) ─────────────────────

  describe("action=decompose", () => {
    it("shows 'None found' when epic has no children (line 339)", async () => {
      const { server, getTool } = createMockServer();
      registerIssuesTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const getIssueSpy = vi
        .spyOn(JiraClient.prototype, "getIssue")
        .mockResolvedValue(
          makeIssueDetail("BP-100", { summary: "Epic summary", description: "Epic desc", labels: ["feature"] }),
        );
      const searchSpy = vi.spyOn(JiraClient.prototype, "searchIssues").mockResolvedValue({
        issues: [],
        total: 0,
      });

      const issues = getTool("issues");
      const result = await issues({ action: "decompose", epicKey: "BP-100" });
      expect(result.isError).toBeUndefined();
      const text = getText(result);
      expect(text).toContain("Epic Decomposition: BP-100");
      expect(text).toContain("Existing Stories\nNone found.");
      expect(text).toContain("Epic desc");

      getIssueSpy.mockRestore();
      searchSpy.mockRestore();
    });

    it("shows existing children table when epic has stories (lines 331-337)", async () => {
      const { server, getTool } = createMockServer();
      registerIssuesTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const getIssueSpy = vi
        .spyOn(JiraClient.prototype, "getIssue")
        .mockResolvedValue(
          makeIssueDetail("BP-100", { summary: "Epic summary", description: "Epic desc", labels: [] }),
        );
      const searchSpy = vi.spyOn(JiraClient.prototype, "searchIssues").mockResolvedValue({
        issues: [
          {
            key: "BP-101",
            id: "101",
            fields: {
              summary: "Child story 1",
              status: { name: "In Progress" },
              priority: { name: "High" },
              assignee: { displayName: "Alice" },
            },
          },
          {
            key: "BP-102",
            id: "102",
            fields: {
              summary: "Child story 2",
              status: { name: "Done" },
              priority: { name: "Medium" },
              assignee: undefined,
            },
          },
        ],
        total: 2,
      });

      const issues = getTool("issues");
      const result = await issues({ action: "decompose", epicKey: "BP-100" });
      expect(result.isError).toBeUndefined();
      const text = getText(result);
      expect(text).toContain("Existing Stories (2/2)");
      expect(text).toContain("BP-101");
      expect(text).toContain("Child story 1");
      expect(text).toContain("Alice");
      expect(text).toContain("BP-102");
      expect(text).toContain("Unassigned");
      expect(text).not.toContain("None found");

      getIssueSpy.mockRestore();
      searchSpy.mockRestore();
    });

    it("returns error when decompose throws (line 373)", async () => {
      const { server, getTool } = createMockServer();
      registerIssuesTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const getIssueSpy = vi
        .spyOn(JiraClient.prototype, "getIssue")
        .mockRejectedValue(new Error("Epic does not exist"));

      const issues = getTool("issues");
      const result = await issues({ action: "decompose", epicKey: "BP-BAD" });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("Failed to decompose BP-BAD");
      expect(getText(result)).toContain("Epic does not exist");

      getIssueSpy.mockRestore();
    });

    it("returns error when epicKey is missing for decompose", async () => {
      const { server, getTool } = createMockServer();
      registerIssuesTool(server, () => kb);
      JiraClient.saveSchemaToDb(kb, testSchema);

      const issues = getTool("issues");
      const result = await issues({ action: "decompose" });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("epicKey is required");
    });
  });

  // rank, find-bugs, assess, triage tests moved to tools-backlog.test.ts and tools-bugs.test.ts
});

// ── Helper function unit tests ──────────────────────────────────────────────

describe("issues-helpers", () => {
  // ── jsonPreprocess ──────────────────────────────────────────────────────────

  describe("jsonPreprocess", () => {
    it("parses a JSON string into an object", () => {
      const result = jsonPreprocess<{ a: number }>('{"a":1}');
      expect(result).toEqual({ a: 1 });
    });

    it("passes through non-string values unchanged", () => {
      const obj = { a: 1 };
      expect(jsonPreprocess(obj)).toBe(obj);
    });

    it("parses a JSON array string", () => {
      const result = jsonPreprocess<string[]>('["x","y"]');
      expect(result).toEqual(["x", "y"]);
    });

    it("passes through null and undefined", () => {
      expect(jsonPreprocess(null)).toBeNull();
      expect(jsonPreprocess(undefined)).toBeUndefined();
    });
  });

  // ── boolPreprocess ──────────────────────────────────────────────────────────

  describe("boolPreprocess", () => {
    it('converts "true" string to true', () => {
      expect(boolPreprocess("true")).toBe(true);
    });

    it('converts "false" string to false', () => {
      expect(boolPreprocess("false")).toBe(false);
    });

    it("passes through boolean true", () => {
      expect(boolPreprocess(true)).toBe(true);
    });

    it("passes through boolean false", () => {
      expect(boolPreprocess(false)).toBe(false);
    });

    it('converts any non-"true" string to false', () => {
      expect(boolPreprocess("yes")).toBe(false);
      expect(boolPreprocess("1")).toBe(false);
    });
  });

  // ── extractKeywords ─────────────────────────────────────────────────────────

  describe("extractKeywords", () => {
    it("extracts meaningful words and filters stop words", () => {
      const result = extractKeywords("Add retry logic to the ingestion pipeline");
      expect(result).not.toContain("the");
      expect(result).not.toContain("add");
      expect(result).toContain("retry");
      expect(result).toContain("logic");
      expect(result).toContain("ingestion");
      expect(result).toContain("pipeline");
    });

    it("deduplicates words", () => {
      const result = extractKeywords("cache cache cache invalidation");
      expect(result.filter((w) => w === "cache")).toHaveLength(1);
    });

    it("filters short words (<=2 chars)", () => {
      const result = extractKeywords("go to db in us");
      expect(result).toHaveLength(0);
    });

    it("handles empty string", () => {
      expect(extractKeywords("")).toEqual([]);
    });

    it("lowercases all output", () => {
      const result = extractKeywords("DatabaseMigration SCHEMA");
      for (const word of result) {
        expect(word).toBe(word.toLowerCase());
      }
    });

    it("splits on punctuation", () => {
      const result = extractKeywords("auth0/login:session.manager");
      expect(result).toContain("auth0");
      expect(result).toContain("login");
      expect(result).toContain("session");
      expect(result).toContain("manager");
    });
  });

  // ── STOP_WORDS ──────────────────────────────────────────────────────────────

  describe("STOP_WORDS", () => {
    it("contains common English stop words", () => {
      expect(STOP_WORDS.has("the")).toBe(true);
      expect(STOP_WORDS.has("and")).toBe(true);
      expect(STOP_WORDS.has("is")).toBe(true);
    });

    it("contains project-specific stop words", () => {
      expect(STOP_WORDS.has("implement")).toBe(true);
      expect(STOP_WORDS.has("configure")).toBe(true);
      expect(STOP_WORDS.has("provision")).toBe(true);
    });
  });

  // ── formatSummaries ─────────────────────────────────────────────────────────

  describe("formatSummaries", () => {
    const makePage = (title: string, preview: string): PageSummary => ({
      id: "1",
      space_key: "SP",
      title,
      url: null,
      page_type: "adr",
      labels: "",
      updated_at: null,
      content_preview: preview,
      source: "confluence",
    });

    it("formats pages as markdown list with heading and count", () => {
      const pages = [makePage("ADR-001", "Use PostgreSQL for storage"), makePage("ADR-002", "Adopt event sourcing")];
      const result = formatSummaries(pages, "ADRs");
      expect(result).toContain("### ADRs (2 total)");
      expect(result).toContain("- **ADR-001**: Use PostgreSQL for storage");
      expect(result).toContain("- **ADR-002**: Adopt event sourcing");
    });

    it("returns empty string for empty page list", () => {
      expect(formatSummaries([], "ADRs")).toBe("");
    });

    it("strips newlines from content_preview", () => {
      const pages = [makePage("Doc", "line one\nline two\nline three")];
      const result = formatSummaries(pages, "Docs");
      expect(result).not.toContain("\nline two");
      expect(result).toContain("line one line two line three");
    });
  });

  // ── formatBoardInfo ─────────────────────────────────────────────────────────

  describe("formatBoardInfo", () => {
    it("formats schema without board info", () => {
      const schema: JiraSchema = {
        projectKey: "BP",
        projectName: "Backlog",
        boardId: "",
        issueTypes: [{ id: "1", name: "Task", subtask: false, fields: [], requiredFields: [] }],
        priorities: [
          { id: "1", name: "Medium" },
          { id: "2", name: "High" },
        ],
        statuses: [],
      };
      const result = formatBoardInfo(schema);
      expect(result).toContain("**Priorities:** Medium, High");
      expect(result).toContain("**Issue Types:** Task");
      expect(result).not.toContain("**Board:**");
    });

    it("formats schema with board, columns, and estimation field", () => {
      const schema: JiraSchema = {
        projectKey: "BP",
        projectName: "Backlog",
        boardId: "",
        issueTypes: [
          { id: "1", name: "Task", subtask: false, fields: [], requiredFields: [] },
          { id: "2", name: "Sub-task", subtask: true, fields: [], requiredFields: [] },
        ],
        priorities: [{ id: "1", name: "Medium" }],
        statuses: [],
        board: {
          name: "Sprint Board",
          type: "scrum",
          estimationField: "story_points",
          columns: [{ name: "To Do" }, { name: "In Progress" }, { name: "Done" }],
        },
      };
      const result = formatBoardInfo(schema);
      expect(result).toContain("**Board:** Sprint Board (scrum)");
      expect(result).toContain("estimates in story_points");
      expect(result).toContain("**Workflow:** To Do \u2192 In Progress \u2192 Done");
      expect(result).toContain("Sub-task [subtask]");
    });

    it("formats board without estimation field", () => {
      const schema: JiraSchema = {
        projectKey: "BP",
        projectName: "Backlog",
        boardId: "",
        issueTypes: [],
        priorities: [],
        statuses: [],
        board: { name: "Kanban", type: "kanban" },
      };
      const result = formatBoardInfo(schema);
      expect(result).toContain("**Board:** Kanban (kanban)");
      expect(result).not.toContain("estimates in");
    });
  });

  // ── formatFieldsList ────────────────────────────────────────────────────────

  describe("formatFieldsList", () => {
    it("formats required and optional fields", () => {
      const typeSpec: JiraSchema["issueTypes"][number] = {
        id: "1",
        name: "Task",
        subtask: false,
        requiredFields: ["Summary"],
        fields: [
          { id: "summary", name: "Summary", required: true, type: "string" },
          { id: "description", name: "Description", required: false, type: "string" },
        ],
      };
      const result = formatFieldsList(typeSpec, "Task");
      expect(result).toContain("## Fields for Task");
      expect(result).toContain("**Summary** [REQUIRED]");
      expect(result).toContain("**Description** [optional]");
      expect(result).toContain("namedFields");
    });

    it("shows allowed values for fields", () => {
      const typeSpec: JiraSchema["issueTypes"][number] = {
        id: "1",
        name: "Bug",
        subtask: false,
        requiredFields: [],
        fields: [
          {
            id: "priority",
            name: "Priority",
            required: true,
            type: "string",
            allowedValues: [
              { id: "1", name: "High" },
              { id: "2", name: "Low" },
            ],
          },
        ],
      };
      const result = formatFieldsList(typeSpec, "Bug");
      expect(result).toContain("values: `High`, `Low`");
    });

    it("handles fields with empty allowedValues", () => {
      const typeSpec: JiraSchema["issueTypes"][number] = {
        id: "1",
        name: "Task",
        subtask: false,
        requiredFields: [],
        fields: [{ id: "labels", name: "Labels", required: false, type: "string", allowedValues: [] }],
      };
      const result = formatFieldsList(typeSpec, "Task");
      expect(result).toContain("**Labels** [optional]");
      expect(result).not.toContain("values:");
    });
  });

  // ── formatSampleTickets ─────────────────────────────────────────────────────

  describe("formatSampleTickets", () => {
    it("formats up to 3 sample tickets", () => {
      const samples = [
        { key: "BP-1", summary: "Add login", type: "Feature", priority: "High", status: "Done", labels: [] },
        { key: "BP-2", summary: "Fix crash", type: "Bug", priority: "Critical", status: "Done", labels: [] },
        { key: "BP-3", summary: "Spike auth", type: "Spike", priority: "Medium", status: "Done", labels: [] },
        { key: "BP-4", summary: "Should not appear", type: "Task", priority: "Low", status: "To Do", labels: [] },
      ];
      const result = formatSampleTickets(samples);
      expect(result).toContain("## Conventions (from recent tickets)");
      expect(result).toContain('BP-1: "Add login" [Feature, High]');
      expect(result).toContain('BP-2: "Fix crash" [Bug, Critical]');
      expect(result).toContain('BP-3: "Spike auth" [Spike, Medium]');
      expect(result).not.toContain("BP-4");
    });

    it("handles fewer than 3 tickets", () => {
      const samples = [
        { key: "BP-1", summary: "Only one", type: "Task", priority: "Medium", status: "Done", labels: [] },
      ];
      const result = formatSampleTickets(samples);
      expect(result).toContain("BP-1");
    });
  });

  // ── buildSchemaGuidance ─────────────────────────────────────────────────────

  describe("buildSchemaGuidance", () => {
    it("returns setup prompt when schema is null", () => {
      const result = buildSchemaGuidance(null, "Task");
      expect(result).toContain("No Jira schema found");
      expect(result).toContain("discover-jira");
    });

    it("includes board info and field list for matching issue type", () => {
      const schema: JiraSchema = {
        projectKey: "BP",
        projectName: "Backlog",
        boardId: "",
        issueTypes: [
          {
            id: "1",
            name: "Task",
            subtask: false,
            requiredFields: ["Summary"],
            fields: [{ id: "summary", name: "Summary", required: true, type: "string" }],
          },
        ],
        priorities: [{ id: "1", name: "Medium" }],
        statuses: [],
      };
      const result = buildSchemaGuidance(schema, "Task");
      expect(result).toContain("**Priorities:** Medium");
      expect(result).toContain("## Fields for Task");
      expect(result).toContain("**Summary** [REQUIRED]");
    });

    it("omits fields section when issue type not found", () => {
      const schema: JiraSchema = {
        projectKey: "BP",
        projectName: "Backlog",
        boardId: "",
        issueTypes: [{ id: "1", name: "Task", subtask: false, fields: [], requiredFields: [] }],
        priorities: [{ id: "1", name: "Medium" }],
        statuses: [],
      };
      const result = buildSchemaGuidance(schema, "Bug");
      expect(result).toContain("**Priorities:** Medium");
      expect(result).not.toContain("## Fields for Bug");
    });

    it("includes sample tickets when present", () => {
      const schema: JiraSchema = {
        projectKey: "BP",
        projectName: "Backlog",
        boardId: "",
        issueTypes: [],
        priorities: [],
        statuses: [],
        sampleTickets: [
          { key: "BP-1", summary: "Do thing", type: "Task", priority: "High", status: "Done", labels: [] },
        ],
      };
      const result = buildSchemaGuidance(schema, "Task");
      expect(result).toContain("Conventions (from recent tickets)");
      expect(result).toContain("BP-1");
    });
  });

  // ── buildKbContextSection ──────────────────────────────────────────────────

  describe("buildKbContextSection", () => {
    it("shows no-context message when everything is empty", () => {
      const ctx = { adrs: [], designs: [], specs: [], chunks: [] };
      const result = buildKbContextSection(ctx);
      expect(result).toContain("## Confluence Context");
      expect(result).toContain("No Confluence context found");
    });

    it("renders ADRs, designs, and specs sections", () => {
      const makePage = (title: string): PageSummary => ({
        id: "1",
        space_key: "SP",
        title,
        url: null,
        page_type: "adr",
        labels: "",
        updated_at: null,
        content_preview: "preview text",
        source: "confluence",
      });
      const ctx = {
        adrs: [makePage("ADR-001")],
        designs: [makePage("Design-A")],
        specs: [makePage("Spec-X")],
        chunks: [],
      };
      const result = buildKbContextSection(ctx);
      expect(result).toContain("### ADRs (1 total)");
      expect(result).toContain("### Design Docs (1 total)");
      expect(result).toContain("### Specs (1 total)");
      expect(result).not.toContain("No Confluence context found");
    });

    it("renders targeted match chunks", () => {
      const ctx = {
        adrs: [],
        designs: [],
        specs: [],
        chunks: [
          { page_title: "Auth Guide", page_type: "design", breadcrumb: "OAuth Section", snippet: "Use PKCE flow" },
          { page_title: "API Spec", page_type: "spec", breadcrumb: "Endpoints", snippet: "POST /tokens" },
        ],
      };
      const result = buildKbContextSection(ctx);
      expect(result).toContain("### Targeted Matches (2 relevant sections)");
      expect(result).toContain("**Auth Guide** > OAuth Section [design]: Use PKCE flow");
      expect(result).toContain("**API Spec** > Endpoints [spec]: POST /tokens");
      expect(result).not.toContain("No Confluence context found");
    });

    it("limits chunks to 25", () => {
      const chunks = Array.from({ length: 30 }, (_, i) => ({
        page_title: `Page ${i}`,
        page_type: "design",
        breadcrumb: "section",
        snippet: `snippet ${i}`,
      }));
      const ctx = { adrs: [], designs: [], specs: [], chunks };
      const result = buildKbContextSection(ctx);
      expect(result).toContain("### Targeted Matches (30 relevant sections)");
      expect(result).toContain("Page 24");
      expect(result).not.toContain("Page 25");
    });
  });
});
