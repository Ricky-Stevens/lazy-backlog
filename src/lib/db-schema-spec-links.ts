/**
 * Schema + prepared statements for the `epic_spec_links` table (Stage D).
 * Extracted from db-schema.ts to keep that file under the 400-line cap.
 *
 * The table records the Confluence page a Jira epic/ticket was generated from.
 * Used to:
 *   - write an "Implementation status" section back to the spec
 *   - flag the spec stale once the epic completes (freshness loop)
 */
import type { SqliteDatabase, Statement } from "./sqlite.js";

/** Create the epic_spec_links table + indexes. Safe to call repeatedly. */
export function initSpecLinksSchema(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS epic_spec_links (
      issue_key TEXT NOT NULL,
      page_id TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'confluence',
      page_title TEXT,
      page_url TEXT,
      stale_flagged_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (issue_key, page_id)
    ) STRICT
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_epic_spec_links_page ON epic_spec_links(page_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_epic_spec_links_issue ON epic_spec_links(issue_key)");
}

/** Prepared statements for spec-link CRUD. */
export interface SpecLinkStatements {
  upsertEpicSpecLink: Statement;
  getSpecLinksByIssue: Statement;
  getSpecLinksByPage: Statement;
  getAllSpecLinks: Statement;
  markSpecLinkStale: Statement;
  markSpecLinkCompleted: Statement;
  deleteSpecLink: Statement;
}

/** Pre-prepare all spec-link statements. */
export function prepareSpecLinkStatements(db: SqliteDatabase): SpecLinkStatements {
  return {
    upsertEpicSpecLink: db.prepare(
      `INSERT INTO epic_spec_links (issue_key, page_id, source, page_title, page_url, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(issue_key, page_id) DO UPDATE SET
         source=excluded.source,
         page_title=excluded.page_title,
         page_url=excluded.page_url`,
    ),
    getSpecLinksByIssue: db.prepare("SELECT * FROM epic_spec_links WHERE issue_key = ? ORDER BY created_at DESC"),
    getSpecLinksByPage: db.prepare("SELECT * FROM epic_spec_links WHERE page_id = ? ORDER BY created_at DESC"),
    getAllSpecLinks: db.prepare("SELECT * FROM epic_spec_links ORDER BY created_at DESC"),
    markSpecLinkStale: db.prepare(
      "UPDATE epic_spec_links SET stale_flagged_at = ? WHERE issue_key = ? AND page_id = ?",
    ),
    markSpecLinkCompleted: db.prepare(
      "UPDATE epic_spec_links SET completed_at = ? WHERE issue_key = ? AND page_id = ?",
    ),
    deleteSpecLink: db.prepare("DELETE FROM epic_spec_links WHERE issue_key = ? AND page_id = ?"),
  };
}
