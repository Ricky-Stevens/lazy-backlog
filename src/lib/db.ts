import fs from "node:fs";
import path from "node:path";
import type { PageType } from "../config/schema.js";
import {
  configurePragmas,
  initSchema,
  migrateSchema,
  type PreparedStatements,
  prepareStatements,
} from "./db-schema.js";
import { prepareSearchVariants, type SearchStatements, searchChunks, searchPages } from "./db-search.js";
import type {
  BacklogAnalysisRecord,
  CachedChangelogEntry,
  CachedSprint,
  ChunkSearchResult,
  IndexedPage,
  PageSummary,
  SearchFilter,
  SearchResult,
  StoredTeamRule,
} from "./db-types.js";
import { Database, type SqliteDatabase } from "./sqlite.js";

export * from "./db-search.js";
export * from "./db-types.js";
export { groupBy } from "./utils.js";

/** Size threshold (100 MB) above which optimize() will also VACUUM. */
const VACUUM_THRESHOLD_BYTES = 100 * 1024 * 1024;

interface CountRow {
  count: number;
}
interface ConfigRow {
  value: string;
}
interface StatsRow {
  group_type: string;
  key: string;
  count: number;
}
interface UpdatedAtRow {
  id: string;
  updated_at: string | null;
}

// ── Knowledge base ─────────────────────────────────────────────────────────

export class KnowledgeBase {
  private readonly db: SqliteDatabase;
  private readonly dbPath: string;
  private readonly stmts: PreparedStatements;
  private readonly searchStmts: SearchStatements;

  constructor(dbPath: string) {
    const resolvedPath = dbPath;
    this.dbPath = resolvedPath;
    const dir = path.dirname(resolvedPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(resolvedPath);
    configurePragmas(this.db);
    initSchema(this.db);
    migrateSchema(this.db);
    this.stmts = prepareStatements(this.db);
    this.searchStmts = prepareSearchVariants(this.db);
  }

  /** Insert or update a single page in the knowledge base. */
  upsertPage(page: IndexedPage): void {
    this.stmts.upsert.run(
      page.id,
      page.space_key,
      page.title,
      page.url,
      page.content,
      page.page_type,
      page.labels,
      page.parent_id,
      page.author_id,
      page.created_at,
      page.updated_at,
      page.indexed_at,
      page.source,
    );
  }

  /** Batch upsert pages in a single transaction for performance. */
  upsertMany(pages: IndexedPage[]): void {
    this.db.transaction(() => {
      for (const page of pages) {
        this.upsertPage(page);
      }
    })();
  }

  /** Check if a page needs re-indexing based on updated_at timestamp. */
  needsReindex(pageId: string, remoteUpdatedAt: string | undefined): boolean {
    // Cast needed: Statement.get() returns unknown; row shape matches our SELECT columns
    const row = this.stmts.getUpdatedAt.get(pageId) as UpdatedAtRow | undefined;
    if (!row) return true; // Not indexed yet
    if (!remoteUpdatedAt) return true; // Can't compare, re-index to be safe
    return row.updated_at !== remoteUpdatedAt;
  }

  /** Full-text search across indexed pages. Falls back to phrase escaping on FTS5 syntax errors. */
  search(query: string, options?: SearchFilter): SearchResult[] {
    return searchPages(query, options ?? {}, this.searchStmts);
  }

  /** Retrieve a single page by Confluence page ID. */
  getPage(id: string): IndexedPage | undefined {
    // Cast needed: Statement.get() returns unknown; row matches SELECT * FROM pages
    return this.stmts.getById.get(id) as IndexedPage | undefined;
  }

  /** Get all pages of a given type, optionally filtered by space. */
  getPagesByType(pageType: PageType, spaceKey?: string): IndexedPage[] {
    if (spaceKey) {
      return this.stmts.getByTypeAndSpace.all(pageType, spaceKey) as IndexedPage[];
    }
    return this.stmts.getByType.all(pageType) as IndexedPage[];
  }

  /** Lightweight version — returns title/labels/preview, no full content. */
  getPageSummaries(pageType: PageType, spaceKey?: string, source?: string): PageSummary[] {
    if (source) {
      return this.stmts.summariesBySource.all(source, pageType) as PageSummary[];
    }
    if (spaceKey) {
      return this.stmts.summariesByTypeAndSpace.all(pageType, spaceKey) as PageSummary[];
    }
    return this.stmts.summariesByType.all(pageType) as PageSummary[];
  }

  /** Get aggregate stats: total pages, breakdown by type, space, and source. */
  getStats(): {
    total: number;
    byType: Record<string, number>;
    bySpace: Record<string, number>;
    bySource: Record<string, number>;
  } {
    // Cast needed: Statement.all() returns unknown[]; row shape matches our UNION ALL query
    const rows = this.stmts.stats.all() as StatsRow[];
    let total = 0;
    const byType: Record<string, number> = {};
    const bySpace: Record<string, number> = {};
    const bySource: Record<string, number> = {};

    for (const row of rows) {
      if (row.group_type === "total") total = row.count;
      else if (row.group_type === "type") byType[row.key] = row.count;
      else if (row.group_type === "space") bySpace[row.key] = row.count;
      else if (row.group_type === "source") bySource[row.key] = row.count;
    }

    return { total, byType, bySpace, bySource };
  }

  /** Read a config value from the key-value store. */
  getConfig(key: string): string | undefined {
    // Cast needed: Statement.get() returns unknown; row shape matches SELECT value FROM config
    const row = this.stmts.getConfig.get(key) as ConfigRow | undefined;
    return row?.value;
  }

  /** Write a config value to the key-value store. */
  setConfig(key: string, value: string): void {
    this.stmts.setConfig.run(key, value);
  }

  /** Delete all pages in a space. Returns the count of deleted pages. */
  clearSpace(spaceKey: string): number {
    // Cast needed: Statement.get() returns unknown; row is SELECT COUNT(*) as count
    const count = (this.stmts.countBySpaceKey.get(spaceKey) as CountRow).count;
    this.stmts.deleteBySpace.run(spaceKey);
    return count;
  }

  /** Delete all pages from a given source. Returns the count of deleted pages. */
  clearSource(source: string): number {
    const count = (this.stmts.countBySource.get(source) as CountRow).count;
    this.stmts.deleteBySource.run(source);
    return count;
  }

  /** Store chunks for a page, replacing any existing chunks. */
  upsertChunks(
    pageId: string,
    chunks: { breadcrumb: string; heading: string; depth: number; content: string; index: number }[],
  ): void {
    this.db.transaction(() => {
      this.stmts.deleteChunksByPage.run(pageId);
      for (const chunk of chunks) {
        this.stmts.insertChunk.run(pageId, chunk.breadcrumb, chunk.heading, chunk.depth, chunk.content, chunk.index);
      }
    })();
  }

  /** Search chunks — returns focused sections with heading breadcrumbs. */
  searchChunks(query: string, options?: SearchFilter): ChunkSearchResult[] {
    return searchChunks(query, options ?? {}, this.searchStmts);
  }

  // ── Sprint methods ──

  /** Insert or update a single sprint. */
  upsertSprint(sprint: CachedSprint): void {
    this.stmts.upsertSprint.run(
      sprint.id,
      sprint.board_id,
      sprint.name,
      sprint.state,
      sprint.goal,
      sprint.start_date,
      sprint.end_date,
      sprint.complete_date,
      sprint.cached_at,
    );
  }

  /** Batch upsert sprints in a single transaction. */
  upsertSprints(sprints: CachedSprint[]): void {
    this.db.transaction(() => {
      for (const sprint of sprints) {
        this.upsertSprint(sprint);
      }
    })();
  }

  /** Retrieve a sprint by ID. */
  getSprint(id: string): CachedSprint | undefined {
    return this.stmts.getSprintById.get(id) as CachedSprint | undefined;
  }

  /** Get sprints for a board, optionally filtered by state. */
  getSprintsByBoard(boardId: string, state?: string): CachedSprint[] {
    if (state) {
      return this.stmts.getSprintsByBoardAndState.all(boardId, state) as CachedSprint[];
    }
    return this.stmts.getSprintsByBoard.all(boardId) as CachedSprint[];
  }

  // ── Changelog methods ──

  /** Batch upsert changelog entries in a transaction. */
  upsertChangelog(entries: CachedChangelogEntry[]): void {
    this.db.transaction(() => {
      for (const entry of entries) {
        this.stmts.insertChangelog.run(
          entry.id,
          entry.issue_key,
          entry.author_name,
          entry.author_id,
          entry.created,
          entry.field,
          entry.from_value,
          entry.to_value,
          entry.cached_at,
        );
      }
    })();
  }

  /** Get all changelog entries for an issue, sorted by created date. */
  getChangelog(issueKey: string): CachedChangelogEntry[] {
    return this.stmts.getChangelogByIssue.all(issueKey) as CachedChangelogEntry[];
  }

  /** Get changelog entries for an issue filtered by field name. */
  getChangelogByField(issueKey: string, field: string): CachedChangelogEntry[] {
    return this.stmts.getChangelogByIssueAndField.all(issueKey, field) as CachedChangelogEntry[];
  }

  /** Remove all changelog entries for an issue. */
  clearChangelogForIssue(issueKey: string): void {
    this.stmts.deleteChangelogByIssue.run(issueKey);
  }

  // ── Stale/recent page queries ──

  /** Get pages with updated_at older than cutoff, optionally filtered. */
  getStalePages(cutoffDate: string, opts?: { spaceKey?: string; pageType?: string; source?: string }): IndexedPage[] {
    if (opts?.pageType && opts?.spaceKey) {
      return this.stmts.getStalePagesAll.all(cutoffDate, opts.pageType, opts.spaceKey) as IndexedPage[];
    }
    if (opts?.pageType) {
      return this.stmts.getStalePagesTyped.all(cutoffDate, opts.pageType) as IndexedPage[];
    }
    if (opts?.spaceKey) {
      return this.stmts.getStalePagesFiltered.all(cutoffDate, opts.spaceKey) as IndexedPage[];
    }
    return this.stmts.getStalePages.all(cutoffDate) as IndexedPage[];
  }

  /** Get pages indexed after the given timestamp, optionally filtered by source. */
  getRecentlyIndexed(since: string, source?: string): IndexedPage[] {
    if (source) {
      return this.stmts.getRecentlyIndexedBySource.all(since, source) as IndexedPage[];
    }
    return this.stmts.getRecentlyIndexed.all(since) as IndexedPage[];
  }

  // ── Team rules methods ──

  /** Insert or update a single team rule. */
  upsertTeamRule(rule: {
    category: string;
    rule_key: string;
    issue_type: string | null;
    rule_value: string;
    confidence: number;
    sample_size: number;
  }): void {
    this.stmts.upsertTeamRule.run(
      rule.category,
      rule.rule_key,
      rule.issue_type,
      rule.rule_value,
      rule.confidence,
      rule.sample_size,
      new Date().toISOString(),
    );
  }

  /** Batch upsert team rules in a single transaction. */
  upsertTeamRules(
    rules: Array<{
      category: string;
      rule_key: string;
      issue_type: string | null;
      rule_value: string;
      confidence: number;
      sample_size: number;
    }>,
  ): void {
    this.db.transaction(() => {
      for (const rule of rules) {
        this.upsertTeamRule(rule);
      }
    })();
  }

  /** Query team rules with optional filters. */
  getTeamRules(category?: string, issueType?: string): StoredTeamRule[] {
    if (category && issueType) {
      return this.stmts.getTeamRulesByCategoryAndType.all(category, issueType) as StoredTeamRule[];
    }
    if (category) {
      return this.stmts.getTeamRulesByCategory.all(category) as StoredTeamRule[];
    }
    if (issueType) {
      return this.stmts.getTeamRulesByIssueType.all(issueType) as StoredTeamRule[];
    }
    return this.stmts.getAllTeamRules.all() as StoredTeamRule[];
  }

  /** Delete all team rules (for re-analysis). */
  clearTeamRules(): void {
    this.stmts.deleteAllTeamRules.run();
  }

  // ── Backlog analysis methods ──

  /** Get the most recent backlog analysis record. */
  getLatestAnalysis(): BacklogAnalysisRecord | null {
    return (this.stmts.getLatestAnalysis.get() as BacklogAnalysisRecord) ?? null;
  }

  /** Record a backlog analysis run. */
  recordAnalysis(record: Omit<BacklogAnalysisRecord, "id">): void {
    this.stmts.insertAnalysis.run(
      record.project_key,
      record.tickets_fetched,
      record.tickets_quality_passed,
      record.quality_threshold,
      record.rules_extracted,
      record.jql_used,
      record.analyzed_at,
    );
  }

  rebuildFts(): void {
    this.db.transaction(() => {
      this.db.exec("DELETE FROM pages_fts");
      this.db.exec(`
        INSERT INTO pages_fts(rowid, title, content, labels)
        SELECT rowid, title, content, labels FROM pages
      `);
      this.db.exec("DELETE FROM chunks_fts");
      this.db.exec(`
        INSERT INTO chunks_fts(rowid, heading, breadcrumb, content)
        SELECT id, heading, breadcrumb, content FROM chunks
      `);
    })();
  }

  /** Return the database file size in bytes, or 0 if the file doesn't exist. */
  getDbSizeBytes(): number {
    try {
      return fs.statSync(this.dbPath).size;
    } catch {
      return 0;
    }
  }

  /**
   * Run PRAGMA optimize (always) and VACUUM (only when DB > 100 MB).
   * Safe to call periodically or on shutdown.
   */
  optimize(): void {
    this.db.exec("PRAGMA optimize");
    if (this.getDbSizeBytes() > VACUUM_THRESHOLD_BYTES) {
      this.db.exec("VACUUM");
    }
  }

  /** Optimize and close the database connection. Call on shutdown. */
  close(): void {
    this.optimize();
    this.db.close();
  }
}
