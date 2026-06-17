import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { DOWNLOAD_DIR_CONFIG_KEY } from "../lib/attachments.js";
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

// ── Test schema & env helpers ────────────────────────────────────────────────

const testSchema: JiraSchema = {
  projectKey: "BP",
  projectName: "Backlog",
  boardId: "266",
  issueTypes: [{ id: "1", name: "Task", subtask: false, fields: [], requiredFields: [] }],
  priorities: [{ id: "1", name: "Medium" }],
  statuses: [],
};

const envSnapshot: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "ATLASSIAN_SITE_URL",
  "ATLASSIAN_EMAIL",
  "ATLASSIAN_API_TOKEN",
  "JIRA_PROJECT_KEY",
  "JIRA_BOARD_ID",
  "LAZY_BACKLOG_UPLOAD_ROOT",
];

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

describe("issues get — attachment surfacing", () => {
  let kb: KnowledgeBase;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "lb-issues-att-"));
    kb = new KnowledgeBase(join(tmpDir, "test.db"));
    setTestEnv();
  });

  afterEach(() => {
    kb.close();
    rmSync(tmpDir, { recursive: true, force: true });
    restoreEnv();
  });

  function issueResponseWith(attachment: unknown[]) {
    return {
      key: "BP-1",
      id: "10001",
      fields: {
        summary: "With attachments",
        issuetype: { name: "Task" },
        priority: { name: "Medium" },
        status: { name: "To Do" },
        labels: [],
        components: [],
        created: "2026-01-01",
        updated: "2026-06-01",
        comment: { comments: [] },
        attachment,
      },
    };
  }

  it("renders the attachment table for a ticket with attachments", async () => {
    const { server, getTool } = createMockServer();
    registerIssuesTool(server, () => kb);
    JiraClient.saveSchemaToDb(kb, testSchema);

    mockFetchResponse(
      issueResponseWith([
        {
          id: "att-1",
          filename: "design.png",
          mimeType: "image/png",
          size: 4096,
          author: { displayName: "Ricky" },
          created: "2026-06-01T00:00:00Z",
          content: "https://test.atlassian.net/secure/attachment/att-1/design.png",
        },
      ]),
    );

    const issues = getTool("issues");
    const result = await issues({ action: "get", issueKey: "BP-1" });
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("Attachments (1)");
    expect(text).toContain("design.png");
    expect(text).toContain("(image)");
    expect(text).toContain("![design.png](https://test.atlassian.net/secure/attachment/att-1/design.png)");
  });

  it("omits the attachments section when there are none", async () => {
    const { server, getTool } = createMockServer();
    registerIssuesTool(server, () => kb);
    JiraClient.saveSchemaToDb(kb, testSchema);

    mockFetchResponse(issueResponseWith([]));
    const issues = getTool("issues");
    const result = await issues({ action: "get", issueKey: "BP-1" });
    expect(result.content[0]?.text).not.toContain("Attachments (");
  });

  // TEST-13: exercise the *real* JiraClient.parseIssue path end-to-end via a
  // fetch-level mock instead of vi.spyOn(JiraClient.prototype, "getIssue").
  // Without this, a regression in parseIssue's `fields.attachment` projection
  // would slip past the rest of this file's spy-based tests.
  it("parses fields.attachment via the real client path (TEST-13)", async () => {
    const { server, getTool } = createMockServer();
    registerIssuesTool(server, () => kb);
    JiraClient.saveSchemaToDb(kb, testSchema);

    // 1. Issue fetch with two attachments — one image, one binary.
    mockFetchResponse(
      issueResponseWith([
        {
          id: "att-img",
          filename: "diagram.png",
          mimeType: "image/png",
          size: 1024,
          author: { displayName: "Author" },
          created: "2026-06-01T00:00:00Z",
          content: "https://test.atlassian.net/secure/attachment/att-img/diagram.png",
        },
        {
          id: "att-bin",
          filename: "data.bin",
          mimeType: "application/octet-stream",
          size: 50,
          created: "2026-06-01T00:00:00Z",
          content: "https://test.atlassian.net/secure/attachment/att-bin/data.bin",
        },
      ]),
    );
    // 2. getDevStatus — returns empty.
    mockFetchResponse({ detail: [] });
    // 3. getIssueLinks (separate endpoint) — returns empty.
    mockFetchResponse({ values: [] });

    const issues = getTool("issues");
    const result = await issues({ action: "get", issueKey: "BP-1" });
    const text = result.content[0]?.text ?? "";

    // Real parseIssue must have produced both attachments — counted, named,
    // image-flagged, and rendered with a markdown image preview for the PNG.
    expect(text).toContain("Attachments (2)");
    expect(text).toContain("diagram.png");
    expect(text).toContain("data.bin");
    expect(text).toContain("(image)");
    expect(text).toContain("![diagram.png](https://test.atlassian.net/secure/attachment/att-img/diagram.png)");
  });
});

describe("issues get — download flow", () => {
  let kb: KnowledgeBase;
  let tmpDir: string;
  let downloadDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "lb-issues-dl-"));
    downloadDir = mkdtempSync(join(tmpdir(), "lb-issues-dl-target-"));
    kb = new KnowledgeBase(join(tmpDir, "test.db"));
    setTestEnv();
  });

  afterEach(() => {
    kb.close();
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(downloadDir, { recursive: true, force: true });
    restoreEnv();
  });

  it("downloads attachments into the configured directory", async () => {
    const { server, getTool } = createMockServer();
    registerIssuesTool(server, () => kb);
    JiraClient.saveSchemaToDb(kb, testSchema);
    kb.setConfig(DOWNLOAD_DIR_CONFIG_KEY, downloadDir);

    // Use vi.spyOn so we don't depend on call ordering of secondary helpers
    // (getDevStatus / getIssueLinks) that go through the same fetch mock.
    const getIssueSpy = vi.spyOn(JiraClient.prototype, "getIssue").mockResolvedValue({
      key: "BP-1",
      id: "10001",
      summary: "With binary",
      issueType: "Task",
      priority: "Medium",
      status: "To Do",
      labels: [],
      components: [],
      created: "2026-01-01",
      updated: "2026-06-01",
      comments: [],
      attachments: [
        {
          id: "att-1",
          filename: "blob.bin",
          mimeType: "application/octet-stream",
          size: 5,
          author: "Ricky",
          created: "2026-06-01T00:00:00Z",
          url: "https://test.atlassian.net/secure/attachment/att-1/blob.bin",
          isImage: false,
        },
      ],
      url: "https://test.atlassian.net/browse/BP-1",
    });
    const devSpy = vi
      .spyOn(JiraClient.prototype, "getDevStatus")
      .mockResolvedValue({ pullRequests: 0, commits: 0, builds: 0, reviews: 0 });
    const linksSpy = vi.spyOn(JiraClient.prototype, "getIssueLinks").mockResolvedValue([]);

    // The download fetch — only call now that goes through `fetch`.
    const payload = new TextEncoder().encode("hello");
    fetchMock.mockResolvedValueOnce(
      new Response(payload, { status: 200, headers: { "Content-Type": "application/octet-stream" } }),
    );

    const issues = getTool("issues");
    const result = await issues({ action: "get", issueKey: "BP-1", download: true });
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("Downloads (1)");

    const expectedPath = join(downloadDir, "blob.bin");
    expect(existsSync(expectedPath)).toBe(true);
    expect(readFileSync(expectedPath).toString()).toBe("hello");

    getIssueSpy.mockRestore();
    devSpy.mockRestore();
    linksSpy.mockRestore();
  });

  it("sanitises a malicious attachment filename before writing", async () => {
    const { server, getTool } = createMockServer();
    registerIssuesTool(server, () => kb);
    JiraClient.saveSchemaToDb(kb, testSchema);
    kb.setConfig(DOWNLOAD_DIR_CONFIG_KEY, downloadDir);

    // Pre-create a sentinel outside the download dir
    const sentinel = join(tmpdir(), "lb-issues-sentinel.bin");
    writeFileSync(sentinel, "original");

    const getIssueSpy = vi.spyOn(JiraClient.prototype, "getIssue").mockResolvedValue({
      key: "BP-1",
      id: "10001",
      summary: "Evil",
      issueType: "Task",
      priority: "Medium",
      status: "To Do",
      labels: [],
      components: [],
      created: "2026-01-01",
      updated: "2026-06-01",
      comments: [],
      attachments: [
        {
          id: "att-evil",
          filename: "../../lb-issues-sentinel.bin",
          mimeType: "application/octet-stream",
          size: 8,
          author: "Mallory",
          created: "2026-06-01T00:00:00Z",
          url: "https://test.atlassian.net/secure/attachment/att-evil/blob.bin",
          isImage: false,
        },
      ],
      url: "https://test.atlassian.net/browse/BP-1",
    });
    const devSpy = vi
      .spyOn(JiraClient.prototype, "getDevStatus")
      .mockResolvedValue({ pullRequests: 0, commits: 0, builds: 0, reviews: 0 });
    const linksSpy = vi.spyOn(JiraClient.prototype, "getIssueLinks").mockResolvedValue([]);

    const payload = new TextEncoder().encode("attacker");
    fetchMock.mockResolvedValueOnce(new Response(payload, { status: 200 }));

    const issues = getTool("issues");
    await issues({ action: "get", issueKey: "BP-1", download: true });

    // TEST-7: the sentinel-untouched assertion alone would pass if the
    // download was silently dropped — assert *positively* that the bytes
    // landed inside the download dir under the sanitised filename.
    expect(readFileSync(sentinel).toString()).toBe("original");
    const safePath = join(downloadDir, "lb-issues-sentinel.bin");
    expect(existsSync(safePath)).toBe(true);
    expect(readFileSync(safePath).toString()).toBe("attacker");

    rmSync(sentinel, { force: true });

    getIssueSpy.mockRestore();
    devSpy.mockRestore();
    linksSpy.mockRestore();
  });
});

describe("issues create — attachments param", () => {
  let kb: KnowledgeBase;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "lb-issues-create-att-"));
    kb = new KnowledgeBase(join(tmpDir, "test.db"));
    setTestEnv();
    // ATT-2: confine uploads to the ephemeral test directory so fixtures
    // under `/tmp/...` are accepted without broadening the default cwd-root.
    process.env.LAZY_BACKLOG_UPLOAD_ROOT = tmpDir;
  });

  afterEach(() => {
    kb.close();
    rmSync(tmpDir, { recursive: true, force: true });
    restoreEnv();
  });

  it("uploads provided attachments after a confirmed create", async () => {
    const { server, getTool } = createMockServer();
    registerIssuesTool(server, () => kb);
    JiraClient.saveSchemaToDb(kb, testSchema);

    const path = join(tmpDir, "spec.md");
    writeFileSync(path, "# spec");

    const createSpy = vi.spyOn(JiraClient.prototype, "createIssue").mockResolvedValue({
      id: "1",
      key: "BP-500",
      self: "",
    });
    const attachSpy = vi.spyOn(JiraClient.prototype, "addAttachment").mockResolvedValue([
      {
        id: "att-1",
        filename: "spec.md",
        mimeType: "text/markdown",
        size: 6,
        created: "2026-01-01",
        url: "",
        isImage: false,
      },
    ]);

    const issues = getTool("issues");
    const result = await issues({
      action: "create",
      summary: "Implement",
      confirmed: true,
      attachments: [path],
    });
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("BP-500");
    expect(text).toContain("1/1 attachment(s) uploaded");
    expect(attachSpy).toHaveBeenCalledWith(
      "BP-500",
      expect.arrayContaining([expect.objectContaining({ filename: "spec.md" })]),
    );

    // TEST-12: assert the contentType is guessed correctly AND the bytes
    // forwarded to addAttachment match the file on disk. Without this, a
    // regression that uploaded zero-length / wrong-type files would still
    // satisfy the objectContaining({filename}) match.
    const firstCall = attachSpy.mock.calls[0];
    const firstFile = (
      firstCall?.[1] as Array<{ filename: string; contentType: string; data: Uint8Array | Buffer }>
    )[0];
    expect(firstFile?.contentType).toBe("text/markdown");
    expect(firstFile?.data).toBeDefined();
    // The fixture wrote "# spec" — 6 bytes UTF-8.
    expect(Buffer.from(firstFile?.data ?? new Uint8Array()).toString("utf8")).toBe("# spec");

    createSpy.mockRestore();
    attachSpy.mockRestore();
  });

  it("records errors when a file is missing", async () => {
    const { server, getTool } = createMockServer();
    registerIssuesTool(server, () => kb);
    JiraClient.saveSchemaToDb(kb, testSchema);

    const createSpy = vi.spyOn(JiraClient.prototype, "createIssue").mockResolvedValue({
      id: "1",
      key: "BP-501",
      self: "",
    });
    const attachSpy = vi.spyOn(JiraClient.prototype, "addAttachment").mockResolvedValue([]);

    const issues = getTool("issues");
    const result = await issues({
      action: "create",
      summary: "Implement",
      confirmed: true,
      attachments: [join(tmpDir, "missing.bin")],
    });
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("BP-501");
    expect(text).toContain("0/1 attachment(s) uploaded");
    expect(text).toContain("file not found");
    // addAttachment should not be called when all files fail validation.
    expect(attachSpy).not.toHaveBeenCalled();

    createSpy.mockRestore();
    attachSpy.mockRestore();
  });
});

describe("issues update — attachments param", () => {
  let kb: KnowledgeBase;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "lb-issues-update-att-"));
    kb = new KnowledgeBase(join(tmpDir, "test.db"));
    setTestEnv();
    process.env.LAZY_BACKLOG_UPLOAD_ROOT = tmpDir;
  });

  afterEach(() => {
    kb.close();
    rmSync(tmpDir, { recursive: true, force: true });
    restoreEnv();
  });

  it("uploads attachments during update", async () => {
    const { server, getTool } = createMockServer();
    registerIssuesTool(server, () => kb);
    JiraClient.saveSchemaToDb(kb, testSchema);

    const path = join(tmpDir, "extra.txt");
    writeFileSync(path, "extra");

    const attachSpy = vi.spyOn(JiraClient.prototype, "addAttachment").mockResolvedValue([
      {
        id: "x",
        filename: "extra.txt",
        mimeType: "text/plain",
        size: 5,
        created: "2026-01-01",
        url: "",
        isImage: false,
      },
    ]);

    const issues = getTool("issues");
    const result = await issues({
      action: "update",
      issueKey: "BP-1",
      attachments: [path],
    });
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("Attachments: 1 uploaded");
    expect(attachSpy).toHaveBeenCalledOnce();

    attachSpy.mockRestore();
  });
});
