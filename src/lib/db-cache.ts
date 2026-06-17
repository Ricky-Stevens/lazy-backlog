/**
 * Sprint / changelog / stale-page / recently-indexed helpers split out of
 * db.ts to keep the parent file under the 400-line project cap. All functions
 * here are stateless — they take the prepared-statement bag from `db-schema`
 * and operate on it. Re-exported from `db.ts` so callers' import paths are
 * unaffected.
 */

import type { PreparedStatements } from "./db-schema-statements.js";
import type { CachedChangelogEntry, CachedSprint, IndexedPage } from "./db-types.js";
import type { SqliteDatabase } from "./sqlite.js";

// ── Sprint cache ──────────────────────────────────────────────────────────

export function upsertSprintRow(stmts: PreparedStatements, sprint: CachedSprint): void {
  stmts.upsertSprint.run(
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

export function upsertSprintRows(db: SqliteDatabase, stmts: PreparedStatements, sprints: CachedSprint[]): void {
  db.transaction(() => {
    for (const sprint of sprints) {
      upsertSprintRow(stmts, sprint);
    }
  })();
}

export function getSprintRow(stmts: PreparedStatements, id: string): CachedSprint | undefined {
  return stmts.getSprintById.get(id) as CachedSprint | undefined;
}

export function getSprintsByBoardRows(stmts: PreparedStatements, boardId: string, state?: string): CachedSprint[] {
  if (state) {
    return stmts.getSprintsByBoardAndState.all(boardId, state) as CachedSprint[];
  }
  return stmts.getSprintsByBoard.all(boardId) as CachedSprint[];
}

// ── Changelog cache ───────────────────────────────────────────────────────

export function upsertChangelogRows(
  db: SqliteDatabase,
  stmts: PreparedStatements,
  entries: CachedChangelogEntry[],
): void {
  db.transaction(() => {
    for (const entry of entries) {
      stmts.insertChangelog.run(
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

export function getChangelogRows(stmts: PreparedStatements, issueKey: string): CachedChangelogEntry[] {
  return stmts.getChangelogByIssue.all(issueKey) as CachedChangelogEntry[];
}

export function getChangelogRowsByField(
  stmts: PreparedStatements,
  issueKey: string,
  field: string,
): CachedChangelogEntry[] {
  return stmts.getChangelogByIssueAndField.all(issueKey, field) as CachedChangelogEntry[];
}

export function clearChangelogForIssueRow(stmts: PreparedStatements, issueKey: string): void {
  stmts.deleteChangelogByIssue.run(issueKey);
}

// ── Stale / recently-indexed page lookups ─────────────────────────────────

export interface StalePageOptions {
  spaceKey?: string;
  pageType?: string;
  source?: string;
}

export function getStalePageRows(
  stmts: PreparedStatements,
  cutoffDate: string,
  opts?: StalePageOptions,
): IndexedPage[] {
  if (opts?.pageType && opts?.spaceKey) {
    return stmts.getStalePagesAll.all(cutoffDate, opts.pageType, opts.spaceKey) as IndexedPage[];
  }
  if (opts?.pageType) {
    return stmts.getStalePagesTyped.all(cutoffDate, opts.pageType) as IndexedPage[];
  }
  if (opts?.spaceKey) {
    return stmts.getStalePagesFiltered.all(cutoffDate, opts.spaceKey) as IndexedPage[];
  }
  return stmts.getStalePages.all(cutoffDate) as IndexedPage[];
}

export function getRecentlyIndexedRows(stmts: PreparedStatements, since: string, source?: string): IndexedPage[] {
  if (source) {
    return stmts.getRecentlyIndexedBySource.all(since, source) as IndexedPage[];
  }
  return stmts.getRecentlyIndexed.all(since) as IndexedPage[];
}
