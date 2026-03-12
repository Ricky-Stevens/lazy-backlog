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
