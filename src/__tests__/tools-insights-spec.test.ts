/**
 * Stage D (D2 + D3) — `insights epic-progress` spec status write-back and
 * freshness loop.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { KnowledgeBase } from "../lib/db.js";
import { JiraClient, type JiraSchema, type SearchIssue } from "../lib/jira.js";
import { registerInsightsTool } from "../tools/insights.js";
import { createMockServer } from "./helpers/mock-server.js";

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
  vi.restoreAllMocks();
});

const testSchema: JiraSchema = {
  projectKey: "BP",
  projectName: "Backlog",
  boardId: "266",
  issueTypes: [{ id: "1", name: "Task", subtask: false, fields: [], requiredFields: [] }],
  priorities: [{ id: "1", name: "Medium" }],
  statuses: [],
};

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

function makeIssue(key: string, status: string, category: string, sp: number): SearchIssue {
  return {
    key,
    id: key.split("-")[1] ?? "0",
    fields: {
      summary: `Issue ${key}`,
      status: { name: status, statusCategory: { name: category } },
      customfield_10016: sp,
    },
  } as unknown as SearchIssue;
}

describe("insights epic-progress — spec status write-back (Stage D2)", () => {
  let kb: KnowledgeBase;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "lb-insights-spec-"));
    kb = new KnowledgeBase(join(tmpDir, "test.db"));
    setTestEnv();
    JiraClient.saveSchemaToDb(kb, testSchema);
  });

  afterEach(() => {
    kb.close();
    rmSync(tmpDir, { recursive: true, force: true });
    restoreEnv();
  });

  it("renders the Source Spec section and a publishable status section when a link exists", async () => {
    kb.upsertEpicSpecLink({
      issueKey: "BP-100",
      pageId: "spec-42",
      pageTitle: "Auth Redesign Spec",
      pageUrl: "https://test.atlassian.net/wiki/spaces/ENG/pages/spec-42",
    });

    vi.spyOn(JiraClient.prototype, "getEpicIssues").mockResolvedValue([
      makeIssue("BP-1", "Done", "Done", 3),
      makeIssue("BP-2", "In Progress", "indeterminate", 5),
    ]);

    const { server, getTool } = createMockServer();
    registerInsightsTool(server, () => kb);
    const insights = getTool("insights");
    const result = await insights({ action: "epic-progress", epicKey: "BP-100" });
    const text = result.content[0]?.text ?? "";

    expect(text).toContain("## Source Spec");
    expect(text).toContain("Auth Redesign Spec");
    expect(text).toContain("page spec-42");
    expect(text).toContain("### Implementation Status (markdown to publish)");
    expect(text).toContain("```markdown");
    expect(text).toContain("## Implementation Status");
    expect(text).toContain("Publish status back to the source spec");
  });

  it("does not render the spec section or publishable block when no link exists", async () => {
    vi.spyOn(JiraClient.prototype, "getEpicIssues").mockResolvedValue([makeIssue("BP-1", "Done", "Done", 3)]);

    const { server, getTool } = createMockServer();
    registerInsightsTool(server, () => kb);
    const insights = getTool("insights");
    const result = await insights({ action: "epic-progress", epicKey: "BP-100" });
    const text = result.content[0]?.text ?? "";

    expect(text).not.toContain("## Source Spec");
    expect(text).not.toContain("Implementation Status (markdown to publish)");
  });

  it("includes the epic page title as the epic summary in the status section", async () => {
    kb.upsertEpicSpecLink({
      issueKey: "BP-100",
      pageId: "spec-42",
      pageTitle: "Auth Redesign Spec",
      pageUrl: null,
    });

    vi.spyOn(JiraClient.prototype, "getEpicIssues").mockResolvedValue([makeIssue("BP-1", "Done", "Done", 3)]);

    const { server, getTool } = createMockServer();
    registerInsightsTool(server, () => kb);
    const insights = getTool("insights");
    const result = await insights({ action: "epic-progress", epicKey: "BP-100" });
    const text = result.content[0]?.text ?? "";

    expect(text).toContain("Auth Redesign Spec");
    expect(text).toContain("**Completion:** 100%");
  });

  it("does not crash when getSpecLinksByIssue throws — graceful degradation", async () => {
    const link = vi.spyOn(KnowledgeBase.prototype, "getSpecLinksByIssue").mockImplementation(() => {
      throw new Error("db gone");
    });
    vi.spyOn(JiraClient.prototype, "getEpicIssues").mockResolvedValue([makeIssue("BP-1", "Done", "Done", 3)]);

    const { server, getTool } = createMockServer();
    registerInsightsTool(server, () => kb);
    const insights = getTool("insights");
    const result = await insights({ action: "epic-progress", epicKey: "BP-100" });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text ?? "").toContain("Epic Progress: BP-100");
    link.mockRestore();
  });
});

describe("insights epic-progress — freshness loop (Stage D3)", () => {
  let kb: KnowledgeBase;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "lb-insights-fresh-"));
    kb = new KnowledgeBase(join(tmpDir, "test.db"));
    setTestEnv();
    JiraClient.saveSchemaToDb(kb, testSchema);
  });

  afterEach(() => {
    kb.close();
    rmSync(tmpDir, { recursive: true, force: true });
    restoreEnv();
  });

  it("flags the spec as stale and marks the epic complete when all issues are Done", async () => {
    kb.upsertEpicSpecLink({ issueKey: "BP-100", pageId: "spec-42", pageTitle: "Spec" });

    vi.spyOn(JiraClient.prototype, "getEpicIssues").mockResolvedValue([
      makeIssue("BP-1", "Done", "Done", 3),
      makeIssue("BP-2", "Done", "Done", 5),
    ]);

    const { server, getTool } = createMockServer();
    registerInsightsTool(server, () => kb);
    const insights = getTool("insights");
    const result = await insights({ action: "epic-progress", epicKey: "BP-100" });

    const text = result.content[0]?.text ?? "";
    expect(text).toContain("epic complete");
    expect(text).toContain("flagged stale now");
    expect(text).toContain("Epic complete — update the spec");

    const link = kb.getSpecLinksByIssue("BP-100")[0];
    expect(link?.completed_at).toMatch(/^\d{4}-/);
    expect(link?.stale_flagged_at).toMatch(/^\d{4}-/);
  });

  it("does not flag the spec stale when the epic is not yet complete", async () => {
    kb.upsertEpicSpecLink({ issueKey: "BP-100", pageId: "spec-42" });

    vi.spyOn(JiraClient.prototype, "getEpicIssues").mockResolvedValue([
      makeIssue("BP-1", "Done", "Done", 3),
      makeIssue("BP-2", "In Progress", "indeterminate", 5),
    ]);

    const { server, getTool } = createMockServer();
    registerInsightsTool(server, () => kb);
    const insights = getTool("insights");
    await insights({ action: "epic-progress", epicKey: "BP-100" });

    const link = kb.getSpecLinksByIssue("BP-100")[0];
    expect(link?.completed_at).toBeNull();
    expect(link?.stale_flagged_at).toBeNull();
  });

  it("preserves a pre-existing stale_flagged_at and does not reflag on subsequent completion reads", async () => {
    kb.upsertEpicSpecLink({ issueKey: "BP-100", pageId: "spec-42" });
    kb.flagSpecStale("BP-100", "spec-42");
    const firstStamp = kb.getSpecLinksByIssue("BP-100")[0]?.stale_flagged_at;
    expect(firstStamp).toMatch(/^\d{4}-/);

    vi.spyOn(JiraClient.prototype, "getEpicIssues").mockResolvedValue([makeIssue("BP-1", "Done", "Done", 3)]);

    const { server, getTool } = createMockServer();
    registerInsightsTool(server, () => kb);
    const insights = getTool("insights");

    // Re-run after a guaranteed clock tick.
    await new Promise((r) => setTimeout(r, 5));
    await insights({ action: "epic-progress", epicKey: "BP-100" });

    expect(kb.getSpecLinksByIssue("BP-100")[0]?.stale_flagged_at).toBe(firstStamp);
  });
});
