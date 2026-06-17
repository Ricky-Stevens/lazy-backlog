/**
 * Tests for the Stage D spec-context helpers.
 *
 * Cover the pure formatting/aggregation surface only — Jira/KB I/O lives in
 * the tools layer and is tested there.
 */
import { describe, expect, it } from "vitest";
import type { IndexedPage } from "../lib/db-types.js";
import {
  buildSpecStatusSection,
  type EpicChildIssue,
  formatSpecContextSection,
  formatSpecLinkLine,
  SPEC_PREVIEW_CHAR_LIMIT,
  summariseEpicStatus,
} from "../lib/spec-context.js";

function makePage(overrides: Partial<IndexedPage> = {}): IndexedPage {
  return {
    id: "pg-1",
    space_key: "ENG",
    title: "Auth Redesign Spec",
    url: "https://example.atlassian.net/wiki/spaces/ENG/pages/pg-1",
    content: "## Goal\n\nReplace legacy session cookies with JWT.\n\n- Add /auth/login\n- Add /auth/refresh\n",
    page_type: "spec",
    labels: "[]",
    parent_id: null,
    author_id: null,
    created_at: null,
    updated_at: null,
    indexed_at: new Date().toISOString(),
    source: "confluence",
    content_hash: null,
    ...overrides,
  };
}

function makeChild(overrides: Partial<EpicChildIssue> = {}): EpicChildIssue {
  return {
    key: "BP-1",
    summary: "Wire up /auth/login",
    statusName: "To Do",
    statusCategory: "new",
    storyPoints: 3,
    ...overrides,
  };
}

describe("formatSpecContextSection", () => {
  it("returns empty string when no page is provided", () => {
    expect(formatSpecContextSection(undefined)).toBe("");
  });

  it("renders title, page id, url, source, type and body", () => {
    const out = formatSpecContextSection(makePage());
    expect(out).toContain("## Source Spec");
    expect(out).toContain("Auth Redesign Spec");
    expect(out).toContain("**Page ID:** pg-1");
    expect(out).toContain("https://example.atlassian.net/wiki/spaces/ENG/pages/pg-1");
    expect(out).toContain("confluence");
    expect(out).toContain("spec");
    expect(out).toContain("Replace legacy session cookies with JWT.");
  });

  it("omits the URL line when the page has no URL", () => {
    const out = formatSpecContextSection(makePage({ url: null }));
    expect(out).not.toContain("**URL:**");
    expect(out).toContain("Auth Redesign Spec");
  });

  it("truncates long bodies with an explicit marker", () => {
    const longBody = "x".repeat(SPEC_PREVIEW_CHAR_LIMIT + 200);
    const out = formatSpecContextSection(makePage({ content: longBody }));
    expect(out).toContain("(truncated");
    expect(out.includes(longBody)).toBe(false);
  });
});

describe("summariseEpicStatus", () => {
  it("handles an empty epic without dividing by zero", () => {
    const s = summariseEpicStatus([]);
    expect(s.total).toBe(0);
    expect(s.completionPct).toBe(0);
    expect(s.isComplete).toBe(false);
    expect(s.remaining).toEqual([]);
  });

  it("counts done / in progress / todo correctly and computes points", () => {
    const s = summariseEpicStatus([
      makeChild({ key: "BP-1", statusCategory: "done", storyPoints: 3 }),
      makeChild({ key: "BP-2", statusCategory: "done", storyPoints: 5 }),
      makeChild({ key: "BP-3", statusCategory: "indeterminate", statusName: "In Progress", storyPoints: 2 }),
      makeChild({ key: "BP-4", statusCategory: "new", statusName: "To Do", storyPoints: 8 }),
    ]);

    expect(s.total).toBe(4);
    expect(s.done).toBe(2);
    expect(s.inProgress).toBe(1);
    expect(s.todo).toBe(1);
    expect(s.totalPoints).toBe(18);
    expect(s.completedPoints).toBe(8);
    expect(s.remainingPoints).toBe(10);
    expect(s.completionPct).toBe(50);
    expect(s.isComplete).toBe(false);
    expect(s.remaining.map((r) => r.key)).toEqual(["BP-3", "BP-4"]);
  });

  it("flags isComplete only when every issue is done", () => {
    const s = summariseEpicStatus([
      makeChild({ key: "BP-1", statusCategory: "done" }),
      makeChild({ key: "BP-2", statusCategory: "done" }),
    ]);
    expect(s.isComplete).toBe(true);
    expect(s.completionPct).toBe(100);
  });

  it("treats unknown categories as todo so they appear in remaining", () => {
    const s = summariseEpicStatus([makeChild({ key: "BP-9", statusCategory: "weird-value" })]);
    expect(s.todo).toBe(1);
    expect(s.remaining.map((r) => r.key)).toEqual(["BP-9"]);
  });
});

describe("buildSpecStatusSection", () => {
  const summary = summariseEpicStatus([
    makeChild({ key: "BP-1", statusCategory: "done", storyPoints: 3 }),
    makeChild({ key: "BP-2", statusCategory: "indeterminate", statusName: "In Progress", storyPoints: 5 }),
  ]);
  const fixedDate = new Date("2026-01-01T00:00:00.000Z");

  it("includes a stable heading, epic link, completion and points lines", () => {
    const md = buildSpecStatusSection("BP-EPIC", "https://example.atlassian.net", summary, { generatedAt: fixedDate });
    expect(md).toContain("## Implementation Status");
    expect(md).toContain("https://example.atlassian.net/browse/BP-EPIC");
    expect(md).toContain("2026-01-01T00:00:00.000Z");
    expect(md).toContain("**Completion:** 50%");
    expect(md).toContain("**Story points:** 3/8 completed, 5 remaining");
  });

  it("renders the open-work table when issues are outstanding", () => {
    const md = buildSpecStatusSection("BP-EPIC", "https://example.atlassian.net", summary, { generatedAt: fixedDate });
    expect(md).toContain("### Open Work");
    expect(md).toContain("| [BP-2](https://example.atlassian.net/browse/BP-2) | Wire up /auth/login | In Progress |");
  });

  it("appends a completion notice when the epic is done", () => {
    const doneSummary = summariseEpicStatus([makeChild({ key: "BP-1", statusCategory: "done", storyPoints: 3 })]);
    const md = buildSpecStatusSection("BP-EPIC", "https://example.atlassian.net", doneSummary, {
      generatedAt: fixedDate,
    });
    expect(md).toContain("Epic complete");
    expect(md).not.toContain("### Open Work");
  });

  it("normalises trailing slashes in the site URL", () => {
    const md = buildSpecStatusSection("BP-EPIC", "https://example.atlassian.net/", summary, {
      generatedAt: fixedDate,
    });
    expect(md).toContain("https://example.atlassian.net/browse/BP-EPIC");
    expect(md).not.toContain("https://example.atlassian.net//browse");
  });

  it("includes the optional epic summary when provided", () => {
    const md = buildSpecStatusSection("BP-EPIC", "https://example.atlassian.net", summary, {
      generatedAt: fixedDate,
      epicSummary: "Auth redesign",
    });
    expect(md).toContain("Auth redesign");
  });

  // ── GEN-10: pipe-escape table cells ────────────────────────────────────

  it("GEN-10: pipe characters inside an issue summary are escaped so the table stays well-formed", () => {
    const summaryWithPipe = summariseEpicStatus([
      makeChild({
        key: "BP-2",
        summary: "Add filter for size | order",
        statusName: "In Progress",
        statusCategory: "indeterminate",
      }),
    ]);
    const md = buildSpecStatusSection("BP-EPIC", "https://example.atlassian.net", summaryWithPipe, {
      generatedAt: fixedDate,
    });
    // The raw `|` in the summary must be escaped so the row keeps exactly 3 cells.
    expect(md).toContain("Add filter for size \\| order");
    // The Open Work table row, after escaping, has the right shape:
    expect(md).toMatch(/\| \[BP-2\]\(\S+\/browse\/BP-2\) \| Add filter for size \\\| order \| In Progress \|/);
  });

  it("GEN-10: newlines inside an issue summary become <br> so the row stays on one line", () => {
    const summaryWithNewline = summariseEpicStatus([
      makeChild({ key: "BP-3", summary: "Line one\nLine two", statusCategory: "new" }),
    ]);
    const md = buildSpecStatusSection("BP-EPIC", "https://example.atlassian.net", summaryWithNewline, {
      generatedAt: fixedDate,
    });
    expect(md).toContain("Line one<br>Line two");
  });
});

describe("formatSpecLinkLine", () => {
  it("returns empty when no page provided", () => {
    expect(formatSpecLinkLine(undefined)).toBe("");
  });

  it("links the title to the URL when present", () => {
    const line = formatSpecLinkLine(makePage());
    expect(line).toContain("[Auth Redesign Spec](https://example.atlassian.net/wiki/spaces/ENG/pages/pg-1)");
    expect(line).toContain("(page pg-1)");
  });

  it("falls back to plain title when no URL", () => {
    const line = formatSpecLinkLine(makePage({ url: null }));
    expect(line).toContain("Auth Redesign Spec");
    expect(line).not.toContain("[Auth");
  });
});
