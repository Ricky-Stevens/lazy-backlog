/**
 * Helpers split out of `db.ts` to keep that file under the 400-line cap.
 * Barrel re-exported from `db.ts` so callers can continue importing from
 * `./db.js` without knowing about the split.
 */

import type { PreparedStatements } from "./db-schema.js";
import type { IndexedPage } from "./db-types.js";
import type { SqliteDatabase } from "./sqlite.js";

/** Pre-computed page-and-chunks bundle for the atomic upsert path. */
export interface PageWithChunks {
  page: IndexedPage;
  chunks: { breadcrumb: string; heading: string; depth: number; content: string; index: number }[];
}

/**
 * Atomically upsert pages AND their pre-computed chunks in a single
 * transaction (DB-3). Returns the number of pages written so callers can
 * attribute counters only on commit (DB-4).
 *
 * The spider previously upserted pages in one transaction and then re-opened
 * a new transaction per page to replace chunks; if anything threw between
 * those two writes (sqlite error mid-loop, malformed markdown surfacing in
 * chunkMarkdown, etc.) the freshly-committed page rows would carry a new
 * content_hash while the FTS chunk index still pointed at the OLD chunks —
 * permanently divergent because needsReindex() now reports "no change".
 *
 * CPU-heavy markdown chunking is performed by the caller BEFORE invoking
 * this method, so the transaction window stays I/O-bound.
 */
export function upsertPagesWithChunksTx(
  db: SqliteDatabase,
  stmts: PreparedStatements,
  upsertPage: (page: IndexedPage) => void,
  entries: PageWithChunks[],
): number {
  if (entries.length === 0) return 0;
  db.transaction(() => {
    for (const { page } of entries) upsertPage(page);
    for (const { page, chunks } of entries) {
      stmts.deleteChunksByPage.run(page.id);
      for (const chunk of chunks) {
        stmts.insertChunk.run(page.id, chunk.breadcrumb, chunk.heading, chunk.depth, chunk.content, chunk.index);
      }
    }
  })();
  return entries.length;
}

/**
 * Rebuild the FTS5 external-content shadow tables for `pages` and `chunks`
 * using the documented `delete-all` + `rebuild` maintenance commands (DB-7).
 *
 * SQLite docs (FTS5 §6) name these as the supported ops on content='pages'
 * / content='chunks' tables. Raw `DELETE FROM ..._fts` happens to work today,
 * but using the documented form keeps us forward-compatible with future FTS5
 * versions where the behaviour of DELETE on shadow tables is not guaranteed.
 */
export function rebuildFtsTx(db: SqliteDatabase): void {
  db.transaction(() => {
    db.exec("INSERT INTO pages_fts(pages_fts) VALUES('delete-all')");
    db.exec("INSERT INTO pages_fts(pages_fts) VALUES('rebuild')");
    db.exec("INSERT INTO chunks_fts(chunks_fts) VALUES('delete-all')");
    db.exec("INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')");
  })();
}
