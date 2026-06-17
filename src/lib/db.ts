import fs from "node:fs";
import path from "node:path";
import type { PageType } from "../config/schema.js";
import {
  clearChangelogForIssueRow,
  getChangelogRows,
  getChangelogRowsByField,
  getRecentlyIndexedRows,
  getSprintRow,
  getSprintsByBoardRows,
  getStalePageRows,
  type StalePageOptions,
  upsertChangelogRows,
  upsertSprintRow,
  upsertSprintRows,
} from "./db-cache.js";
import {
  clearInsights as clearInsightsHelper,
  clearTeamRules as clearTeamRulesHelper,
  getAllInsights as getAllInsightsHelper,
  getInsights as getInsightsHelper,
  getLatestAnalysis as getLatestAnalysisHelper,
  getTeamRules as getTeamRulesHelper,
  type InsightRow,
  recordAnalysis as recordAnalysisHelper,
  type TeamRuleInput,
  upsertInsight as upsertInsightHelper,
  upsertInsightsBatch,
  upsertTeamRule as upsertTeamRuleHelper,
  upsertTeamRulesBatch,
} from "./db-insights.js";
import { type PageWithChunks, rebuildFtsTx, upsertPagesWithChunksTx } from "./db-pages.js";
import {
  configurePragmas,
  initSchema,
  migrateSchema,
  type PreparedStatements,
  prepareStatements,
} from "./db-schema.js";
import { prepareSearchVariants, type SearchStatements, searchChunks, searchPages } from "./db-search.js";
import {
  deleteSpecLink as deleteSpecLinkHelper,
  flagSpecStale as flagSpecStaleHelper,
  getAllSpecLinks as getAllSpecLinksHelper,
  getSpecLinksByIssue as getSpecLinksByIssueHelper,
  getSpecLinksByPage as getSpecLinksByPageHelper,
  markEpicCompleted as markEpicCompletedHelper,
  type UpsertEpicSpecLinkInput,
  upsertEpicSpecLink as upsertEpicSpecLinkHelper,
} from "./db-spec-links.js";
import type {
  BacklogAnalysisRecord,
  CachedChangelogEntry,
  CachedSprint,
  ChunkSearchResult,
  EpicSpecLink,
  IndexedPage,
  PageSummary,
  SearchFilter,
  SearchResult,
  StoredTeamRule,
} from "./db-types.js";
import { Database, type SqliteDatabase } from "./sqlite.js";

export * from "./db-insights.js";
export type { PageWithChunks } from "./db-pages.js";
export * from "./db-search.js";
export * from "./db-spec-links.js";
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
interface ReindexFingerprintRow {
  id: string;
  updated_at: string | null;
  content_hash: string | null;
}

export class KnowledgeBase {
  private readonly db: SqliteDatabase;
  private readonly dbPath: string;
  private readonly stmts: PreparedStatements;
  private readonly searchStmts: SearchStatements;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    this.db = new Database(dbPath);
    configurePragmas(this.db);
    initSchema(this.db);
    migrateSchema(this.db);
    this.stmts = prepareStatements(this.db);
    this.searchStmts = prepareSearchVariants(this.db);
  }

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
      page.content_hash,
    );
  }

  upsertMany(pages: IndexedPage[]): void {
    this.db.transaction(() => {
      for (const page of pages) {
        this.upsertPage(page);
      }
    })();
  }

  /**
   * Decide whether a page must be re-indexed. Returns true when:
   * - the page has never been indexed (no row);
   * - we cannot determine equivalence (missing both fingerprints);
   * - the content hash differs from the stored hash (content, title, or labels
   *   changed even if the source's `updated_at` was not bumped);
   * - the `updated_at` advanced beyond what we have on disk.
   *
   * `contentHash` is optional for callers that haven't migrated yet; when
   * omitted we fall back to the legacy updated_at-only behaviour.
   */
  needsReindex(pageId: string, remoteUpdatedAt: string | undefined, contentHash?: string): boolean {
    const row = this.stmts.getReindexFingerprint.get(pageId) as ReindexFingerprintRow | undefined;
    if (!row) return true; // Not indexed yet
    if (contentHash !== undefined) {
      // Hash-aware path. A NULL stored hash means we haven't fingerprinted this
      // page yet (legacy row) — re-index so we backfill the hash.
      if (row.content_hash === null) return true;
      if (row.content_hash !== contentHash) return true;
      // Hashes match: content/labels/title unchanged. Still re-index if the
      // remote claims a newer updated_at (defensive — metadata may have moved
      // without affecting the hash, e.g. version numbers, parent ids).
      if (remoteUpdatedAt && row.updated_at !== remoteUpdatedAt) return true;
      return false;
    }
    if (!remoteUpdatedAt) return true; // Can't compare, re-index to be safe
    return row.updated_at !== remoteUpdatedAt;
  }

  search(query: string, options?: SearchFilter): SearchResult[] {
    return searchPages(query, options ?? {}, this.searchStmts);
  }

  getPage(id: string): IndexedPage | undefined {
    return this.stmts.getById.get(id) as IndexedPage | undefined;
  }

  getPagesByType(pageType: PageType, spaceKey?: string): IndexedPage[] {
    if (spaceKey) {
      return this.stmts.getByTypeAndSpace.all(pageType, spaceKey) as IndexedPage[];
    }
    return this.stmts.getByType.all(pageType) as IndexedPage[];
  }

  getPageSummaries(pageType: PageType, spaceKey?: string, source?: string): PageSummary[] {
    if (source) {
      return this.stmts.summariesBySource.all(source, pageType) as PageSummary[];
    }
    if (spaceKey) {
      return this.stmts.summariesByTypeAndSpace.all(pageType, spaceKey) as PageSummary[];
    }
    return this.stmts.summariesByType.all(pageType) as PageSummary[];
  }

  getStats(): {
    total: number;
    byType: Record<string, number>;
    bySpace: Record<string, number>;
    bySource: Record<string, number>;
  } {
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

  getConfig(key: string): string | undefined {
    const row = this.stmts.getConfig.get(key) as ConfigRow | undefined;
    return row?.value;
  }

  setConfig(key: string, value: string): void {
    this.stmts.setConfig.run(key, value);
  }

  clearSpace(spaceKey: string): number {
    const count = (this.stmts.countBySpaceKey.get(spaceKey) as CountRow).count;
    this.stmts.deleteBySpace.run(spaceKey);
    return count;
  }

  clearSource(source: string): number {
    const count = (this.stmts.countBySource.get(source) as CountRow).count;
    this.stmts.deleteBySource.run(source);
    return count;
  }

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

  /** See `upsertPagesWithChunksTx` in `db-pages.ts` for full notes. */
  upsertPagesWithChunks(entries: PageWithChunks[]): number {
    return upsertPagesWithChunksTx(this.db, this.stmts, (p) => this.upsertPage(p), entries);
  }

  searchChunks(query: string, options?: SearchFilter): ChunkSearchResult[] {
    return searchChunks(query, options ?? {}, this.searchStmts);
  }

  upsertSprint(sprint: CachedSprint): void {
    upsertSprintRow(this.stmts, sprint);
  }

  upsertSprints(sprints: CachedSprint[]): void {
    upsertSprintRows(this.db, this.stmts, sprints);
  }

  getSprint(id: string): CachedSprint | undefined {
    return getSprintRow(this.stmts, id);
  }

  getSprintsByBoard(boardId: string, state?: string): CachedSprint[] {
    return getSprintsByBoardRows(this.stmts, boardId, state);
  }

  upsertChangelog(entries: CachedChangelogEntry[]): void {
    upsertChangelogRows(this.db, this.stmts, entries);
  }

  getChangelog(issueKey: string): CachedChangelogEntry[] {
    return getChangelogRows(this.stmts, issueKey);
  }

  getChangelogByField(issueKey: string, field: string): CachedChangelogEntry[] {
    return getChangelogRowsByField(this.stmts, issueKey, field);
  }

  clearChangelogForIssue(issueKey: string): void {
    clearChangelogForIssueRow(this.stmts, issueKey);
  }

  getStalePages(cutoffDate: string, opts?: StalePageOptions): IndexedPage[] {
    return getStalePageRows(this.stmts, cutoffDate, opts);
  }

  getRecentlyIndexed(since: string, source?: string): IndexedPage[] {
    return getRecentlyIndexedRows(this.stmts, since, source);
  }

  upsertTeamRule(rule: TeamRuleInput): void {
    upsertTeamRuleHelper(this.stmts, rule);
  }

  upsertTeamRules(rules: TeamRuleInput[]): void {
    upsertTeamRulesBatch(this.db, this.stmts, rules);
  }

  getTeamRules(category?: string, issueType?: string): StoredTeamRule[] {
    return getTeamRulesHelper(this.stmts, category, issueType);
  }

  clearTeamRules(): void {
    clearTeamRulesHelper(this.stmts);
  }

  getLatestAnalysis(): BacklogAnalysisRecord | null {
    return getLatestAnalysisHelper(this.stmts);
  }

  recordAnalysis(record: Omit<BacklogAnalysisRecord, "id">): void {
    recordAnalysisHelper(this.stmts, record);
  }

  upsertInsight(category: string, key: string, data: unknown, sampleSize: number, confidence: number): void {
    upsertInsightHelper(this.stmts, category, key, data, sampleSize, confidence);
  }

  upsertInsights(
    insights: Array<{ category: string; key: string; data: unknown; sampleSize: number; confidence: number }>,
  ): void {
    upsertInsightsBatch(this.db, this.stmts, insights);
  }

  getInsights(category: string): InsightRow[] {
    return getInsightsHelper(this.stmts, category);
  }

  getAllInsights(): InsightRow[] {
    return getAllInsightsHelper(this.stmts);
  }

  clearInsights(category?: string): void {
    clearInsightsHelper(this.stmts, category);
  }

  // ── Spec ↔ Epic links (Stage D) — implementations in db-spec-links.ts ──
  upsertEpicSpecLink(input: UpsertEpicSpecLinkInput): void {
    upsertEpicSpecLinkHelper(this.stmts, input);
  }
  getSpecLinksByIssue(issueKey: string): EpicSpecLink[] {
    return getSpecLinksByIssueHelper(this.stmts, issueKey);
  }
  getSpecLinksByPage(pageId: string): EpicSpecLink[] {
    return getSpecLinksByPageHelper(this.stmts, pageId);
  }
  getAllSpecLinks(): EpicSpecLink[] {
    return getAllSpecLinksHelper(this.stmts);
  }
  flagSpecStale(issueKey: string, pageId: string): boolean {
    return flagSpecStaleHelper(this.stmts, issueKey, pageId);
  }
  markEpicCompleted(issueKey: string, pageId: string): boolean {
    return markEpicCompletedHelper(this.stmts, issueKey, pageId);
  }
  deleteSpecLink(issueKey: string, pageId: string): boolean {
    return deleteSpecLinkHelper(this.stmts, issueKey, pageId);
  }

  /** See `rebuildFtsTx` in `db-pages.ts` for the notes. */
  rebuildFts(): void {
    rebuildFtsTx(this.db);
  }

  getDbSizeBytes(): number {
    try {
      return fs.statSync(this.dbPath).size;
    } catch {
      return 0;
    }
  }

  optimize(): void {
    this.db.exec("PRAGMA optimize");
    if (this.getDbSizeBytes() > VACUUM_THRESHOLD_BYTES) {
      this.db.exec("VACUUM");
    }
  }

  close(): void {
    this.optimize();
    this.db.close();
  }
}
