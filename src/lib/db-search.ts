import type { ChunkSearchResult, SearchFilter, SearchResult } from "./db-types.js";
import type { SqliteDatabase, Statement } from "./sqlite.js";

// ── FTS5 sanitization ────────────────────────────────────────────────────────

/** Characters and operators that have special meaning in FTS5 MATCH syntax. */
const FTS5_SPECIAL_CHARS = /[*"()^+-]/g;
const FTS5_OPERATORS = /\b(NEAR|AND|OR|NOT)\b/gi;

/**
 * Sanitize user input for safe use in FTS5 MATCH queries.
 * Strips special characters, removes FTS5 operators, and wraps each
 * remaining word in double quotes for exact token matching.
 * Returns empty string for empty/whitespace-only input.
 */
export function sanitizeFtsQuery(query: string): string {
  const stripped = query.replaceAll(FTS5_SPECIAL_CHARS, " ").replaceAll(FTS5_OPERATORS, " ");
  const words = stripped.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return "";
  return words.map((w) => `"${w}"`).join(" ");
}

// ── Filter key + dynamic dispatch ────────────────────────────────────────────

/** Derive a canonical key from active filter fields. */
function filterKey(f: SearchFilter): string {
  const parts: string[] = [];
  if (f.source) parts.push("source");
  if (f.pageType) parts.push("type");
  if (f.spaceKey) parts.push("space");
  return parts.join("_") || "none";
}

/** Build the positional params array: [query, ...activeFilters, limit]. */
function buildParams(query: string, filter: SearchFilter, defaultLimit: number): unknown[] {
  const params: unknown[] = [query];
  if (filter.source) params.push(filter.source);
  if (filter.pageType) params.push(filter.pageType);
  if (filter.spaceKey) params.push(filter.spaceKey);
  params.push(filter.limit || defaultLimit);
  return params;
}

/**
 * Pick the correct pre-prepared statement variant and bind params.
 * Cast to T[] is required because the sqlite adapter's Statement.all()
 * returns `unknown[]` — the caller knows the row shape from the SQL.
 */
export function runFilteredQuery<T>(
  stmts: Record<string, Statement>,
  query: string,
  filter: SearchFilter,
  defaultLimit: number,
): T[] {
  const key = filterKey(filter);
  const stmt = stmts[key];
  if (!stmt) throw new Error(`No prepared statement for filter key: ${key}`);
  const params = buildParams(query, filter, defaultLimit);
  return stmt.all(...params) as T[];
}

/**
 * Execute an FTS5 query after sanitizing user input.
 * Returns empty array for empty/whitespace-only queries.
 */
export function ftsQuery<T>(
  query: string,
  filter: SearchFilter,
  defaultLimit: number,
  stmts: Record<string, Statement>,
): T[] {
  const sanitized = sanitizeFtsQuery(query);
  if (sanitized === "") return [];
  try {
    return runFilteredQuery<T>(stmts, sanitized, filter, defaultLimit);
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes("fts5")) {
      // Last-resort fallback: wrap entire sanitized query as a single phrase
      return runFilteredQuery<T>(stmts, `"${sanitized.replaceAll('"', '""')}"`, filter, defaultLimit);
    }
    throw err;
  }
}

// ── Search functions (delegated from KnowledgeBase) ─────────────────────────

/** All search statement variants keyed by filter combination, for pages and chunks. */
export interface SearchStatements {
  [key: string]: Statement;
}

/** Full-text search across indexed pages. Falls back to phrase escaping on FTS5 syntax errors. */
export function searchPages(query: string, options: SearchFilter, searchStmts: SearchStatements): SearchResult[] {
  // Extract page-level statements (keys without "chunk_" prefix)
  const pageStmts: Record<string, Statement> = {};
  for (const [k, v] of Object.entries(searchStmts)) {
    if (!k.startsWith("chunk_")) pageStmts[k] = v;
  }
  return ftsQuery<SearchResult>(query, options, 10, pageStmts);
}

/** Search chunks — returns focused sections with heading breadcrumbs. */
export function searchChunks(query: string, options: SearchFilter, searchStmts: SearchStatements): ChunkSearchResult[] {
  // Extract chunk-level statements (strip "chunk_" prefix)
  const chunkStmts: Record<string, Statement> = {};
  for (const [k, v] of Object.entries(searchStmts)) {
    if (k.startsWith("chunk_")) chunkStmts[k.slice(6)] = v;
  }
  return ftsQuery<ChunkSearchResult>(query, options, 5, chunkStmts);
}

// ── Filter clause combinations ───────────────────────────────────────────────

/** All possible filter keys and their SQL WHERE clause fragments. */
const FILTER_COMBOS: Array<{ key: string; clause: string }> = [
  { key: "none", clause: "" },
  { key: "source", clause: " AND p.source = ?" },
  { key: "type", clause: " AND p.page_type = ?" },
  { key: "space", clause: " AND p.space_key = ?" },
  { key: "source_type", clause: " AND p.source = ? AND p.page_type = ?" },
  { key: "source_space", clause: " AND p.source = ? AND p.space_key = ?" },
  { key: "type_space", clause: " AND p.page_type = ? AND p.space_key = ?" },
  { key: "source_type_space", clause: " AND p.source = ? AND p.page_type = ? AND p.space_key = ?" },
];

// ── Search statement preparation ────────────────────────────────────────────

/** Pre-prepare all 8 page + 8 chunk search filter combinations. */
export function prepareSearchVariants(db: SqliteDatabase): SearchStatements {
  // Page-level search (legacy, still useful for title/label matching)
  const pageBase = (filters: string) => `
    SELECT p.id, p.space_key, p.title, p.url, p.page_type, p.labels, p.source,
      snippet(pages_fts, 1, '**', '**', '…', 48) AS snippet, rank
    FROM pages_fts
    JOIN pages p ON p.rowid = pages_fts.rowid
    WHERE pages_fts MATCH ?${filters}
    ORDER BY rank LIMIT ?
  `;

  // Chunk-level search (primary — returns focused sections with breadcrumbs)
  const chunkBase = (filters: string) => `
    SELECT c.id as chunk_id, c.page_id, c.breadcrumb, c.heading, c.depth,
      p.space_key, p.title as page_title, p.url, p.page_type, p.labels, p.source,
      snippet(chunks_fts, 2, '**', '**', '…', 48) AS snippet, rank
    FROM chunks_fts
    JOIN chunks c ON c.id = chunks_fts.rowid
    JOIN pages p ON p.id = c.page_id
    WHERE chunks_fts MATCH ?${filters}
    ORDER BY rank LIMIT ?
  `;

  const stmts: SearchStatements = {};
  for (const { key, clause } of FILTER_COMBOS) {
    stmts[key] = db.prepare(pageBase(clause));
    stmts[`chunk_${key}`] = db.prepare(chunkBase(clause));
  }
  return stmts;
}
