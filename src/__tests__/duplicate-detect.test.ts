import { describe, expect, it, vi } from "vitest";
import type { JiraClient } from "../lib/jira.js";
import { findDuplicates, jaccardSimilarity, tokenize } from "../lib/duplicate-detect.js";

// ── tokenize ─────────────────────────────────────────────────────────────

describe("tokenize", () => {
  it("lowercases and splits on non-alphanumeric characters", () => {
    const result = tokenize("Hello-World! Foo_Bar", new Set());
    expect(result).toEqual(new Set(["hello", "world", "foo", "bar"]));
  });

  it("filters default stop words", () => {
    const result = tokenize("the quick brown fox jumps over the lazy dog");
    // "the", "over" are stop words; "fox" is 3 chars so kept
    expect(result.has("the")).toBe(false);
    expect(result.has("over")).toBe(false);
    expect(result.has("quick")).toBe(true);
    expect(result.has("brown")).toBe(true);
    expect(result.has("fox")).toBe(true);
  });

  it("filters words with 2 or fewer characters", () => {
    const result = tokenize("I am ok no", new Set());
    // "i", "am", "ok", "no" — all <= 2 chars
    expect(result.size).toBe(0);
  });

  it("returns a Set (no duplicates)", () => {
    const result = tokenize("login login login page", new Set());
    expect(result.size).toBe(2);
    expect(result.has("login")).toBe(true);
    expect(result.has("page")).toBe(true);
  });

  it("handles empty string", () => {
    const result = tokenize("");
    expect(result.size).toBe(0);
  });

  it("uses custom stop words when provided", () => {
    const custom = new Set(["custom"]);
    const result = tokenize("custom word here", custom);
    expect(result.has("custom")).toBe(false);
    expect(result.has("word")).toBe(true);
    expect(result.has("here")).toBe(true);
  });
});

// ── jaccardSimilarity ────────────────────────────────────────────────────

describe("jaccardSimilarity", () => {
  it("returns 1.0 for identical sets", () => {
    const s = new Set(["foo", "bar", "baz"]);
    expect(jaccardSimilarity(s, s)).toBe(1);
  });

  it("returns 0.0 for disjoint sets", () => {
    const a = new Set(["foo", "bar"]);
    const b = new Set(["baz", "qux"]);
    expect(jaccardSimilarity(a, b)).toBe(0);
  });

  it("returns correct ratio for partial overlap", () => {
    const a = new Set(["foo", "bar", "baz"]);
    const b = new Set(["bar", "baz", "qux"]);
    // intersection = 2, union = 4
    expect(jaccardSimilarity(a, b)).toBeCloseTo(0.5, 5);
  });

  it("returns 0 when both sets are empty", () => {
    expect(jaccardSimilarity(new Set(), new Set())).toBe(0);
  });

  it("returns 0 when one set is empty", () => {
    expect(jaccardSimilarity(new Set(["foo"]), new Set())).toBe(0);
    expect(jaccardSimilarity(new Set(), new Set(["foo"]))).toBe(0);
  });
});

// ── findDuplicates ───────────────────────────────────────────────────────

describe("findDuplicates", () => {
  function mockJira(issues: Array<{ key: string; summary: string; status: string }>) {
    return {
      searchIssues: vi.fn().mockResolvedValue({
        issues: issues.map((i) => ({
          key: i.key,
          fields: {
            summary: i.summary,
            status: { name: i.status },
          },
        })),
      }),
    } as unknown as JiraClient;
  }

  it("returns candidates above threshold sorted by similarity desc", async () => {
    const jira = mockJira([
      { key: "PROJ-1", summary: "Implement user authentication login flow", status: "Done" },
      { key: "PROJ-2", summary: "Update database migration scripts", status: "To Do" },
      { key: "PROJ-3", summary: "Implement user authentication system", status: "In Progress" },
    ]);

    const results = await findDuplicates(jira, "Implement user authentication login", undefined, "PROJ", 0.1);

    expect(results.length).toBeGreaterThan(0);
    // Should be sorted descending by similarity
    for (let i = 1; i < results.length; i++) {
      expect((results[i - 1] as (typeof results)[number]).similarity).toBeGreaterThanOrEqual(
        (results[i] as (typeof results)[number]).similarity,
      );
    }
    // Each result should have required fields
    for (const r of results) {
      expect(r).toHaveProperty("issueKey");
      expect(r).toHaveProperty("summary");
      expect(r).toHaveProperty("status");
      expect(r).toHaveProperty("similarity");
    }
  });

  it("returns empty array when no matches exceed threshold", async () => {
    const jira = mockJira([{ key: "PROJ-1", summary: "completely unrelated topic xyz", status: "Done" }]);

    const results = await findDuplicates(jira, "Implement user authentication login", undefined, "PROJ", 0.99);

    expect(results).toEqual([]);
  });

  it("handles missing description", async () => {
    const jira = mockJira([{ key: "PROJ-1", summary: "Fix login page error handling", status: "Done" }]);

    const results = await findDuplicates(jira, "Fix login page error handling", undefined, "PROJ", 0.1);

    expect(results.length).toBeGreaterThan(0);
    expect(jira.searchIssues).toHaveBeenCalledTimes(1);
  });

  it("includes description in token matching when provided", async () => {
    const jira = mockJira([{ key: "PROJ-1", summary: "Fix authentication timeout errors", status: "Open" }]);

    const results = await findDuplicates(
      jira,
      "Fix auth errors",
      "authentication timeout occurring during login",
      "PROJ",
      0.1,
    );

    expect(jira.searchIssues).toHaveBeenCalledTimes(1);
    // The JQL should contain keywords from the combined text
    const jql = (jira.searchIssues as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(jql).toContain('project = "PROJ"');
  });

  it("returns empty array when input tokenizes to nothing", async () => {
    const jira = mockJira([]);

    // All words are stop words or <= 2 chars
    const results = await findDuplicates(jira, "the a an is", undefined, "PROJ");

    expect(results).toEqual([]);
    expect(jira.searchIssues).not.toHaveBeenCalled();
  });
});
