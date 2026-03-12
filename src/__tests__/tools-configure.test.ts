import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { KnowledgeBase } from "../lib/db.js";
import { _internals as httpInternals } from "../lib/http-utils.js";
import { registerConfigureTool } from "../tools/configure.js";
import { createMockServer } from "./helpers/mock-server.js";

// ── Module mocks for learn-team ──────────────────────────────────────────────

const mockSearchIssues = vi.fn();
const mockGetIssueChangelog = vi.fn();

vi.mock("../lib/jira.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const RealJiraClient = actual.JiraClient as {
    discoverSchema: (...args: unknown[]) => unknown;
    saveSchemaToDb: (...args: unknown[]) => unknown;
  };
  return {
    ...actual,
    JiraClient: class MockJiraClient {
      searchIssues = mockSearchIssues;
      getIssueChangelog = mockGetIssueChangelog;
      project = "BP";
      static discoverSchema = RealJiraClient.discoverSchema;
      static saveSchemaToDb = RealJiraClient.saveSchemaToDb;
      static loadSchemaFromDb = vi.fn(() => null);
    },
  };
});

const mockAnalyzeBacklog: Mock = vi.fn();
const mockAdfToText: Mock = vi.fn((v: unknown) => (typeof v === "string" ? v : ""));

vi.mock("../lib/team-rules.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    analyzeBacklog: (...args: unknown[]) => mockAnalyzeBacklog(...(args as [unknown, unknown])),
  };
});

vi.mock("../lib/adf.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    adfToText: (...args: unknown[]) => mockAdfToText(...(args as [unknown])),
  };
});

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
  fetchMock.mockReset();
  fetchMock.mockImplementation(() => Promise.resolve(new Response("{}")));
});

// ── Env helpers ──────────────────────────────────────────────────────────────

const envSnapshot: Record<string, string | undefined> = {};
const ENV_KEYS = ["ATLASSIAN_SITE_URL", "ATLASSIAN_EMAIL", "ATLASSIAN_API_TOKEN", "JIRA_PROJECT_KEY", "JIRA_BOARD_ID"];

function setTestEnv() {
  for (const key of ENV_KEYS) envSnapshot[key] = process.env[key];
  process.env.ATLASSIAN_SITE_URL = "https://test.atlassian.net";
  process.env.ATLASSIAN_EMAIL = "test@example.com";
  process.env.ATLASSIAN_API_TOKEN = "tok_123";
  process.env.JIRA_PROJECT_KEY = "BP";
}

function restoreEnv() {
  for (const key of ENV_KEYS) {
    if (envSnapshot[key] === undefined) delete process.env[key];
    else process.env[key] = envSnapshot[key];
  }
}

// ── registerConfigureTool ────────────────────────────────────────────────────

describe("registerConfigureTool", () => {
  it("registers single configure tool", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "lb-cfg-reg-"));
    const kb = new KnowledgeBase(join(tmpDir, "test.db"));
    try {
      const { server, toolNames } = createMockServer();
      registerConfigureTool(server, () => kb);
      expect(toolNames()).toEqual(["configure"]);
    } finally {
      kb.close();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── action=set ───────────────────────────────────────────────────────────────

describe("action=set", () => {
  let kb: KnowledgeBase;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "lb-cfg-set-"));
    kb = new KnowledgeBase(join(tmpDir, "test.db"));
    setTestEnv();
  });

  afterEach(() => {
    kb.close();
    rmSync(tmpDir, { recursive: true, force: true });
    restoreEnv();
  });

  it("stores jiraProjectKey in SQLite config", async () => {
    const { server, getTool } = createMockServer();
    registerConfigureTool(server, () => kb);

    const configure = getTool("configure");
    const result = await configure({ action: "set", jiraProjectKey: "PROJ" });
    expect(result.content[0]?.text).toContain("Saved");
    expect(result.content[0]?.text).toContain("Project: PROJ");

    const stored = JSON.parse(kb.getConfig("atlassian") ?? "{}");
    expect(stored.jiraProjectKey).toBe("PROJ");
  });

  it("merges with existing config", async () => {
    const { server, getTool } = createMockServer();
    registerConfigureTool(server, () => kb);

    const configure = getTool("configure");
    await configure({ action: "set", jiraProjectKey: "BP" });
    await configure({ action: "set", jiraBoardId: "266" });

    const stored = JSON.parse(kb.getConfig("atlassian") ?? "{}");
    expect(stored.jiraProjectKey).toBe("BP");
    expect(stored.jiraBoardId).toBe("266");
  });

  it("returns error when auth env vars are missing", async () => {
    delete process.env.ATLASSIAN_SITE_URL;
    delete process.env.ATLASSIAN_EMAIL;
    delete process.env.ATLASSIAN_API_TOKEN;

    const { server, getTool } = createMockServer();
    registerConfigureTool(server, () => kb);

    const configure = getTool("configure");
    const result = await configure({
      action: "set",
      jiraProjectKey: "BP",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Atlassian auth not configured");
  });

  it("handles invalid JSON in existing config gracefully", async () => {
    // Pre-populate config with invalid JSON to trigger catch in handleSet
    kb.setConfig("atlassian", "this-is-not-json");

    const { server, getTool } = createMockServer();
    registerConfigureTool(server, () => kb);

    const configure = getTool("configure");
    const result = await configure({ action: "set", jiraProjectKey: "NEW" });
    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.text).toContain("Saved");
    expect(result.content[0]?.text).toContain("Project: NEW");

    // Should have replaced the invalid JSON with valid config
    const stored = JSON.parse(kb.getConfig("atlassian") ?? "{}");
    expect(stored.jiraProjectKey).toBe("NEW");
  });

  it("saves boardId in config", async () => {
    const { server, getTool } = createMockServer();
    registerConfigureTool(server, () => kb);

    const configure = getTool("configure");
    const result = await configure({ action: "set", jiraBoardId: "42" });
    expect(result.content[0]?.text).toContain("Saved");
    expect(result.content[0]?.text).toContain("Board: 42");
  });

  it("saves rootPageIds in config", async () => {
    const { server, getTool } = createMockServer();
    registerConfigureTool(server, () => kb);

    const configure = getTool("configure");
    const result = await configure({ action: "set", rootPageIds: ["111", "222"] });
    expect(result.content[0]?.text).toContain("Saved");

    const stored = JSON.parse(kb.getConfig("atlassian") ?? "{}");
    expect(stored.rootPageIds).toEqual(["111", "222"]);
  });

  it("returns summary of saved settings", async () => {
    const { server, getTool } = createMockServer();
    registerConfigureTool(server, () => kb);

    const configure = getTool("configure");
    const result = await configure({
      action: "set",
      jiraProjectKey: "BP",
      confluenceSpaces: ["ENG", "PM"],
    });
    expect(result.content[0]?.text).toContain("Project: BP");
    expect(result.content[0]?.text).toContain("Spaces: ENG, PM");
  });
});

// ── action=get ───────────────────────────────────────────────────────────────

describe("action=get", () => {
  let kb: KnowledgeBase;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "lb-cfg-get-"));
    kb = new KnowledgeBase(join(tmpDir, "test.db"));
    setTestEnv();
  });

  afterEach(() => {
    kb.close();
    rmSync(tmpDir, { recursive: true, force: true });
    restoreEnv();
  });

  it("returns current config with env + SQLite values", async () => {
    const { server, getTool } = createMockServer();
    registerConfigureTool(server, () => kb);

    // Store a value in SQLite
    kb.setConfig("atlassian", JSON.stringify({ jiraBoardId: "266" }));

    const configure = getTool("configure");
    const result = await configure({ action: "get" });
    const text = result.content[0]?.text ?? "";

    expect(text).toContain("Current Configuration");
    expect(text).toContain("atlassian.net");
    expect(text).toContain("test@example.com");
  });

  it("shows jiraProjectKey from env when set", async () => {
    const { server, getTool } = createMockServer();
    registerConfigureTool(server, () => kb);

    const configure = getTool("configure");
    const result = await configure({ action: "get" });
    const text = result.content[0]?.text ?? "";

    expect(text).toContain("BP");
    expect(text).toContain("JIRA_PROJECT_KEY");
  });

  it("shows board ID from SQLite config", async () => {
    kb.setConfig("atlassian", JSON.stringify({ jiraBoardId: "266" }));

    const { server, getTool } = createMockServer();
    registerConfigureTool(server, () => kb);

    const configure = getTool("configure");
    const result = await configure({ action: "get" });
    const text = result.content[0]?.text ?? "";

    expect(text).toContain("266");
    expect(text).toContain("SQLite");
  });

  it("shows setup status section with schema and rules info", async () => {
    const { server, getTool } = createMockServer();
    registerConfigureTool(server, () => kb);

    const configure = getTool("configure");
    const result = await configure({ action: "get" });
    const text = result.content[0]?.text ?? "";

    expect(text).toContain("Setup Status");
    expect(text).toContain("Jira Schema");
    expect(text).toContain("Team Conventions");
    expect(text).toContain("Confluence KB");
  });

  it("returns error when auth env vars are missing", async () => {
    delete process.env.ATLASSIAN_SITE_URL;
    delete process.env.ATLASSIAN_EMAIL;
    delete process.env.ATLASSIAN_API_TOKEN;

    const { server, getTool } = createMockServer();
    registerConfigureTool(server, () => kb);

    const configure = getTool("configure");
    const result = await configure({ action: "get" });

    expect(result.isError).toBe(true);
  });
});

// ── action=setup ─────────────────────────────────────────────────────────────

describe("action=setup", () => {
  let kb: KnowledgeBase;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "lb-cfg-setup-"));
    kb = new KnowledgeBase(join(tmpDir, "test.db"));
    setTestEnv();
    mockSearchIssues.mockReset();
    mockGetIssueChangelog.mockReset();
    mockAnalyzeBacklog.mockReset();
    mockAdfToText.mockReset();
    mockAdfToText.mockImplementation((v: unknown) => (typeof v === "string" ? v : ""));
  });

  afterEach(() => {
    kb.close();
    rmSync(tmpDir, { recursive: true, force: true });
    restoreEnv();
  });

  it("runs Jira schema discovery and team learning", async () => {
    const { server, getTool } = createMockServer();
    registerConfigureTool(server, () => kb);

    // Mock Jira discovery: GET project, createmeta, fields, priorities, statuses, recent issues
    mockFetchResponse({ key: "BP", name: "Backlog", id: "10000" });
    mockFetchResponse({ values: [{ id: "1", name: "Task", subtask: false }] });
    mockFetchResponse({ values: [] });
    mockFetchResponse([{ id: "1", name: "Medium" }]);
    mockFetchResponse([]);
    mockFetchResponse({ issues: [] });

    // Mock learn-team: searchIssues returns empty (no completed tickets)
    mockSearchIssues.mockResolvedValue({ issues: [], total: 0 });

    const configure = getTool("configure");
    const result = await configure({ action: "setup", projectKey: "BP" });
    const text = result.content[0]?.text ?? "";

    expect(text).toContain("Setup Results");
    expect(text).toContain("Jira Schema");
    expect(text).toContain("Backlog (BP)");
    expect(text).toContain("Team Conventions");
  });

  it("returns Jira results and team conventions in output", async () => {
    const { server, getTool } = createMockServer();
    registerConfigureTool(server, () => kb);

    // Mock Jira discovery
    mockFetchResponse({ key: "BP", name: "Backlog", id: "10000" });
    mockFetchResponse({ values: [{ id: "1", name: "Task", subtask: false }] });
    mockFetchResponse({ values: [] });
    mockFetchResponse([{ id: "1", name: "Medium" }]);
    mockFetchResponse([]);
    mockFetchResponse({ issues: [] });

    // Mock learn-team: has tickets
    mockSearchIssues.mockResolvedValue({
      issues: [
        {
          key: "BP-1",
          fields: {
            summary: "Add login",
            description: "desc",
            status: { name: "Done" },
            issuetype: { name: "Story" },
            priority: { name: "High" },
            labels: ["auth"],
            components: [{ name: "frontend" }],
            created: "2025-01-01T00:00:00Z",
            updated: "2025-01-10T00:00:00Z",
            resolutiondate: "2025-01-10T00:00:00Z",
          },
        },
      ],
      total: 1,
    });
    mockGetIssueChangelog.mockResolvedValue([]);
    mockAnalyzeBacklog.mockReturnValue({
      rules: [
        { category: "naming", rule_key: "k", issue_type: "Story", rule_value: "v", confidence: 0.85, sample_size: 1 },
      ],
      totalTickets: 1,
      qualityPassed: 1,
      qualityFailed: 0,
      avgQualityScore: 75.0,
      rulesByCategory: { naming: 1 },
    });

    const configure = getTool("configure");
    const result = await configure({ action: "setup" });
    const text = result.content[0]?.text ?? "";

    expect(text).toContain("Backlog (BP)");
    expect(text).toContain("issue types");
    expect(text).toContain("Team Conventions");
    expect(text).toContain("1 rules extracted");
    expect(mockAnalyzeBacklog).toHaveBeenCalledOnce();
  });

  it("skips Confluence when no spaces configured", async () => {
    const { server, getTool } = createMockServer();
    registerConfigureTool(server, () => kb);

    // Mock Jira discovery
    mockFetchResponse({ key: "BP", name: "Backlog", id: "10000" });
    mockFetchResponse({ values: [{ id: "1", name: "Task", subtask: false }] });
    mockFetchResponse({ values: [] });
    mockFetchResponse([{ id: "1", name: "Medium" }]);
    mockFetchResponse([]);
    mockFetchResponse({ issues: [] });

    // Mock learn-team: empty
    mockSearchIssues.mockResolvedValue({ issues: [], total: 0 });

    const configure = getTool("configure");
    const result = await configure({ action: "setup" });
    const text = result.content[0]?.text ?? "";

    expect(text).toContain("Jira Schema");
    expect(text).toContain("Not configured");
  });

  it("returns error when no project key configured", async () => {
    delete process.env.JIRA_PROJECT_KEY;

    const { server, getTool } = createMockServer();
    registerConfigureTool(server, () => kb);

    const configure = getTool("configure");
    const result = await configure({ action: "setup" });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("projectKey");
    expect(result.content[0]?.text).toContain("Setup needs more info");
  });

  it("returns error when Jira API call fails", { timeout: 15_000 }, async () => {
    const { server, getTool } = createMockServer();
    registerConfigureTool(server, () => kb);

    // Stub sleep to avoid real delays during retries
    const origSleep = httpInternals.sleep;
    httpInternals.sleep = () => Promise.resolve();

    // Must reject enough times to exhaust all retry attempts (initial + MAX_RETRIES)
    const err = new Error("ECONNREFUSED: connection refused");
    fetchMock.mockRejectedValueOnce(err);
    fetchMock.mockRejectedValueOnce(err);
    fetchMock.mockRejectedValueOnce(err);
    fetchMock.mockRejectedValueOnce(err);

    const configure = getTool("configure");
    const result = await configure({ action: "setup" });

    httpInternals.sleep = origSleep;

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Jira discovery failed");
    expect(result.content[0]?.text).toContain("ECONNREFUSED");
  });

  it("handles empty ticket history gracefully", async () => {
    const { server, getTool } = createMockServer();
    registerConfigureTool(server, () => kb);

    // Mock Jira discovery
    mockFetchResponse({ key: "BP", name: "Backlog", id: "10000" });
    mockFetchResponse({ values: [{ id: "1", name: "Task", subtask: false }] });
    mockFetchResponse({ values: [] });
    mockFetchResponse([{ id: "1", name: "Medium" }]);
    mockFetchResponse([]);
    mockFetchResponse({ issues: [] });

    // Mock learn-team: no completed tickets
    mockSearchIssues.mockResolvedValue({ issues: [], total: 0 });

    const configure = getTool("configure");
    const result = await configure({ action: "setup" });
    const text = result.content[0]?.text ?? "";

    expect(text).toContain("No completed tickets found");
    expect(text).toContain("Setup complete");
  });

  it("persists projectKey, boardId, and spaceKeys to config", async () => {
    const { server, getTool } = createMockServer();
    registerConfigureTool(server, () => kb);

    // Mock Jira discovery
    mockFetchResponse({ key: "BP", name: "Backlog", id: "10000" });
    mockFetchResponse({ values: [{ id: "1", name: "Task", subtask: false }] });
    mockFetchResponse({ values: [] });
    mockFetchResponse([{ id: "1", name: "Medium" }]);
    mockFetchResponse([]);
    mockFetchResponse({ issues: [] });

    // Mock learn-team: empty
    mockSearchIssues.mockResolvedValue({ issues: [], total: 0 });

    const configure = getTool("configure");
    await configure({
      action: "setup",
      projectKey: "PROJ",
      boardId: "42",
      spaceKeys: ["ENG", "PM"],
    });

    const stored = JSON.parse(kb.getConfig("atlassian") ?? "{}");
    expect(stored.jiraProjectKey).toBe("PROJ");
    expect(stored.jiraBoardId).toBe("42");
    expect(stored.confluenceSpaces).toEqual(["ENG", "PM"]);
  });

  it("merges setup params into existing config without overwriting other keys", async () => {
    // Pre-populate config with an extra key
    kb.setConfig("atlassian", JSON.stringify({ rootPageIds: ["111"], jiraBoardId: "99" }));

    const { server, getTool } = createMockServer();
    registerConfigureTool(server, () => kb);

    // Mock Jira discovery
    mockFetchResponse({ key: "NEW", name: "NewProject", id: "20000" });
    mockFetchResponse({ values: [{ id: "2", name: "Bug", subtask: false }] });
    mockFetchResponse({ values: [] });
    mockFetchResponse([{ id: "2", name: "High" }]);
    mockFetchResponse([]);
    mockFetchResponse({ issues: [] });

    // Mock learn-team: empty
    mockSearchIssues.mockResolvedValue({ issues: [], total: 0 });

    const configure = getTool("configure");
    await configure({ action: "setup", projectKey: "NEW" });

    const stored = JSON.parse(kb.getConfig("atlassian") ?? "{}");
    // New value persisted
    expect(stored.jiraProjectKey).toBe("NEW");
    // Existing keys preserved
    expect(stored.rootPageIds).toEqual(["111"]);
    // boardId comes from existing config since not passed in params
    expect(stored.jiraBoardId).toBe("99");
  });

  it("returns error when missing projectKey and no env fallback", async () => {
    delete process.env.JIRA_PROJECT_KEY;

    // Pre-populate config without jiraProjectKey
    kb.setConfig("atlassian", JSON.stringify({ jiraBoardId: "10" }));

    const { server, getTool } = createMockServer();
    registerConfigureTool(server, () => kb);

    const configure = getTool("configure");
    const result = await configure({ action: "setup" });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Setup needs more info");
    expect(result.content[0]?.text).toContain("projectKey");
  });

  it("saves Jira schema to DB during setup", async () => {
    const { server, getTool } = createMockServer();
    registerConfigureTool(server, () => kb);

    // Mock Jira discovery: project, createmeta, fields×2, priorities, statuses, samples
    mockFetchResponse({ key: "BP", name: "Backlog", id: "10000" });
    mockFetchResponse({
      values: [
        { id: "1", name: "Task", subtask: false },
        { id: "2", name: "Story", subtask: false },
      ],
    });
    mockFetchResponse({ values: [] }); // fields for Task
    mockFetchResponse({ values: [] }); // fields for Story
    mockFetchResponse([
      { id: "1", name: "High" },
      { id: "2", name: "Low" },
    ]);
    mockFetchResponse([]); // statuses
    mockFetchResponse({ issues: [] }); // sample issues

    // Mock learn-team: empty
    mockSearchIssues.mockResolvedValue({ issues: [], total: 0 });

    const configure = getTool("configure");
    const result = await configure({ action: "setup", projectKey: "BP" });
    const text = result.content[0]?.text ?? "";

    // Schema details appear in output
    expect(text).toContain("2 issue types");
    expect(text).toContain("2 priorities");

    // Schema was saved — verify via the config table (saveSchemaToDb writes there)
    const schemaJson = kb.getConfig("jira-schema");
    expect(schemaJson).toBeTruthy();
    const schema = JSON.parse(schemaJson ?? "");
    expect(schema.projectKey).toBe("BP");
  });

  it("reports team conventions failure without crashing", async () => {
    const { server, getTool } = createMockServer();
    registerConfigureTool(server, () => kb);

    // Mock Jira discovery
    mockFetchResponse({ key: "BP", name: "Backlog", id: "10000" });
    mockFetchResponse({ values: [{ id: "1", name: "Task", subtask: false }] });
    mockFetchResponse({ values: [] });
    mockFetchResponse([{ id: "1", name: "Medium" }]);
    mockFetchResponse([]);
    mockFetchResponse({ issues: [] });

    // Make searchIssues throw to simulate team-learning failure
    mockSearchIssues.mockRejectedValue(new Error("Jira search exploded"));

    const configure = getTool("configure");
    const result = await configure({ action: "setup", projectKey: "BP" });
    const text = result.content[0]?.text ?? "";

    // Setup should still succeed overall, with a failure note for team conventions
    expect(result.isError).toBeFalsy();
    expect(text).toContain("Jira Schema");
    expect(text).toContain("FAILED");
    expect(text).toContain("Jira search exploded");
    expect(text).toContain("Setup complete");
  });

  it("proceeds when projectKey present but boardId and spaces missing", async () => {
    // Tests validateSetupParams returning null when projectKey is provided
    // but boardId and spaces are missing (they're recommended, not required)
    delete process.env.JIRA_BOARD_ID;

    const { server, getTool } = createMockServer();
    registerConfigureTool(server, () => kb);

    // Mock Jira discovery (no boardId passed)
    mockFetchResponse({ key: "BP", name: "Backlog", id: "10000" });
    mockFetchResponse({ values: [{ id: "1", name: "Task", subtask: false }] });
    mockFetchResponse({ values: [] });
    mockFetchResponse([{ id: "1", name: "Medium" }]);
    mockFetchResponse([]);
    mockFetchResponse({ issues: [] });

    // Mock learn-team: empty
    mockSearchIssues.mockResolvedValue({ issues: [], total: 0 });

    const configure = getTool("configure");
    const result = await configure({ action: "setup", projectKey: "BP" });
    const text = result.content[0]?.text ?? "";

    // Should succeed (not return validation error)
    expect(result.isError).toBeFalsy();
    expect(text).toContain("Setup Results");
    expect(text).toContain("Jira Schema");
  });

  it("merges setup config into invalid JSON gracefully", async () => {
    // Pre-populate config with invalid JSON to test the catch block in persistSetupConfig
    kb.setConfig("atlassian", "not-valid-json{{{");

    const { server, getTool } = createMockServer();
    registerConfigureTool(server, () => kb);

    // Mock Jira discovery
    mockFetchResponse({ key: "BP", name: "Backlog", id: "10000" });
    mockFetchResponse({ values: [{ id: "1", name: "Task", subtask: false }] });
    mockFetchResponse({ values: [] });
    mockFetchResponse([{ id: "1", name: "Medium" }]);
    mockFetchResponse([]);
    mockFetchResponse({ issues: [] });

    // Mock learn-team: empty
    mockSearchIssues.mockResolvedValue({ issues: [], total: 0 });

    const configure = getTool("configure");
    const result = await configure({ action: "setup", projectKey: "BP" });
    const text = result.content[0]?.text ?? "";

    // Should succeed, starting fresh config
    expect(result.isError).toBeFalsy();
    expect(text).toContain("Setup Results");

    // Config should be valid JSON now
    const stored = JSON.parse(kb.getConfig("atlassian") ?? "{}");
    expect(stored.jiraProjectKey).toBe("BP");
  });

  it("returns error when auth env vars missing for setup", async () => {
    delete process.env.ATLASSIAN_SITE_URL;
    delete process.env.ATLASSIAN_EMAIL;
    delete process.env.ATLASSIAN_API_TOKEN;

    const { server, getTool } = createMockServer();
    registerConfigureTool(server, () => kb);

    const configure = getTool("configure");
    const result = await configure({ action: "setup", projectKey: "BP" });

    expect(result.isError).toBe(true);
  });

  it("maps ticket fields with missing nested values and assignee", async () => {
    const { server, getTool } = createMockServer();
    registerConfigureTool(server, () => kb);

    // Mock Jira discovery
    mockFetchResponse({ key: "BP", name: "Backlog", id: "10000" });
    mockFetchResponse({ values: [{ id: "1", name: "Task", subtask: false }] });
    mockFetchResponse({ values: [] });
    mockFetchResponse([{ id: "1", name: "Medium" }]);
    mockFetchResponse([]);
    mockFetchResponse({ issues: [] });

    // Return tickets with various edge cases to cover branches in mapIssueToTicket
    mockSearchIssues.mockResolvedValue({
      issues: [
        {
          key: "BP-1",
          fields: {
            summary: "Task with assignee",
            description: "desc",
            status: { name: "Done" },
            issuetype: { name: "Story" },
            priority: { name: "High" },
            labels: ["backend"],
            components: [{ name: "API" }, { notAName: true }], // second component has no .name
            assignee: { displayName: "Alice" },
            created: "2025-01-01T00:00:00Z",
            updated: "2025-01-10T00:00:00Z",
            resolutiondate: "2025-01-10T00:00:00Z",
            story_points: 5,
          },
        },
        {
          key: "BP-2",
          fields: {
            // Missing or non-string fields to exercise fallback branches
            summary: null, // non-string → fallback to ""
            description: null, // adfToText returns ""
            status: null, // nested name → "Unknown"
            issuetype: null, // nested name → "Unknown"
            priority: null, // nested name → "Medium"
            labels: null, // falsy → []
            components: null, // falsy → []
            assignee: null, // null → null
            created: 123, // non-string → fallback
            updated: 456,
            resolutiondate: null,
          },
        },
      ],
      total: 2,
    });
    mockGetIssueChangelog.mockResolvedValue([]);
    mockAnalyzeBacklog.mockReturnValue({
      rules: [],
      totalTickets: 2,
      qualityPassed: 1,
      qualityFailed: 1,
      avgQualityScore: 50.0,
      rulesByCategory: {},
    });

    const configure = getTool("configure");
    const result = await configure({ action: "setup", projectKey: "BP" });
    expect(result.isError).toBeFalsy();

    // Verify analyzeBacklog was called with properly mapped tickets
    const tickets = mockAnalyzeBacklog.mock.calls[0]?.[0] as Array<{
      assignee: string | null;
      components: string[];
      status: string;
      issueType: string;
    }>;
    // First ticket: has assignee
    expect(tickets[0]?.assignee).toBe("Alice");
    expect(tickets[0]?.components).toContain("API");
    // Second ticket: missing fields fall back
    expect(tickets[1]?.status).toBe("Unknown");
    expect(tickets[1]?.issueType).toBe("Unknown");
    expect(tickets[1]?.assignee).toBeNull();
  });

  it("handles multi-page ticket fetching", async () => {
    const { server, getTool } = createMockServer();
    registerConfigureTool(server, () => kb);

    // Mock Jira discovery
    mockFetchResponse({ key: "BP", name: "Backlog", id: "10000" });
    mockFetchResponse({ values: [{ id: "1", name: "Task", subtask: false }] });
    mockFetchResponse({ values: [] });
    mockFetchResponse([{ id: "1", name: "Medium" }]);
    mockFetchResponse([]);
    mockFetchResponse({ issues: [] });

    const makeIssue = (key: string) => ({
      key,
      fields: {
        summary: `Task ${key}`,
        description: "desc",
        status: { name: "Done" },
        issuetype: { name: "Task" },
        priority: { name: "Medium" },
        labels: [],
        components: [],
        created: "2025-01-01T00:00:00Z",
        updated: "2025-01-02T00:00:00Z",
        resolutiondate: null,
      },
    });

    // To paginate: pageSize = min(50, maxTickets). First batch must return exactly pageSize items.
    // maxTickets=3 → pageSize=3. First batch: 3 items, total=4. 3<3=false, 3>=4=false → continues.
    // After first batch: allTickets=3, 3<3=false → while exits. Need maxTickets=4.
    // maxTickets=4 → pageSize=4. First batch: 4 items, total=5. 4<4=false, 4>=5=false → continues.
    // After first batch: allTickets=4, 4<4=false → while exits. Need maxTickets=5.
    // maxTickets=5 → pageSize=5. First batch: 5 items, total=6. 5<5=false, 5>=6=false → continues.
    // After first batch: allTickets=5, 5<5=false → while exits. Same issue.
    // The while condition checks BEFORE the second iteration. So we need allTickets < maxTickets
    // after first batch. First batch returns pageSize items. So maxTickets > pageSize.
    // But pageSize = min(50, maxTickets), so pageSize = maxTickets when maxTickets <= 50.
    // This means we can never paginate when maxTickets <= 50!
    // Actually we CAN — pageSize = min(50, maxTickets). If maxTickets=100, pageSize=50.
    // First batch: 50 items. allTickets=50 < 100 → continues.
    mockSearchIssues
      .mockResolvedValueOnce({
        issues: Array.from({ length: 50 }, (_, i) => makeIssue(`BP-${i + 1}`)),
        total: 52,
      })
      .mockResolvedValueOnce({
        issues: [makeIssue("BP-51"), makeIssue("BP-52")],
        total: 52,
      });
    mockGetIssueChangelog.mockResolvedValue([]);
    mockAnalyzeBacklog.mockReturnValue({
      rules: [],
      totalTickets: 52,
      qualityPassed: 52,
      qualityFailed: 0,
      avgQualityScore: 80.0,
      rulesByCategory: {},
    });

    const configure = getTool("configure");
    const result = await configure({ action: "setup", projectKey: "BP", maxTickets: 100 });
    expect(result.isError).toBeFalsy();

    const tickets = mockAnalyzeBacklog.mock.calls[0]?.[0] as Array<{ key: string }>;
    expect(tickets).toHaveLength(52);
    expect(mockSearchIssues).toHaveBeenCalledTimes(2);
  });

  it("enriches changelogs with actual items from getIssueChangelog", async () => {
    const { server, getTool } = createMockServer();
    registerConfigureTool(server, () => kb);

    // Mock Jira discovery
    mockFetchResponse({ key: "BP", name: "Backlog", id: "10000" });
    mockFetchResponse({ values: [{ id: "1", name: "Task", subtask: false }] });
    mockFetchResponse({ values: [] });
    mockFetchResponse([{ id: "1", name: "Medium" }]);
    mockFetchResponse([]);
    mockFetchResponse({ issues: [] });

    // Mock learn-team: has ticket
    mockSearchIssues.mockResolvedValue({
      issues: [
        {
          key: "BP-1",
          fields: {
            summary: "Task 1",
            description: "desc",
            status: { name: "Done" },
            issuetype: { name: "Task" },
            priority: { name: "Medium" },
            labels: [],
            components: [],
            created: "2025-01-01T00:00:00Z",
            updated: "2025-01-02T00:00:00Z",
            resolutiondate: "2025-01-02T00:00:00Z",
          },
        },
      ],
      total: 1,
    });
    // Return actual changelog entries with items to cover lines 120-127
    mockGetIssueChangelog.mockResolvedValue([
      {
        created: "2025-01-01T12:00:00Z",
        items: [
          { field: "status", fromString: "To Do", toString: "In Progress" },
          { field: "assignee", fromString: null, toString: "Alice" },
        ],
      },
      {
        created: "2025-01-02T12:00:00Z",
        items: [{ field: "status", fromString: "In Progress", toString: "Done" }],
      },
    ]);
    mockAnalyzeBacklog.mockReturnValue({
      rules: [],
      totalTickets: 1,
      qualityPassed: 1,
      qualityFailed: 0,
      avgQualityScore: 75.0,
      rulesByCategory: {},
    });

    const configure = getTool("configure");
    const result = await configure({ action: "setup", projectKey: "BP" });
    const text = result.content[0]?.text ?? "";

    expect(result.isError).toBeFalsy();
    expect(text).toContain("Team Conventions");
    // Verify analyzeBacklog was called with tickets that have changelog entries
    expect(mockAnalyzeBacklog).toHaveBeenCalledOnce();
    const tickets = mockAnalyzeBacklog.mock.calls[0]?.[0] as Array<{ changelog: unknown[] }>;
    expect(tickets[0]?.changelog).toHaveLength(3); // 2 + 1 items flattened
  });

  it("handles changelog fetch failure gracefully (catch branch)", async () => {
    const { server, getTool } = createMockServer();
    registerConfigureTool(server, () => kb);

    // Mock Jira discovery
    mockFetchResponse({ key: "BP", name: "Backlog", id: "10000" });
    mockFetchResponse({ values: [{ id: "1", name: "Task", subtask: false }] });
    mockFetchResponse({ values: [] });
    mockFetchResponse([{ id: "1", name: "Medium" }]);
    mockFetchResponse([]);
    mockFetchResponse({ issues: [] });

    mockSearchIssues.mockResolvedValue({
      issues: [
        {
          key: "BP-1",
          fields: {
            summary: "Task 1",
            description: "desc",
            status: { name: "Done" },
            issuetype: { name: "Task" },
            priority: { name: "Medium" },
            labels: [],
            components: [],
            created: "2025-01-01T00:00:00Z",
            updated: "2025-01-02T00:00:00Z",
            resolutiondate: null,
          },
        },
      ],
      total: 1,
    });
    // Throw to trigger the catch branch at line 128
    mockGetIssueChangelog.mockRejectedValue(new Error("Changelog fetch failed"));
    mockAnalyzeBacklog.mockReturnValue({
      rules: [],
      totalTickets: 1,
      qualityPassed: 1,
      qualityFailed: 0,
      avgQualityScore: 75.0,
      rulesByCategory: {},
    });

    const configure = getTool("configure");
    const result = await configure({ action: "setup", projectKey: "BP" });

    expect(result.isError).toBeFalsy();
    // Verify the ticket still has empty changelog (fallback to [])
    const tickets = mockAnalyzeBacklog.mock.calls[0]?.[0] as Array<{ changelog: unknown[] }>;
    expect(tickets[0]?.changelog).toEqual([]);
  });

  it("passes quality threshold to team analysis", async () => {
    const { server, getTool } = createMockServer();
    registerConfigureTool(server, () => kb);

    // Mock Jira discovery
    mockFetchResponse({ key: "BP", name: "Backlog", id: "10000" });
    mockFetchResponse({ values: [{ id: "1", name: "Task", subtask: false }] });
    mockFetchResponse({ values: [] });
    mockFetchResponse([{ id: "1", name: "Medium" }]);
    mockFetchResponse([]);
    mockFetchResponse({ issues: [] });

    // Mock learn-team
    mockSearchIssues.mockResolvedValue({
      issues: [
        {
          key: "BP-1",
          fields: {
            summary: "Task 1",
            description: "desc",
            status: { name: "Done" },
            issuetype: { name: "Task" },
            priority: { name: "Medium" },
            labels: [],
            components: [],
            created: "2025-01-01T00:00:00Z",
            updated: "2025-01-02T00:00:00Z",
            resolutiondate: null,
          },
        },
      ],
      total: 1,
    });
    mockGetIssueChangelog.mockResolvedValue([]);
    mockAnalyzeBacklog.mockReturnValue({
      rules: [],
      totalTickets: 1,
      qualityPassed: 0,
      qualityFailed: 1,
      avgQualityScore: 40.0,
      rulesByCategory: {},
    });

    const configure = getTool("configure");
    await configure({ action: "setup", qualityThreshold: 80 });

    expect(mockAnalyzeBacklog).toHaveBeenCalledWith(expect.any(Array), 80);
  });
});
