import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IndexedPage } from "../lib/db.js";
import { KnowledgeBase } from "../lib/db.js";
import {
  appendSection,
  formatSummaryLine,
  MAX_PAGE_CHARS,
  MAX_PAGE_SIZE,
  MIN_PAGE_SIZE,
  paginateContent,
  registerKnowledgeTool,
} from "../tools/knowledge.js";
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
    content_hash: overrides.content_hash ?? null,
  };
}

// ── Default params helper ────────────────────────────────────────────────────

const defaults = {
  limit: 5,
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

      kb.upsertPage(
        makePage({
          id: "p1",
          title: "Auth Design",
          url: "https://wiki.example.com/page-1",
          content: "OAuth2 authentication flow",
        }),
      );
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
      expect(result.content[0]?.text).toContain("Total pages");
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
      expect(result.content[0]?.text).toContain("Total pages");
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
      expect(text).toContain("Total pages");
      expect(text).toContain("By source:");
    });

    it("includes context summary with ADRs in stats", async () => {
      const { server, getTool } = createMockServer();
      registerKnowledgeTool(server, () => kb);

      kb.upsertPage(makePage({ id: "a1", title: "ADR-001", page_type: "adr", content: "Use PostgreSQL" }));

      const tool = getTool("knowledge");
      const result = await tool({
        action: "stats",
        ...defaults,
      });
      expect(result.content[0]?.text).toContain("Context Summary");
      expect(result.content[0]?.text).toContain("ADRs");
    });

    it("includes KB health indicator", async () => {
      const { server, getTool } = createMockServer();
      registerKnowledgeTool(server, () => kb);

      kb.upsertPage(makePage({ id: "p1", page_type: "adr", updated_at: new Date().toISOString() }));

      const tool = getTool("knowledge");
      const result = await tool({
        action: "stats",
        ...defaults,
      });
      const text = result.content[0]?.text ?? "";
      expect(text).toContain("KB Health:");
      expect(text).toMatch(/healthy|needs-attention|stale/);
    });

    it("shows stale docs section for old pages", async () => {
      const { server, getTool } = createMockServer();
      registerKnowledgeTool(server, () => kb);

      kb.upsertPage(makePage({ id: "old1", title: "Old Page", updated_at: "2020-01-01T00:00:00Z" }));

      const tool = getTool("knowledge");
      const result = await tool({
        action: "stats",
        ...defaults,
      });
      const text = result.content[0]?.text ?? "";
      expect(text).toContain("Stale Docs");
      expect(text).toContain("Old Page");
    });

    it("shows recent changes section", async () => {
      const { server, getTool } = createMockServer();
      registerKnowledgeTool(server, () => kb);

      kb.upsertPage(makePage({ id: "p1", title: "Fresh Page", indexed_at: new Date().toISOString() }));

      const tool = getTool("knowledge");
      const result = await tool({
        action: "stats",
        ...defaults,
      });
      const text = result.content[0]?.text ?? "";
      expect(text).toContain("Recent Changes");
      expect(text).toContain("Fresh Page");
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

    it("paginates long pages instead of silently truncating (E2)", async () => {
      const { server, getTool } = createMockServer();
      registerKnowledgeTool(server, () => kb);

      kb.upsertPage(makePage({ id: "p1", title: "Big Page", content: "A".repeat(20000) }));

      const tool = getTool("knowledge");
      const result = await tool({
        action: "get-page",
        pageId: "p1",
        ...defaults,
      });
      const text = result.content[0]?.text ?? "";
      // Continuation metadata replaces the old silent "truncated" suffix.
      expect(text).toContain("Page 1 of 2");
      expect(text).toContain("20000 chars");
      // Old silent truncation marker must NOT appear anymore.
      expect(text).not.toContain("[truncated");
    });

    it("includes URL when page has one", async () => {
      const { server, getTool } = createMockServer();
      registerKnowledgeTool(server, () => kb);

      kb.upsertPage(
        makePage({ id: "p1", title: "With URL", url: "https://wiki.example.com/page-1", content: "content" }),
      );

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
      const dashIdx = lines.indexOf("---");
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

    // ── E2 — Pagination instead of silent truncation ─────────────────────

    it("returns the requested page slice when paginating", async () => {
      const { server, getTool } = createMockServer();
      registerKnowledgeTool(server, () => kb);

      // 30k content + default 15k window = 2 pages.
      const content = `${"A".repeat(15000)}${"B".repeat(15000)}`;
      kb.upsertPage(makePage({ id: "p1", title: "Big Page", content }));

      const tool = getTool("knowledge");

      const p1 = await tool({ action: "get-page", pageId: "p1", page: 1, ...defaults });
      const text1 = p1.content[0]?.text ?? "";
      expect(text1).toContain("Page 1 of 2");
      expect(text1).toContain("A".repeat(100));
      expect(text1).not.toContain("B".repeat(100));
      expect(text1).toContain("page=2");

      const p2 = await tool({ action: "get-page", pageId: "p1", page: 2, ...defaults });
      const text2 = p2.content[0]?.text ?? "";
      expect(text2).toContain("Page 2 of 2");
      expect(text2).toContain("B".repeat(100));
      expect(text2).not.toContain("A".repeat(100));
      expect(text2).toContain("final page");
    });

    it("reassembles to the full original content across pages", async () => {
      const { server, getTool } = createMockServer();
      registerKnowledgeTool(server, () => kb);

      // Use a distinctive pattern so we can detect any loss across page seams.
      const total = 32_000;
      const content = Array.from({ length: total }, (_, i) => String.fromCharCode(33 + (i % 90))).join("");
      kb.upsertPage(makePage({ id: "p1", title: "Big Page", content }));

      const tool = getTool("knowledge");
      // Use pageSize = MIN_PAGE_SIZE for many small windows.
      const pageSize = MIN_PAGE_SIZE;
      const expectedPages = Math.ceil(total / pageSize);

      let assembled = "";
      for (let p = 1; p <= expectedPages; p++) {
        const r = await tool({ action: "get-page", pageId: "p1", page: p, pageSize, ...defaults });
        const text = r.content[0]?.text ?? "";
        // Strip the metadata header (everything up to and including the first `---\n`)
        // and the pagination footer (everything from the LAST `---\n` onwards).
        const afterHeader = text.split("\n---\n").slice(1).join("\n---\n");
        const footerIdx = afterHeader.lastIndexOf("\n\n---\n**Page ");
        const slice = footerIdx >= 0 ? afterHeader.slice(0, footerIdx) : afterHeader;
        assembled += slice;
      }
      expect(assembled).toBe(content);
    });

    it("clamps an out-of-range page to the last page (no silent loss)", async () => {
      const { server, getTool } = createMockServer();
      registerKnowledgeTool(server, () => kb);

      const content = `${"X".repeat(15000)}${"Y".repeat(15000)}`;
      kb.upsertPage(makePage({ id: "p1", title: "Big", content }));

      const tool = getTool("knowledge");
      const result = await tool({ action: "get-page", pageId: "p1", page: 99, ...defaults });
      const text = result.content[0]?.text ?? "";
      expect(text).toContain("Page 2 of 2");
      expect(text).toContain("Y".repeat(100));
    });

    it("omits pagination metadata for short pages (back-compat)", async () => {
      const { server, getTool } = createMockServer();
      registerKnowledgeTool(server, () => kb);

      kb.upsertPage(makePage({ id: "p1", title: "Small", content: "tiny body" }));

      const tool = getTool("knowledge");
      const result = await tool({ action: "get-page", pageId: "p1", ...defaults });
      const text = result.content[0]?.text ?? "";
      expect(text).not.toContain("Page 1 of");
      expect(text).toContain("tiny body");
    });

    // ── PAG-7 — future-dated updated_at ──────────────────────────────────

    it("does not label a future-dated page as 'Fresh' (PAG-7)", async () => {
      const { server, getTool } = createMockServer();
      registerKnowledgeTool(server, () => kb);

      const future = new Date(Date.now() + 5 * 86_400_000).toISOString();
      kb.upsertPage(makePage({ id: "p1", title: "Tomorrow", content: "future body", updated_at: future }));

      const tool = getTool("knowledge");
      const result = await tool({ action: "get-page", pageId: "p1", ...defaults });
      const text = result.content[0]?.text ?? "";
      // The label must NOT claim "Fresh" with a negative day count.
      expect(text).not.toMatch(/\*\*Fresh\*\* \(-\d+d ago\)/);
      // It should surface the future-date condition explicitly.
      expect(text).toContain("Future-dated");
    });

    it("renders 'Fresh' for a present-day update", async () => {
      const { server, getTool } = createMockServer();
      registerKnowledgeTool(server, () => kb);
      kb.upsertPage(
        makePage({ id: "p1", title: "Today", content: "today body", updated_at: new Date().toISOString() }),
      );
      const tool = getTool("knowledge");
      const result = await tool({ action: "get-page", pageId: "p1", ...defaults });
      const text = result.content[0]?.text ?? "";
      expect(text).toMatch(/\*\*Fresh\*\* \(0d ago\)/);
    });

    it("suggests fetching the next chunk when more pages remain", async () => {
      const { server, getTool } = createMockServer();
      registerKnowledgeTool(server, () => kb);

      kb.upsertPage(makePage({ id: "p1", title: "Big", content: "Z".repeat(MAX_PAGE_CHARS * 2 + 10) }));

      const tool = getTool("knowledge");
      const result = await tool({ action: "get-page", pageId: "p1", page: 1, ...defaults });
      const text = result.content[0]?.text ?? "";
      expect(text).toContain("Next steps");
      // The suggestion mentions "N+1" symbolically; just check the concept surfaces.
      expect(text.toLowerCase()).toContain("next chunk");
    });
  });
});

// ── paginateContent (pure helper, E2) ─────────────────────────────────────

describe("paginateContent", () => {
  it("returns a single page for short content", () => {
    const w = paginateContent("hello world", 1, MAX_PAGE_CHARS);
    expect(w.totalPages).toBe(1);
    expect(w.hasMore).toBe(false);
    expect(w.body).toBe("hello world");
    expect(w.totalChars).toBe("hello world".length);
  });

  it("splits content into ceil(len/size) pages", () => {
    const content = "a".repeat(45_000);
    const w = paginateContent(content, 1, 15_000);
    expect(w.totalPages).toBe(3);
    expect(w.body.length).toBe(15_000);
    expect(w.hasMore).toBe(true);
  });

  it("returns the correct slice for any page within range", () => {
    const content = "0123456789".repeat(3000); // 30_000 chars
    const w2 = paginateContent(content, 2, 10_000);
    expect(w2.page).toBe(2);
    expect(w2.body).toBe(content.slice(10_000, 20_000));
    expect(w2.hasMore).toBe(true);
    const w3 = paginateContent(content, 3, 10_000);
    expect(w3.page).toBe(3);
    expect(w3.hasMore).toBe(false);
  });

  it("clamps page above totalPages to the last page (never silently empty)", () => {
    const content = "x".repeat(5_000);
    const w = paginateContent(content, 99, MAX_PAGE_CHARS);
    expect(w.page).toBe(1);
    expect(w.body.length).toBe(5_000);
  });

  it("clamps page below 1 to the first page", () => {
    const content = "x".repeat(5_000);
    const w = paginateContent(content, 0, MAX_PAGE_CHARS);
    expect(w.page).toBe(1);
  });

  it("clamps pageSize below MIN_PAGE_SIZE up", () => {
    const w = paginateContent("a".repeat(10_000), 1, 1);
    expect(w.effectiveSize).toBe(MIN_PAGE_SIZE);
  });

  it("clamps pageSize above MAX_PAGE_SIZE down", () => {
    const w = paginateContent("a".repeat(10_000), 1, 10_000_000);
    expect(w.effectiveSize).toBe(MAX_PAGE_SIZE);
  });

  it("returns at least one page even for empty content (no divide-by-zero)", () => {
    const w = paginateContent("", 1, MAX_PAGE_CHARS);
    expect(w.totalPages).toBe(1);
    expect(w.body).toBe("");
    expect(w.hasMore).toBe(false);
  });

  // ── PAG-1 — surrogate-pair safety ────────────────────────────────────────

  it("never splits a UTF-16 surrogate pair across page boundaries (PAG-1)", () => {
    // 😀 (U+1F600) takes two code units (0xD83D, 0xDE00). With pageSize=MIN_PAGE_SIZE
    // (1000) and 999 'a' chars before the emoji, the boundary at index 1000
    // lands inside the emoji's surrogate pair. The fix walks `end` back by 1
    // so the whole pair rolls into page 2.
    const content = `${"a".repeat(999)}\u{1F600}${"b".repeat(999)}`;
    const p1 = paginateContent(content, 1, MIN_PAGE_SIZE);
    const p2 = paginateContent(content, 2, MIN_PAGE_SIZE);

    // No lone surrogates in either body — both code units of the emoji land
    // together on page 2.
    function hasLoneSurrogate(s: string): boolean {
      for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c >= 0xd800 && c <= 0xdbff) {
          // high surrogate; expect low surrogate next
          const next = s.charCodeAt(i + 1);
          if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
          i++; // skip the low surrogate
        } else if (c >= 0xdc00 && c <= 0xdfff) {
          // low surrogate without preceding high
          return true;
        }
      }
      return false;
    }
    expect(hasLoneSurrogate(p1.body)).toBe(false);
    expect(hasLoneSurrogate(p2.body)).toBe(false);

    // Reassembly is lossless.
    expect(p1.body + p2.body).toBe(content);

    // JSON.stringify must NOT emit a lone surrogate (the precise symptom in
    // the defect report — RFC 8259 §8.2 violation).
    expect(() => JSON.parse(JSON.stringify(p1.body))).not.toThrow();
    expect(() => JSON.parse(JSON.stringify(p2.body))).not.toThrow();
  });

  // ── PAG-2 — NaN / Infinity inputs ────────────────────────────────────────

  it("coerces NaN page to 1 instead of returning an empty body (PAG-2)", () => {
    const content = "x".repeat(30_000);
    const w = paginateContent(content, Number.NaN, 10_000);
    expect(w.page).toBe(1);
    expect(w.body.length).toBe(10_000);
  });

  it("coerces NaN pageSize to MAX_PAGE_CHARS (PAG-2)", () => {
    const content = "x".repeat(30_000);
    const w = paginateContent(content, 1, Number.NaN);
    // After coercion + clamping, effectiveSize falls within [MIN, MAX].
    expect(w.effectiveSize).toBeGreaterThanOrEqual(MIN_PAGE_SIZE);
    expect(w.effectiveSize).toBeLessThanOrEqual(MAX_PAGE_SIZE);
    expect(w.body.length).toBeGreaterThan(0);
  });

  it("treats Infinity page as last page (PAG-2)", () => {
    const content = "x".repeat(30_000);
    const w = paginateContent(content, Number.POSITIVE_INFINITY, 10_000);
    expect(w.page).toBe(3);
    expect(w.hasMore).toBe(false);
  });

  it("treats -Infinity page as first page (PAG-2)", () => {
    const content = "x".repeat(30_000);
    const w = paginateContent(content, Number.NEGATIVE_INFINITY, 10_000);
    expect(w.page).toBe(1);
  });

  // ── PAG-3 — fractional page rejected ────────────────────────────────────

  it("floors a fractional page to the integer page (PAG-3)", () => {
    const content = "0123456789".repeat(3000);
    const integer = paginateContent(content, 1, 10_000);
    const fractional = paginateContent(content, 1.7, 10_000);
    expect(fractional.page).toBe(integer.page);
    expect(fractional.body).toBe(integer.body);
  });

  it("never produces an overlapping slice from a fractional page (PAG-3)", () => {
    // The defect report demonstrated page=1.5 returning a body starting at
    // offset 5000 — overlapping integer pages 1 and 2. After the fix, the
    // body for any fractional `page` matches the floor of that page.
    const content = "0123456789".repeat(3000);
    const w = paginateContent(content, 1.5, 10_000);
    expect(w.body).toBe(content.slice(0, 10_000));
  });
});
