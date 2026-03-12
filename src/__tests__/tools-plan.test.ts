import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { IndexedPage } from "../lib/db.js";
import { KnowledgeBase } from "../lib/db.js";
import { JiraClient, type JiraSchema } from "../lib/jira.js";
import { registerIssuesTool } from "../tools/issues.js";
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

function makePage(overrides: Partial<IndexedPage> = {}): IndexedPage {
  return {
    id: overrides.id ?? "page-1",
    space_key: overrides.space_key ?? "ENG",
    title: overrides.title ?? "Test Page",
    url: overrides.url ?? null,
    content: overrides.content ?? "Some content about authentication.",
    page_type: overrides.page_type ?? "design",
    labels: overrides.labels ?? '["design"]',
    parent_id: overrides.parent_id ?? null,
    author_id: overrides.author_id ?? null,
    created_at: overrides.created_at ?? null,
    updated_at: overrides.updated_at ?? "2025-06-01T00:00:00Z",
    indexed_at: overrides.indexed_at ?? new Date().toISOString(),
    source: overrides.source ?? "confluence",
  };
}

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
const ENV_KEYS = ["ATLASSIAN_SITE_URL", "ATLASSIAN_EMAIL", "ATLASSIAN_API_TOKEN", "JIRA_PROJECT_KEY"];

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

// ── Tests ────────────────────────────────────────────────────────────────────

describe("registerIssuesTool (plan actions)", () => {
  let kb: KnowledgeBase;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "lb-plan-test-"));
    kb = new KnowledgeBase(join(tmpDir, "test.db"));
    setTestEnv();
  });

  afterEach(() => {
    kb.close();
    rmSync(tmpDir, { recursive: true, force: true });
    restoreEnv();
  });

  it("registers issues tool with create and decompose actions", () => {
    const { server, toolNames } = createMockServer();
    registerIssuesTool(server, () => kb);
    expect(toolNames()).toContain("issues");
  });

  describe("action=create (preview with context)", () => {
    it("returns preview with schema guidance and Confluence context", async () => {
      const { server, getTool } = createMockServer();
      registerIssuesTool(server, () => kb);

      JiraClient.saveSchemaToDb(kb, testSchema);
      kb.upsertPage(makePage({ id: "a1", page_type: "adr", title: "ADR-001", content: "Use Terraform for infra" }));

      const issues = getTool("issues");
      const result = await issues({
        action: "create",
        summary: "Provision staging environment with Terraform",
      });
      const text = result.content[0]?.text;
      expect(text).toContain("Ticket Preview");
      expect(text).toContain("ADR");
      expect(text).toContain("Field Rules");
      expect(text).toContain("confirmed=true");
    });

    it("works without Confluence data (empty KB)", async () => {
      const { server, getTool } = createMockServer();
      registerIssuesTool(server, () => kb);

      JiraClient.saveSchemaToDb(kb, testSchema);

      const issues = getTool("issues");
      const result = await issues({ action: "create", summary: "Build a new widget" });
      const text = result.content[0]?.text;
      expect(text).toContain("Ticket Preview");
      expect(text).toContain("No Confluence context found");
    });
  });

  describe("action=decompose", () => {
    it("fetches epic details and existing children", async () => {
      const { server, getTool } = createMockServer();
      registerIssuesTool(server, () => kb);

      JiraClient.saveSchemaToDb(kb, testSchema);

      // GET epic details
      mockFetchResponse({
        key: "BP-50",
        id: "10050",
        fields: {
          summary: "Epic: User Authentication",
          description: {
            type: "doc",
            version: 1,
            content: [{ type: "paragraph", content: [{ type: "text", text: "Build OAuth2 auth" }] }],
          },
          issuetype: { name: "Epic" },
          priority: { name: "High" },
          status: { name: "In Progress" },
          labels: ["auth"],
          components: [],
          created: "2025-01-01",
          updated: "2025-06-01",
          comment: { comments: [] },
        },
      });

      // POST search for children
      mockFetchResponse({
        issues: [
          {
            key: "BP-51",
            fields: {
              summary: "Login page",
              status: { name: "Done" },
              priority: { name: "Medium" },
              assignee: null,
            },
          },
        ],
        total: 1,
      });

      const plan = getTool("issues");
      const result = await plan({ action: "decompose", epicKey: "BP-50" });
      const text = result.content[0]?.text;
      expect(text).toContain("Epic Decomposition: BP-50");
      expect(text).toContain("User Authentication");
      expect(text).toContain("BP-51");
      expect(text).toContain("Login page");
    });

    it("handles missing epic gracefully", async () => {
      const { server, getTool } = createMockServer();
      registerIssuesTool(server, () => kb);

      JiraClient.saveSchemaToDb(kb, testSchema);

      // GET epic fails
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ errorMessages: ["Issue Does Not Exist"] }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        }),
      );

      const plan = getTool("issues");
      const result = await plan({ action: "decompose", epicKey: "BP-999" });
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("Failed to decompose BP-999");
    });
  });
});
