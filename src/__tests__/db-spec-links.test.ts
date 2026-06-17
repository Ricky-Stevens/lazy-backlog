/**
 * Tests for the spec ↔ epic link helpers (Stage H split).
 *
 * Covers both the helper-function surface in db-spec-links.ts and the
 * barrel-re-exported import path through db.ts, since the Stage H hygiene
 * split must preserve callers that import from either location.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as dbBarrel from "../lib/db.js";
import { KnowledgeBase } from "../lib/db.js";
import type * as specLinksDirect from "../lib/db-spec-links.js";

function freshDbPath(): string {
  return path.join(os.tmpdir(), `db-spec-links-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
}

describe("spec link helpers", () => {
  let dbPath: string;
  let kb: KnowledgeBase;

  beforeEach(() => {
    dbPath = freshDbPath();
    kb = new KnowledgeBase(dbPath);
  });

  afterEach(() => {
    kb.close();
    try {
      fs.unlinkSync(dbPath);
      fs.unlinkSync(`${dbPath}-wal`);
      fs.unlinkSync(`${dbPath}-shm`);
    } catch {
      // best-effort cleanup
    }
  });

  it("upserts and retrieves a spec link with default source", () => {
    kb.upsertEpicSpecLink({
      issueKey: "ABC-1",
      pageId: "page-1",
      pageTitle: "Spec",
      pageUrl: "https://example/wiki/page-1",
    });
    const linksByIssue = kb.getSpecLinksByIssue("ABC-1");
    expect(linksByIssue).toHaveLength(1);
    expect(linksByIssue[0]).toMatchObject({
      issue_key: "ABC-1",
      page_id: "page-1",
      source: "confluence",
      page_title: "Spec",
      page_url: "https://example/wiki/page-1",
      stale_flagged_at: null,
      completed_at: null,
    });
    expect(linksByIssue[0]?.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("upsert is idempotent on (issue_key, page_id) and refreshes mutable fields", () => {
    kb.upsertEpicSpecLink({ issueKey: "ABC-1", pageId: "page-1", pageTitle: "Old", pageUrl: "u1" });
    kb.upsertEpicSpecLink({ issueKey: "ABC-1", pageId: "page-1", pageTitle: "New", pageUrl: "u2" });
    const links = kb.getSpecLinksByIssue("ABC-1");
    expect(links).toHaveLength(1);
    expect(links[0]?.page_title).toBe("New");
    expect(links[0]?.page_url).toBe("u2");
  });

  it("honours a custom source", () => {
    kb.upsertEpicSpecLink({ issueKey: "ABC-1", pageId: "p", source: "github" });
    expect(kb.getSpecLinksByIssue("ABC-1")[0]?.source).toBe("github");
  });

  it("getSpecLinksByPage returns all issues linked to a page", () => {
    kb.upsertEpicSpecLink({ issueKey: "ABC-1", pageId: "p" });
    kb.upsertEpicSpecLink({ issueKey: "ABC-2", pageId: "p" });
    kb.upsertEpicSpecLink({ issueKey: "ABC-3", pageId: "other" });
    const linksForP = kb.getSpecLinksByPage("p");
    expect(linksForP.map((l) => l.issue_key).sort()).toEqual(["ABC-1", "ABC-2"]);
  });

  it("getAllSpecLinks returns everything", () => {
    kb.upsertEpicSpecLink({ issueKey: "ABC-1", pageId: "p1" });
    kb.upsertEpicSpecLink({ issueKey: "ABC-2", pageId: "p2" });
    expect(kb.getAllSpecLinks()).toHaveLength(2);
  });

  it("flagSpecStale stamps the row and returns true on hit / false on miss", () => {
    kb.upsertEpicSpecLink({ issueKey: "ABC-1", pageId: "p" });
    expect(kb.flagSpecStale("ABC-1", "p")).toBe(true);
    expect(kb.getSpecLinksByIssue("ABC-1")[0]?.stale_flagged_at).toMatch(/^\d{4}-/);
    expect(kb.flagSpecStale("does-not", "exist")).toBe(false);
  });

  it("markEpicCompleted stamps completed_at and returns true on hit / false on miss", () => {
    kb.upsertEpicSpecLink({ issueKey: "ABC-1", pageId: "p" });
    expect(kb.markEpicCompleted("ABC-1", "p")).toBe(true);
    expect(kb.getSpecLinksByIssue("ABC-1")[0]?.completed_at).toMatch(/^\d{4}-/);
    expect(kb.markEpicCompleted("nope", "nope")).toBe(false);
  });

  it("deleteSpecLink removes a row and reports the change", () => {
    kb.upsertEpicSpecLink({ issueKey: "ABC-1", pageId: "p" });
    expect(kb.deleteSpecLink("ABC-1", "p")).toBe(true);
    expect(kb.getSpecLinksByIssue("ABC-1")).toHaveLength(0);
    expect(kb.deleteSpecLink("ABC-1", "p")).toBe(false);
  });

  it("re-exports the helper functions through the db.ts barrel", () => {
    // Stage H hygiene split: callers that imported helpers from db.js must
    // continue to work via the `export * from "./db-spec-links.js"` barrel.
    expect(typeof (dbBarrel as unknown as typeof specLinksDirect).upsertEpicSpecLink).toBe("function");
    expect(typeof (dbBarrel as unknown as typeof specLinksDirect).flagSpecStale).toBe("function");
    expect(typeof (dbBarrel as unknown as typeof specLinksDirect).markEpicCompleted).toBe("function");
    expect(typeof (dbBarrel as unknown as typeof specLinksDirect).deleteSpecLink).toBe("function");
    expect(typeof (dbBarrel as unknown as typeof specLinksDirect).getSpecLinksByIssue).toBe("function");
    expect(typeof (dbBarrel as unknown as typeof specLinksDirect).getSpecLinksByPage).toBe("function");
    expect(typeof (dbBarrel as unknown as typeof specLinksDirect).getAllSpecLinks).toBe("function");
  });
});
