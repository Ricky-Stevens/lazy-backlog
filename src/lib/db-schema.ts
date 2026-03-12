import type { SqliteDatabase, Statement } from "./sqlite.js";

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
      indexed_at TEXT NOT NULL
    ) STRICT
  `);

  db.exec("CREATE INDEX IF NOT EXISTS idx_pages_space ON pages(space_key)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_pages_type ON pages(page_type)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_pages_space_type ON pages(space_key, page_type)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_pages_updated ON pages(updated_at)");

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
}

/** Migrate existing DBs: add `source` column to pages if missing. */
export function migrateSchema(db: SqliteDatabase): void {
  const columns = db.pragma("table_info(pages)") as Array<{ name: string }>;
  const hasSource = columns.some((c) => c.name === "source");
  if (!hasSource) {
    db.exec("ALTER TABLE pages ADD COLUMN source TEXT NOT NULL DEFAULT 'confluence'");
    db.exec("CREATE INDEX IF NOT EXISTS idx_pages_source ON pages(source)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_pages_source_key ON pages(source, space_key)");
  }
}

/** Map of all pre-prepared CRUD statements. */
export interface PreparedStatements {
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
  upsertTeamRule: Statement;
  getAllTeamRules: Statement;
  getTeamRulesByCategory: Statement;
  getTeamRulesByCategoryAndType: Statement;
  getTeamRulesByIssueType: Statement;
  deleteAllTeamRules: Statement;
  insertAnalysis: Statement;
  getLatestAnalysis: Statement;
}

/** Pre-prepare all CRUD statements to avoid dynamic SQL. */
export function prepareStatements(db: SqliteDatabase): PreparedStatements {
  return {
    upsert: db.prepare(
      `INSERT INTO pages (id, space_key, title, url, content, page_type, labels, parent_id, author_id, created_at, updated_at, indexed_at, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         space_key=excluded.space_key, title=excluded.title, url=excluded.url,
         content=excluded.content, page_type=excluded.page_type, labels=excluded.labels,
         parent_id=excluded.parent_id, author_id=excluded.author_id,
         created_at=excluded.created_at, updated_at=excluded.updated_at,
         indexed_at=excluded.indexed_at, source=excluded.source`,
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
    // Team rule statements
    upsertTeamRule: db.prepare(
      `INSERT INTO team_rules (category, rule_key, issue_type, rule_value, confidence, sample_size, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(category, rule_key, COALESCE(issue_type, '__all__')) DO UPDATE SET
         rule_value=excluded.rule_value, confidence=excluded.confidence,
         sample_size=excluded.sample_size, updated_at=excluded.updated_at`,
    ),
    getAllTeamRules: db.prepare("SELECT * FROM team_rules ORDER BY category, rule_key"),
    getTeamRulesByCategory: db.prepare("SELECT * FROM team_rules WHERE category = ? ORDER BY rule_key"),
    getTeamRulesByCategoryAndType: db.prepare(
      "SELECT * FROM team_rules WHERE category = ? AND (issue_type = ? OR issue_type IS NULL) ORDER BY rule_key",
    ),
    getTeamRulesByIssueType: db.prepare(
      "SELECT * FROM team_rules WHERE issue_type = ? OR issue_type IS NULL ORDER BY category, rule_key",
    ),
    deleteAllTeamRules: db.prepare("DELETE FROM team_rules"),
    // Backlog analysis statements
    insertAnalysis: db.prepare(
      `INSERT INTO backlog_analysis (project_key, tickets_fetched, tickets_quality_passed, quality_threshold, rules_extracted, jql_used, analyzed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ),
    getLatestAnalysis: db.prepare("SELECT * FROM backlog_analysis ORDER BY analyzed_at DESC LIMIT 1"),
  };
}
