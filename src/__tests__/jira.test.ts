import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { KnowledgeBase } from "../lib/db.js";
import { JiraClient, type JiraSchema, type JiraTicketInput, markdownToAdf } from "../lib/jira.js";

/** Loose ADF node shape for test assertions (avoids strict union narrowing). */
type AnyAdfNode = {
  type: string;
  text?: string;
  content?: AnyAdfNode[];
  attrs?: Record<string, unknown>;
  marks?: { type: string; attrs?: Record<string, string> }[];
};

// Helper to extract fetch call body
function getCallBody(callIndex: number): Record<string, unknown> {
  const call = fetchMock.mock.calls[callIndex];
  return JSON.parse(call?.[1]?.body as string);
}

// ── Fetch mock helpers ───────────────────────────────────────────────────────

const originalFetch = globalThis.fetch;
let fetchMock: Mock;

function mockFetchResponse(body: unknown, status = 200) {
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

function mockFetchError(status: number, body: string) {
  fetchMock.mockResolvedValueOnce(new Response(body, { status, headers: { "Content-Type": "text/plain" } }));
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

// ── Test schema for JiraClient ───────────────────────────────────────────────

const testSchema: JiraSchema = {
  projectKey: "BP",
  projectName: "Backlog Project",
  boardId: "266",
  issueTypes: [
    {
      id: "1",
      name: "Task",
      subtask: false,
      fields: [
        { id: "summary", name: "Summary", type: "string", required: true, system: "summary" },
        { id: "customfield_10016", name: "Story Points", type: "number", required: false },
        {
          id: "components",
          name: "Components",
          type: "array",
          required: false,
          system: "components",
          allowedValues: [
            { id: "10001", name: "Backend" },
            { id: "10002", name: "Frontend" },
          ],
        },
        {
          id: "customfield_999",
          name: "Environment",
          type: "option",
          required: true,
          custom: "select",
          allowedValues: [
            { id: "env-1", name: "Production" },
            { id: "env-2", name: "Staging" },
          ],
        },
      ],
      requiredFields: ["summary", "customfield_999"],
    },
  ],
  priorities: [
    { id: "1", name: "High" },
    { id: "2", name: "Medium" },
  ],
  statuses: [],
  board: {
    name: "Sprint Board",
    type: "scrum",
    teamFieldId: "customfield_100",
    teamId: "team-uuid",
    teamName: "Wall-E",
  },
};

const testConfig = {
  siteUrl: "https://test.atlassian.net",
  email: "test@example.com",
  apiToken: "tok_123",
  jiraProjectKey: "BP",
  confluenceSpaces: [],
  rootPageIds: [],
};

// ── markdownToAdf ────────────────────────────────────────────────────────────

describe("markdownToAdf", () => {
  /** Cast helper — markdownToAdf returns strict AdfNode; tests need loose access. */
  const toAdf = (md: string) => markdownToAdf(md) as unknown as AnyAdfNode;

  it("returns a doc node with version 1", () => {
    const adf = toAdf("Hello");
    expect(adf.type).toBe("doc");
    expect((adf as Record<string, unknown>).version).toBe(1);
    expect(adf.content).toBeDefined();
  });

  it("converts plain text to a paragraph", () => {
    const adf = toAdf("Hello world");
    expect(adf.content).toHaveLength(1);
    expect(adf.content?.[0]?.type).toBe("paragraph");
  });

  it("converts headings (h1-h6)", () => {
    const adf = toAdf("# Title\n## Subtitle\n### Section");
    expect(adf.content).toHaveLength(3);
    expect(adf.content?.[0]?.type).toBe("heading");
    expect(adf.content?.[0]?.attrs).toEqual({ level: 1 });
  });

  it("converts bullet lists", () => {
    const adf = toAdf("- Item one\n- Item two\n- Item three");
    expect(adf.content).toHaveLength(1);
    expect(adf.content?.[0]?.type).toBe("bulletList");
    expect(adf.content?.[0]?.content).toHaveLength(3);
  });

  it("converts ordered lists", () => {
    const adf = toAdf("1. First\n2. Second\n3. Third");
    expect(adf.content).toHaveLength(1);
    expect(adf.content?.[0]?.type).toBe("orderedList");
    expect(adf.content?.[0]?.content).toHaveLength(3);
  });

  it("nests bullet sub-items under parent item", () => {
    const adf = toAdf("- Parent\n  - Child one\n  - Child two\n- Second parent");
    expect(adf.content).toHaveLength(1);
    const list = adf.content?.[0];
    expect(list?.type).toBe("bulletList");
    expect(list?.content).toHaveLength(2);
    // First item has a nested bulletList
    const firstItem = list?.content?.[0];
    expect(firstItem?.content).toHaveLength(2); // paragraph + nested list
    const nestedList = firstItem?.content?.[1];
    expect(nestedList?.type).toBe("bulletList");
    expect(nestedList?.content).toHaveLength(2);
  });

  it("nests ordered sub-items under bullet parent", () => {
    const adf = toAdf("- Parent\n  1. Step one\n  2. Step two");
    const firstItem = adf.content?.[0]?.content?.[0];
    const nestedList = firstItem?.content?.[1];
    expect(nestedList?.type).toBe("orderedList");
    expect(nestedList?.content).toHaveLength(2);
  });

  it("handles deeply nested lists", () => {
    const adf = toAdf("- L1\n  - L2\n    - L3");
    const l1Item = adf.content?.[0]?.content?.[0];
    const l2List = l1Item?.content?.[1];
    expect(l2List?.type).toBe("bulletList");
    const l2Item = l2List?.content?.[0];
    const l3List = l2Item?.content?.[1];
    expect(l3List?.type).toBe("bulletList");
    expect(l3List?.content).toHaveLength(1);
  });

  it("converts code blocks with language", () => {
    const adf = toAdf("```typescript\nconst x = 1;\n```");
    expect(adf.content?.[0]?.type).toBe("codeBlock");
    expect(adf.content?.[0]?.attrs).toEqual({ language: "typescript" });
  });

  it("converts code blocks without language", () => {
    const adf = toAdf("```\nsome code\n```");
    expect(adf.content?.[0]?.type).toBe("codeBlock");
  });

  it("converts horizontal rules", () => {
    const adf = toAdf("Above\n\n---\n\nBelow");
    const rule = adf.content?.find((n) => n.type === "rule");
    expect(rule).toBeDefined();
  });

  it("handles bold inline formatting", () => {
    const adf = toAdf("This is **bold** text");
    const para = adf.content?.[0];
    const boldNode = para?.content?.find((n) => n.marks?.some((m) => m.type === "strong"));
    expect(boldNode).toBeDefined();
    expect(boldNode?.text).toBe("bold");
  });

  it("handles italic inline formatting", () => {
    const adf = toAdf("This is *italic* text");
    const para = adf.content?.[0];
    const italicNode = para?.content?.find((n) => n.marks?.some((m) => m.type === "em"));
    expect(italicNode).toBeDefined();
  });

  it("handles inline code formatting", () => {
    const adf = toAdf("Use `bun test` to run");
    const para = adf.content?.[0];
    const codeNode = para?.content?.find((n) => n.marks?.some((m) => m.type === "code"));
    expect(codeNode).toBeDefined();
    expect(codeNode?.text).toBe("bun test");
  });

  it("converts markdown links to ADF link marks", () => {
    const adf = toAdf("See [Confluence](https://example.com/wiki) for details");
    const para = adf.content?.[0];
    const linkNode = para?.content?.find((n) => n.marks?.some((m) => m.type === "link"));
    expect(linkNode).toBeDefined();
    expect(linkNode?.text).toBe("Confluence");
    expect(linkNode?.marks?.[0]?.attrs?.href).toBe("https://example.com/wiki");
  });

  it("converts bare URLs to ADF link marks", () => {
    const adf = toAdf("Visit https://example.com/page for more info");
    const para = adf.content?.[0];
    const linkNode = para?.content?.find((n) => n.marks?.some((m) => m.type === "link"));
    expect(linkNode).toBeDefined();
    expect(linkNode?.text).toBe("https://example.com/page");
    expect(linkNode?.marks?.[0]?.attrs?.href).toBe("https://example.com/page");
  });

  it("handles multiple links in one line", () => {
    const adf = toAdf("[A](https://a.com) and [B](https://b.com)");
    const para = adf.content?.[0];
    const linkNodes = para?.content?.filter((n) => n.marks?.some((m) => m.type === "link"));
    expect(linkNodes).toHaveLength(2);
    expect(linkNodes?.[0]?.text).toBe("A");
    expect(linkNodes?.[1]?.text).toBe("B");
  });

  it("converts task list items to taskList/taskItem nodes", () => {
    const adf = toAdf("- [ ] Todo item\n- [x] Done item");
    expect(adf.content).toHaveLength(1);
    const taskList = adf.content?.[0];
    expect(taskList?.type).toBe("taskList");
    expect(taskList?.content).toHaveLength(2);
    expect(taskList?.content?.[0]?.type).toBe("taskItem");
    expect(taskList?.content?.[0]?.attrs?.state).toBe("TODO");
    expect(taskList?.content?.[0]?.content?.[0]?.text).toBe("Todo item");
    expect(taskList?.content?.[1]?.attrs?.state).toBe("DONE");
    expect(taskList?.content?.[1]?.content?.[0]?.text).toBe("Done item");
  });

  it("handles uppercase X in task list", () => {
    const adf = toAdf("- [X] Also done");
    const taskItem = adf.content?.[0]?.content?.[0];
    expect(taskItem?.attrs?.state).toBe("DONE");
  });

  it("keeps task lists separate from bullet lists", () => {
    const adf = toAdf("- [ ] Task\n- Regular bullet");
    expect(adf.content).toHaveLength(2);
    expect(adf.content?.[0]?.type).toBe("taskList");
    expect(adf.content?.[1]?.type).toBe("bulletList");
  });

  it("skips empty lines", () => {
    const adf = toAdf("Line one\n\n\n\nLine two");
    const paragraphs = adf.content?.filter((n) => n.type === "paragraph");
    expect(paragraphs).toHaveLength(2);
  });

  it("handles empty input", () => {
    const adf = toAdf("");
    expect(adf.type).toBe("doc");
    expect(adf.content).toHaveLength(0);
  });

  it("handles mixed content", () => {
    const md = "# Title\n\nSome text\n\n- List item\n\n```\ncode\n```\n\n---\n\nEnd";
    const adf = toAdf(md);
    const types = adf.content?.map((n) => n.type);
    expect(types).toContain("heading");
    expect(types).toContain("paragraph");
    expect(types).toContain("bulletList");
    expect(types).toContain("codeBlock");
    expect(types).toContain("rule");
  });
});

// ── JiraClient ───────────────────────────────────────────────────────────────

describe("JiraClient", () => {
  describe("createIssue", () => {
    it("creates a basic issue", async () => {
      const client = new JiraClient(testConfig, testSchema);
      mockFetchResponse({ id: "10001", key: "BP-100", self: "https://test.atlassian.net/rest/api/3/issue/10001" });

      const result = await client.createIssue({
        summary: "Test ticket",
        issueType: "Task",
      });

      expect(result.key).toBe("BP-100");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("includes description as ADF", async () => {
      const client = new JiraClient(testConfig, testSchema);
      mockFetchResponse({ id: "10001", key: "BP-101", self: "" });

      await client.createIssue({
        summary: "With description",
        issueType: "Task",
        description: "# Context\nSome details",
      });

      const body = getCallBody(0);
      expect(body.fields).toHaveProperty("description");
      expect((body.fields as Record<string, unknown>).description).toHaveProperty("type", "doc");
    });

    it("includes priority when specified", async () => {
      const client = new JiraClient(testConfig, testSchema);
      mockFetchResponse({ id: "10001", key: "BP-102", self: "" });

      await client.createIssue({
        summary: "High priority",
        issueType: "Task",
        priority: "High",
      });

      const body = getCallBody(0);
      expect(body.fields).toHaveProperty("priority", { name: "High" });
    });

    it("includes labels when specified", async () => {
      const client = new JiraClient(testConfig, testSchema);
      mockFetchResponse({ id: "10001", key: "BP-103", self: "" });

      await client.createIssue({
        summary: "Labeled ticket",
        issueType: "Task",
        labels: ["tech-debt", "auth"],
      });

      const body = getCallBody(0);
      expect(body.fields).toHaveProperty("labels", ["tech-debt", "auth"]);
    });

    it("includes parent key for sub-tasks", async () => {
      const client = new JiraClient(testConfig, testSchema);
      mockFetchResponse({ id: "10001", key: "BP-104", self: "" });

      await client.createIssue({
        summary: "Sub-task",
        issueType: "Task",
        parentKey: "BP-50",
      });

      const body = getCallBody(0);
      expect(body.fields).toHaveProperty("parent", { key: "BP-50" });
    });

    it("resolves story points to custom field", async () => {
      const client = new JiraClient(testConfig, testSchema);
      mockFetchResponse({ id: "10001", key: "BP-105", self: "" });

      await client.createIssue({
        summary: "Pointed ticket",
        issueType: "Task",
        storyPoints: 5,
      });

      const body = getCallBody(0);
      expect(body.fields).toHaveProperty("customfield_10016", 5);
    });

    it("resolves components by name", async () => {
      const client = new JiraClient(testConfig, testSchema);
      mockFetchResponse({ id: "10001", key: "BP-106", self: "" });

      await client.createIssue({
        summary: "With components",
        issueType: "Task",
        components: ["Backend"],
      });

      const body = getCallBody(0);
      expect(body.fields).toHaveProperty("components", [{ id: "10001" }]);
    });

    it("auto-fills required fields with first allowed value", async () => {
      const client = new JiraClient(testConfig, testSchema);
      mockFetchResponse({ id: "10001", key: "BP-107", self: "" });

      await client.createIssue({
        summary: "Auto-filled",
        issueType: "Task",
      });

      const body = getCallBody(0);
      // customfield_999 (Environment) is required, should be auto-filled
      expect(body.fields).toHaveProperty("customfield_999", { id: "env-1" });
    });

    it("auto-assigns team from board config", async () => {
      const client = new JiraClient(testConfig, testSchema);
      mockFetchResponse({ id: "10001", key: "BP-108", self: "" });

      await client.createIssue({
        summary: "With team",
        issueType: "Task",
      });

      const body = getCallBody(0);
      expect(body.fields).toHaveProperty("customfield_100", "team-uuid");
    });

    it("throws on HTTP error", async () => {
      const client = new JiraClient(testConfig, testSchema);
      mockFetchError(400, '{"errorMessages":["Field required"],"errors":{}}');

      await expect(client.createIssue({ summary: "Bad", issueType: "Task" })).rejects.toThrow("Jira 400");
    });
  });

  describe("getIssue", () => {
    it("fetches and maps issue fields", async () => {
      const client = new JiraClient(testConfig, testSchema);
      mockFetchResponse({
        key: "BP-1",
        id: "10001",
        fields: {
          summary: "Fix auth bug",
          description: {
            type: "doc",
            content: [
              { type: "paragraph", content: [{ type: "text", text: "Fix the auth" }] },
              { type: "heading", content: [{ type: "text", text: "Steps" }] },
              {
                type: "bulletList",
                content: [
                  { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Step 1" }] }] },
                ],
              },
              { type: "codeBlock", content: [{ type: "text", text: "const x = 1" }] },
              { type: "hardBreak" },
            ],
          },
          issuetype: { name: "Bug" },
          priority: { name: "High" },
          status: { name: "In Progress" },
          labels: ["auth"],
          components: [{ name: "Backend" }],
          parent: { key: "BP-0" },
          assignee: { displayName: "Ricky" },
          reporter: { displayName: "Alice" },
          created: "2025-01-01T00:00:00Z",
          updated: "2025-06-01T00:00:00Z",
          comment: {
            comments: [
              {
                author: { displayName: "Bob" },
                created: "2025-06-01T00:00:00Z",
                body: {
                  type: "doc",
                  content: [{ type: "paragraph", content: [{ type: "text", text: "Looks good" }] }],
                },
              },
            ],
          },
        },
      });

      const issue = await client.getIssue("BP-1");
      expect(issue.key).toBe("BP-1");
      expect(issue.summary).toBe("Fix auth bug");
      expect(issue.description).toContain("Fix the auth");
      expect(issue.description).toContain("Steps");
      expect(issue.description).toContain("- Step 1");
      expect(issue.description).toContain("```");
      expect(issue.issueType).toBe("Bug");
      expect(issue.priority).toBe("High");
      expect(issue.status).toBe("In Progress");
      expect(issue.labels).toEqual(["auth"]);
      expect(issue.components).toEqual(["Backend"]);
      expect(issue.parentKey).toBe("BP-0");
      expect(issue.assignee).toBe("Ricky");
      expect(issue.comments).toHaveLength(1);
      expect(issue.comments[0]?.body).toContain("Looks good");
      expect(issue.url).toContain("BP-1");
    });

    it("handles issue without description", async () => {
      const client = new JiraClient(testConfig, testSchema);
      mockFetchResponse({
        key: "BP-2",
        id: "10002",
        fields: {
          summary: "No description",
          issuetype: { name: "Task" },
          priority: { name: "Medium" },
          status: { name: "To Do" },
          labels: [],
          components: [],
          created: "2025-01-01T00:00:00Z",
          updated: "2025-06-01T00:00:00Z",
        },
      });

      const issue = await client.getIssue("BP-2");
      expect(issue.description).toBeUndefined();
    });
  });

  describe("updateIssue", () => {
    it("updates issue fields", async () => {
      const client = new JiraClient(testConfig, testSchema);
      // First call: GET to fetch issue type
      mockFetchResponse({ fields: { issuetype: { name: "Task" } } });
      // Second call: PUT to update
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

      await client.updateIssue({
        issueKey: "BP-1",
        summary: "Updated summary",
        priority: "High",
      });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const putCall = fetchMock.mock.calls[1];
      expect(putCall?.[1]?.method).toBe("PUT");
      const body = getCallBody(1);
      expect(body.fields).toHaveProperty("summary", "Updated summary");
    });

    it("throws when no fields to update", async () => {
      const client = new JiraClient(testConfig, testSchema);
      mockFetchResponse({ fields: { issuetype: { name: "Task" } } });

      await expect(client.updateIssue({ issueKey: "BP-1" })).rejects.toThrow("No fields to update");
    });

    it("includes comment in update", async () => {
      const client = new JiraClient(testConfig, testSchema);
      mockFetchResponse({ fields: { issuetype: { name: "Task" } } });
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

      await client.updateIssue({ issueKey: "BP-1", comment: "Done" });

      const body = getCallBody(1);
      expect((body.update as Record<string, unknown[]>).comment?.[0]).toHaveProperty("add");
    });
  });

  describe("resolveCustomFields via namedFields", () => {
    it("resolves named fields with allowed values", async () => {
      const client = new JiraClient(testConfig, testSchema);
      mockFetchResponse({ id: "10001", key: "BP-200", self: "" });

      await client.createIssue({
        summary: "Named field test",
        issueType: "Task",
        namedFields: { Environment: "Staging" },
      });

      const body = getCallBody(0);
      expect(body.fields).toHaveProperty("customfield_999", { id: "env-2" });
    });

    it("sets field to null when value is null", async () => {
      const client = new JiraClient(testConfig, testSchema);
      mockFetchResponse({ id: "10001", key: "BP-201", self: "" });

      await client.createIssue({
        summary: "Null field test",
        issueType: "Task",
        namedFields: { Environment: null },
      });

      const body = getCallBody(0);
      expect(body.fields).toHaveProperty("customfield_999", null);
    });
  });

  describe("schema DB operations", () => {
    let kb: KnowledgeBase;
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), "lb-jira-test-"));
      kb = new KnowledgeBase(join(tmpDir, "test.db"));
    });

    afterEach(() => {
      kb.close();
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("saves and loads schema from DB", () => {
      JiraClient.saveSchemaToDb(kb, testSchema);
      const loaded = JiraClient.loadSchemaFromDb(kb);
      expect(loaded).toBeDefined();
      expect(loaded?.projectKey).toBe("BP");
      expect(loaded?.issueTypes).toHaveLength(1);
    });

    it("returns null for missing schema", () => {
      expect(JiraClient.loadSchemaFromDb(kb)).toBeNull();
    });

    it("returns null for corrupt schema", () => {
      kb.setConfig("jira-schema", "not-json{{{");
      expect(JiraClient.loadSchemaFromDb(kb)).toBeNull();
    });
  });

  describe("createIssuesBatch", () => {
    it("creates multiple issues and returns results", async () => {
      const client = new JiraClient(testConfig, testSchema);
      mockFetchResponse({ id: "1", key: "BP-1", self: "" });
      mockFetchResponse({ id: "2", key: "BP-2", self: "" });

      const inputs: JiraTicketInput[] = [
        { summary: "Ticket 1", issueType: "Task" },
        { summary: "Ticket 2", issueType: "Task" },
      ];

      const result = await client.createIssuesBatch(inputs);
      expect(result.issues).toHaveLength(2);
      expect(result.errors).toHaveLength(0);
    });

    it("captures errors without stopping batch", async () => {
      const client = new JiraClient(testConfig, testSchema);
      mockFetchResponse({ id: "1", key: "BP-1", self: "" });
      mockFetchError(400, '{"errorMessages":["Bad request"],"errors":{}}');

      const inputs: JiraTicketInput[] = [
        { summary: "Good ticket", issueType: "Task" },
        { summary: "Bad ticket", issueType: "Task" },
      ];

      const result = await client.createIssuesBatch(inputs);
      expect(result.issues).toHaveLength(1);
      expect(result.errors).toHaveLength(1);
    });
  });

  describe("getFieldGuide", () => {
    it("returns formatted field guide for known issue type", () => {
      const client = new JiraClient(testConfig, testSchema);
      const guide = client.getFieldGuide("Task");
      expect(guide).toContain("## Fields for Task");
      expect(guide).toContain("**Summary**");
      expect(guide).toContain("**REQUIRED**");
      expect(guide).toContain("**Story Points**");
      expect(guide).toContain("optional");
      expect(guide).toContain("Values:");
    });

    it("returns null for unknown issue type", () => {
      const client = new JiraClient(testConfig, testSchema);
      expect(client.getFieldGuide("NonExistent")).toBeNull();
    });

    it("returns null without schema", () => {
      const client = new JiraClient(testConfig);
      expect(client.getFieldGuide("Task")).toBeNull();
    });
  });

  describe("searchIssues", () => {
    it("returns parsed issues for valid JQL", async () => {
      const client = new JiraClient(testConfig, testSchema);
      mockFetchResponse({
        issues: [
          { key: "BP-1", id: "1", fields: { summary: "Issue 1", status: { name: "To Do" } } },
          { key: "BP-2", id: "2", fields: { summary: "Issue 2", status: { name: "Done" } } },
        ],
        total: 2,
      });

      const result = await client.searchIssues("project = BP ORDER BY created DESC");
      expect(result.issues).toHaveLength(2);
      expect(result.total).toBe(2);
      expect(result.issues[0]?.key).toBe("BP-1");
    });

    it("returns empty array for no matches", async () => {
      const client = new JiraClient(testConfig, testSchema);
      mockFetchResponse({ issues: [], total: 0 });

      const result = await client.searchIssues("project = BP AND summary ~ nonexistent");
      expect(result.issues).toHaveLength(0);
      expect(result.total).toBe(0);
    });

    it("respects maxResults parameter", async () => {
      const client = new JiraClient(testConfig, testSchema);
      mockFetchResponse({ issues: [], total: 0 });

      await client.searchIssues("project = BP", undefined, 10);
      const call = fetchMock.mock.calls[0];
      const url = new URL((call?.[0] ?? "") as string);
      expect(url.searchParams.get("maxResults")).toBe("10");
    });

    it("handles 400 (invalid JQL)", async () => {
      const client = new JiraClient(testConfig, testSchema);
      mockFetchError(400, '{"errorMessages":["Invalid JQL"],"errors":{}}');

      await expect(client.searchIssues("INVALID JQL !!!")).rejects.toThrow("Jira 400");
    });
  });

  describe("listSprints", () => {
    it("returns sprints for board", async () => {
      const client = new JiraClient(testConfig, testSchema);
      mockFetchResponse({
        maxResults: 50,
        startAt: 0,
        isLast: true,
        values: [
          { id: 1, name: "Sprint 1", state: "active" },
          { id: 2, name: "Sprint 2", state: "future" },
        ],
      });

      const sprints = await client.listSprints("266");
      expect(sprints).toHaveLength(2);
      expect(sprints[0]?.name).toBe("Sprint 1");
    });

    it("filters by state parameter", async () => {
      const client = new JiraClient(testConfig, testSchema);
      mockFetchResponse({
        maxResults: 50,
        startAt: 0,
        isLast: true,
        values: [{ id: 1, name: "Sprint 1", state: "active" }],
      });

      await client.listSprints("266", "active");
      const url = fetchMock.mock.calls[0]?.[0] as string;
      expect(url).toContain("state=active");
    });

    it("handles pagination", async () => {
      const client = new JiraClient(testConfig, testSchema);
      mockFetchResponse({
        maxResults: 1,
        startAt: 0,
        isLast: false,
        values: [{ id: 1, name: "Sprint 1", state: "closed" }],
      });
      mockFetchResponse({
        maxResults: 1,
        startAt: 1,
        isLast: true,
        values: [{ id: 2, name: "Sprint 2", state: "active" }],
      });

      const sprints = await client.listSprints("266");
      expect(sprints).toHaveLength(2);
      expect(sprints[1]?.name).toBe("Sprint 2");
    });

    it("returns empty for board with no sprints", async () => {
      const client = new JiraClient(testConfig, testSchema);
      mockFetchResponse({
        maxResults: 50,
        startAt: 0,
        isLast: true,
        values: [],
      });

      const sprints = await client.listSprints("999");
      expect(sprints).toHaveLength(0);
    });
  });

  describe("getSprint", () => {
    it("returns sprint details", async () => {
      const client = new JiraClient(testConfig, testSchema);
      mockFetchResponse({ id: 42, name: "Sprint 42", state: "active", goal: "Ship it" });

      const sprint = await client.getSprint("42");
      expect(sprint.id).toBe(42);
      expect(sprint.name).toBe("Sprint 42");
      expect(sprint.goal).toBe("Ship it");
    });

    it("throws for 404", async () => {
      const client = new JiraClient(testConfig, testSchema);
      mockFetchError(404, "Sprint not found");

      await expect(client.getSprint("9999")).rejects.toThrow("Jira 404");
    });
  });

  describe("getSprintIssues", () => {
    it("returns issues with fields", async () => {
      const client = new JiraClient(testConfig, testSchema);
      mockFetchResponse({
        issues: [{ key: "BP-10", id: "10", fields: { summary: "Sprint issue", status: { name: "To Do" } } }],
        total: 1,
        maxResults: 50,
      });

      const result = await client.getSprintIssues("42");
      expect(result.issues).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(result.issues[0]?.key).toBe("BP-10");
    });

    it("returns empty for sprint with no issues", async () => {
      const client = new JiraClient(testConfig, testSchema);
      mockFetchResponse({ issues: [], total: 0, maxResults: 50 });

      const result = await client.getSprintIssues("42");
      expect(result.issues).toHaveLength(0);
      expect(result.total).toBe(0);
    });
  });

  describe("createSprint", () => {
    it("creates sprint with name and goal", async () => {
      const client = new JiraClient(testConfig, testSchema);
      mockFetchResponse({ id: 99, name: "New Sprint", state: "future", goal: "Deliver feature X" });

      const sprint = await client.createSprint("266", "New Sprint", { goal: "Deliver feature X" });
      expect(sprint.id).toBe(99);
      expect(sprint.name).toBe("New Sprint");
    });

    it("sends correct body to API", async () => {
      const client = new JiraClient(testConfig, testSchema);
      mockFetchResponse({ id: 99, name: "S1", state: "future" });

      await client.createSprint("266", "S1", {
        goal: "Goal",
        startDate: "2026-01-01",
        endDate: "2026-01-14",
      });

      const body = getCallBody(0);
      expect(body.name).toBe("S1");
      expect(body.originBoardId).toBe("266");
      expect(body.goal).toBe("Goal");
      expect(body.startDate).toBe("2026-01-01");
      expect(body.endDate).toBe("2026-01-14");
    });
  });

  describe("moveIssuesToSprint", () => {
    it("sends correct issue keys in body", async () => {
      const client = new JiraClient(testConfig, testSchema);
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

      await client.moveIssuesToSprint("42", ["BP-1", "BP-2", "BP-3"]);

      const body = getCallBody(0);
      expect(body.issues).toEqual(["BP-1", "BP-2", "BP-3"]);
    });
  });

  describe("getIssueChangelog", () => {
    it("returns parsed changelog entries", async () => {
      const client = new JiraClient(testConfig, testSchema);
      mockFetchResponse({
        maxResults: 50,
        startAt: 0,
        isLast: true,
        values: [
          {
            id: "100",
            author: { displayName: "Alice", accountId: "abc123" },
            created: "2026-01-01T00:00:00Z",
            items: [{ field: "status", fromString: "To Do", toString: "In Progress" }],
          },
        ],
      });

      const entries = await client.getIssueChangelog("BP-1");
      expect(entries).toHaveLength(1);
      expect(entries[0]?.author.displayName).toBe("Alice");
      expect(entries[0]?.items[0]?.field).toBe("status");
    });

    it("handles pagination", async () => {
      const client = new JiraClient(testConfig, testSchema);
      mockFetchResponse({
        maxResults: 1,
        startAt: 0,
        isLast: false,
        values: [
          {
            id: "1",
            author: { displayName: "A", accountId: "a" },
            created: "2026-01-01T00:00:00Z",
            items: [{ field: "status", fromString: "To Do", toString: "In Progress" }],
          },
        ],
      });
      mockFetchResponse({
        maxResults: 1,
        startAt: 1,
        isLast: true,
        values: [
          {
            id: "2",
            author: { displayName: "B", accountId: "b" },
            created: "2026-01-02T00:00:00Z",
            items: [{ field: "priority", fromString: "Medium", toString: "High" }],
          },
        ],
      });

      const entries = await client.getIssueChangelog("BP-1");
      expect(entries).toHaveLength(2);
    });

    it("returns empty for no changes", async () => {
      const client = new JiraClient(testConfig, testSchema);
      mockFetchResponse({
        maxResults: 50,
        startAt: 0,
        isLast: true,
        values: [],
      });

      const entries = await client.getIssueChangelog("BP-1");
      expect(entries).toHaveLength(0);
    });
  });

  describe("addComment", () => {
    it("posts ADF-formatted comment", async () => {
      const client = new JiraClient(testConfig, testSchema);
      mockFetchResponse({});

      await client.addComment("BP-1", "This is a **comment**");

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const url = fetchMock.mock.calls[0]?.[0] as string;
      expect(url).toContain("/rest/api/3/issue/BP-1/comment");
    });

    it("includes ADF body in request", async () => {
      const client = new JiraClient(testConfig, testSchema);
      mockFetchResponse({});

      await client.addComment("BP-1", "Hello world");

      const body = getCallBody(0);
      expect(body.body).toHaveProperty("type", "doc");
      expect((body.body as Record<string, unknown>).version).toBe(1);
    });
  });

  describe("addLabels", () => {
    it("sends label add operations", async () => {
      const client = new JiraClient(testConfig, testSchema);
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

      await client.addLabels("BP-1", ["tech-debt", "urgent"]);

      const body = getCallBody(0);
      expect(body.update).toEqual({
        labels: [{ add: "tech-debt" }, { add: "urgent" }],
      });
    });
  });

  describe("loadSchema", () => {
    it("returns null for undefined path", () => {
      expect(JiraClient.loadSchema()).toBeNull();
    });

    it("returns null for nonexistent file", () => {
      expect(JiraClient.loadSchema("/tmp/nonexistent-schema.json")).toBeNull();
    });
  });

  describe("input validation", () => {
    it("rejects invalid issue keys", async () => {
      const client = new JiraClient(testConfig, testSchema);
      await expect(client.getIssue("bad-key")).rejects.toThrow("Invalid issue key");
      await expect(client.getIssue("123-ABC")).rejects.toThrow("Invalid issue key");
      await expect(client.getIssue("BP 1")).rejects.toThrow("Invalid issue key");
      await expect(client.getIssue("")).rejects.toThrow("Invalid issue key");
    });

    it("rejects siteUrl without https://", () => {
      expect(() => new JiraClient({ ...testConfig, siteUrl: "http://test.atlassian.net" }, testSchema)).toThrow(
        "siteUrl must start with https://",
      );
    });

    it("rejects siteUrl pointing to private IP ranges (SSRF)", () => {
      const privateUrls = [
        "https://localhost",
        "https://127.0.0.1",
        "https://10.0.0.1",
        "https://172.16.0.1",
        "https://172.31.255.255",
        "https://192.168.1.1",
      ];
      for (const url of privateUrls) {
        expect(() => new JiraClient({ ...testConfig, siteUrl: url }, testSchema)).toThrow(
          "siteUrl must not point to a private/internal address",
        );
      }
    });

    it("allows valid public https URLs", () => {
      expect(
        () => new JiraClient({ ...testConfig, siteUrl: "https://mycompany.atlassian.net" }, testSchema),
      ).not.toThrow();
    });
  });

  describe("retry/backoff", () => {
    it("retries on 429 with Retry-After header", async () => {
      const client = new JiraClient(testConfig, testSchema);

      // First call: 429 with Retry-After
      fetchMock.mockResolvedValueOnce(new Response("", { status: 429, headers: { "Retry-After": "1" } }));
      // Second call: success
      mockFetchResponse({ id: "1", key: "BP-1", self: "" });

      const result = await client.createIssue({ summary: "Retry test", issueType: "Task" });
      expect(result.key).toBe("BP-1");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("retries on 500 with exponential backoff", async () => {
      const client = new JiraClient(testConfig, testSchema);

      // First call: 500
      fetchMock.mockResolvedValueOnce(new Response("Server Error", { status: 500 }));
      // Second call: 500
      fetchMock.mockResolvedValueOnce(new Response("Server Error", { status: 500 }));
      // Third call: success
      mockFetchResponse({ id: "1", key: "BP-1", self: "" });

      const result = await client.createIssue({ summary: "Backoff test", issueType: "Task" });
      expect(result.key).toBe("BP-1");
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it("throws after exhausting retries on 500", async () => {
      const client = new JiraClient(testConfig, testSchema);

      // All 4 calls return 500 (0..3 = 4 attempts)
      for (let i = 0; i <= 3; i++) {
        fetchMock.mockResolvedValueOnce(new Response("Server Error", { status: 500 }));
      }

      await expect(client.createIssue({ summary: "Fail test", issueType: "Task" })).rejects.toThrow("Jira 500");
    }, 15_000);
  });

  describe("transitionIssue", () => {
    it("posts transition to correct endpoint", async () => {
      const client = new JiraClient(testConfig, testSchema);
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

      await client.transitionIssue("BP-1", "31");

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const url = fetchMock.mock.calls[0]?.[0] as string;
      expect(url).toContain("/rest/api/3/issue/BP-1/transitions");
      const body = getCallBody(0);
      expect(body.transition).toEqual({ id: "31" });
    });
  });

  describe("assignIssue", () => {
    it("assigns issue to a user", async () => {
      const client = new JiraClient(testConfig, testSchema);
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

      await client.assignIssue("BP-1", "abc-123");

      const url = fetchMock.mock.calls[0]?.[0] as string;
      expect(url).toContain("/rest/api/3/issue/BP-1/assignee");
      const body = getCallBody(0);
      expect(body.accountId).toBe("abc-123");
    });

    it("unassigns issue with null accountId", async () => {
      const client = new JiraClient(testConfig, testSchema);
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

      await client.assignIssue("BP-1", null);

      const body = getCallBody(0);
      expect(body.accountId).toBeNull();
    });
  });

  describe("linkIssues", () => {
    it("creates issue link with correct body", async () => {
      const client = new JiraClient(testConfig, testSchema);
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

      await client.linkIssues("BP-1", "BP-2", "Blocks");

      const body = getCallBody(0);
      expect(body.type).toEqual({ name: "Blocks" });
      expect(body.inwardIssue).toEqual({ key: "BP-1" });
      expect(body.outwardIssue).toEqual({ key: "BP-2" });
    });

    it("handles 201 with empty body", async () => {
      const client = new JiraClient(testConfig, testSchema);
      fetchMock.mockResolvedValueOnce(new Response("", { status: 201 }));

      await expect(client.linkIssues("BP-1", "BP-2", "Relates")).resolves.toBeUndefined();
    });

    it("validates both issue keys", async () => {
      const client = new JiraClient(testConfig, testSchema);
      await expect(client.linkIssues("bad", "BP-2", "Blocks")).rejects.toThrow("Invalid issue key");
      await expect(client.linkIssues("BP-1", "bad", "Blocks")).rejects.toThrow("Invalid issue key");
    });
  });

  describe("rankIssue", () => {
    it("ranks issue before another issue", async () => {
      const client = new JiraClient(testConfig, testSchema);
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

      await client.rankIssue("BP-1", { rankBefore: "BP-2" });

      const url = fetchMock.mock.calls[0]?.[0] as string;
      expect(url).toContain("/rest/agile/1.0/issue/rank");
      const body = getCallBody(0);
      expect(body.issues).toEqual(["BP-1"]);
      expect(body.rankBeforeIssue).toBe("BP-2");
      expect(body.rankAfterIssue).toBeUndefined();
    });

    it("ranks issue after another issue", async () => {
      const client = new JiraClient(testConfig, testSchema);
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

      await client.rankIssue("BP-3", { rankAfter: "BP-4" });

      const body = getCallBody(0);
      expect(body.issues).toEqual(["BP-3"]);
      expect(body.rankAfterIssue).toBe("BP-4");
      expect(body.rankBeforeIssue).toBeUndefined();
    });

    it("throws if neither rankBefore nor rankAfter provided", async () => {
      const client = new JiraClient(testConfig, testSchema);

      await expect(client.rankIssue("BP-1", {})).rejects.toThrow(
        "rankIssue requires exactly one of rankBefore or rankAfter",
      );
    });

    it("validates all issue keys", async () => {
      const client = new JiraClient(testConfig, testSchema);
      await expect(client.rankIssue("bad", { rankBefore: "BP-1" })).rejects.toThrow("Invalid issue key");
      await expect(client.rankIssue("BP-1", { rankBefore: "bad" })).rejects.toThrow("Invalid issue key");
      await expect(client.rankIssue("BP-1", { rankAfter: "bad" })).rejects.toThrow("Invalid issue key");
    });
  });

  describe("getBacklogIssues", () => {
    it("fetches backlog issues for a board", async () => {
      const client = new JiraClient(testConfig, testSchema);
      mockFetchResponse({
        issues: [
          { key: "BP-1", fields: { summary: "First" } },
          { key: "BP-2", fields: { summary: "Second" } },
        ],
        total: 2,
        maxResults: 50,
      });

      const result = await client.getBacklogIssues("266", 50, 0);
      expect(result.issues).toHaveLength(2);
      expect(result.total).toBe(2);
      expect(result.issues[0]?.key).toBe("BP-1");

      const call = fetchMock.mock.calls[0];
      const url = new URL((call?.[0] ?? "") as string);
      expect(url.pathname).toContain("/rest/agile/1.0/board/266/backlog");
      expect(url.searchParams.get("maxResults")).toBe("50");
    });

    it("supports pagination with startAt", async () => {
      const client = new JiraClient(testConfig, testSchema);
      mockFetchResponse({
        issues: [{ key: "BP-99", fields: { summary: "Last" } }],
        total: 100,
        maxResults: 1,
      });

      const result = await client.getBacklogIssues("266", 1, 99);
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0]?.key).toBe("BP-99");

      const call = fetchMock.mock.calls[0];
      const url = new URL((call?.[0] ?? "") as string);
      expect(url.searchParams.get("startAt")).toBe("99");
      expect(url.searchParams.get("maxResults")).toBe("1");
    });
  });

  describe("getIssueLinks", () => {
    it("parses inward and outward links correctly", async () => {
      const client = new JiraClient(testConfig, testSchema);
      mockFetchResponse({
        fields: {
          issuelinks: [
            {
              type: { name: "Blocks" },
              inwardIssue: {
                key: "BP-10",
                fields: { summary: "Blocker issue", status: { name: "To Do" } },
              },
            },
            {
              type: { name: "Relates" },
              outwardIssue: {
                key: "BP-20",
                fields: { summary: "Related issue", status: { name: "Done" } },
              },
            },
          ],
        },
      });

      const links = await client.getIssueLinks("BP-1");
      expect(links).toHaveLength(2);
      expect(links[0]).toEqual({
        type: "Blocks",
        direction: "inward",
        linkedIssue: { key: "BP-10", summary: "Blocker issue", status: "To Do" },
      });
      expect(links[1]).toEqual({
        type: "Relates",
        direction: "outward",
        linkedIssue: { key: "BP-20", summary: "Related issue", status: "Done" },
      });
    });

    it("returns empty array when no links exist", async () => {
      const client = new JiraClient(testConfig, testSchema);
      mockFetchResponse({ fields: { issuelinks: [] } });

      const links = await client.getIssueLinks("BP-1");
      expect(links).toHaveLength(0);
    });

    it("validates issue key", async () => {
      const client = new JiraClient(testConfig, testSchema);
      await expect(client.getIssueLinks("bad")).rejects.toThrow("Invalid issue key");
    });
  });

  describe("getEpicIssues", () => {
    it("returns child issues of an epic", async () => {
      const client = new JiraClient(testConfig, testSchema);
      mockFetchResponse({
        issues: [
          { key: "BP-5", id: "5", fields: { summary: "Child 1", status: { name: "To Do" } } },
          { key: "BP-6", id: "6", fields: { summary: "Child 2", status: { name: "In Progress" } } },
        ],
        total: 2,
      });

      const issues = await client.getEpicIssues("BP-1");
      expect(issues).toHaveLength(2);
      expect(issues[0]?.key).toBe("BP-5");
      expect(issues[1]?.key).toBe("BP-6");

      // Verify the JQL used
      const call = fetchMock.mock.calls[0];
      const url = new URL((call?.[0] ?? "") as string);
      expect(url.searchParams.get("jql")).toBe('"Epic Link" = BP-1 OR parent = BP-1');
    });

    it("validates epic key", async () => {
      const client = new JiraClient(testConfig, testSchema);
      await expect(client.getEpicIssues("bad")).rejects.toThrow("Invalid issue key");
    });
  });

  describe("getSprintDetails", () => {
    it("returns sprint with goal", async () => {
      const client = new JiraClient(testConfig, testSchema);
      mockFetchResponse({
        id: 42,
        name: "Sprint 42",
        state: "active",
        goal: "Ship auth feature",
        startDate: "2026-01-01T00:00:00Z",
        endDate: "2026-01-14T00:00:00Z",
      });

      const sprint = await client.getSprintDetails("42");
      expect(sprint.id).toBe(42);
      expect(sprint.name).toBe("Sprint 42");
      expect(sprint.state).toBe("active");
      expect(sprint.goal).toBe("Ship auth feature");
      expect(sprint.startDate).toBe("2026-01-01T00:00:00Z");
      expect(sprint.endDate).toBe("2026-01-14T00:00:00Z");

      const url = fetchMock.mock.calls[0]?.[0] as string;
      expect(url).toContain("/rest/agile/1.0/sprint/42");
    });

    it("returns sprint without optional fields", async () => {
      const client = new JiraClient(testConfig, testSchema);
      mockFetchResponse({ id: 10, name: "Sprint 10", state: "future" });

      const sprint = await client.getSprintDetails("10");
      expect(sprint.id).toBe(10);
      expect(sprint.goal).toBeUndefined();
      expect(sprint.startDate).toBeUndefined();
      expect(sprint.endDate).toBeUndefined();
    });
  });

  describe("updateSprint", () => {
    it("sends correct PUT request with updates", async () => {
      const client = new JiraClient(testConfig, testSchema);
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

      await client.updateSprint("42", {
        goal: "New goal",
        name: "Renamed Sprint",
        startDate: "2026-02-01",
        endDate: "2026-02-14",
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const url = fetchMock.mock.calls[0]?.[0] as string;
      expect(url).toContain("/rest/agile/1.0/sprint/42");
      const call = fetchMock.mock.calls[0];
      expect(call?.[1]?.method).toBe("PUT");
      const body = getCallBody(0);
      expect(body.goal).toBe("New goal");
      expect(body.name).toBe("Renamed Sprint");
      expect(body.startDate).toBe("2026-02-01");
      expect(body.endDate).toBe("2026-02-14");
    });

    it("sends only provided fields", async () => {
      const client = new JiraClient(testConfig, testSchema);
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

      await client.updateSprint("42", { goal: "Just the goal" });

      const body = getCallBody(0);
      expect(body.goal).toBe("Just the goal");
      expect(body.name).toBeUndefined();
    });
  });

  describe("discoverSchema", () => {
    it("discovers project schema from API", async () => {
      const config = { siteUrl: "https://test.atlassian.net", email: "test@example.com", apiToken: "tok_123" };

      // 1. Project info
      mockFetchResponse({ name: "Test Project" });
      // 2. Issue types (createmeta)
      mockFetchResponse({ values: [{ id: "1", name: "Task", subtask: false }] });
      // 3. Fields for Task
      mockFetchResponse({
        values: [
          { fieldId: "summary", name: "Summary", required: true, schema: { type: "string", system: "summary" } },
          { fieldId: "customfield_10016", name: "Story Points", required: false, schema: { type: "number" } },
        ],
      });
      // 4. Priorities
      mockFetchResponse([
        { id: "1", name: "High" },
        { id: "2", name: "Medium" },
      ]);
      // 5. Statuses
      mockFetchResponse([{ name: "Task", statuses: [{ id: "1", name: "To Do", statusCategory: { name: "To Do" } }] }]);
      // 6. Sample tickets
      mockFetchResponse({
        issues: [
          {
            key: "BP-1",
            fields: {
              summary: "Sample",
              issuetype: { name: "Task" },
              priority: { name: "High" },
              status: { name: "To Do" },
              labels: [],
            },
          },
        ],
      });

      const schema = await JiraClient.discoverSchema(config, "BP");
      expect(schema.projectKey).toBe("BP");
      expect(schema.projectName).toBe("Test Project");
      expect(schema.issueTypes).toHaveLength(1);
      expect(schema.issueTypes[0]?.name).toBe("Task");
      expect(schema.priorities).toHaveLength(2);
      expect(schema.sampleTickets).toHaveLength(1);
    });

    it("discovers schema with board config", async () => {
      const config = { siteUrl: "https://test.atlassian.net", email: "test@example.com", apiToken: "tok_123" };

      // 1. Project info
      mockFetchResponse({ name: "Board Project" });
      // 2. Issue types
      mockFetchResponse({ values: [{ id: "1", name: "Story", subtask: false }] });
      // 3. Fields for Story (include team field)
      mockFetchResponse({
        values: [
          { fieldId: "summary", name: "Summary", required: true, schema: { type: "string", system: "summary" } },
          {
            fieldId: "customfield_100",
            name: "Team",
            required: false,
            schema: { type: "team", custom: "com.atlassian.teams:team" },
          },
        ],
      });
      // 4. Priorities
      mockFetchResponse([{ id: "1", name: "Medium" }]);
      // 5. Board config
      mockFetchResponse({
        name: "Scrum Board",
        type: "scrum",
        estimation: { field: { displayName: "Story Points" } },
        columnConfig: { columns: [{ name: "To Do", statuses: [{ name: "To Do" }] }] },
      });
      // 6. Board ticket with team
      mockFetchResponse({
        issues: [{ fields: { customfield_100: { id: "team-uuid", name: "Alpha" } } }],
      });
      // 7. Statuses
      mockFetchResponse([]);
      // 8. Sample tickets
      mockFetchResponse({ issues: [] });

      const schema = await JiraClient.discoverSchema(config, "BP", "266");
      expect(schema.board).toBeDefined();
      expect(schema.board?.name).toBe("Scrum Board");
      expect(schema.board?.teamId).toBe("team-uuid");
      expect(schema.board?.teamName).toBe("Alpha");
    });

    it("falls back to legacy createmeta endpoint when new endpoint fails", async () => {
      const config = { siteUrl: "https://test.atlassian.net", email: "test@example.com", apiToken: "tok_123" };

      // 1. Project info
      mockFetchResponse({ name: "Legacy Project" });
      // 2. New createmeta endpoint → 404
      mockFetchError(404, "Not Found");
      // 3. Legacy createmeta endpoint → success
      mockFetchResponse({
        projects: [
          {
            issuetypes: [
              { id: "10", name: "Bug", subtask: false },
              { id: "11", name: "Sub-task", subtask: true },
            ],
          },
        ],
      });
      // 4. Fields for Bug
      mockFetchResponse({
        values: [
          { fieldId: "summary", name: "Summary", required: true, schema: { type: "string", system: "summary" } },
        ],
      });
      // 5. Fields for Sub-task
      mockFetchResponse({ values: [] });
      // 6. Priorities
      mockFetchResponse([{ id: "1", name: "Critical" }]);
      // 7. Statuses
      mockFetchResponse([]);
      // 8. Sample tickets
      mockFetchResponse({ issues: [] });

      const schema = await JiraClient.discoverSchema(config, "LEGACY");
      expect(schema.projectName).toBe("Legacy Project");
      expect(schema.issueTypes).toHaveLength(2);
      expect(schema.issueTypes[0]?.name).toBe("Bug");
      expect(schema.issueTypes[1]?.subtask).toBe(true);
    });

    it("handles field metadata fetch failure gracefully", async () => {
      const config = { siteUrl: "https://test.atlassian.net", email: "test@example.com", apiToken: "tok_123" };

      // 1. Project info
      mockFetchResponse({ name: "Field Error Project" });
      // 2. Issue types
      mockFetchResponse({ values: [{ id: "1", name: "Task", subtask: false }] });
      // 3. Fields endpoint → error (should be caught, resulting in empty fields)
      mockFetchError(403, "Forbidden");
      // 4. Priorities
      mockFetchResponse([{ id: "1", name: "Medium" }]);
      // 5. Statuses
      mockFetchResponse([]);
      // 6. Sample tickets
      mockFetchResponse({ issues: [] });

      const schema = await JiraClient.discoverSchema(config, "FE");
      expect(schema.issueTypes).toHaveLength(1);
      expect(schema.issueTypes[0]?.fields).toHaveLength(0);
      expect(schema.issueTypes[0]?.requiredFields).toHaveLength(0);
    });

    it("discovers board without team field", async () => {
      const config = { siteUrl: "https://test.atlassian.net", email: "test@example.com", apiToken: "tok_123" };

      // 1. Project info
      mockFetchResponse({ name: "No Team Project" });
      // 2. Issue types (no team custom field)
      mockFetchResponse({
        values: [{ id: "1", name: "Task", subtask: false }],
      });
      // 3. Fields for Task (no team field)
      mockFetchResponse({
        values: [
          { fieldId: "summary", name: "Summary", required: true, schema: { type: "string", system: "summary" } },
        ],
      });
      // 4. Priorities
      mockFetchResponse([{ id: "1", name: "Medium" }]);
      // 5. Board config (no team → skip team sample)
      mockFetchResponse({
        name: "Kanban Board",
        type: "kanban",
        columnConfig: { columns: [{ name: "Backlog", statuses: [{ name: "Backlog" }] }] },
      });
      // 6. Statuses
      mockFetchResponse([]);
      // 7. Sample tickets
      mockFetchResponse({ issues: [] });

      const schema = await JiraClient.discoverSchema(config, "NT", "100");
      expect(schema.board).toBeDefined();
      expect(schema.board?.name).toBe("Kanban Board");
      expect(schema.board?.type).toBe("kanban");
      expect(schema.board?.teamFieldId).toBeUndefined();
      expect(schema.board?.teamId).toBeUndefined();
      expect(schema.board?.estimationField).toBeUndefined();
    });

    it("handles board config fetch failure gracefully", async () => {
      const config = { siteUrl: "https://test.atlassian.net", email: "test@example.com", apiToken: "tok_123" };

      // 1. Project info
      mockFetchResponse({ name: "Board Error Project" });
      // 2. Issue types
      mockFetchResponse({ values: [{ id: "1", name: "Task", subtask: false }] });
      // 3. Fields for Task
      mockFetchResponse({ values: [] });
      // 4. Priorities
      mockFetchResponse([{ id: "1", name: "Medium" }]);
      // 5. Board config → error (caught, board stays undefined)
      mockFetchError(403, "Forbidden");
      // 6. Statuses
      mockFetchResponse([]);
      // 7. Sample tickets
      mockFetchResponse({ issues: [] });

      const schema = await JiraClient.discoverSchema(config, "BE", "999");
      expect(schema.board).toBeUndefined();
    });

    it("handles team value sample fetch failure", async () => {
      const config = { siteUrl: "https://test.atlassian.net", email: "test@example.com", apiToken: "tok_123" };

      // 1. Project info
      mockFetchResponse({ name: "Team Error Project" });
      // 2. Issue types
      mockFetchResponse({
        values: [{ id: "1", name: "Story", subtask: false }],
      });
      // 3. Fields with team field
      mockFetchResponse({
        values: [
          { fieldId: "summary", name: "Summary", required: true, schema: { type: "string", system: "summary" } },
          {
            fieldId: "customfield_200",
            name: "Team",
            required: false,
            schema: { type: "team", custom: "com.atlassian.teams:team" },
          },
        ],
      });
      // 4. Priorities
      mockFetchResponse([{ id: "1", name: "High" }]);
      // 5. Board config
      mockFetchResponse({
        name: "Sprint Board",
        type: "scrum",
        estimation: { field: { displayName: "Story Points" } },
      });
      // 6. Board ticket fetch → error (team sample fails, caught)
      mockFetchError(403, "Forbidden");
      // 7. Statuses
      mockFetchResponse([]);
      // 8. Sample tickets
      mockFetchResponse({ issues: [] });

      const schema = await JiraClient.discoverSchema(config, "TE", "200");
      expect(schema.board).toBeDefined();
      expect(schema.board?.name).toBe("Sprint Board");
      expect(schema.board?.estimationField).toBe("Story Points");
      // Team info should be absent since sample fetch failed
      expect(schema.board?.teamFieldId).toBeUndefined();
      expect(schema.board?.teamId).toBeUndefined();
    });

    it("handles board ticket with no team value", async () => {
      const config = { siteUrl: "https://test.atlassian.net", email: "test@example.com", apiToken: "tok_123" };

      // 1. Project info
      mockFetchResponse({ name: "No Team Value" });
      // 2. Issue types
      mockFetchResponse({
        values: [{ id: "1", name: "Story", subtask: false }],
      });
      // 3. Fields with team field
      mockFetchResponse({
        values: [
          { fieldId: "summary", name: "Summary", required: true, schema: { type: "string", system: "summary" } },
          {
            fieldId: "customfield_300",
            name: "Team",
            required: false,
            schema: { type: "team", custom: "com.atlassian.teams:team" },
          },
        ],
      });
      // 4. Priorities
      mockFetchResponse([{ id: "1", name: "Medium" }]);
      // 5. Board config
      mockFetchResponse({ name: "Board", type: "scrum" });
      // 6. Board ticket — team field is null (no team assigned)
      mockFetchResponse({ issues: [{ fields: { customfield_300: null } }] });
      // 7. Statuses
      mockFetchResponse([]);
      // 8. Sample tickets
      mockFetchResponse({ issues: [] });

      const schema = await JiraClient.discoverSchema(config, "NTV", "300");
      expect(schema.board).toBeDefined();
      // teamValue?.id is falsy → teamFieldId/teamId should not be set
      expect(schema.board?.teamFieldId).toBeUndefined();
      expect(schema.board?.teamId).toBeUndefined();
    });

    it("handles statuses fetch failure gracefully", async () => {
      const config = { siteUrl: "https://test.atlassian.net", email: "test@example.com", apiToken: "tok_123" };

      // 1. Project info
      mockFetchResponse({ name: "Status Error Project" });
      // 2. Issue types
      mockFetchResponse({ values: [{ id: "1", name: "Task", subtask: false }] });
      // 3. Fields for Task
      mockFetchResponse({ values: [] });
      // 4. Priorities
      mockFetchResponse([{ id: "1", name: "Medium" }]);
      // 5. Statuses → error (caught, statuses stays undefined)
      mockFetchError(403, "Forbidden");
      // 6. Sample tickets
      mockFetchResponse({ issues: [] });

      const schema = await JiraClient.discoverSchema(config, "SE");
      expect(schema.statuses).toBeUndefined();
      expect(schema.sampleTickets).toBeDefined();
    });

    it("handles sample tickets fetch failure gracefully", async () => {
      const config = { siteUrl: "https://test.atlassian.net", email: "test@example.com", apiToken: "tok_123" };

      // 1. Project info
      mockFetchResponse({ name: "Sample Error Project" });
      // 2. Issue types
      mockFetchResponse({ values: [{ id: "1", name: "Task", subtask: false }] });
      // 3. Fields for Task
      mockFetchResponse({ values: [] });
      // 4. Priorities
      mockFetchResponse([{ id: "1", name: "Medium" }]);
      // 5. Statuses
      mockFetchResponse([{ name: "Task", statuses: [{ id: "1", name: "Open", statusCategory: { name: "To Do" } }] }]);
      // 6. Sample tickets → error (caught, sampleTickets stays undefined)
      mockFetchError(403, "Forbidden");

      const schema = await JiraClient.discoverSchema(config, "SPE");
      expect(schema.statuses).toHaveLength(1);
      expect(schema.sampleTickets).toBeUndefined();
    });

    it("maps field metadata with key-based format (no fieldId)", async () => {
      const config = { siteUrl: "https://test.atlassian.net", email: "test@example.com", apiToken: "tok_123" };

      // 1. Project info
      mockFetchResponse({ name: "Key Format" });
      // 2. Issue types
      mockFetchResponse({ values: [{ id: "1", name: "Task", subtask: false }] });
      // 3. Fields with key-based format (legacy) — note: no fieldId, uses key instead
      mockFetchResponse({
        values: [
          {
            key: "summary",
            name: "Summary",
            required: true,
            schema: { type: "string", system: "summary" },
            allowedValues: [{ id: "1", name: "Option A", value: "a" }],
          },
          {
            key: "customfield_50",
            name: "Custom Field",
            required: false,
            schema: { type: "string" },
          },
        ],
      });
      // 4. Priorities
      mockFetchResponse([{ id: "1", name: "Medium" }]);
      // 5. Statuses
      mockFetchResponse([]);
      // 6. Sample tickets
      mockFetchResponse({ issues: [] });

      const schema = await JiraClient.discoverSchema(config, "KF");
      const taskType = schema.issueTypes[0];
      expect(taskType?.fields).toHaveLength(2);
      // key-based field should use key as id
      expect(taskType?.fields[0]?.id).toBe("summary");
      expect(taskType?.fields[0]?.allowedValues).toHaveLength(1);
      expect(taskType?.fields[0]?.allowedValues?.[0]?.name).toBe("Option A");
      expect(taskType?.fields[1]?.id).toBe("customfield_50");
      expect(taskType?.requiredFields).toContain("summary");
    });
  });
});
