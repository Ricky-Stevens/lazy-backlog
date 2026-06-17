/**
 * Stage D (D1) — spec-grounded `issues create` flow.
 *
 * Covers: preview includes spec content, confirmed create persists a KB
 * spec link + best-effort Jira remote link, and the bulk-create path
 * applies the link to every created issue.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { KnowledgeBase } from "../lib/db.js";
import type { IndexedPage } from "../lib/db-types.js";
import { JiraClient, type JiraSchema } from "../lib/jira.js";
import { registerIssuesTool } from "../tools/issues.js";
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

function seedSpec(kb: KnowledgeBase, overrides: Partial<IndexedPage> = {}): IndexedPage {
  const page: IndexedPage = {
    id: "spec-42",
    space_key: "ENG",
    title: "Auth Redesign Spec",
    url: "https://test.atlassian.net/wiki/spaces/ENG/pages/spec-42",
    content: "## Goal\n\nReplace legacy session cookies with JWT.\n\nAcceptance: rollout behind a feature flag.",
    page_type: "spec",
    labels: "[]",
    parent_id: null,
    author_id: null,
    created_at: null,
    updated_at: null,
    indexed_at: new Date().toISOString(),
    source: "confluence",
    content_hash: null,
    ...overrides,
  };
  kb.upsertPage(page);
  return page;
}

describe("issues create — spec-grounded (Stage D1)", () => {
  let kb: KnowledgeBase;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "lb-issues-spec-"));
    kb = new KnowledgeBase(join(tmpDir, "test.db"));
    setTestEnv();
    JiraClient.saveSchemaToDb(kb, testSchema);
  });

  afterEach(() => {
    kb.close();
    rmSync(tmpDir, { recursive: true, force: true });
    restoreEnv();
  });

  it("preview inlines the source spec content when sourcePageId resolves", async () => {
    seedSpec(kb);
    const { server, getTool } = createMockServer();
    registerIssuesTool(server, () => kb);

    const issues = getTool("issues");
    const result = await issues({
      action: "create",
      summary: "Wire up /auth/login",
      sourcePageId: "spec-42",
    });
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("## Source Spec");
    expect(text).toContain("Auth Redesign Spec");
    expect(text).toContain("**Page ID:** spec-42");
    expect(text).toContain("Replace legacy session cookies with JWT.");
  });

  it("preview warns when sourcePageId is not indexed", async () => {
    const { server, getTool } = createMockServer();
    registerIssuesTool(server, () => kb);

    const issues = getTool("issues");
    const result = await issues({
      action: "create",
      summary: "Wire up /auth/login",
      sourcePageId: "missing-spec",
    });
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("Source spec not found");
    expect(text).toContain("missing-spec");
  });

  it("confirmed create persists a KB spec link and adds a Jira remote link", async () => {
    seedSpec(kb);
    const { server, getTool } = createMockServer();
    registerIssuesTool(server, () => kb);

    const createSpy = vi
      .spyOn(JiraClient.prototype, "createIssue")
      .mockResolvedValue({ id: "1", key: "BP-500", self: "" });
    const remoteSpy = vi.spyOn(JiraClient.prototype, "addRemoteLink").mockResolvedValue({ id: 99 });

    const issues = getTool("issues");
    const result = await issues({
      action: "create",
      summary: "Wire up /auth/login",
      sourcePageId: "spec-42",
      confirmed: true,
    });

    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(createSpy.mock.calls[0]?.[0]?.description).toContain("Source spec: [Auth Redesign Spec]");

    expect(remoteSpy).toHaveBeenCalledTimes(1);
    expect(remoteSpy).toHaveBeenCalledWith(
      "BP-500",
      expect.objectContaining({
        url: "https://test.atlassian.net/wiki/spaces/ENG/pages/spec-42",
        title: "Auth Redesign Spec",
        globalId: "lazy-backlog-spec-confluence-spec-42",
      }),
    );

    const links = kb.getSpecLinksByIssue("BP-500");
    expect(links).toHaveLength(1);
    expect(links[0]?.page_id).toBe("spec-42");

    const text = result.content[0]?.text ?? "";
    expect(text).toContain("BP-500");
    expect(text).toContain("Source spec");
    expect(text).toContain("Publish implementation status back to the source spec");
  });

  it("confirmed create still records the KB link when the Jira remote-link call fails", async () => {
    seedSpec(kb);
    const { server, getTool } = createMockServer();
    registerIssuesTool(server, () => kb);

    vi.spyOn(JiraClient.prototype, "createIssue").mockResolvedValue({ id: "1", key: "BP-501", self: "" });
    vi.spyOn(JiraClient.prototype, "addRemoteLink").mockRejectedValue(new Error("forbidden"));

    const issues = getTool("issues");
    const result = await issues({
      action: "create",
      summary: "Wire up /auth/login",
      sourcePageId: "spec-42",
      confirmed: true,
    });

    expect(kb.getSpecLinksByIssue("BP-501")).toHaveLength(1);
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("could not attach Jira remote link");
    expect(text).toContain("forbidden");
  });

  it("confirmed create surfaces a hint when sourcePageId points to a page that isn't indexed", async () => {
    const { server, getTool } = createMockServer();
    registerIssuesTool(server, () => kb);

    vi.spyOn(JiraClient.prototype, "createIssue").mockResolvedValue({ id: "1", key: "BP-502", self: "" });
    const remoteSpy = vi.spyOn(JiraClient.prototype, "addRemoteLink");

    const issues = getTool("issues");
    const result = await issues({
      action: "create",
      summary: "Wire up /auth/login",
      sourcePageId: "ghost-spec",
      confirmed: true,
    });

    expect(remoteSpy).not.toHaveBeenCalled();
    expect(kb.getSpecLinksByIssue("BP-502")).toHaveLength(0);
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("sourcePageId='ghost-spec' was not found");
  });

  it("does not double-append the spec reference when the description already mentions the page id", async () => {
    seedSpec(kb);
    const { server, getTool } = createMockServer();
    registerIssuesTool(server, () => kb);

    const createSpy = vi
      .spyOn(JiraClient.prototype, "createIssue")
      .mockResolvedValue({ id: "1", key: "BP-503", self: "" });
    vi.spyOn(JiraClient.prototype, "addRemoteLink").mockResolvedValue({ id: 1 });

    const issues = getTool("issues");
    await issues({
      action: "create",
      summary: "Wire up /auth/login",
      description: "Detailed spec — see page spec-42 for context.",
      sourcePageId: "spec-42",
      confirmed: true,
    });

    const passedDesc = createSpy.mock.calls[0]?.[0]?.description ?? "";
    expect((passedDesc.match(/page spec-42/g) ?? []).length).toBe(1);
  });

  it("bulk create persists spec links for every created issue", async () => {
    seedSpec(kb);
    const { server, getTool } = createMockServer();
    registerIssuesTool(server, () => kb);

    vi.spyOn(JiraClient.prototype, "createIssuesBatch").mockResolvedValue({
      issues: [
        { id: "1", key: "BP-601", self: "" },
        { id: "2", key: "BP-602", self: "" },
      ],
      errors: [],
    });
    const remoteSpy = vi.spyOn(JiraClient.prototype, "addRemoteLink").mockResolvedValue({ id: 1 });

    const issues = getTool("issues");
    await issues({
      action: "create",
      tickets: [
        { summary: "A", issueType: "Task", labels: [], components: [], priority: "Medium" },
        { summary: "B", issueType: "Task", labels: [], components: [], priority: "Medium" },
      ],
      sourcePageId: "spec-42",
      confirmed: true,
    });

    expect(remoteSpy).toHaveBeenCalledTimes(2);
    expect(
      kb
        .getSpecLinksByPage("spec-42")
        .map((l) => l.issue_key)
        .sort(),
    ).toEqual(["BP-601", "BP-602"]);
  });

  it("rejects a source page that belongs to a different source than requested", async () => {
    seedSpec(kb, { source: "github" });
    const { server, getTool } = createMockServer();
    registerIssuesTool(server, () => kb);

    vi.spyOn(JiraClient.prototype, "createIssue").mockResolvedValue({ id: "1", key: "BP-700", self: "" });
    const remoteSpy = vi.spyOn(JiraClient.prototype, "addRemoteLink");

    const issues = getTool("issues");
    await issues({
      action: "create",
      summary: "Wire up /auth/login",
      sourcePageId: "spec-42",
      sourcePageSource: "confluence",
      confirmed: true,
    });

    expect(remoteSpy).not.toHaveBeenCalled();
    expect(kb.getSpecLinksByIssue("BP-700")).toHaveLength(0);
  });
});
