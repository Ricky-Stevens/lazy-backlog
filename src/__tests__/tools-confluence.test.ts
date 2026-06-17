import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { IndexedPage } from "../lib/db.js";
import { KnowledgeBase } from "../lib/db.js";
import { registerConfluenceTool } from "../tools/confluence.js";
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
  fetchMock.mockReset();
  fetchMock.mockImplementation(() => Promise.resolve(new Response("{}")));
});

// ── Env helpers ──────────────────────────────────────────────────────────────

const envSnapshot: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "ATLASSIAN_SITE_URL",
  "ATLASSIAN_EMAIL",
  "ATLASSIAN_API_TOKEN",
  "JIRA_PROJECT_KEY",
  "JIRA_BOARD_ID",
  "CONFLUENCE_SPACES",
];

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

function makePage(overrides: Partial<IndexedPage> = {}): IndexedPage {
  return {
    id: overrides.id ?? "page-1",
    space_key: overrides.space_key ?? "ENG",
    title: overrides.title ?? "Test Page",
    url: overrides.url ?? "https://wiki.example.com/page-1",
    content: overrides.content ?? "Some content about authentication and OAuth2.",
    page_type: overrides.page_type ?? "design",
    labels: overrides.labels ?? '["design","auth"]',
    parent_id: overrides.parent_id ?? null,
    author_id: overrides.author_id ?? null,
    created_at: overrides.created_at ?? "2025-01-01T00:00:00Z",
    updated_at: overrides.updated_at ?? "2025-06-01T00:00:00Z",
    indexed_at: overrides.indexed_at ?? new Date().toISOString(),
    source: overrides.source ?? "confluence",
    content_hash: overrides.content_hash ?? null,
  };
}

// ── Default params helper ────────────────────────────────────────────────────

const defaults = {
  maxDepth: 10,
  maxConcurrency: 5,
  includeLabels: [] as string[],
  excludeLabels: [] as string[],
  force: false,
};

// ── registerConfluenceTool ─────────────────────────────────────────────────

describe("registerConfluenceTool", () => {
  let kb: KnowledgeBase;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "lb-confluence-test-"));
    kb = new KnowledgeBase(join(tmpDir, "test.db"));
  });

  afterEach(() => {
    kb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("registers a single 'confluence' tool", () => {
    const { server, toolNames } = createMockServer();
    registerConfluenceTool(server, () => kb);
    expect(toolNames()).toEqual(["confluence"]);
  });

  // ── spider ──────────────────────────────────────────────────────────────

  describe("action=spider", () => {
    beforeEach(() => {
      setTestEnv();
    });

    afterEach(() => {
      restoreEnv();
    });

    it("crawls and returns summary", async () => {
      const { server, getTool } = createMockServer();
      registerConfluenceTool(server, () => kb);

      // Mock: getSpace -> GET /wiki/api/v2/spaces?keys=ENG&limit=1
      mockFetchResponse({
        results: [{ id: "100", key: "ENG", name: "Engineering", type: "global" }],
        _links: {},
      });
      // Mock: listPagesInSpace -> GET /wiki/api/v2/spaces/100/pages?limit=50
      mockFetchResponse({
        results: [
          {
            id: "101",
            title: "Test Page",
            status: "current",
            _links: { webui: "/wiki/spaces/ENG/pages/101" },
          },
        ],
        _links: {},
      });
      // Mock: getPageFull -> parallel: GET page body + GET labels
      mockFetchResponse({
        id: "101",
        title: "Test Page",
        body: { storage: { value: "<p>Some content</p>" } },
        version: { number: 1, when: "2025-01-01T00:00:00Z" },
        _links: { webui: "/wiki/spaces/ENG/pages/101" },
      });
      mockFetchResponse({ results: [], _links: {} });

      const tool = getTool("confluence");
      const result = await tool({
        action: "spider",
        spaceKey: "ENG",
        ...defaults,
        maxDepth: 1,
        maxConcurrency: 1,
      });
      const text = result.content[0]?.text ?? "";

      expect(result.isError).toBeUndefined();
      expect(text).toContain("Indexed:");
      expect(text).toContain("KB total:");
    });

    it("rebuilds FTS when force=true", async () => {
      const { server, getTool } = createMockServer();
      registerConfluenceTool(server, () => kb);

      // Pre-populate a page so rebuildFts has something to work with
      kb.upsertPage(makePage({ id: "p1", title: "Existing Page", content: "existing content" }));

      // Mock: getSpace
      mockFetchResponse({
        results: [{ id: "100", key: "ENG", name: "Engineering", type: "global" }],
        _links: {},
      });
      // Mock: listPagesInSpace (empty — no new pages to crawl)
      mockFetchResponse({
        results: [],
        _links: {},
      });

      const tool = getTool("confluence");
      const result = await tool({
        action: "spider",
        spaceKey: "ENG",
        ...defaults,
        force: true,
        maxDepth: 1,
        maxConcurrency: 1,
      });
      const text = result.content[0]?.text ?? "";

      expect(result.isError).toBeUndefined();
      expect(text).toContain("FTS index rebuilt");
      expect(text).toContain("KB total:");
    });

    it("returns error when config is missing", async () => {
      restoreEnv();
      delete process.env.ATLASSIAN_SITE_URL;
      delete process.env.ATLASSIAN_EMAIL;
      delete process.env.ATLASSIAN_API_TOKEN;

      const { server, getTool } = createMockServer();
      registerConfluenceTool(server, () => kb);

      const tool = getTool("confluence");
      const result = await tool({
        action: "spider",
        spaceKey: "ENG",
        ...defaults,
      });

      expect(result.isError).toBe(true);
    });
  });

  // ── list-spaces ─────────────────────────────────────────────────────────

  describe("action=list-spaces", () => {
    beforeEach(() => {
      setTestEnv();
    });

    afterEach(() => {
      restoreEnv();
    });

    it("returns spaces list", async () => {
      const { server, getTool } = createMockServer();
      registerConfluenceTool(server, () => kb);

      // Mock: GET /wiki/api/v2/spaces
      mockFetchResponse({
        results: [
          { id: "1", key: "ENG", name: "Engineering", type: "global" },
          { id: "2", key: "PM", name: "Product", type: "global" },
        ],
        _links: {},
      });

      const tool = getTool("confluence");
      const result = await tool({
        action: "list-spaces",
        ...defaults,
      });
      const text = result.content[0]?.text ?? "";

      expect(result.isError).toBeUndefined();
      expect(text).toContain("ENG");
      expect(text).toContain("Engineering");
      expect(text).toContain("PM");
      expect(text).toContain("Product");
    });

    it("returns error when config is missing", async () => {
      restoreEnv();
      delete process.env.ATLASSIAN_SITE_URL;
      delete process.env.ATLASSIAN_EMAIL;
      delete process.env.ATLASSIAN_API_TOKEN;

      const { server, getTool } = createMockServer();
      registerConfluenceTool(server, () => kb);

      const tool = getTool("confluence");
      const result = await tool({
        action: "list-spaces",
        ...defaults,
      });

      expect(result.isError).toBe(true);
    });

    it("returns empty message when no spaces found", async () => {
      const { server, getTool } = createMockServer();
      registerConfluenceTool(server, () => kb);

      // Mock: GET /wiki/api/v2/spaces returns empty
      mockFetchResponse({
        results: [],
        _links: {},
      });

      const tool = getTool("confluence");
      const result = await tool({
        action: "list-spaces",
        ...defaults,
      });
      const text = result.content[0]?.text ?? "";
      expect(result.isError).toBeUndefined();
      expect(text).toContain("No spaces found");
    });
  });

  describe("action=spider (error reporting)", () => {
    beforeEach(() => {
      setTestEnv();
    });

    afterEach(() => {
      restoreEnv();
    });

    it("reports crawl errors in output", async () => {
      const { server, getTool } = createMockServer();
      registerConfluenceTool(server, () => kb);

      // Mock: getSpace
      mockFetchResponse({
        results: [{ id: "100", key: "ENG", name: "Engineering", type: "global" }],
        _links: {},
      });
      // Mock: listPagesInSpace with pages that will trigger errors
      mockFetchResponse({
        results: [
          {
            id: "101",
            title: "Page 1",
            status: "current",
            _links: { webui: "/wiki/spaces/ENG/pages/101" },
          },
        ],
        _links: {},
      });
      // Mock: getPageFull fails for page body
      mockFetchResponse({ error: "Not found" }, 404);
      // Mock: labels (still called in parallel)
      mockFetchResponse({ results: [], _links: {} });

      const tool = getTool("confluence");
      const result = await tool({
        action: "spider",
        spaceKey: "ENG",
        ...defaults,
        maxDepth: 1,
        maxConcurrency: 1,
      });
      const text = result.content[0]?.text ?? "";
      // Should still complete without isError flag — errors are reported inline
      expect(text).toContain("KB total:");
    });

    // ── publish ─────────────────────────────────────────────────────────────

    describe("action=publish", () => {
      beforeEach(() => {
        setTestEnv();
        // PUB-1: publish now fails closed when the allow-list is empty.
        // Set the spaces ENG/DOCS up-front so the existing happy-path tests
        // continue to operate within an allow-listed scope. Tests that
        // exercise the fail-closed path clear this env explicitly.
        process.env.CONFLUENCE_SPACES = "ENG,DOCS";
      });

      afterEach(() => {
        restoreEnv();
      });

      it("returns preview-only without writing when confirm is false", async () => {
        const { server, getTool } = createMockServer();
        registerConfluenceTool(server, () => kb);

        const tool = getTool("confluence");
        const result = await tool({
          action: "publish",
          spaceKey: "ENG",
          title: "New Page",
          content: "# Hello\n\nSome body.",
          confirm: false,
          ...defaults,
        });
        const text = result.content[0]?.text ?? "";

        expect(result.isError).toBeUndefined();
        expect(text).toContain("Confluence Publish Preview");
        expect(text).toContain("Mode:** Create");
        expect(text).toContain("Nothing has been written");
        // Critical: no HTTP calls happened.
        expect(fetchMock).not.toHaveBeenCalled();
      });

      it("create flow with confirm=true calls createPage and returns URL + version", async () => {
        const { server, getTool } = createMockServer();
        registerConfluenceTool(server, () => kb);

        // 1) getSpace (read) — required by createPage to resolve spaceId.
        mockFetchResponse({
          results: [{ id: "100", key: "ENG", name: "Engineering", type: "global" }],
          _links: {},
        });
        // 2) POST /wiki/api/v2/pages — create response.
        mockFetchResponse({
          id: "999",
          title: "New Page",
          version: { number: 1 },
          _links: { webui: "/wiki/spaces/ENG/pages/999" },
        });

        const tool = getTool("confluence");
        const result = await tool({
          action: "publish",
          spaceKey: "ENG",
          title: "New Page",
          content: "# Hello",
          confirm: true,
          ...defaults,
        });
        const text = result.content[0]?.text ?? "";

        expect(result.isError).toBeUndefined();
        expect(text).toContain("Page created");
        expect(text).toContain("ID: 999");
        expect(text).toContain("Version: 1");
        // PUB-7: the webui already contains /wiki, so the URL must NOT
        // double-prepend it (was: /wiki/wiki/spaces/...).
        expect(text).toContain("/wiki/spaces/ENG/pages/999");
        expect(text).not.toContain("/wiki/wiki/");

        // Verify POST happened with storage body.
        const postCall = fetchMock.mock.calls.find((c) => {
          const init = c[1] as RequestInit | undefined;
          return init?.method === "POST";
        });
        expect(postCall).toBeDefined();
        const body =
          postCall?.[1] && typeof (postCall[1] as RequestInit).body === "string"
            ? JSON.parse((postCall[1] as RequestInit).body as string)
            : null;
        expect(body?.spaceId).toBe("100");
        expect(body?.title).toBe("New Page");
        expect(body?.body?.representation).toBe("storage");
        expect(body?.body?.value).toContain("<h1>Hello</h1>");
      });

      it("update flow with confirm=true fetches version then calls updatePage with version+1", async () => {
        const { server, getTool } = createMockServer();
        registerConfluenceTool(server, () => kb);

        // PUB-13/PUB-4: pre-confirm meta (page + spaces) + fresh meta + PUT.
        // 1a) pre-confirm meta — GET /wiki/api/v2/pages/123
        mockFetchResponse({ id: "123", title: "Old", spaceId: "100", version: { number: 7 } });
        // 1b) pre-confirm meta — GET /wiki/api/v2/spaces?ids=100
        mockFetchResponse({
          results: [{ id: "100", key: "ENG", name: "Engineering", type: "global" }],
          _links: {},
        });
        // 2a) fresh meta — GET /wiki/api/v2/pages/123
        mockFetchResponse({ id: "123", title: "Old", spaceId: "100", version: { number: 7 } });
        // 2b) fresh meta — GET /wiki/api/v2/spaces?ids=100
        mockFetchResponse({
          results: [{ id: "100", key: "ENG", name: "Engineering", type: "global" }],
          _links: {},
        });
        // 3) PUT /wiki/api/v2/pages/123 — update response.
        mockFetchResponse({
          id: "123",
          title: "Renamed",
          version: { number: 8 },
          _links: { webui: "/wiki/spaces/ENG/pages/123" },
        });

        const tool = getTool("confluence");
        const result = await tool({
          action: "publish",
          pageId: "123",
          title: "Renamed",
          content: "updated body",
          confirm: true,
          ...defaults,
        });
        const text = result.content[0]?.text ?? "";

        expect(result.isError).toBeUndefined();
        expect(text).toContain("Page updated");
        expect(text).toContain("New version: 8");

        const putCall = fetchMock.mock.calls.find((c) => {
          const init = c[1] as RequestInit | undefined;
          return init?.method === "PUT";
        });
        expect(putCall).toBeDefined();
        const body =
          putCall?.[1] && typeof (putCall[1] as RequestInit).body === "string"
            ? JSON.parse((putCall[1] as RequestInit).body as string)
            : null;
        expect(body?.id).toBe("123");
        expect(body?.title).toBe("Renamed");
        expect(body?.version?.number).toBe(8); // current + 1
        expect(body?.body?.representation).toBe("storage");
      });

      it("surfaces 409 version conflicts explicitly", async () => {
        const { server, getTool } = createMockServer();
        registerConfluenceTool(server, () => kb);

        // PUB-13/PUB-4: pre-confirm meta + fresh meta + PUT(409).
        mockFetchResponse({ id: "123", title: "Old", spaceId: "100", version: { number: 2 } });
        mockFetchResponse({
          results: [{ id: "100", key: "ENG", name: "Engineering", type: "global" }],
          _links: {},
        });
        mockFetchResponse({ id: "123", title: "Old", spaceId: "100", version: { number: 2 } });
        mockFetchResponse({
          results: [{ id: "100", key: "ENG", name: "Engineering", type: "global" }],
          _links: {},
        });
        // PUT → 409
        fetchMock.mockResolvedValueOnce(
          new Response(JSON.stringify({ errors: [{ title: "stale version" }] }), {
            status: 409,
            headers: { "Content-Type": "application/json" },
          }),
        );

        const tool = getTool("confluence");
        const result = await tool({
          action: "publish",
          pageId: "123",
          title: "X",
          content: "body",
          confirm: true,
          ...defaults,
        });
        const text = result.content[0]?.text ?? "";

        expect(result.isError).toBe(true);
        expect(text.toLowerCase()).toContain("version conflict");
      });

      it("never emits <script> or on*= attributes from an XSS payload", async () => {
        const { server, getTool } = createMockServer();
        registerConfluenceTool(server, () => kb);

        // getSpace
        mockFetchResponse({
          results: [{ id: "100", key: "ENG", name: "Engineering", type: "global" }],
          _links: {},
        });
        // POST create
        mockFetchResponse({
          id: "999",
          title: "XSS test",
          version: { number: 1 },
          _links: { webui: "/wiki/spaces/ENG/pages/999" },
        });

        const tool = getTool("confluence");
        await tool({
          action: "publish",
          spaceKey: "ENG",
          title: "XSS test",
          content: 'Hello <script>alert(1)</script> [click](javascript:bad()) <iframe src="x"></iframe> onclick="x"',
          confirm: true,
          ...defaults,
        });

        const postCall = fetchMock.mock.calls.find((c) => {
          const init = c[1] as RequestInit | undefined;
          return init?.method === "POST";
        });
        const body = JSON.parse((postCall?.[1] as RequestInit).body as string);
        const storage: string = body.body.value;

        expect(storage).not.toMatch(/<script/i);
        expect(storage).not.toMatch(/<iframe/i);
        expect(storage).not.toMatch(/\son\w+=/i);
        expect(storage).not.toContain("javascript:");
      });

      it("rejects missing target", async () => {
        const { server, getTool } = createMockServer();
        registerConfluenceTool(server, () => kb);

        const tool = getTool("confluence");
        const result = await tool({
          action: "publish",
          content: "body",
          ...defaults,
        });
        expect(result.isError).toBe(true);
      });

      it("rejects create without title", async () => {
        const { server, getTool } = createMockServer();
        registerConfluenceTool(server, () => kb);

        const tool = getTool("confluence");
        const result = await tool({
          action: "publish",
          spaceKey: "ENG",
          content: "body",
          ...defaults,
        });
        expect(result.isError).toBe(true);
      });

      it("rejects empty content", async () => {
        const { server, getTool } = createMockServer();
        registerConfluenceTool(server, () => kb);

        const tool = getTool("confluence");
        const result = await tool({
          action: "publish",
          spaceKey: "ENG",
          title: "X",
          content: "   ",
          ...defaults,
        });
        expect(result.isError).toBe(true);
      });

      // ── Project-scope (confluenceSpaces) enforcement ─────────────────────

      it("rejects create into a space outside the configured allow-list at preview time", async () => {
        process.env.CONFLUENCE_SPACES = "ENG,DOCS";
        const { server, getTool } = createMockServer();
        registerConfluenceTool(server, () => kb);

        const tool = getTool("confluence");
        const result = await tool({
          action: "publish",
          spaceKey: "OTHER",
          title: "Sneaky",
          content: "leak",
          confirm: false,
          ...defaults,
        });

        expect(result.isError).toBe(true);
        const text = result.content[0]?.text ?? "";
        expect(text).toContain("not in the configured confluenceSpaces");
        // Crucially: no HTTP request was made — preview-time rejection.
        expect(fetchMock).not.toHaveBeenCalled();
      });

      it("rejects create into a disallowed space even when confirm=true", async () => {
        process.env.CONFLUENCE_SPACES = "ENG";
        const { server, getTool } = createMockServer();
        registerConfluenceTool(server, () => kb);

        const tool = getTool("confluence");
        const result = await tool({
          action: "publish",
          spaceKey: "OTHER",
          title: "Sneaky",
          content: "leak",
          confirm: true,
          ...defaults,
        });

        expect(result.isError).toBe(true);
        // No write — no createPage call against the API.
        const writes = fetchMock.mock.calls.filter((c) => {
          const init = c[1] as RequestInit | undefined;
          return init?.method === "POST" || init?.method === "PUT";
        });
        expect(writes).toHaveLength(0);
      });

      it("allows create into an allowed space (case-insensitive match)", async () => {
        process.env.CONFLUENCE_SPACES = "eng,docs";
        const { server, getTool } = createMockServer();
        registerConfluenceTool(server, () => kb);

        // getSpace + POST create
        mockFetchResponse({
          results: [{ id: "100", key: "ENG", name: "Engineering", type: "global" }],
          _links: {},
        });
        mockFetchResponse({
          id: "999",
          title: "Allowed",
          version: { number: 1 },
          _links: { webui: "/wiki/spaces/ENG/pages/999" },
        });

        const tool = getTool("confluence");
        const result = await tool({
          action: "publish",
          spaceKey: "ENG",
          title: "Allowed",
          content: "ok",
          confirm: true,
          ...defaults,
        });

        expect(result.isError).toBeUndefined();
        const text = result.content[0]?.text ?? "";
        expect(text).toContain("Page created");
      });

      it("rejects update of a page whose space is outside the allow-list", async () => {
        process.env.CONFLUENCE_SPACES = "ENG";
        const { server, getTool } = createMockServer();
        registerConfluenceTool(server, () => kb);

        // 1) GET /wiki/api/v2/pages/123 — returns spaceId
        mockFetchResponse({ id: "123", title: "Foreign Page", spaceId: "555", version: { number: 4 } });
        // 2) GET /wiki/api/v2/spaces?ids=555 — returns space "OTHER"
        mockFetchResponse({
          results: [{ id: "555", key: "OTHER", name: "Other Team", type: "global" }],
          _links: {},
        });

        const tool = getTool("confluence");
        const result = await tool({
          action: "publish",
          pageId: "123",
          title: "Renamed",
          content: "body",
          confirm: true,
          ...defaults,
        });

        expect(result.isError).toBe(true);
        const text = result.content[0]?.text ?? "";
        expect(text).toContain("not in the configured confluenceSpaces");
        expect(text).toContain('lives in space "OTHER"');

        // Crucially: no PUT — the page was not updated.
        const puts = fetchMock.mock.calls.filter((c) => {
          const init = c[1] as RequestInit | undefined;
          return init?.method === "PUT";
        });
        expect(puts).toHaveLength(0);
      });

      it("rejects update of a disallowed page at preview time (no PUT, no version fetch beyond scope check)", async () => {
        process.env.CONFLUENCE_SPACES = "ENG";
        const { server, getTool } = createMockServer();
        registerConfluenceTool(server, () => kb);

        // Scope check: page → spaceId, then spaceId → space key.
        mockFetchResponse({ id: "123", title: "Foreign Page", spaceId: "555", version: { number: 4 } });
        mockFetchResponse({
          results: [{ id: "555", key: "OTHER", name: "Other Team", type: "global" }],
          _links: {},
        });

        const tool = getTool("confluence");
        const result = await tool({
          action: "publish",
          pageId: "123",
          title: "Renamed",
          content: "body",
          confirm: false,
          ...defaults,
        });

        expect(result.isError).toBe(true);
        // No PUT.
        const writes = fetchMock.mock.calls.filter((c) => {
          const init = c[1] as RequestInit | undefined;
          return init?.method === "PUT" || init?.method === "POST";
        });
        expect(writes).toHaveLength(0);
      });

      it("allows update of a page in an allowed space", async () => {
        process.env.CONFLUENCE_SPACES = "ENG";
        const { server, getTool } = createMockServer();
        registerConfluenceTool(server, () => kb);

        // PUB-13/PUB-4: publish now resolves page meta once at scope-check time
        // and re-fetches immediately before the PUT (TOCTOU shrink). Each meta
        // lookup costs page-GET + space-GET → 4 GETs total, then 1 PUT.
        // 1a) pre-confirm meta: page → spaceId + version + title
        mockFetchResponse({ id: "123", title: "Old", spaceId: "100", version: { number: 7 } });
        // 1b) pre-confirm meta: spaceId → key "ENG"
        mockFetchResponse({
          results: [{ id: "100", key: "ENG", name: "Engineering", type: "global" }],
          _links: {},
        });
        // 2a) fresh meta before PUT
        mockFetchResponse({ id: "123", title: "Old", spaceId: "100", version: { number: 7 } });
        // 2b) fresh meta space lookup
        mockFetchResponse({
          results: [{ id: "100", key: "ENG", name: "Engineering", type: "global" }],
          _links: {},
        });
        // 3) PUT update
        mockFetchResponse({
          id: "123",
          title: "Renamed",
          version: { number: 8 },
          _links: { webui: "/wiki/spaces/ENG/pages/123" },
        });

        const tool = getTool("confluence");
        const result = await tool({
          action: "publish",
          pageId: "123",
          title: "Renamed",
          content: "body",
          confirm: true,
          ...defaults,
        });

        expect(result.isError).toBeUndefined();
        const text = result.content[0]?.text ?? "";
        expect(text).toContain("Page updated");
        expect(text).toContain("New version: 8");
      });

      it("PUB-1: empty allow-list refuses publish (fail-closed default)", async () => {
        // Explicitly clear so resolveConfig falls back to []. The previous
        // behaviour silently allowed any reachable space; PUB-1 changed
        // this to fail closed.
        delete process.env.CONFLUENCE_SPACES;
        const { server, getTool } = createMockServer();
        registerConfluenceTool(server, () => kb);

        const tool = getTool("confluence");
        const result = await tool({
          action: "publish",
          spaceKey: "ANYTHING",
          title: "P",
          content: "ok",
          confirm: true,
          ...defaults,
        });

        expect(result.isError).toBe(true);
        const text = result.content[0]?.text ?? "";
        expect(text).toMatch(/allow-list is empty/i);
        // Critical: nothing was POSTed — preview-time rejection.
        expect(fetchMock).not.toHaveBeenCalled();
      });

      it("PUB-3: preview shows the storage XHTML and a sanitisation summary", async () => {
        // CONFLUENCE_SPACES already includes ENG via beforeEach.
        const { server, getTool } = createMockServer();
        registerConfluenceTool(server, () => kb);

        const tool = getTool("confluence");
        const result = await tool({
          action: "publish",
          spaceKey: "ENG",
          title: "P",
          // Inputs that materially change after sanitisation: a <script>
          // tag and a `javascript:` link. The preview must expose this.
          content: "# Hello\n\n<script>alert(1)</script>\n\n[click](javascript:bad())",
          confirm: false,
          ...defaults,
        });
        const text = result.content[0]?.text ?? "";

        expect(result.isError).toBeUndefined();
        // Storage excerpt block is present and labelled.
        expect(text).toContain("## Storage XHTML");
        // The XHTML excerpt contains the converted <h1>.
        expect(text).toContain("<h1>Hello</h1>");
        // Extract the storage section and assert <script> does NOT survive
        // into the XHTML the API will receive. (The raw markdown — by design
        // — still shows the input verbatim for review.)
        const storageBlock = text.split("## Storage XHTML")[1] ?? "";
        expect(storageBlock).not.toMatch(/<script\b/);
        // Sanitisation summary line surfaces what changed.
        expect(text).toMatch(/Sanitisation:.*1 <script> stripped/i);
        expect(text).toMatch(/dangerous link/i);
        // Nothing was written — preview only.
        expect(fetchMock).not.toHaveBeenCalled();
      });

      it("PUB-5: rejects when both pageId and spaceKey are supplied", async () => {
        const { server, getTool } = createMockServer();
        registerConfluenceTool(server, () => kb);

        const tool = getTool("confluence");
        const result = await tool({
          action: "publish",
          pageId: "123",
          spaceKey: "ENG",
          title: "X",
          content: "body",
          confirm: false,
          ...defaults,
        });

        expect(result.isError).toBe(true);
        const text = result.content[0]?.text ?? "";
        expect(text).toMatch(/either `pageId`.*OR `spaceKey`/i);
        expect(fetchMock).not.toHaveBeenCalled();
      });

      it("PUB-6: rejects create when parentId resolves to a different space", async () => {
        process.env.CONFLUENCE_SPACES = "ENG";
        const { server, getTool } = createMockServer();
        registerConfluenceTool(server, () => kb);

        // GET /pages/parent-id → spaceId 999
        mockFetchResponse({ id: "parent-id", title: "Parent", spaceId: "999", version: { number: 1 } });
        // GET /spaces?ids=999 → key "OTHER"
        mockFetchResponse({
          results: [{ id: "999", key: "OTHER", name: "Other Team", type: "global" }],
          _links: {},
        });

        const tool = getTool("confluence");
        const result = await tool({
          action: "publish",
          spaceKey: "ENG",
          title: "New",
          content: "body",
          parentId: "parent-id",
          confirm: false,
          ...defaults,
        });

        expect(result.isError).toBe(true);
        const text = result.content[0]?.text ?? "";
        expect(text).toMatch(/parentId.*OTHER.*ENG/i);
        // No POST to /pages happened.
        const writes = fetchMock.mock.calls.filter((c) => {
          const init = c[1] as RequestInit | undefined;
          return init?.method === "POST" || init?.method === "PUT";
        });
        expect(writes).toHaveLength(0);
      });

      it("PUB-4: re-fetches page meta before the PUT and refuses if space changed", async () => {
        process.env.CONFLUENCE_SPACES = "ENG";
        const { server, getTool } = createMockServer();
        registerConfluenceTool(server, () => kb);

        // 1a) pre-confirm meta: page in ENG (spaceId 100)
        mockFetchResponse({ id: "123", title: "Old", spaceId: "100", version: { number: 7 } });
        mockFetchResponse({
          results: [{ id: "100", key: "ENG", name: "Engineering", type: "global" }],
          _links: {},
        });
        // 2a) fresh meta — the page has been MOVED to OTHER (spaceId 555).
        mockFetchResponse({ id: "123", title: "Old", spaceId: "555", version: { number: 7 } });
        mockFetchResponse({
          results: [{ id: "555", key: "OTHER", name: "Other Team", type: "global" }],
          _links: {},
        });

        const tool = getTool("confluence");
        const result = await tool({
          action: "publish",
          pageId: "123",
          title: "Renamed",
          content: "body",
          confirm: true,
          ...defaults,
        });

        expect(result.isError).toBe(true);
        const text = result.content[0]?.text ?? "";
        expect(text).toMatch(/moved to "OTHER"/i);
        // Critical: the PUT must NOT have fired.
        const puts = fetchMock.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === "PUT");
        expect(puts).toHaveLength(0);
      });

      it("PUB-12: 4xx response body is included in the error message", async () => {
        process.env.CONFLUENCE_SPACES = "ENG";
        const { server, getTool } = createMockServer();
        registerConfluenceTool(server, () => kb);

        // Create flow: getSpace then POST returns 400.
        mockFetchResponse({
          results: [{ id: "100", key: "ENG", name: "Engineering", type: "global" }],
          _links: {},
        });
        fetchMock.mockResolvedValueOnce(
          new Response(JSON.stringify({ errors: [{ title: "title must not be blank" }] }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          }),
        );

        const tool = getTool("confluence");
        const result = await tool({
          action: "publish",
          spaceKey: "ENG",
          title: "Whatever",
          content: "body",
          confirm: true,
          ...defaults,
        });

        expect(result.isError).toBe(true);
        const text = result.content[0]?.text ?? "";
        // The actionable detail from the body must be surfaced.
        expect(text).toContain("title must not be blank");
      });

      it("PUB-1: explicit ['*'] allow-list reinstates unscoped writes", async () => {
        process.env.CONFLUENCE_SPACES = "*";
        const { server, getTool } = createMockServer();
        registerConfluenceTool(server, () => kb);

        // getSpace + POST create — no scope check fetches occur for wildcard.
        mockFetchResponse({
          results: [{ id: "100", key: "ANYTHING", name: "X", type: "global" }],
          _links: {},
        });
        mockFetchResponse({
          id: "999",
          title: "P",
          version: { number: 1 },
          _links: { webui: "/wiki/spaces/ANYTHING/pages/999" },
        });

        const tool = getTool("confluence");
        const result = await tool({
          action: "publish",
          spaceKey: "ANYTHING",
          title: "P",
          content: "ok",
          confirm: true,
          ...defaults,
        });

        expect(result.isError).toBeUndefined();
      });
    });

    it("shows truncated error list when more than 5 errors", async () => {
      const { server, getTool } = createMockServer();
      registerConfluenceTool(server, () => kb);

      // We need to mock the Spider to return many errors
      const { Spider } = await import("../lib/indexer.js");
      const crawlSpy = vi.spyOn(Spider.prototype, "crawl").mockResolvedValueOnce({
        indexed: 0,
        unchanged: 0,
        skipped: 0,
        errors: ["err1", "err2", "err3", "err4", "err5", "err6", "err7"],
      });

      const tool = getTool("confluence");
      const result = await tool({
        action: "spider",
        spaceKey: "ENG",
        ...defaults,
      });
      const text = result.content[0]?.text ?? "";
      expect(text).toContain("Errors (7)");
      expect(text).toContain("and 2 more");

      crawlSpy.mockRestore();
    });
  });
});
