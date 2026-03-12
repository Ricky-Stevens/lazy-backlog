import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CachedChangelogEntry, CachedSprint, IndexedPage } from "../lib/db.js";
import { KnowledgeBase, ftsQuery, sanitizeFtsQuery } from "../lib/db.js";

/** Create a minimal IndexedPage for testing. */
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
    author_id: overrides.author_id ?? "user-1",
    created_at: overrides.created_at ?? "2025-01-01T00:00:00Z",
    updated_at: overrides.updated_at ?? "2025-06-01T00:00:00Z",
    indexed_at: overrides.indexed_at ?? new Date().toISOString(),
    source: overrides.source ?? "confluence",
  };
}

let kb: KnowledgeBase;
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "lb-test-"));
  kb = new KnowledgeBase(join(tmpDir, "test.db"));
});

afterEach(() => {
  kb.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── Config ───────────────────────────────────────────────────────────────────

describe("config", () => {
  it("returns undefined for missing key", () => {
    expect(kb.getConfig("nonexistent")).toBeUndefined();
  });

  it("stores and retrieves config values", () => {
    kb.setConfig("project", "BP");
    expect(kb.getConfig("project")).toBe("BP");
  });

  it("overwrites existing config", () => {
    kb.setConfig("key", "v1");
    kb.setConfig("key", "v2");
    expect(kb.getConfig("key")).toBe("v2");
  });
});

// ── Page CRUD ────────────────────────────────────────────────────────────────

describe("page CRUD", () => {
  it("upserts and retrieves a page by ID", () => {
    const page = makePage();
    kb.upsertPage(page);
    const result = kb.getPage("page-1");
    expect(result).toBeDefined();
    expect(result?.title).toBe("Test Page");
    expect(result?.page_type).toBe("design");
  });

  it("updates page on re-upsert", () => {
    kb.upsertPage(makePage({ title: "Original" }));
    kb.upsertPage(makePage({ title: "Updated" }));
    expect(kb.getPage("page-1")?.title).toBe("Updated");
  });

  it("returns falsy for nonexistent page", () => {
    expect(kb.getPage("nope")).toBeFalsy();
  });

  it("upserts many pages in a transaction", () => {
    const pages = Array.from({ length: 20 }, (_, i) => makePage({ id: `page-${i}`, title: `Page ${i}` }));
    kb.upsertMany(pages);
    expect(kb.getPage("page-0")).toBeDefined();
    expect(kb.getPage("page-19")).toBeDefined();
  });
});

// ── Stats ────────────────────────────────────────────────────────────────────

describe("getStats", () => {
  it("returns zero counts for empty DB", () => {
    const stats = kb.getStats();
    expect(stats.total).toBe(0);
  });

  it("counts pages by type and space", () => {
    kb.upsertPage(makePage({ id: "1", page_type: "adr", space_key: "ENG" }));
    kb.upsertPage(makePage({ id: "2", page_type: "adr", space_key: "ENG" }));
    kb.upsertPage(makePage({ id: "3", page_type: "design", space_key: "PM" }));

    const stats = kb.getStats();
    expect(stats.total).toBe(3);
    expect(stats.byType.adr).toBe(2);
    expect(stats.byType.design).toBe(1);
    expect(stats.bySpace.ENG).toBe(2);
    expect(stats.bySpace.PM).toBe(1);
  });
});

// ── FTS5 Search ──────────────────────────────────────────────────────────────

describe("search", () => {
  it("finds pages by keyword", () => {
    kb.upsertPage(makePage({ id: "1", content: "OAuth2 authentication flow" }));
    kb.upsertPage(makePage({ id: "2", content: "Database migration guide" }));

    const results = kb.search("OAuth2");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]?.id).toBe("1");
  });

  it("filters by page type", () => {
    kb.upsertPage(makePage({ id: "1", page_type: "adr", content: "auth decision" }));
    kb.upsertPage(makePage({ id: "2", page_type: "design", content: "auth design" }));

    const results = kb.search("auth", { pageType: "adr" });
    expect(results).toHaveLength(1);
    expect(results[0]?.page_type).toBe("adr");
  });

  it("filters by space key", () => {
    kb.upsertPage(makePage({ id: "1", space_key: "ENG", content: "terraform modules" }));
    kb.upsertPage(makePage({ id: "2", space_key: "PM", content: "terraform roadmap" }));

    const results = kb.search("terraform", { spaceKey: "ENG" });
    expect(results).toHaveLength(1);
    expect(results[0]?.space_key).toBe("ENG");
  });

  it("returns empty for no matches", () => {
    kb.upsertPage(makePage());
    expect(kb.search("zzzznonexistent")).toHaveLength(0);
  });

  it("respects limit option", () => {
    for (let i = 0; i < 20; i++) {
      kb.upsertPage(makePage({ id: `p-${i}`, content: `common keyword page ${i}` }));
    }
    const results = kb.search("common", { limit: 5 });
    expect(results).toHaveLength(5);
  });
});

// ── needsReindex ─────────────────────────────────────────────────────────────

describe("needsReindex", () => {
  it("returns true for new page", () => {
    expect(kb.needsReindex("page-new", "2025-06-01")).toBe(true);
  });

  it("returns true when page has been updated", () => {
    kb.upsertPage(makePage({ id: "page-1", updated_at: "2025-01-01T00:00:00Z" }));
    expect(kb.needsReindex("page-1", "2025-06-01T00:00:00Z")).toBe(true);
  });

  it("returns false when page is unchanged", () => {
    const ts = "2025-06-01T00:00:00Z";
    kb.upsertPage(makePage({ id: "page-1", updated_at: ts }));
    expect(kb.needsReindex("page-1", ts)).toBe(false);
  });
});

// ── rebuildFts ───────────────────────────────────────────────────────────────

describe("rebuildFts", () => {
  it("rebuilds FTS index and search still works", () => {
    kb.upsertPage(makePage({ id: "1", content: "kubernetes deployment" }));
    kb.rebuildFts();
    const results = kb.search("kubernetes");
    expect(results).toHaveLength(1);
  });
});

// ── getPagesByType ───────────────────────────────────────────────────────────

describe("getPagesByType", () => {
  it("returns pages filtered by type", () => {
    kb.upsertPage(makePage({ id: "1", page_type: "adr" }));
    kb.upsertPage(makePage({ id: "2", page_type: "design" }));
    kb.upsertPage(makePage({ id: "3", page_type: "adr" }));

    const adrs = kb.getPagesByType("adr");
    expect(adrs).toHaveLength(2);
    expect(adrs.every((p) => p.page_type === "adr")).toBe(true);
  });

  it("filters by type and space", () => {
    kb.upsertPage(makePage({ id: "1", page_type: "adr", space_key: "ENG" }));
    kb.upsertPage(makePage({ id: "2", page_type: "adr", space_key: "PM" }));

    const results = kb.getPagesByType("adr", "ENG");
    expect(results).toHaveLength(1);
    expect(results[0]?.space_key).toBe("ENG");
  });

  it("returns empty array for no matches", () => {
    expect(kb.getPagesByType("runbook")).toHaveLength(0);
  });
});

// ── getPageSummaries ─────────────────────────────────────────────────────────

describe("getPageSummaries", () => {
  it("returns summaries filtered by type", () => {
    kb.upsertPage(makePage({ id: "1", page_type: "design", title: "Auth Design" }));
    kb.upsertPage(makePage({ id: "2", page_type: "adr", title: "ADR-001" }));

    const summaries = kb.getPageSummaries("design");
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.title).toBe("Auth Design");
  });

  it("filters by type and space", () => {
    kb.upsertPage(makePage({ id: "1", page_type: "design", space_key: "ENG" }));
    kb.upsertPage(makePage({ id: "2", page_type: "design", space_key: "PM" }));

    const summaries = kb.getPageSummaries("design", "ENG");
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.space_key).toBe("ENG");
  });
});

// ── Chunks ───────────────────────────────────────────────────────────────────

describe("upsertChunks + searchChunks", () => {
  it("stores and searches chunks", () => {
    kb.upsertPage(makePage({ id: "p1", content: "parent page" }));
    kb.upsertChunks("p1", [
      { breadcrumb: "Auth", heading: "OAuth2", depth: 2, content: "OAuth2 token refresh flow details", index: 0 },
      { breadcrumb: "Auth", heading: "SAML", depth: 2, content: "SAML federation setup guide", index: 1 },
    ]);

    const results = kb.searchChunks("OAuth2");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]?.heading).toBe("OAuth2");
  });

  it("replaces chunks on re-upsert", () => {
    kb.upsertPage(makePage({ id: "p1", content: "page" }));
    kb.upsertChunks("p1", [{ breadcrumb: "", heading: "Old", depth: 1, content: "old chunk content", index: 0 }]);
    kb.upsertChunks("p1", [{ breadcrumb: "", heading: "New", depth: 1, content: "new chunk content", index: 0 }]);

    const oldResults = kb.searchChunks("old chunk");
    expect(oldResults).toHaveLength(0);

    const newResults = kb.searchChunks("new chunk");
    expect(newResults.length).toBeGreaterThanOrEqual(1);
  });

  it("filters chunk search by page type", () => {
    kb.upsertPage(makePage({ id: "p1", page_type: "adr", content: "adr page" }));
    kb.upsertPage(makePage({ id: "p2", page_type: "design", content: "design page" }));
    kb.upsertChunks("p1", [{ breadcrumb: "", heading: "A", depth: 1, content: "kubernetes cluster setup", index: 0 }]);
    kb.upsertChunks("p2", [
      { breadcrumb: "", heading: "B", depth: 1, content: "kubernetes networking design", index: 0 },
    ]);

    const results = kb.searchChunks("kubernetes", { pageType: "adr" });
    expect(results).toHaveLength(1);
    expect(results[0]?.page_type).toBe("adr");
  });

  it("filters chunk search by space key", () => {
    kb.upsertPage(makePage({ id: "p1", space_key: "ENG", content: "eng page" }));
    kb.upsertPage(makePage({ id: "p2", space_key: "PM", content: "pm page" }));
    kb.upsertChunks("p1", [{ breadcrumb: "", heading: "A", depth: 1, content: "terraform modules guide", index: 0 }]);
    kb.upsertChunks("p2", [{ breadcrumb: "", heading: "B", depth: 1, content: "terraform roadmap plan", index: 0 }]);

    const results = kb.searchChunks("terraform", { spaceKey: "ENG" });
    expect(results).toHaveLength(1);
    expect(results[0]?.space_key).toBe("ENG");
  });
});

// ── clearSpace ───────────────────────────────────────────────────────────────

describe("clearSpace", () => {
  it("removes all pages from a space", () => {
    kb.upsertPage(makePage({ id: "1", space_key: "ENG" }));
    kb.upsertPage(makePage({ id: "2", space_key: "PM" }));
    kb.clearSpace("ENG");
    expect(kb.getPage("1")).toBeFalsy();
    expect(kb.getPage("2")).toBeTruthy();
  });
});

// ── Sprints cache ─────────────────────────────────────────────────────────

function makeSprint(overrides: Partial<CachedSprint> = {}): CachedSprint {
  return {
    id: overrides.id ?? "sprint-1",
    board_id: overrides.board_id ?? "board-1",
    name: overrides.name ?? "Sprint 1",
    state: overrides.state ?? "active",
    goal: overrides.goal ?? "Ship auth feature",
    start_date: overrides.start_date ?? "2025-06-01T00:00:00Z",
    end_date: overrides.end_date ?? "2025-06-14T00:00:00Z",
    complete_date: overrides.complete_date ?? null,
    cached_at: overrides.cached_at ?? new Date().toISOString(),
  };
}

function makeChangelog(overrides: Partial<CachedChangelogEntry> = {}): CachedChangelogEntry {
  return {
    id: overrides.id ?? "cl-1",
    issue_key: overrides.issue_key ?? "PROJ-1",
    author_name: overrides.author_name ?? "Alice",
    author_id: overrides.author_id ?? "user-1",
    created: overrides.created ?? "2025-06-01T10:00:00Z",
    field: overrides.field ?? "status",
    from_value: overrides.from_value ?? "To Do",
    to_value: overrides.to_value ?? "In Progress",
    cached_at: overrides.cached_at ?? new Date().toISOString(),
  };
}

describe("sprints cache", () => {
  it("upsertSprint stores and retrieves sprint", () => {
    const sprint = makeSprint();
    kb.upsertSprint(sprint);
    const result = kb.getSprint("sprint-1");
    expect(result).toBeDefined();
    expect(result?.name).toBe("Sprint 1");
    expect(result?.state).toBe("active");
  });

  it("upsertSprint updates on re-upsert", () => {
    kb.upsertSprint(makeSprint({ state: "active" }));
    kb.upsertSprint(makeSprint({ state: "closed" }));
    expect(kb.getSprint("sprint-1")?.state).toBe("closed");
  });

  it("upsertSprints batch inserts in transaction", () => {
    const sprints = [
      makeSprint({ id: "s1", name: "Sprint 1" }),
      makeSprint({ id: "s2", name: "Sprint 2" }),
      makeSprint({ id: "s3", name: "Sprint 3" }),
    ];
    kb.upsertSprints(sprints);
    expect(kb.getSprint("s1")).toBeDefined();
    expect(kb.getSprint("s2")).toBeDefined();
    expect(kb.getSprint("s3")).toBeDefined();
  });

  it("getSprintsByBoard filters by board ID", () => {
    kb.upsertSprint(makeSprint({ id: "s1", board_id: "board-1" }));
    kb.upsertSprint(makeSprint({ id: "s2", board_id: "board-2" }));
    kb.upsertSprint(makeSprint({ id: "s3", board_id: "board-1" }));

    const results = kb.getSprintsByBoard("board-1");
    expect(results).toHaveLength(2);
    expect(results.every((s) => s.board_id === "board-1")).toBe(true);
  });

  it("getSprintsByBoard filters by state", () => {
    kb.upsertSprint(makeSprint({ id: "s1", board_id: "board-1", state: "active" }));
    kb.upsertSprint(makeSprint({ id: "s2", board_id: "board-1", state: "closed" }));
    kb.upsertSprint(makeSprint({ id: "s3", board_id: "board-1", state: "active" }));

    const results = kb.getSprintsByBoard("board-1", "active");
    expect(results).toHaveLength(2);
    expect(results.every((s) => s.state === "active")).toBe(true);
  });

  it("getSprint returns undefined for missing sprint", () => {
    expect(kb.getSprint("nonexistent")).toBeFalsy();
  });
});

// ── Changelogs cache ──────────────────────────────────────────────────────

describe("changelogs cache", () => {
  it("upsertChangelog stores entries", () => {
    kb.upsertChangelog([makeChangelog()]);
    const results = kb.getChangelog("PROJ-1");
    expect(results).toHaveLength(1);
    expect(results[0]?.field).toBe("status");
  });

  it("getChangelog returns entries sorted by created date", () => {
    kb.upsertChangelog([
      makeChangelog({ id: "cl-3", created: "2025-06-03T10:00:00Z" }),
      makeChangelog({ id: "cl-1", created: "2025-06-01T10:00:00Z" }),
      makeChangelog({ id: "cl-2", created: "2025-06-02T10:00:00Z" }),
    ]);
    const results = kb.getChangelog("PROJ-1");
    expect(results).toHaveLength(3);
    expect(results[0]?.id).toBe("cl-1");
    expect(results[1]?.id).toBe("cl-2");
    expect(results[2]?.id).toBe("cl-3");
  });

  it("getChangelogByField filters by field name", () => {
    kb.upsertChangelog([
      makeChangelog({ id: "cl-1", field: "status" }),
      makeChangelog({ id: "cl-2", field: "assignee" }),
      makeChangelog({ id: "cl-3", field: "status" }),
    ]);
    const results = kb.getChangelogByField("PROJ-1", "status");
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.field === "status")).toBe(true);
  });

  it("clearChangelogForIssue removes all entries for an issue", () => {
    kb.upsertChangelog([
      makeChangelog({ id: "cl-1", issue_key: "PROJ-1" }),
      makeChangelog({ id: "cl-2", issue_key: "PROJ-1" }),
      makeChangelog({ id: "cl-3", issue_key: "PROJ-2" }),
    ]);
    kb.clearChangelogForIssue("PROJ-1");
    expect(kb.getChangelog("PROJ-1")).toHaveLength(0);
    expect(kb.getChangelog("PROJ-2")).toHaveLength(1);
  });
});

// ── getStalePages ─────────────────────────────────────────────────────────

describe("getStalePages", () => {
  it("returns pages older than cutoff date", () => {
    kb.upsertPage(makePage({ id: "1", updated_at: "2025-01-01T00:00:00Z" }));
    kb.upsertPage(makePage({ id: "2", updated_at: "2025-06-01T00:00:00Z" }));
    kb.upsertPage(makePage({ id: "3", updated_at: "2025-03-01T00:00:00Z" }));

    const stale = kb.getStalePages("2025-04-01T00:00:00Z");
    expect(stale).toHaveLength(2);
  });

  it("filters by space key", () => {
    kb.upsertPage(makePage({ id: "1", updated_at: "2025-01-01T00:00:00Z", space_key: "ENG" }));
    kb.upsertPage(makePage({ id: "2", updated_at: "2025-01-01T00:00:00Z", space_key: "PM" }));

    const stale = kb.getStalePages("2025-04-01T00:00:00Z", { spaceKey: "ENG" });
    expect(stale).toHaveLength(1);
    expect(stale[0]?.space_key).toBe("ENG");
  });

  it("filters by page type", () => {
    kb.upsertPage(makePage({ id: "1", updated_at: "2025-01-01T00:00:00Z", page_type: "adr" }));
    kb.upsertPage(makePage({ id: "2", updated_at: "2025-01-01T00:00:00Z", page_type: "design" }));

    const stale = kb.getStalePages("2025-04-01T00:00:00Z", { pageType: "adr" });
    expect(stale).toHaveLength(1);
    expect(stale[0]?.page_type).toBe("adr");
  });

  it("returns empty when all pages are fresh", () => {
    kb.upsertPage(makePage({ id: "1", updated_at: "2025-06-01T00:00:00Z" }));
    const stale = kb.getStalePages("2025-01-01T00:00:00Z");
    expect(stale).toHaveLength(0);
  });
});

// ── getRecentlyIndexed ────────────────────────────────────────────────────

describe("getRecentlyIndexed", () => {
  it("returns pages indexed after timestamp", () => {
    kb.upsertPage(makePage({ id: "1", indexed_at: "2025-06-01T00:00:00Z" }));
    kb.upsertPage(makePage({ id: "2", indexed_at: "2025-06-10T00:00:00Z" }));

    const recent = kb.getRecentlyIndexed("2025-06-05T00:00:00Z");
    expect(recent).toHaveLength(1);
    expect(recent[0]?.id).toBe("2");
  });

  it("returns empty when nothing recent", () => {
    kb.upsertPage(makePage({ id: "1", indexed_at: "2025-01-01T00:00:00Z" }));
    const recent = kb.getRecentlyIndexed("2025-06-01T00:00:00Z");
    expect(recent).toHaveLength(0);
  });
});

// ── Team rules ────────────────────────────────────────────────────────────

describe("team rules", () => {
  it("upsertTeamRule stores and retrieves a rule", () => {
    kb.upsertTeamRule({
      category: "naming_convention",
      rule_key: "pattern/Story",
      issue_type: "Story",
      rule_value: "verb-first",
      confidence: 0.85,
      sample_size: 30,
    });
    const rules = kb.getTeamRules();
    expect(rules).toHaveLength(1);
    expect(rules[0]?.category).toBe("naming_convention");
    expect(rules[0]?.rule_value).toBe("verb-first");
    expect(rules[0]?.confidence).toBeCloseTo(0.85);
  });

  it("upsertTeamRule updates on conflict", () => {
    kb.upsertTeamRule({
      category: "naming_convention",
      rule_key: "pattern/Story",
      issue_type: "Story",
      rule_value: "verb-first",
      confidence: 0.5,
      sample_size: 10,
    });
    kb.upsertTeamRule({
      category: "naming_convention",
      rule_key: "pattern/Story",
      issue_type: "Story",
      rule_value: "tag-prefix",
      confidence: 0.9,
      sample_size: 50,
    });
    const rules = kb.getTeamRules();
    expect(rules).toHaveLength(1);
    expect(rules[0]?.rule_value).toBe("tag-prefix");
    expect(rules[0]?.confidence).toBeCloseTo(0.9);
  });

  it("getTeamRules filters by category", () => {
    kb.upsertTeamRule({
      category: "naming_convention",
      rule_key: "pattern/Story",
      issue_type: "Story",
      rule_value: "verb-first",
      confidence: 0.8,
      sample_size: 20,
    });
    kb.upsertTeamRule({
      category: "story_points",
      rule_key: "median/Story",
      issue_type: "Story",
      rule_value: "5",
      confidence: 0.7,
      sample_size: 25,
    });

    const naming = kb.getTeamRules("naming_convention");
    expect(naming).toHaveLength(1);
    expect(naming[0]?.category).toBe("naming_convention");

    const points = kb.getTeamRules("story_points");
    expect(points).toHaveLength(1);
    expect(points[0]?.category).toBe("story_points");
  });

  it("getTeamRules filters by issueType (includes null issue_type rules)", () => {
    kb.upsertTeamRule({
      category: "naming_convention",
      rule_key: "pattern/Story",
      issue_type: "Story",
      rule_value: "verb-first",
      confidence: 0.8,
      sample_size: 20,
    });
    kb.upsertTeamRule({
      category: "naming_convention",
      rule_key: "pattern/Bug",
      issue_type: "Bug",
      rule_value: "verb-first",
      confidence: 0.7,
      sample_size: 15,
    });
    kb.upsertTeamRule({
      category: "label_patterns",
      rule_key: "top_labels",
      issue_type: null,
      rule_value: "[]",
      confidence: 0.6,
      sample_size: 30,
    });

    const storyRules = kb.getTeamRules(undefined, "Story");
    // Should include Story-specific + null issue_type rules
    expect(storyRules.length).toBeGreaterThanOrEqual(2);
    expect(storyRules.some((r) => r.issue_type === "Story")).toBe(true);
    expect(storyRules.some((r) => r.issue_type === null)).toBe(true);
    expect(storyRules.every((r) => r.issue_type !== "Bug")).toBe(true);
  });

  it("getTeamRules filters by both category and issueType", () => {
    kb.upsertTeamRule({
      category: "naming_convention",
      rule_key: "pattern/Story",
      issue_type: "Story",
      rule_value: "verb-first",
      confidence: 0.8,
      sample_size: 20,
    });
    kb.upsertTeamRule({
      category: "naming_convention",
      rule_key: "pattern/Bug",
      issue_type: "Bug",
      rule_value: "verb-first",
      confidence: 0.7,
      sample_size: 15,
    });

    const result = kb.getTeamRules("naming_convention", "Story");
    expect(result).toHaveLength(1);
    expect(result[0]?.issue_type).toBe("Story");
  });

  it("getTeamRules returns empty array when no rules exist", () => {
    const rules = kb.getTeamRules();
    expect(rules).toEqual([]);
  });

  it("clearTeamRules removes all team rules", () => {
    kb.upsertTeamRule({
      category: "naming_convention",
      rule_key: "pattern/Story",
      issue_type: "Story",
      rule_value: "verb-first",
      confidence: 0.8,
      sample_size: 20,
    });
    kb.upsertTeamRule({
      category: "story_points",
      rule_key: "median/Story",
      issue_type: "Story",
      rule_value: "5",
      confidence: 0.7,
      sample_size: 25,
    });

    expect(kb.getTeamRules().length).toBe(2);
    kb.clearTeamRules();
    expect(kb.getTeamRules()).toEqual([]);
  });
});

// ── Backlog analysis ──────────────────────────────────────────────────────

describe("backlog analysis", () => {
  it("recordAnalysis stores and getLatestAnalysis retrieves it", () => {
    kb.recordAnalysis({
      project_key: "PROJ",
      tickets_fetched: 100,
      tickets_quality_passed: 80,
      quality_threshold: 60,
      rules_extracted: 25,
      jql_used: "project = PROJ ORDER BY created DESC",
      analyzed_at: "2025-06-01T00:00:00Z",
    });

    const latest = kb.getLatestAnalysis();
    expect(latest).not.toBeNull();
    expect(latest?.project_key).toBe("PROJ");
    expect(latest?.tickets_fetched).toBe(100);
    expect(latest?.tickets_quality_passed).toBe(80);
    expect(latest?.rules_extracted).toBe(25);
  });

  it("getLatestAnalysis returns most recent by timestamp", () => {
    kb.recordAnalysis({
      project_key: "PROJ",
      tickets_fetched: 50,
      tickets_quality_passed: 40,
      quality_threshold: 60,
      rules_extracted: 15,
      jql_used: "project = PROJ",
      analyzed_at: "2025-01-01T00:00:00Z",
    });
    kb.recordAnalysis({
      project_key: "PROJ",
      tickets_fetched: 100,
      tickets_quality_passed: 80,
      quality_threshold: 60,
      rules_extracted: 30,
      jql_used: "project = PROJ",
      analyzed_at: "2025-06-01T00:00:00Z",
    });

    const latest = kb.getLatestAnalysis();
    expect(latest).not.toBeNull();
    expect(latest?.tickets_fetched).toBe(100);
    expect(latest?.rules_extracted).toBe(30);
    expect(latest?.analyzed_at).toBe("2025-06-01T00:00:00Z");
  });

  it("getLatestAnalysis returns null when no analysis exists", () => {
    const latest = kb.getLatestAnalysis();
    expect(latest).toBeNull();
  });
});

// ── Search with source filter ────────────────────────────────────────────

describe("search with source filter", () => {
  it("filters pages by source", () => {
    kb.upsertPage(makePage({ id: "1", source: "confluence", content: "gamma delta content" }));
    kb.upsertPage(makePage({ id: "2", source: "manual", content: "gamma delta content" }));

    const results = kb.search("gamma", { source: "confluence" });
    expect(results).toHaveLength(1);
    expect(results[0]?.source).toBe("confluence");
  });

  it("filters by source and pageType", () => {
    kb.upsertPage(makePage({ id: "1", source: "confluence", page_type: "adr", content: "sigma tau content" }));
    kb.upsertPage(makePage({ id: "2", source: "confluence", page_type: "design", content: "sigma tau content" }));
    kb.upsertPage(makePage({ id: "3", source: "manual", page_type: "adr", content: "sigma tau content" }));

    const results = kb.search("sigma", { source: "confluence", pageType: "adr" });
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe("1");
  });

  it("filters by source and spaceKey", () => {
    kb.upsertPage(makePage({ id: "1", source: "confluence", space_key: "ENG", content: "omega phi content" }));
    kb.upsertPage(makePage({ id: "2", source: "manual", space_key: "ENG", content: "omega phi content" }));
    kb.upsertPage(makePage({ id: "3", source: "confluence", space_key: "PM", content: "omega phi content" }));

    const results = kb.search("omega", { source: "confluence", spaceKey: "ENG" });
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe("1");
  });

  it("filters by source, pageType, and spaceKey", () => {
    kb.upsertPage(
      makePage({ id: "1", source: "confluence", page_type: "adr", space_key: "ENG", content: "psi chi content" }),
    );
    kb.upsertPage(
      makePage({ id: "2", source: "confluence", page_type: "adr", space_key: "PM", content: "psi chi content" }),
    );
    kb.upsertPage(
      makePage({ id: "3", source: "manual", page_type: "adr", space_key: "ENG", content: "psi chi content" }),
    );
    kb.upsertPage(
      makePage({ id: "4", source: "confluence", page_type: "design", space_key: "ENG", content: "psi chi content" }),
    );

    const results = kb.search("psi", { source: "confluence", pageType: "adr", spaceKey: "ENG" });
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe("1");
  });

  it("filters chunks by source", () => {
    kb.upsertPage(makePage({ id: "p1", source: "confluence", content: "page" }));
    kb.upsertPage(makePage({ id: "p2", source: "manual", content: "page" }));
    kb.upsertChunks("p1", [
      { breadcrumb: "", heading: "H", depth: 1, content: "epsilon zeta unique content", index: 0 },
    ]);
    kb.upsertChunks("p2", [
      { breadcrumb: "", heading: "H", depth: 1, content: "epsilon zeta unique content", index: 0 },
    ]);

    const results = kb.searchChunks("epsilon", { source: "confluence" });
    expect(results).toHaveLength(1);
    expect(results[0]?.source).toBe("confluence");
  });
});

// ── ftsQuery FTS5 error fallback (lines 77-81) ──────────────────────────

describe("ftsQuery FTS5 error fallback", () => {
  it("falls back to phrase-wrapping on fts5 syntax error", () => {
    const fallbackResult = [{ id: "1", title: "found" }];
    let callCount = 0;
    const mockStmt = {
      all: vi.fn((..._args: unknown[]) => {
        callCount++;
        if (callCount === 1) {
          throw new Error("fts5: syntax error near something");
        }
        return fallbackResult;
      }),
    };
    const stmts = { none: mockStmt };

    const results = ftsQuery<{ id: string }>("test query", {}, 10, stmts as never);
    expect(results).toEqual(fallbackResult);
    expect(mockStmt.all).toHaveBeenCalledTimes(2);
  });

  it("re-throws non-fts5 errors without fallback", () => {
    const mockStmt = {
      all: vi.fn(() => {
        throw new Error("SQLITE_ERROR: some other error");
      }),
    };
    const stmts = { none: mockStmt };

    expect(() => ftsQuery("test query", {}, 10, stmts as never)).toThrow("SQLITE_ERROR: some other error");
    expect(mockStmt.all).toHaveBeenCalledTimes(1);
  });
});

// ── sanitizeFtsQuery ──────────────────────────────────────────────────────

describe("sanitizeFtsQuery", () => {
  it("wraps words in double quotes", () => {
    expect(sanitizeFtsQuery("foo bar")).toBe('"foo" "bar"');
  });

  it("strips special FTS5 characters", () => {
    expect(sanitizeFtsQuery('hello* "world" (test)')).toBe('"hello" "world" "test"');
  });

  it("strips caret and plus/minus operators", () => {
    expect(sanitizeFtsQuery("^start +include -exclude")).toBe('"start" "include" "exclude"');
  });

  it("removes FTS5 keyword operators", () => {
    expect(sanitizeFtsQuery("foo AND bar OR baz NOT qux")).toBe('"foo" "bar" "baz" "qux"');
    expect(sanitizeFtsQuery("term1 NEAR term2")).toBe('"term1" "term2"');
  });

  it("handles case-insensitive FTS5 operators", () => {
    expect(sanitizeFtsQuery("foo and bar or baz")).toBe('"foo" "bar" "baz"');
  });

  it("returns empty string for empty input", () => {
    expect(sanitizeFtsQuery("")).toBe("");
  });

  it("returns empty string for whitespace-only input", () => {
    expect(sanitizeFtsQuery("   \t\n  ")).toBe("");
  });

  it("returns empty string for only-special-chars input", () => {
    expect(sanitizeFtsQuery('*"()+^-')).toBe("");
  });
});

// ── Search with special characters ────────────────────────────────────────

describe("search with special FTS5 characters", () => {
  it("does not throw on special characters in search()", () => {
    kb.upsertPage(makePage({ id: "1", content: "safe content here" }));
    expect(() => kb.search('test* "quoted" (parens) AND OR NOT')).not.toThrow();
  });

  it("does not throw on special characters in searchChunks()", () => {
    kb.upsertPage(makePage({ id: "1", content: "safe content" }));
    kb.upsertChunks("1", [{ breadcrumb: "", heading: "H", depth: 1, content: "chunk content", index: 0 }]);
    expect(() => kb.searchChunks('test* "quoted" (parens) ^caret')).not.toThrow();
  });

  it("returns empty results for empty query", () => {
    kb.upsertPage(makePage({ id: "1", content: "some content" }));
    expect(kb.search("")).toHaveLength(0);
    expect(kb.search("   ")).toHaveLength(0);
  });

  it("still finds results after sanitization", () => {
    kb.upsertPage(makePage({ id: "1", content: "authentication flow details" }));
    const results = kb.search("authentication*");
    expect(results.length).toBeGreaterThanOrEqual(1);
  });
});

// ── ftsQuery fallback on FTS5 syntax errors ───────────────────────────────

describe("ftsQuery fallback and edge cases", () => {
  it("filters by both pageType and spaceKey", () => {
    kb.upsertPage(makePage({ id: "1", page_type: "adr", space_key: "ENG", content: "alpha bravo content" }));
    kb.upsertPage(makePage({ id: "2", page_type: "adr", space_key: "PM", content: "alpha bravo content" }));
    kb.upsertPage(makePage({ id: "3", page_type: "design", space_key: "ENG", content: "alpha bravo content" }));

    const results = kb.search("alpha", { pageType: "adr", spaceKey: "ENG" });
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe("1");
  });

  it("filters chunks by both pageType and spaceKey", () => {
    kb.upsertPage(makePage({ id: "p1", page_type: "adr", space_key: "ENG", content: "page" }));
    kb.upsertPage(makePage({ id: "p2", page_type: "adr", space_key: "PM", content: "page" }));
    kb.upsertPage(makePage({ id: "p3", page_type: "design", space_key: "ENG", content: "page" }));
    kb.upsertChunks("p1", [{ breadcrumb: "", heading: "H", depth: 1, content: "zephyr unique content", index: 0 }]);
    kb.upsertChunks("p2", [{ breadcrumb: "", heading: "H", depth: 1, content: "zephyr unique content", index: 0 }]);
    kb.upsertChunks("p3", [{ breadcrumb: "", heading: "H", depth: 1, content: "zephyr unique content", index: 0 }]);

    const results = kb.searchChunks("zephyr", { pageType: "adr", spaceKey: "ENG" });
    expect(results).toHaveLength(1);
    expect(results[0]?.space_key).toBe("ENG");
    expect(results[0]?.page_type).toBe("adr");
  });

  it("returns empty for query of only special characters", () => {
    kb.upsertPage(makePage({ id: "1", content: "test content" }));
    expect(kb.search('*"()^+-')).toHaveLength(0);
    expect(kb.searchChunks('*"()^+-')).toHaveLength(0);
  });

  it("returns empty for query of only FTS5 operators", () => {
    kb.upsertPage(makePage({ id: "1", content: "test content" }));
    expect(kb.search("AND OR NOT")).toHaveLength(0);
  });

  it("handles query with mixed special chars and valid words", () => {
    kb.upsertPage(makePage({ id: "1", content: "deployment pipeline configuration" }));
    const results = kb.search('"deployment" AND (pipeline)');
    expect(results.length).toBeGreaterThanOrEqual(1);
  });
});

// ── sanitizeFtsQuery additional edge cases ────────────────────────────────

describe("sanitizeFtsQuery edge cases", () => {
  it("handles single word input", () => {
    expect(sanitizeFtsQuery("hello")).toBe('"hello"');
  });

  it("handles consecutive spaces", () => {
    expect(sanitizeFtsQuery("foo    bar")).toBe('"foo" "bar"');
  });

  it("handles mixed operators and special chars", () => {
    expect(sanitizeFtsQuery('*NEAR(test AND "quoted") OR other+')).toBe('"test" "quoted" "other"');
  });

  it("handles tab and newline whitespace", () => {
    expect(sanitizeFtsQuery("foo\tbar\nbaz")).toBe('"foo" "bar" "baz"');
  });
});

// ── optimize + getDbSizeBytes ─────────────────────────────────────────────

describe("optimize and getDbSizeBytes", () => {
  it("optimize() runs without error", () => {
    kb.upsertPage(makePage({ id: "1" }));
    expect(() => kb.optimize()).not.toThrow();
  });

  it("getDbSizeBytes() returns a positive number for an existing DB", () => {
    kb.upsertPage(makePage({ id: "1" }));
    const size = kb.getDbSizeBytes();
    expect(size).toBeGreaterThan(0);
  });

  it("getDbSizeBytes() returns a reasonable value", () => {
    const size = kb.getDbSizeBytes();
    // Even an empty DB with schema should be at least a few KB
    expect(size).toBeGreaterThan(1000);
    // And less than 10 MB for an empty test DB
    expect(size).toBeLessThan(10 * 1024 * 1024);
  });
});
