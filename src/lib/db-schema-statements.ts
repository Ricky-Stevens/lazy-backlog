import { type InsightsStatements, prepareInsightsStatements } from "./db-schema-insights.js";
import { prepareSpecLinkStatements, type SpecLinkStatements } from "./db-schema-spec-links.js";
import type { SqliteDatabase, Statement } from "./sqlite.js";

/**
 * Map of all pre-prepared CRUD statements. Extends `SpecLinkStatements` so the
 * spec-link prepared statements (split into db-schema-spec-links.ts) remain
 * accessible from the same bag — callers can keep using a single
 * `PreparedStatements` object exactly as before the split.
 */
export interface PreparedStatements extends SpecLinkStatements, InsightsStatements {
  upsert: Statement;
  getById: Statement;
  getByType: Statement;
  getByTypeAndSpace: Statement;
  summariesByType: Statement;
  summariesByTypeAndSpace: Statement;
  summariesBySource: Statement;
  stats: Statement;
  getConfig: Statement;
  setConfig: Statement;
  deleteBySpace: Statement;
  deleteBySource: Statement;
  countBySpaceKey: Statement;
  countBySource: Statement;
  getUpdatedAt: Statement;
  getReindexFingerprint: Statement;
  insertChunk: Statement;
  deleteChunksByPage: Statement;
  getChunksByPage: Statement;
  upsertSprint: Statement;
  getSprintById: Statement;
  getSprintsByBoard: Statement;
  getSprintsByBoardAndState: Statement;
  insertChangelog: Statement;
  getChangelogByIssue: Statement;
  getChangelogByIssueAndField: Statement;
  deleteChangelogByIssue: Statement;
  getStalePages: Statement;
  getStalePagesFiltered: Statement;
  getStalePagesTyped: Statement;
  getStalePagesAll: Statement;
  getRecentlyIndexed: Statement;
  getRecentlyIndexedBySource: Statement;
  // Team-rule / analysis / insight statements are contributed by
  // InsightsStatements (extended above). Spec-link statements are contributed
  // by SpecLinkStatements (extended above).
}

/** Pre-prepare all CRUD statements to avoid dynamic SQL. */
export function prepareStatements(db: SqliteDatabase): PreparedStatements {
  return {
    upsert: db.prepare(
      `INSERT INTO pages (id, space_key, title, url, content, page_type, labels, parent_id, author_id, created_at, updated_at, indexed_at, source, content_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         space_key=excluded.space_key, title=excluded.title, url=excluded.url,
         content=excluded.content, page_type=excluded.page_type, labels=excluded.labels,
         parent_id=excluded.parent_id, author_id=excluded.author_id,
         created_at=excluded.created_at, updated_at=excluded.updated_at,
         indexed_at=excluded.indexed_at, source=excluded.source,
         content_hash=excluded.content_hash`,
    ),
    getById: db.prepare("SELECT * FROM pages WHERE id = ?"),
    getByType: db.prepare("SELECT * FROM pages WHERE page_type = ? ORDER BY title"),
    getByTypeAndSpace: db.prepare("SELECT * FROM pages WHERE page_type = ? AND space_key = ? ORDER BY title"),
    // Lightweight queries — no content body, just preview
    summariesByType: db.prepare(
      `SELECT id, space_key, title, url, page_type, labels, updated_at, source,
       substr(content, 1, 300) as content_preview
       FROM pages WHERE page_type = ? ORDER BY title`,
    ),
    summariesByTypeAndSpace: db.prepare(
      `SELECT id, space_key, title, url, page_type, labels, updated_at, source,
       substr(content, 1, 300) as content_preview
       FROM pages WHERE page_type = ? AND space_key = ? ORDER BY title`,
    ),
    summariesBySource: db.prepare(
      `SELECT id, space_key, title, url, page_type, labels, updated_at, source,
       substr(content, 1, 300) as content_preview
       FROM pages WHERE source = ? AND page_type = ? ORDER BY title`,
    ),
    // Stats in a single query
    stats: db.prepare(`
      SELECT
        'total' as group_type, 'all' as key, COUNT(*) as count FROM pages
      UNION ALL
      SELECT 'type', page_type, COUNT(*) FROM pages GROUP BY page_type
      UNION ALL
      SELECT 'space', space_key, COUNT(*) FROM pages GROUP BY space_key
      UNION ALL
      SELECT 'source', source, COUNT(*) FROM pages GROUP BY source
      UNION ALL
      SELECT 'chunks', 'all', COUNT(*) FROM chunks
    `),
    getConfig: db.prepare("SELECT value FROM config WHERE key = ?"),
    setConfig: db.prepare(
      "INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ),
    deleteBySpace: db.prepare("DELETE FROM pages WHERE space_key = ?"),
    deleteBySource: db.prepare("DELETE FROM pages WHERE source = ?"),
    countBySpaceKey: db.prepare("SELECT COUNT(*) as count FROM pages WHERE space_key = ?"),
    countBySource: db.prepare("SELECT COUNT(*) as count FROM pages WHERE source = ?"),
    getUpdatedAt: db.prepare("SELECT id, updated_at FROM pages WHERE id = ?"),
    getReindexFingerprint: db.prepare("SELECT id, updated_at, content_hash FROM pages WHERE id = ?"),
    // Chunk statements
    insertChunk: db.prepare(
      `INSERT INTO chunks (page_id, breadcrumb, heading, depth, content, chunk_index)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ),
    deleteChunksByPage: db.prepare("DELETE FROM chunks WHERE page_id = ?"),
    getChunksByPage: db.prepare("SELECT * FROM chunks WHERE page_id = ? ORDER BY chunk_index"),
    // Sprint statements
    upsertSprint: db.prepare(
      `INSERT INTO sprints (id, board_id, name, state, goal, start_date, end_date, complete_date, cached_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         board_id=excluded.board_id, name=excluded.name, state=excluded.state,
         goal=excluded.goal, start_date=excluded.start_date, end_date=excluded.end_date,
         complete_date=excluded.complete_date, cached_at=excluded.cached_at`,
    ),
    getSprintById: db.prepare("SELECT * FROM sprints WHERE id = ?"),
    getSprintsByBoard: db.prepare("SELECT * FROM sprints WHERE board_id = ? ORDER BY start_date DESC"),
    getSprintsByBoardAndState: db.prepare(
      "SELECT * FROM sprints WHERE board_id = ? AND state = ? ORDER BY start_date DESC",
    ),
    // Changelog statements
    insertChangelog: db.prepare(
      `INSERT INTO changelogs (id, issue_key, author_name, author_id, created, field, from_value, to_value, cached_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         issue_key=excluded.issue_key, author_name=excluded.author_name, author_id=excluded.author_id,
         created=excluded.created, field=excluded.field, from_value=excluded.from_value,
         to_value=excluded.to_value, cached_at=excluded.cached_at`,
    ),
    getChangelogByIssue: db.prepare("SELECT * FROM changelogs WHERE issue_key = ? ORDER BY created ASC"),
    getChangelogByIssueAndField: db.prepare(
      "SELECT * FROM changelogs WHERE issue_key = ? AND field = ? ORDER BY created ASC",
    ),
    deleteChangelogByIssue: db.prepare("DELETE FROM changelogs WHERE issue_key = ?"),
    // Stale/recent page queries
    getStalePages: db.prepare("SELECT * FROM pages WHERE updated_at < ? ORDER BY updated_at ASC"),
    getStalePagesFiltered: db.prepare(
      "SELECT * FROM pages WHERE updated_at < ? AND space_key = ? ORDER BY updated_at ASC",
    ),
    getStalePagesTyped: db.prepare(
      "SELECT * FROM pages WHERE updated_at < ? AND page_type = ? ORDER BY updated_at ASC",
    ),
    getStalePagesAll: db.prepare(
      "SELECT * FROM pages WHERE updated_at < ? AND page_type = ? AND space_key = ? ORDER BY updated_at ASC",
    ),
    getRecentlyIndexed: db.prepare("SELECT * FROM pages WHERE indexed_at > ? ORDER BY indexed_at DESC"),
    getRecentlyIndexedBySource: db.prepare(
      "SELECT * FROM pages WHERE indexed_at > ? AND source = ? ORDER BY indexed_at DESC",
    ),
    // Team-rule / backlog-analysis / team-insight statements (db-schema-insights.ts)
    ...prepareInsightsStatements(db),
    // Epic ↔ spec link statements (Stage D) (db-schema-spec-links.ts)
    ...prepareSpecLinkStatements(db),
  };
}
