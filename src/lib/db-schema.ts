import { initSpecLinksSchema } from "./db-schema-spec-links.js";
import type { SqliteDatabase } from "./sqlite.js";

// Re-export the split helpers so callers can keep importing from db-schema.js
// without knowing about the split.
export {
  type InsightsStatements,
  prepareInsightsStatements,
} from "./db-schema-insights.js";
export {
  initSpecLinksSchema,
  prepareSpecLinkStatements,
  type SpecLinkStatements,
} from "./db-schema-spec-links.js";
// PreparedStatements + prepareStatements live in db-schema-statements.ts so
// db-schema.ts stays under the 400-line cap. Re-exported here to preserve all
// existing import paths.
export { type PreparedStatements, prepareStatements } from "./db-schema-statements.js";

/** Configure SQLite PRAGMAs for performance. */
export function configurePragmas(db: SqliteDatabase): void {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL"); // Safe with WAL, 2x faster than FULL
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA cache_size = -64000"); // 64MB cache for bulk indexing
  db.exec("PRAGMA mmap_size = 268435456"); // 256MB memory-mapped I/O
  db.exec("PRAGMA temp_store = MEMORY");
}

/** Create all tables, indexes, triggers, and FTS5 virtual tables. */
export function initSchema(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pages (
      id TEXT PRIMARY KEY,
      space_key TEXT NOT NULL,
      title TEXT NOT NULL,
      url TEXT,
      content TEXT NOT NULL,
      page_type TEXT NOT NULL DEFAULT 'other',
      labels TEXT NOT NULL DEFAULT '[]',
      parent_id TEXT,
      author_id TEXT,
      created_at TEXT,
      updated_at TEXT,
      indexed_at TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'confluence',
      content_hash TEXT
    ) STRICT
  `);

  db.exec("CREATE INDEX IF NOT EXISTS idx_pages_space ON pages(space_key)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_pages_type ON pages(page_type)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_pages_space_type ON pages(space_key, page_type)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_pages_updated ON pages(updated_at)");
  // DB-5: `source` indexes belong in the canonical schema so a fresh DB
  // doesn't have to ALTER TABLE itself on first open. migrateSchema() still
  // covers legacy DBs that pre-date the column (idempotent via hasSource).
  db.exec("CREATE INDEX IF NOT EXISTS idx_pages_source ON pages(source)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_pages_source_key ON pages(source, space_key)");

  // ── Chunks table: section-level content with heading breadcrumbs ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
      breadcrumb TEXT NOT NULL DEFAULT '',
      heading TEXT NOT NULL DEFAULT '',
      depth INTEGER NOT NULL DEFAULT 0,
      content TEXT NOT NULL,
      chunk_index INTEGER NOT NULL DEFAULT 0
    ) STRICT
  `);

  db.exec("CREATE INDEX IF NOT EXISTS idx_chunks_page ON chunks(page_id)");

  db.exec(`
    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT
  `);

  // ── FTS5 on pages (kept for backward compat) ──
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
      title,
      content,
      labels,
      content='pages',
      content_rowid='rowid'
    )
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS pages_ai AFTER INSERT ON pages BEGIN
      INSERT INTO pages_fts(rowid, title, content, labels)
      VALUES (new.rowid, new.title, new.content, new.labels);
    END
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS pages_ad AFTER DELETE ON pages BEGIN
      INSERT INTO pages_fts(pages_fts, rowid, title, content, labels)
      VALUES ('delete', old.rowid, old.title, old.content, old.labels);
    END
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS pages_au AFTER UPDATE ON pages BEGIN
      INSERT INTO pages_fts(pages_fts, rowid, title, content, labels)
      VALUES ('delete', old.rowid, old.title, old.content, old.labels);
      INSERT INTO pages_fts(rowid, title, content, labels)
      VALUES (new.rowid, new.title, new.content, new.labels);
    END
  `);

  // ── FTS5 on chunks (primary search target) ──
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      heading,
      breadcrumb,
      content,
      content='chunks',
      content_rowid='id'
    )
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
      INSERT INTO chunks_fts(rowid, heading, breadcrumb, content)
      VALUES (new.id, new.heading, new.breadcrumb, new.content);
    END
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, heading, breadcrumb, content)
      VALUES ('delete', old.id, old.heading, old.breadcrumb, old.content);
    END
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, heading, breadcrumb, content)
      VALUES ('delete', old.id, old.heading, old.breadcrumb, old.content);
      INSERT INTO chunks_fts(rowid, heading, breadcrumb, content)
      VALUES (new.id, new.heading, new.breadcrumb, new.content);
    END
  `);

  // ── Sprint cache ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS sprints (
      id TEXT PRIMARY KEY,
      board_id TEXT NOT NULL,
      name TEXT NOT NULL,
      state TEXT NOT NULL,
      goal TEXT,
      start_date TEXT,
      end_date TEXT,
      complete_date TEXT,
      cached_at TEXT NOT NULL
    ) STRICT
  `);

  // ── Changelog cache ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS changelogs (
      id TEXT PRIMARY KEY,
      issue_key TEXT NOT NULL,
      author_name TEXT,
      author_id TEXT,
      created TEXT NOT NULL,
      field TEXT NOT NULL,
      from_value TEXT,
      to_value TEXT,
      cached_at TEXT NOT NULL
    ) STRICT
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_changelogs_issue ON changelogs(issue_key)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_changelogs_field ON changelogs(field)");

  // ── Team rules ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS team_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL,
      rule_key TEXT NOT NULL,
      issue_type TEXT,
      rule_value TEXT NOT NULL,
      confidence REAL NOT NULL,
      sample_size INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT
  `);

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_team_rules_unique
      ON team_rules(category, rule_key, COALESCE(issue_type, '__all__'))
  `);

  // ── Backlog analysis log ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS backlog_analysis (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_key TEXT NOT NULL,
      tickets_fetched INTEGER NOT NULL,
      tickets_quality_passed INTEGER NOT NULL,
      quality_threshold INTEGER NOT NULL,
      rules_extracted INTEGER NOT NULL,
      jql_used TEXT NOT NULL,
      analyzed_at TEXT NOT NULL
    ) STRICT
  `);

  // ── Team insights ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS team_insights (
      category TEXT NOT NULL,
      insight_key TEXT NOT NULL,
      data TEXT NOT NULL,
      sample_size INTEGER NOT NULL DEFAULT 0,
      confidence REAL NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (category, insight_key)
    ) STRICT
  `);

  // ── Spec ↔ Epic links (Stage D) — schema lives in db-schema-spec-links.ts ──
  initSpecLinksSchema(db);
}

/** Migrate existing DBs: add `source` and `content_hash` columns to pages if missing. */
export function migrateSchema(db: SqliteDatabase): void {
  const columns = db.pragma("table_info(pages)") as Array<{ name: string }>;
  const hasSource = columns.some((c) => c.name === "source");
  if (!hasSource) {
    db.exec("ALTER TABLE pages ADD COLUMN source TEXT NOT NULL DEFAULT 'confluence'");
    db.exec("CREATE INDEX IF NOT EXISTS idx_pages_source ON pages(source)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_pages_source_key ON pages(source, space_key)");
  }

  // E1 (Stage E) — content-hash incremental sync. The hash fingerprints content
  // + labels + title (+ attachments, see DB-2) so label-only, content-only, or
  // attachment-only changes are re-indexed even when `updated_at` was not
  // bumped by the source. Nullable to keep the migration additive: existing
  // rows have NULL until the next crawl re-hashes them. DB-6: re-indexing of
  // legacy NULL-hash rows is enforced explicitly by `KnowledgeBase.needsReindex`
  // (see `db.ts`: `if (row.content_hash === null) return true;`) — the NULL
  // value does NOT participate in the `!==` comparison; treating it as
  // must-re-index is a deliberate special case so the first post-migration
  // crawl backfills `content_hash` for every legacy row.
  const hasContentHash = columns.some((c) => c.name === "content_hash");
  if (!hasContentHash) {
    db.exec("ALTER TABLE pages ADD COLUMN content_hash TEXT");
  }

  // epic_spec_links is created by initSchema() (CREATE IF NOT EXISTS), so no
  // explicit migration is needed for fresh installs. The IF NOT EXISTS guard
  // covers older DBs too — calling initSchema() at startup is enough.
}

// Implementations of PreparedStatements / prepareStatements live in
// db-schema-statements.ts (re-exported above) to keep this file under the
// 400-line project cap.
