import type { PageType } from "../config/schema.js";

// ── Domain types ───────────────────────────────────────────────────────────

export interface IndexedPage {
  id: string;
  space_key: string;
  title: string;
  url: string | null;
  content: string;
  page_type: PageType;
  labels: string; // JSON array
  parent_id: string | null;
  author_id: string | null;
  created_at: string | null;
  updated_at: string | null;
  indexed_at: string;
  source: string;
}

/** Lightweight projection — no content body. */
export interface PageSummary {
  id: string;
  space_key: string;
  title: string;
  url: string | null;
  page_type: PageType;
  labels: string;
  updated_at: string | null;
  content_preview: string;
  source: string;
}

export interface SearchResult {
  id: string;
  space_key: string;
  title: string;
  url: string | null;
  snippet: string;
  page_type: PageType;
  labels: string;
  rank: number;
  source: string;
}

export interface ChunkSearchResult {
  chunk_id: number;
  page_id: string;
  breadcrumb: string;
  heading: string;
  depth: number;
  space_key: string;
  page_title: string;
  url: string | null;
  page_type: PageType;
  labels: string;
  snippet: string;
  rank: number;
  source: string;
}

export interface CachedSprint {
  id: string;
  board_id: string;
  name: string;
  state: string;
  goal: string | null;
  start_date: string | null;
  end_date: string | null;
  complete_date: string | null;
  cached_at: string;
}

export interface CachedChangelogEntry {
  id: string;
  issue_key: string;
  author_name: string | null;
  author_id: string | null;
  created: string;
  field: string;
  from_value: string | null;
  to_value: string | null;
  cached_at: string;
}

export interface StoredTeamRule {
  id: number;
  category: string;
  rule_key: string;
  issue_type: string | null;
  rule_value: string;
  confidence: number;
  sample_size: number;
  updated_at: string;
}

export interface BacklogAnalysisRecord {
  id: number;
  project_key: string;
  tickets_fetched: number;
  tickets_quality_passed: number;
  quality_threshold: number;
  rules_extracted: number;
  jql_used: string;
  analyzed_at: string;
}

/** Filter options shared by page and chunk search. */
export interface SearchFilter {
  source?: string;
  pageType?: string;
  spaceKey?: string;
  limit?: number;
}
