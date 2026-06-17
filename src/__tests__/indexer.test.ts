import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfluenceClient, ConfluencePage } from "../lib/confluence.js";
import { KnowledgeBase } from "../lib/db.js";
import { classifyPage, computeContentHash, Spider } from "../lib/indexer.js";

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

      // Pre-index the page with the hash the spider will compute for the
      // incoming page so the incremental-sync check sees an unchanged page.
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
        content_hash: computeContentHash(page),
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

    // GEN-8: non-Error throws (plain objects, strings) used to render as
    // `[object Object]` because the catch block interpolated `${err}` raw.
    // The toErrMsg helper normalises these into a readable message.
    it("renders non-Error throws as a readable message (GEN-8)", async () => {
      const client = mockClient({
        getPageFull: async () => {
          // Simulate a rejected promise that carries a plain object — e.g. a
          // structured error from a third-party SDK. The test exercises the
          // `toErrMsg` helper which must turn this into something readable.
          throw { code: "ENOTFOUND", statusText: "host not found" };
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
      // Critical: the message must NOT be `[object Object]`.
      expect(result.errors[0]).not.toContain("[object Object]");
      // It must surface enough of the structured fields to be useful.
      expect(result.errors[0]).toMatch(/ENOTFOUND|host not found/);
    });

    // GEN-9: crawlTree previously called flushBatch one page at a time. The
    // batched implementation must still index every reachable page; this
    // regression test walks a 60-page tree (>50 = forces an intermediate
    // flush) and asserts the count is exact AND every page persisted.
    it("batches flushes across a deep tree without losing pages (GEN-9)", async () => {
      const totalPages = 60;
      const children = new Map<string, ConfluencePage[]>();
      for (let i = 0; i < totalPages; i++) {
        const id = `tree-${i}`;
        const childList = i + 1 < totalPages ? [makePage({ id: `tree-${i + 1}` })] : [];
        children.set(id, childList);
      }
      const client = mockClient({
        getPageFull: async (id: string) => makePage({ id, body: `body ${id}` }),
        getPageChildren: async (id: string) => children.get(id) ?? [],
      });

      const spider = new Spider(client, kb);
      const result = await spider.crawl({
        rootPageId: "tree-0",
        maxDepth: totalPages + 5,
        maxConcurrency: 1,
        includeLabels: [],
        excludeLabels: [],
      });

      expect(result.errors).toHaveLength(0);
      expect(result.indexed).toBe(totalPages);
      // Every page must be queryable — the final flushPending() catches the
      // tail batch that didn't hit the 50-page threshold.
      for (let i = 0; i < totalPages; i++) {
        expect(kb.getPage(`tree-${i}`)).toBeTruthy();
      }
    });
  });
});

// ── E1 — Content-hash incremental sync ─────────────────────────────────────

describe("computeContentHash", () => {
  it("returns a stable hex digest for the same inputs", () => {
    const a = computeContentHash({ title: "T", body: "B", labels: ["x", "y"] });
    const b = computeContentHash({ title: "T", body: "B", labels: ["x", "y"] });
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });

  it("is order-insensitive for labels", () => {
    const a = computeContentHash({ title: "T", body: "B", labels: ["x", "y"] });
    const b = computeContentHash({ title: "T", body: "B", labels: ["y", "x"] });
    expect(a).toBe(b);
  });

  it("changes when the body changes", () => {
    const a = computeContentHash({ title: "T", body: "B1", labels: [] });
    const b = computeContentHash({ title: "T", body: "B2", labels: [] });
    expect(a).not.toBe(b);
  });

  it("changes when labels change", () => {
    const a = computeContentHash({ title: "T", body: "B", labels: ["alpha"] });
    const b = computeContentHash({ title: "T", body: "B", labels: ["alpha", "beta"] });
    expect(a).not.toBe(b);
  });

  it("changes when the title changes", () => {
    const a = computeContentHash({ title: "T1", body: "B", labels: [] });
    const b = computeContentHash({ title: "T2", body: "B", labels: [] });
    expect(a).not.toBe(b);
  });

  it("treats undefined body as empty string", () => {
    const a = computeContentHash({ title: "T", body: undefined, labels: [] });
    const b = computeContentHash({ title: "T", body: "", labels: [] });
    expect(a).toBe(b);
  });

  // ── DB-1 — label-boundary collisions ──────────────────────────────────────

  it("does NOT collide when a label contains the separator character (DB-1)", () => {
    // Old impl joined labels with `,` so labels=['a,b'] hashed identically
    // to labels=['a','b']. JSON-encoding makes these distinct.
    const a = computeContentHash({ title: "T", body: "B", labels: ["a,b"] });
    const b = computeContentHash({ title: "T", body: "B", labels: ["a", "b"] });
    expect(a).not.toBe(b);
  });

  it("does NOT collide when labels include an empty string (DB-1)", () => {
    // Old impl: labels=[] joined to '' just like labels=[''] joined to ''.
    const a = computeContentHash({ title: "T", body: "B", labels: [] });
    const b = computeContentHash({ title: "T", body: "B", labels: [""] });
    expect(a).not.toBe(b);
  });

  it("does NOT collide when title/body share a separator boundary (DB-1)", () => {
    // Old impl concatenated with single-byte separators which made
    // shifting characters across the boundary undetectable. Two payloads
    // that differ only in WHERE the title ends and the body begins must
    // produce different hashes.
    const a = computeContentHash({ title: "ABC", body: "DEF", labels: [] });
    const b = computeContentHash({ title: "AB", body: "CDEF", labels: [] });
    expect(a).not.toBe(b);
  });

  // ── DB-2 — attachment-only edits force re-index ──────────────────────────

  it("changes when an attachment is renamed (DB-2)", () => {
    const base = { title: "T", body: "B", labels: ["a"] };
    const a = computeContentHash({
      ...base,
      attachments: [
        { id: "1", filename: "old.pdf", mediaType: "application/pdf", size: 100, url: "u", isImage: false },
      ],
    });
    const b = computeContentHash({
      ...base,
      attachments: [
        { id: "1", filename: "new.pdf", mediaType: "application/pdf", size: 100, url: "u", isImage: false },
      ],
    });
    expect(a).not.toBe(b);
  });

  it("changes when an attachment is swapped (different id, same filename) (DB-2)", () => {
    const base = { title: "T", body: "B", labels: ["a"] };
    const a = computeContentHash({
      ...base,
      attachments: [
        { id: "1", filename: "doc.pdf", mediaType: "application/pdf", size: 100, url: "u", isImage: false },
      ],
    });
    const b = computeContentHash({
      ...base,
      attachments: [
        { id: "2", filename: "doc.pdf", mediaType: "application/pdf", size: 100, url: "u", isImage: false },
      ],
    });
    expect(a).not.toBe(b);
  });

  it("is order-insensitive for attachments (DB-2)", () => {
    const att1 = { id: "1", filename: "a.pdf", mediaType: "application/pdf", size: 1, url: "u", isImage: false };
    const att2 = { id: "2", filename: "b.pdf", mediaType: "application/pdf", size: 2, url: "u", isImage: false };
    const a = computeContentHash({ title: "T", body: "B", labels: [], attachments: [att1, att2] });
    const b = computeContentHash({ title: "T", body: "B", labels: [], attachments: [att2, att1] });
    expect(a).toBe(b);
  });

  it("treats undefined attachments as []", () => {
    const a = computeContentHash({ title: "T", body: "B", labels: [] });
    const b = computeContentHash({ title: "T", body: "B", labels: [], attachments: [] });
    expect(a).toBe(b);
  });
});

describe("Spider — content-hash incremental sync (E1)", () => {
  let kb: KnowledgeBase;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "lb-spider-hash-test-"));
    kb = new KnowledgeBase(join(tmpDir, "test.db"));
  });

  afterEach(() => {
    kb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function runCrawl(client: ConfluenceClient) {
    return new Spider(client, kb).crawl({
      spaceKey: "ENG",
      maxDepth: 10,
      maxConcurrency: 1,
      includeLabels: [],
      excludeLabels: [],
    });
  }

  it("re-indexes when labels change but updated_at does not (label-only change)", async () => {
    const page = makePage({
      id: "p1",
      title: "Doc",
      body: "stable body",
      labels: ["draft"],
      updatedAt: "2025-01-01T00:00:00Z",
    });
    const client = mockClient({ listPagesInSpace: async () => [page], getPageFull: async () => page });
    const first = await runCrawl(client);
    expect(first.indexed).toBe(1);

    // Same updatedAt, same body, but a new label — old behaviour would have
    // marked the page unchanged. The hash now detects the label change.
    const relabeled = makePage({
      id: "p1",
      title: "Doc",
      body: "stable body",
      labels: ["draft", "approved"],
      updatedAt: "2025-01-01T00:00:00Z",
    });
    const client2 = mockClient({
      listPagesInSpace: async () => [relabeled],
      getPageFull: async () => relabeled,
    });
    const second = await runCrawl(client2);
    expect(second.indexed).toBe(1);
    expect(second.unchanged).toBe(0);

    // Verify the labels were actually persisted.
    const stored = kb.getPage("p1");
    expect(stored?.labels).toContain("approved");
  });

  it("re-indexes when ONLY attachments change (DB-2 — attachment-only edits)", async () => {
    // Page is created with one attachment, indexed, then a re-crawl swaps the
    // attachment id. Body / title / labels / updated_at are untouched. The
    // old hash (which ignored attachments) would mark the page unchanged and
    // leave the stored manifest stale. The fix folds attachments into the
    // hash so this case forces a re-index.
    const att1 = {
      id: "a1",
      filename: "old.pdf",
      mediaType: "application/pdf",
      size: 100,
      url: "https://example.com/old.pdf",
      isImage: false,
    };
    const att2 = {
      id: "a2",
      filename: "new.pdf",
      mediaType: "application/pdf",
      size: 200,
      url: "https://example.com/new.pdf",
      isImage: false,
    };
    const page = makePage({
      id: "p1",
      title: "Doc",
      body: "stable body",
      labels: ["x"],
      updatedAt: "2025-01-01T00:00:00Z",
    });
    page.attachments = [att1];
    const client = mockClient({ listPagesInSpace: async () => [page], getPageFull: async () => page });
    expect((await runCrawl(client)).indexed).toBe(1);

    // Re-crawl with the attachment swapped — everything else identical.
    const swapped = makePage({
      id: "p1",
      title: "Doc",
      body: "stable body",
      labels: ["x"],
      updatedAt: "2025-01-01T00:00:00Z",
    });
    swapped.attachments = [att2];
    const client2 = mockClient({
      listPagesInSpace: async () => [swapped],
      getPageFull: async () => swapped,
    });
    const second = await runCrawl(client2);
    expect(second.indexed).toBe(1);
    expect(second.unchanged).toBe(0);

    // The persisted manifest now points at the NEW attachment.
    const manifestRaw = kb.getConfig("confluence-attachments:p1");
    expect(manifestRaw).toBeTruthy();
    const manifest = JSON.parse(manifestRaw ?? "[]") as Array<{ id: string }>;
    expect(manifest.map((a) => a.id)).toEqual(["a2"]);
  });

  it("re-indexes when body changes but updated_at does not (content-only change)", async () => {
    const page = makePage({
      id: "p1",
      title: "Doc",
      body: "original body",
      labels: [],
      updatedAt: "2025-01-01T00:00:00Z",
    });
    const client = mockClient({ listPagesInSpace: async () => [page], getPageFull: async () => page });
    expect((await runCrawl(client)).indexed).toBe(1);

    const edited = makePage({
      id: "p1",
      title: "Doc",
      body: "edited body",
      labels: [],
      updatedAt: "2025-01-01T00:00:00Z",
    });
    const client2 = mockClient({ listPagesInSpace: async () => [edited], getPageFull: async () => edited });
    const second = await runCrawl(client2);
    expect(second.indexed).toBe(1);
    expect(second.unchanged).toBe(0);
    expect(kb.getPage("p1")?.content).toBe("edited body");
  });

  it("skips truly unchanged pages (hash and updated_at match)", async () => {
    const page = makePage({
      id: "p1",
      title: "Doc",
      body: "body",
      labels: ["x"],
      updatedAt: "2025-01-01T00:00:00Z",
    });
    const client = mockClient({ listPagesInSpace: async () => [page], getPageFull: async () => page });
    expect((await runCrawl(client)).indexed).toBe(1);

    // Same page again — expect unchanged.
    const second = await runCrawl(client);
    expect(second.indexed).toBe(0);
    expect(second.unchanged).toBe(1);
  });

  it("re-indexes legacy rows with NULL content_hash (backfill on first re-crawl)", async () => {
    // Simulate a row from before the migration: identical content but
    // content_hash is null.
    kb.upsertPage({
      id: "p1",
      space_key: "ENG",
      title: "Legacy",
      url: null,
      content: "body",
      page_type: "other",
      labels: "[]",
      parent_id: null,
      author_id: null,
      created_at: null,
      updated_at: "2025-01-01T00:00:00Z",
      indexed_at: new Date().toISOString(),
      source: "confluence",
      content_hash: null,
    });

    const page = makePage({
      id: "p1",
      title: "Legacy",
      body: "body",
      labels: [],
      updatedAt: "2025-01-01T00:00:00Z",
    });
    const client = mockClient({ listPagesInSpace: async () => [page], getPageFull: async () => page });

    const result = await runCrawl(client);
    expect(result.indexed).toBe(1); // backfilled
    expect(result.unchanged).toBe(0);
    // After backfill, hash is populated.
    expect(kb.getPage("p1")?.content_hash).toMatch(/^[a-f0-9]{64}$/);

    // Now a second pass should mark it unchanged.
    const second = await runCrawl(client);
    expect(second.indexed).toBe(0);
    expect(second.unchanged).toBe(1);
  });
});

// ── DB-3 / DB-4 — flushBatch atomicity & honest indexed counter ────────────

describe("Spider — flushBatch atomicity (DB-3, DB-4)", () => {
  let kb: KnowledgeBase;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "lb-spider-atomicity-"));
    kb = new KnowledgeBase(join(tmpDir, "test.db"));
  });

  afterEach(() => {
    kb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does NOT commit page rows when chunk insertion fails (DB-3)", async () => {
    // Simulate a chunk-insert sqlite failure by spying on upsertPagesWithChunks
    // and throwing AFTER the transaction body — equivalent to a per-page
    // chunk-builder failure mid-batch. The old code committed the page in one
    // transaction and the chunks in another, so a failure left a "fresh hash
    // + stale chunks" mismatch on disk. The new code wraps both in a single
    // sqlite transaction; on throw, neither lands.
    const original = kb.upsertPagesWithChunks.bind(kb);
    const spy = vi.spyOn(kb, "upsertPagesWithChunks").mockImplementation((entries) => {
      // Run the real upsert to get the rows, then re-open a fresh transaction
      // to roll back by throwing — simulates a failure inside the transaction.
      original(entries);
      throw new Error("simulated sqlite error mid-chunk-insert");
    });

    const page = {
      id: "p1",
      title: "Doc",
      spaceId: "space-1",
      status: "current",
      labels: [],
      body: "Body content for chunking",
      updatedAt: "2025-01-01T00:00:00Z",
    };
    const client = mockClient({
      listPagesInSpace: async () => [page as ConfluencePage],
      getPageFull: async () => page as ConfluencePage,
    });
    const result = await new Spider(client, kb).crawl({
      spaceKey: "ENG",
      maxDepth: 10,
      maxConcurrency: 1,
      includeLabels: [],
      excludeLabels: [],
    });
    // The error should be surfaced and `result.indexed` should NOT count
    // the page (DB-4) — the spy bumped the row count then threw, but the
    // caller treats that as a failed flush.
    expect(result.indexed).toBe(0);
    expect(result.errors.length).toBeGreaterThan(0);
    spy.mockRestore();
  });

  it("only attributes `result.indexed` after a successful flush (DB-4)", async () => {
    // Independent expectation: when flushBatch succeeds for N pages, the
    // counter advances by exactly N — NOT before the flush runs.
    const pages: ConfluencePage[] = [];
    for (let i = 0; i < 3; i++) {
      pages.push({
        id: `p${i}`,
        title: `Page ${i}`,
        spaceId: "space-1",
        status: "current",
        labels: [],
        body: `Body ${i}`,
        updatedAt: "2025-01-01T00:00:00Z",
      });
    }
    const client = mockClient({
      listPagesInSpace: async () => pages,
      getPageFull: async (id: string) => pages.find((p) => p.id === id) as ConfluencePage,
    });
    const result = await new Spider(client, kb).crawl({
      spaceKey: "ENG",
      maxDepth: 10,
      maxConcurrency: 1,
      includeLabels: [],
      excludeLabels: [],
    });
    expect(result.indexed).toBe(3);
    expect(result.errors).toHaveLength(0);
    for (const p of pages) {
      expect(kb.getPage(p.id)).toBeTruthy();
    }
  });
});

// ── KnowledgeBase.needsReindex direct unit tests ───────────────────────────

describe("KnowledgeBase.needsReindex (E1 hash-aware)", () => {
  let kb: KnowledgeBase;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "lb-needsreindex-"));
    kb = new KnowledgeBase(join(tmpDir, "test.db"));
  });

  afterEach(() => {
    kb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function seed(hash: string | null, updatedAt: string | null = "2025-01-01T00:00:00Z") {
    kb.upsertPage({
      id: "p1",
      space_key: "ENG",
      title: "T",
      url: null,
      content: "body",
      page_type: "other",
      labels: "[]",
      parent_id: null,
      author_id: null,
      created_at: null,
      updated_at: updatedAt,
      indexed_at: new Date().toISOString(),
      source: "confluence",
      content_hash: hash,
    });
  }

  it("returns true for an unknown page", () => {
    expect(kb.needsReindex("missing", "2025-01-01T00:00:00Z", "abc")).toBe(true);
  });

  it("returns true when the stored hash is null (legacy row)", () => {
    seed(null);
    expect(kb.needsReindex("p1", "2025-01-01T00:00:00Z", "abc")).toBe(true);
  });

  it("returns false when hash and updated_at both match", () => {
    seed("abc");
    expect(kb.needsReindex("p1", "2025-01-01T00:00:00Z", "abc")).toBe(false);
  });

  it("returns true when the hash differs even though updated_at matches", () => {
    seed("abc");
    expect(kb.needsReindex("p1", "2025-01-01T00:00:00Z", "def")).toBe(true);
  });

  it("returns true when hash matches but remote updated_at advanced", () => {
    seed("abc");
    expect(kb.needsReindex("p1", "2025-06-01T00:00:00Z", "abc")).toBe(true);
  });

  it("falls back to legacy updated_at-only behaviour when hash is omitted", () => {
    seed("abc");
    expect(kb.needsReindex("p1", "2025-01-01T00:00:00Z")).toBe(false);
    expect(kb.needsReindex("p1", "2025-06-01T00:00:00Z")).toBe(true);
  });

  it("returns true when remote updated_at is undefined (legacy path, defensive)", () => {
    seed("abc");
    expect(kb.needsReindex("p1", undefined)).toBe(true);
  });
});
