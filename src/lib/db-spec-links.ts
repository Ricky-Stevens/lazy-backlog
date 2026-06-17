/**
 * KnowledgeBase mixin functions for spec ↔ epic links (Stage D).
 * Extracted from db.ts to keep that file under the 400-line limit.
 *
 * These helpers take the prepared statements bag from db-schema.ts and execute
 * idempotent CRUD against the `epic_spec_links` table. Date stamping happens
 * here (not in SQL) so tests can mock the clock if needed.
 */
import type { PreparedStatements } from "./db-schema.js";
import type { EpicSpecLink } from "./db-types.js";

/**
 * Input shape for upserting a spec link. `source` defaults to "confluence" so
 * callers indexing other knowledge sources (future github/gdocs connectors)
 * can override.
 */
export interface UpsertEpicSpecLinkInput {
  issueKey: string;
  pageId: string;
  source?: string;
  pageTitle?: string | null;
  pageUrl?: string | null;
}

/** Insert or refresh the link between a generated Jira issue and its source page. */
export function upsertEpicSpecLink(stmts: PreparedStatements, input: UpsertEpicSpecLinkInput): void {
  stmts.upsertEpicSpecLink.run(
    input.issueKey,
    input.pageId,
    input.source ?? "confluence",
    input.pageTitle ?? null,
    input.pageUrl ?? null,
    new Date().toISOString(),
  );
}

/** All spec links for a given Jira issue key. */
export function getSpecLinksByIssue(stmts: PreparedStatements, issueKey: string): EpicSpecLink[] {
  return stmts.getSpecLinksByIssue.all(issueKey) as EpicSpecLink[];
}

/** All spec links for a given Confluence page id. */
export function getSpecLinksByPage(stmts: PreparedStatements, pageId: string): EpicSpecLink[] {
  return stmts.getSpecLinksByPage.all(pageId) as EpicSpecLink[];
}

/** All stored spec links, newest first. */
export function getAllSpecLinks(stmts: PreparedStatements): EpicSpecLink[] {
  return stmts.getAllSpecLinks.all() as EpicSpecLink[];
}

/** Flag a spec as stale. Returns true when a row changed. */
export function flagSpecStale(stmts: PreparedStatements, issueKey: string, pageId: string): boolean {
  const info = stmts.markSpecLinkStale.run(new Date().toISOString(), issueKey, pageId) as {
    changes?: number;
  };
  return (info.changes ?? 0) > 0;
}

/** Record that the linked epic has completed. Returns true when a row changed. */
export function markEpicCompleted(stmts: PreparedStatements, issueKey: string, pageId: string): boolean {
  const info = stmts.markSpecLinkCompleted.run(new Date().toISOString(), issueKey, pageId) as {
    changes?: number;
  };
  return (info.changes ?? 0) > 0;
}

/** Remove a spec link. Returns true when a row was deleted. */
export function deleteSpecLink(stmts: PreparedStatements, issueKey: string, pageId: string): boolean {
  const info = stmts.deleteSpecLink.run(issueKey, pageId) as { changes?: number };
  return (info.changes ?? 0) > 0;
}
