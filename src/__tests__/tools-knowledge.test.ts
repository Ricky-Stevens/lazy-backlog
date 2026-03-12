import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IndexedPage } from "../lib/db.js";
import { KnowledgeBase } from "../lib/db.js";
import { appendSection, formatSummaryLine, registerKnowledgeTool } from "../tools/knowledge.js";
import { createMockServer } from "./helpers/mock-server.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

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
  limit: 5,
  summarize: false,
  staleDays: 90,
};

// ── formatSummaryLine ──────────────────────────────────────────────────────

describe("formatSummaryLine", () => {
  it("formats a summary with title, space, labels, and preview", () => {
    const result = formatSummaryLine({
      id: "p1",
      title: "Test Page",
      space_key: "ENG",
      page_type: "design",
      url: null,
      labels: '["design"]',
      content_preview: "Preview text here.",
      updated_at: "2025-06-01",
      source: "confluence",
    });
    expect(result).toContain("**Test Page**");
    expect(result).toContain("(ENG)");
    expect(result).toContain("Preview text here.");
  });
});

// ── appendSection ──────────────────────────────────────────────────────────

describe("appendSection", () => {
  it("emits heading and items", () => {
    const pages = [
      {
        id: "a1",
        title: "ADR-001",
        space_key: "ENG",
        page_type: "adr" as const,
        url: null,
        labels: "[]",
        content_preview: "Decision",
        updated_at: null,
        source: "confluence",
      },
    ];
    const parts: string[] = [];
    const remaining = appendSection(pages, "ADRs", 10, 5000, (s) => parts.push(s));
    const output = parts.join("");
    expect(output).toContain("## ADRs (1)");
    expect(output).toContain("### ADR-001");
    expect(remaining).toBeLessThan(5000);
  });

  it("returns budget unchanged for empty pages", () => {
    const remaining = appendSection([], "Empty", 10, 5000, () => {});
    expect(remaining).toBe(5000);
  });

  it("returns budget unchanged when budget is zero", () => {
    const pages = [
      {
        id: "a1",
        title: "ADR-001",
        space_key: "ENG",
        page_type: "adr" as const,
        url: null,
        labels: "[]",
        content_preview: "Decision",
        updated_at: null,
        source: "confluence",
      },
    ];
    const remaining = appendSection(pages, "ADRs", 10, 0, () => {});
    expect(remaining).toBe(0);
  });

  it("truncates when budget runs low", () => {
    const pages = Array.from({ length: 5 }, (_, i) => ({
      id: `a${i}`,
      title: `ADR-${String(i).padStart(3, "0")}`,
      space_key: "ENG",
      page_type: "adr" as const,
      url: null,
      labels: "[]",
      content_preview: "A".repeat(50),
      updated_at: null,
      source: "confluence",
    }));
    const parts: string[] = [];
    // Give just enough budget for heading + ~1 item, forcing truncation
    const remaining = appendSection(pages, "ADRs", 5, 120, (s) => parts.push(s));
    const output = parts.join("");
    expect(output).toContain("## ADRs (5)");
    // Should have truncated with "…and X more"
    expect(output).toContain("more");
    expect(remaining).toBeLessThanOrEqual(100);
  });
});

// ── registerKnowledgeTool ────────────────────────────────────────────────

describe("registerKnowledgeTool", () => {
  let kb: KnowledgeBase;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "lb-knowledge-test-"));
    kb = new KnowledgeBase(join(tmpDir, "test.db"));
  });

  afterEach(() => {
    kb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("registers a single 'knowledge' tool", () => {
    const { server, toolNames } = createMockServer();
    registerKnowledgeTool(server, () => kb);
    expect(toolNames()).toEqual(["knowledge"]);
  });

  // ── search ─────────────────────────────────────────────────────────────

  describe("action=search", () => {
    it("returns chunk matches with headings", async () => {
      const { server, getTool } = createMockServer();
      registerKnowledgeTool(server, () => kb);

      kb.upsertPage(makePage({ id: "p1", title: "Auth Design", content: "OAuth2 authentication flow" }));
      kb.upsertChunks("p1", [
        {
          breadcrumb: "Auth > OAuth2",
          heading: "Token Flow",
          depth: 2,
          content: "OAuth2 token refresh mechanism details",
          index: 0,
        },
      ]);

      const tool = getTool("knowledge");
      const result = await tool({
        action: "search",
        query: "OAuth2",
        ...defaults,
      });
      expect(result.content[0]?.text).toContain("results");
      expect(result.content[0]?.text).toContain("Auth Design");
    });

    it("shows URL suffix for chunk results when available", async () => {
      const { server, getTool } = createMockServer();
      registerKnowledgeTool(server, () => kb);

      kb.upsertPage(makePage({ id: "p1", title: "Auth Design", url: "https://wiki.example.com/page-1", content: "OAuth2 authentication flow" }));
      kb.upsertChunks("p1", [
        {
          breadcrumb: "Auth > OAuth2",
          heading: "Token Flow",
          depth: 2,
          content: "OAuth2 token refresh mechanism details",
          index: 0,
        },
      ]);

      const tool = getTool("knowledge");
      const result = await tool({
        action: "search",
        query: "OAuth2",
        ...defaults,
      });
      expect(result.content[0]?.text).toContain("https://wiki.example.com/page-1");
    });

    it("falls back to page search when no chunks", async () => {
      const { server, getTool } = createMockServer();
      registerKnowledgeTool(server, () => kb);

      kb.upsertPage(
        makePage({
          id: "p1",
          title: "DB Migration",
          content: "PostgreSQL migration guide",
          page_type: "runbook",
          labels: "[]",
        }),
      );

      const tool = getTool("knowledge");
      const result = await tool({
        action: "search",
        query: "PostgreSQL",
        ...defaults,
      });
      expect(result.content[0]?.text).toContain("DB Migration");
    });

    it("returns empty for no matches", async () => {
      const { server, getTool } = createMockServer();
      registerKnowledgeTool(server, () => kb);

      const tool = getTool("knowledge");
      const result = await tool({
        action: "search",
        query: "nonexistent",
        ...defaults,
      });
      expect(result.content[0]?.text).toContain("No results");
    });

    it("filters by pageType", async () => {
      const { server, getTool } = createMockServer();
      registerKnowledgeTool(server, () => kb);

      kb.upsertPage(makePage({ id: "p1", title: "Design Doc", content: "OAuth2 flow", page_type: "design" }));
      kb.upsertPage(makePage({ id: "p2", title: "Runbook", content: "OAuth2 runbook", page_type: "runbook" }));

      const tool = getTool("knowledge");
      const result = await tool({
        action: "search",
        query: "OAuth2",
        pageType: "runbook",
        ...defaults,
      });
      expect(result.content[0]?.text).toContain("Runbook");
      expect(result.content[0]?.text).not.toContain("Design Doc");
    });

    it("returns stats when no query", async () => {
      const { server, getTool } = createMockServer();
      registerKnowledgeTool(server, () => kb);

      kb.upsertPage(makePage({ id: "p1", page_type: "adr" }));

      const tool = getTool("knowledge");
      const result = await tool({
        action: "search",
        ...defaults,
      });
      expect(result.content[0]?.text).toContain("Total: 1");
      expect(result.content[0]?.text).toContain("adr");
    });

    it("returns empty message for stats on empty KB", async () => {
      const { server, getTool } = createMockServer();
      registerKnowledgeTool(server, () => kb);

      const tool = getTool("knowledge");
      const result = await tool({
        action: "search",
        ...defaults,
      });
      expect(result.content[0]?.text).toContain("empty");
    });

    it("returns context summary when summarize=true", async () => {
      const { server, getTool } = createMockServer();
      registerKnowledgeTool(server, () => kb);

      kb.upsertPage(makePage({ id: "a1", title: "ADR-001", page_type: "adr", content: "Use PostgreSQL" }));
      kb.upsertPage(makePage({ id: "d1", title: "Auth Design", page_type: "design", content: "OAuth2 design" }));

      const tool = getTool("knowledge");
      const result = await tool({
        action: "search",
        ...defaults,
        summarize: true,
      });
      expect(result.content[0]?.text).toContain("Project Context");
      expect(result.content[0]?.text).toContain("ADRs");
    });

    it("returns empty message when summarize=true on empty KB (no query falls through to stats)", async () => {
      const { server, getTool } = createMockServer();
      registerKnowledgeTool(server, () => kb);

      const tool = getTool("knowledge");
      const result = await tool({
        action: "search",
        ...defaults,
        summarize: true,
      });
      expect(result.content[0]?.text).toContain("empty");
    });
  });

  // ── stats ──────────────────────────────────────────────────────────────

  describe("action=stats", () => {
    it("returns stats overview", async () => {
      const { server, getTool } = createMockServer();
      registerKnowledgeTool(server, () => kb);

      kb.upsertPage(makePage({ id: "p1", page_type: "adr" }));

      const tool = getTool("knowledge");
      const result = await tool({
        action: "stats",
        ...defaults,
      });
      expect(result.content[0]?.text).toContain("Total: 1");
      expect(result.content[0]?.text).toContain("adr");
    });

    it("returns empty message on empty KB", async () => {
      const { server, getTool } = createMockServer();
      registerKnowledgeTool(server, () => kb);

      const tool = getTool("knowledge");
      const result = await tool({
        action: "stats",
        ...defaults,
      });
      expect(result.content[0]?.text).toContain("empty");
    });

    it("shows source breakdown when bySource is present", async () => {
      const { server, getTool } = createMockServer();
      registerKnowledgeTool(server, () => kb);

      kb.upsertPage(makePage({ id: "p1", page_type: "adr", source: "confluence" }));
      kb.upsertPage(makePage({ id: "p2", page_type: "design", source: "github" }));

      const tool = getTool("knowledge");
      const result = await tool({
        action: "stats",
        ...defaults,
      });
      const text = result.content[0]?.text ?? "";
      expect(text).toContain("Total: 2");
      expect(text).toContain("By source:");
    });

    it("returns context summary when summarize=true", async () => {
      const { server, getTool } = createMockServer();
      registerKnowledgeTool(server, () => kb);

      kb.upsertPage(makePage({ id: "a1", title: "ADR-001", page_type: "adr", content: "Use PostgreSQL" }));

      const tool = getTool("knowledge");
      const result = await tool({
        action: "stats",
        ...defaults,
        summarize: true,
      });
      expect(result.content[0]?.text).toContain("Project Context");
      expect(result.content[0]?.text).toContain("ADRs");
    });
  });

  // ── get-page ───────────────────────────────────────────────────────────

  describe("action=get-page", () => {
    it("returns full page content", async () => {
      const { server, getTool } = createMockServer();
      registerKnowledgeTool(server, () => kb);

      kb.upsertPage(makePage({ id: "p1", title: "Auth Design", content: "Full page content here" }));

      const tool = getTool("knowledge");
      const result = await tool({
        action: "get-page",
        pageId: "p1",
        ...defaults,
      });
      expect(result.content[0]?.text).toContain("Auth Design");
      expect(result.content[0]?.text).toContain("Full page content here");
    });

    it("returns error for missing page", async () => {
      const { server, getTool } = createMockServer();
      registerKnowledgeTool(server, () => kb);

      const tool = getTool("knowledge");
      const result = await tool({
        action: "get-page",
        pageId: "nonexistent",
        ...defaults,
      });
      expect(result.isError).toBe(true);
    });

    it("truncates at 15K chars", async () => {
      const { server, getTool } = createMockServer();
      registerKnowledgeTool(server, () => kb);

      kb.upsertPage(makePage({ id: "p1", title: "Big Page", content: "A".repeat(20000) }));

      const tool = getTool("knowledge");
      const result = await tool({
        action: "get-page",
        pageId: "p1",
        ...defaults,
      });
      expect(result.content[0]?.text).toContain("truncated");
    });

    it("includes URL when page has one", async () => {
      const { server, getTool } = createMockServer();
      registerKnowledgeTool(server, () => kb);

      kb.upsertPage(makePage({ id: "p1", title: "With URL", url: "https://wiki.example.com/page-1", content: "content" }));

      const tool = getTool("knowledge");
      const result = await tool({
        action: "get-page",
        pageId: "p1",
        ...defaults,
      });
      expect(result.content[0]?.text).toContain("https://wiki.example.com/page-1");
    });

    it("omits URL line when page has empty URL", async () => {
      const { server, getTool } = createMockServer();
      registerKnowledgeTool(server, () => kb);

      kb.upsertPage(makePage({ id: "p1", title: "No URL Page", url: "", content: "content here" }));

      const tool = getTool("knowledge");
      const result = await tool({
        action: "get-page",
        pageId: "p1",
        ...defaults,
      });
      const text = result.content[0]?.text ?? "";
      expect(text).toContain("No URL Page");
      // The URL line should not appear between the metadata and the ---
      const lines = text.split("\n");
      const dashIdx = lines.findIndex((l) => l === "---");
      // Line before --- should be the metadata line, not a URL
      expect(lines[dashIdx - 1]).not.toMatch(/^https?:\/\//);
    });

    it("returns error when pageId is missing", async () => {
      const { server, getTool } = createMockServer();
      registerKnowledgeTool(server, () => kb);

      const tool = getTool("knowledge");
      const result = await tool({
        action: "get-page",
        ...defaults,
      });
      expect(result.isError).toBe(true);
    });
  });

  // ── stale-docs ─────────────────────────────────────────────────────────

  describe("action=stale-docs", () => {
    it("returns stale pages", async () => {
      const { server, getTool } = createMockServer();
      registerKnowledgeTool(server, () => kb);

      kb.upsertPage(makePage({ id: "old1", title: "Old Page", updated_at: "2020-01-01T00:00:00Z" }));

      const tool = getTool("knowledge");
      const result = await tool({
        action: "stale-docs",
        ...defaults,
        staleDays: 30,
      });
      expect(result.content[0]?.text).toContain("Old Page");
      expect(result.content[0]?.text).toContain("stale");
    });

    it("returns empty when all pages are fresh", async () => {
      const { server, getTool } = createMockServer();
      registerKnowledgeTool(server, () => kb);

      kb.upsertPage(makePage({ id: "fresh1", title: "Fresh Page", updated_at: new Date().toISOString() }));

      const tool = getTool("knowledge");
      const result = await tool({
        action: "stale-docs",
        ...defaults,
      });
      expect(result.content[0]?.text).toContain("No pages older than");
    });
  });

  // ── what-changed ───────────────────────────────────────────────────────

  describe("action=what-changed", () => {
    it("returns recently changed pages", async () => {
      const { server, getTool } = createMockServer();
      registerKnowledgeTool(server, () => kb);

      kb.upsertPage(makePage({ id: "p1", title: "Recently Changed", indexed_at: new Date().toISOString() }));

      const tool = getTool("knowledge");
      const result = await tool({
        action: "what-changed",
        since: "2020-01-01T00:00:00Z",
        ...defaults,
      });
      expect(result.content[0]?.text).toContain("Recently Changed");
    });

    it("returns empty when since finds nothing", async () => {
      const { server, getTool } = createMockServer();
      registerKnowledgeTool(server, () => kb);

      const tool = getTool("knowledge");
      const futureDate = new Date(Date.now() + 86400000).toISOString();
      const result = await tool({
        action: "what-changed",
        since: futureDate,
        ...defaults,
      });
      expect(result.content[0]?.text).toContain("No changes");
    });

    it("returns error when since is missing", async () => {
      const { server, getTool } = createMockServer();
      registerKnowledgeTool(server, () => kb);

      const tool = getTool("knowledge");
      const result = await tool({
        action: "what-changed",
        ...defaults,
      });
      expect(result.isError).toBe(true);
    });
  });
});
