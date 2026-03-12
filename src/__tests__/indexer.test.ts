import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConfluenceClient, ConfluencePage } from "../lib/confluence.js";
import { KnowledgeBase } from "../lib/db.js";
import { classifyPage, Spider } from "../lib/indexer.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Create a minimal ConfluencePage for testing. */
function makePage(overrides: Partial<ConfluencePage> = {}): ConfluencePage {
  return {
    id: overrides.id ?? "page-1",
    title: overrides.title ?? "Untitled",
    spaceId: overrides.spaceId ?? "space-1",
    status: overrides.status ?? "current",
    labels: overrides.labels ?? [],
    body: overrides.body ?? "Some page content here.",
    spaceKey: overrides.spaceKey,
    parentId: overrides.parentId,
    authorId: overrides.authorId,
    createdAt: overrides.createdAt,
    updatedAt: overrides.updatedAt ?? "2025-06-01T00:00:00Z",
    url: overrides.url,
  };
}

/** Create a mock ConfluenceClient with configurable responses. */
function mockClient(overrides: Partial<ConfluenceClient> = {}): ConfluenceClient {
  return {
    getSpace: overrides.getSpace ?? (async () => ({ id: "space-1", key: "ENG", name: "Engineering", type: "global" })),
    getSpaces: overrides.getSpaces ?? (async () => []),
    listPagesInSpace: overrides.listPagesInSpace ?? (async () => []),
    getPageFull: overrides.getPageFull ?? (async (id: string) => makePage({ id })),
    getPageChildren: overrides.getPageChildren ?? (async () => []),
    searchCQL: overrides.searchCQL ?? (async () => []),
  } as unknown as ConfluenceClient;
}

// ── classifyPage ─────────────────────────────────────────────────────────────

describe("classifyPage", () => {
  // ADR detection
  it("detects ADR by title pattern (ADR-001)", () => {
    expect(classifyPage(makePage({ title: "ADR-001: Use PostgreSQL" }))).toBe("adr");
  });

  it("detects ADR by label", () => {
    expect(classifyPage(makePage({ labels: ["adr"] }))).toBe("adr");
  });

  it("detects ADR by title keyword", () => {
    expect(classifyPage(makePage({ title: "Architecture Decision Record" }))).toBe("adr");
  });

  it("detects ADR by body content (status/context/decision sections)", () => {
    const body = "## Status\nAccepted\n\n## Context\nWe need a DB\n\n## Decision\nUse Postgres";
    expect(classifyPage(makePage({ body }))).toBe("adr");
  });

  // Design doc detection
  it("detects design doc by label", () => {
    expect(classifyPage(makePage({ labels: ["design-doc"] }))).toBe("design");
  });

  it("detects design doc by title", () => {
    expect(classifyPage(makePage({ title: "Technical Design: Auth Service" }))).toBe("design");
  });

  it("detects RFC as design doc", () => {
    expect(classifyPage(makePage({ title: "RFC: New API Gateway" }))).toBe("design");
  });

  // Runbook detection
  it("detects runbook by label", () => {
    expect(classifyPage(makePage({ labels: ["runbook"] }))).toBe("runbook");
  });

  it("detects runbook by title", () => {
    expect(classifyPage(makePage({ title: "Incident Runbook: DB Failover" }))).toBe("runbook");
  });

  it("detects playbook as runbook", () => {
    expect(classifyPage(makePage({ title: "Deployment Playbook" }))).toBe("runbook");
  });

  // Meeting notes detection
  it("detects meeting notes by label", () => {
    expect(classifyPage(makePage({ labels: ["meeting-notes"] }))).toBe("meeting");
  });

  it("detects meeting notes by date pattern in title", () => {
    expect(classifyPage(makePage({ title: "2025-01-15 Meeting Standup" }))).toBe("meeting");
  });

  // Spec detection
  it("detects spec by label", () => {
    expect(classifyPage(makePage({ labels: ["spec"] }))).toBe("spec");
  });

  it("detects spec by title keyword", () => {
    expect(classifyPage(makePage({ title: "API Specification v2" }))).toBe("spec");
  });

  it("detects PRD as spec", () => {
    expect(classifyPage(makePage({ title: "PRD: User Management" }))).toBe("spec");
  });

  // Fallback
  it("returns 'other' for unclassifiable pages", () => {
    expect(classifyPage(makePage({ title: "Random Team Page" }))).toBe("other");
  });

  it("returns 'other' for page with no labels or keywords", () => {
    expect(classifyPage(makePage({ title: "Hello World", labels: [] }))).toBe("other");
  });
});

// ── Spider ───────────────────────────────────────────────────────────────────

describe("Spider", () => {
  let kb: KnowledgeBase;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "lb-spider-test-"));
    kb = new KnowledgeBase(join(tmpDir, "test.db"));
  });

  afterEach(() => {
    kb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("crawl", () => {
    it("throws when neither spaceKey nor rootPageId provided", async () => {
      const spider = new Spider(mockClient(), kb);
      await expect(
        spider.crawl({ maxDepth: 10, maxConcurrency: 1, includeLabels: [], excludeLabels: [] }),
      ).rejects.toThrow("Either spaceKey or rootPageId must be provided");
    });
  });

  describe("crawlSpace", () => {
    it("indexes pages from a space", async () => {
      const pages = [
        makePage({ id: "p1", title: "Design Doc", body: "# Auth\nOAuth2 flow details" }),
        makePage({ id: "p2", title: "Runbook", body: "# Steps\nRestart the service" }),
      ];

      const client = mockClient({
        getSpace: async () => ({ id: "space-1", key: "ENG", name: "Engineering", type: "global" }),
        listPagesInSpace: async () => pages,
        getPageFull: async (id: string) => pages.find((p) => p.id === id) as (typeof pages)[number],
      });

      const spider = new Spider(client, kb);
      const result = await spider.crawl({
        spaceKey: "ENG",
        maxDepth: 10,
        maxConcurrency: 2,
        includeLabels: [],
        excludeLabels: [],
      });

      expect(result.indexed).toBe(2);
      expect(result.errors).toHaveLength(0);
      expect(kb.getPage("p1")).toBeTruthy();
      expect(kb.getPage("p2")).toBeTruthy();
    });

    it("skips unchanged pages (incremental sync)", async () => {
      const page = makePage({ id: "p1", title: "Existing", body: "content here", updatedAt: "2025-01-01T00:00:00Z" });

      // Pre-index the page
      kb.upsertPage({
        id: "p1",
        space_key: "ENG",
        title: "Existing",
        url: null,
        content: "content here",
        page_type: "other",
        labels: "[]",
        parent_id: null,
        author_id: null,
        created_at: null,
        updated_at: "2025-01-01T00:00:00Z",
        indexed_at: new Date().toISOString(),
        source: "confluence",
      });

      const client = mockClient({
        listPagesInSpace: async () => [page],
        getPageFull: async () => page,
      });

      const spider = new Spider(client, kb);
      const result = await spider.crawl({
        spaceKey: "ENG",
        maxDepth: 10,
        maxConcurrency: 1,
        includeLabels: [],
        excludeLabels: [],
      });

      expect(result.unchanged).toBe(1);
      expect(result.indexed).toBe(0);
    });

    it("skips empty pages", async () => {
      const page = makePage({ id: "p1", body: "" });

      const client = mockClient({
        listPagesInSpace: async () => [page],
        getPageFull: async () => page,
      });

      const spider = new Spider(client, kb);
      const result = await spider.crawl({
        spaceKey: "ENG",
        maxDepth: 10,
        maxConcurrency: 1,
        includeLabels: [],
        excludeLabels: [],
      });

      expect(result.skipped).toBe(1);
      expect(result.indexed).toBe(0);
    });

    it("respects includeLabels filter", async () => {
      const page = makePage({ id: "p1", labels: ["internal"], body: "Some content" });

      const client = mockClient({
        listPagesInSpace: async () => [page],
        getPageFull: async () => page,
      });

      const spider = new Spider(client, kb);
      const result = await spider.crawl({
        spaceKey: "ENG",
        maxDepth: 10,
        maxConcurrency: 1,
        includeLabels: ["design-doc"],
        excludeLabels: [],
      });

      expect(result.skipped).toBe(1);
      expect(result.indexed).toBe(0);
    });

    it("respects excludeLabels filter", async () => {
      const page = makePage({ id: "p1", labels: ["draft"], body: "Draft content" });

      const client = mockClient({
        listPagesInSpace: async () => [page],
        getPageFull: async () => page,
      });

      const spider = new Spider(client, kb);
      const result = await spider.crawl({
        spaceKey: "ENG",
        maxDepth: 10,
        maxConcurrency: 1,
        includeLabels: [],
        excludeLabels: ["draft"],
      });

      expect(result.skipped).toBe(1);
      expect(result.indexed).toBe(0);
    });

    it("throws when space not found", async () => {
      const client = mockClient({
        getSpace: async () => undefined,
      });

      const spider = new Spider(client, kb);
      await expect(
        spider.crawl({
          spaceKey: "NOPE",
          maxDepth: 10,
          maxConcurrency: 1,
          includeLabels: [],
          excludeLabels: [],
        }),
      ).rejects.toThrow("Space 'NOPE' not found");
    });

    it("captures errors without crashing", async () => {
      const client = mockClient({
        listPagesInSpace: async () => [makePage({ id: "p1" })],
        getPageFull: async () => {
          throw new Error("API timeout");
        },
      });

      const spider = new Spider(client, kb);
      const result = await spider.crawl({
        spaceKey: "ENG",
        maxDepth: 10,
        maxConcurrency: 1,
        includeLabels: [],
        excludeLabels: [],
      });

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain("API timeout");
    });

    it("calls onProgress callback", async () => {
      const page = makePage({ id: "p1", body: "content" });
      const client = mockClient({
        listPagesInSpace: async () => [page],
        getPageFull: async () => page,
      });

      const progressCalls: unknown[] = [];
      const spider = new Spider(client, kb);
      await spider.crawl(
        { spaceKey: "ENG", maxDepth: 10, maxConcurrency: 1, includeLabels: [], excludeLabels: [] },
        (progress) => progressCalls.push(progress),
      );

      expect(progressCalls.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("crawlTree", () => {
    it("crawls page tree recursively", async () => {
      const root = makePage({ id: "root", title: "Root Page", body: "Root content" });
      const child = makePage({ id: "child-1", title: "Child Page", body: "Child content" });

      const client = mockClient({
        getPageFull: async (id: string) => {
          if (id === "root") return root;
          if (id === "child-1") return child;
          throw new Error(`Unknown page: ${id}`);
        },
        getPageChildren: async (id: string) => {
          if (id === "root") return [makePage({ id: "child-1" })];
          return [];
        },
      });

      const spider = new Spider(client, kb);
      const result = await spider.crawl({
        rootPageId: "root",
        spaceKey: "ENG",
        maxDepth: 10,
        maxConcurrency: 1,
        includeLabels: [],
        excludeLabels: [],
      });

      expect(result.indexed).toBe(2);
      expect(kb.getPage("root")).toBeTruthy();
      expect(kb.getPage("child-1")).toBeTruthy();
    });

    it("respects maxDepth", async () => {
      const root = makePage({ id: "root", body: "Root" });
      const deep = makePage({ id: "deep", body: "Deep" });

      const client = mockClient({
        getPageFull: async (id: string) => (id === "root" ? root : deep),
        getPageChildren: async (id: string) => {
          if (id === "root") return [makePage({ id: "deep" })];
          return [];
        },
      });

      const spider = new Spider(client, kb);
      const result = await spider.crawl({
        rootPageId: "root",
        maxDepth: 0,
        maxConcurrency: 1,
        includeLabels: [],
        excludeLabels: [],
      });

      // Only root crawled, depth 0 means no children
      expect(result.indexed).toBe(1);
      expect(kb.getPage("deep")).toBeFalsy();
    });

    it("handles errors in tree crawl gracefully", async () => {
      const client = mockClient({
        getPageFull: async () => {
          throw new Error("Network error");
        },
        getPageChildren: async () => [],
      });

      const spider = new Spider(client, kb);
      const result = await spider.crawl({
        rootPageId: "root",
        maxDepth: 10,
        maxConcurrency: 1,
        includeLabels: [],
        excludeLabels: [],
      });

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain("Network error");
    });
  });
});
