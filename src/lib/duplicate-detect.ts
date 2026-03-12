/**
 * Duplicate detection — Jaccard similarity over tokenized issue summaries.
 *
 * Uses JiraClient.searchIssues to find candidates and scores them
 * against the proposed ticket text.
 */

import type { JiraClient } from "./jira.js";

// ─── Types ──────────────────────────────────────────────────────────────────────

export interface DuplicateCandidate {
  issueKey: string;
  summary: string;
  status: string;
  similarity: number; // 0.0–1.0
}

// ─── Stop words ─────────────────────────────────────────────────────────────────

const DEFAULT_STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "shall",
  "should",
  "may",
  "might",
  "can",
  "could",
  "must",
  "to",
  "of",
  "in",
  "for",
  "on",
  "with",
  "at",
  "by",
  "from",
  "as",
  "into",
  "through",
  "during",
  "before",
  "after",
  "above",
  "below",
  "between",
  "out",
  "off",
  "over",
  "under",
  "again",
  "then",
  "once",
  "all",
  "each",
  "every",
  "both",
  "few",
  "more",
  "most",
  "other",
  "some",
  "such",
  "no",
  "not",
  "only",
  "same",
  "so",
  "than",
  "too",
  "very",
  "just",
  "because",
  "but",
  "and",
  "or",
  "if",
  "while",
  "that",
  "this",
  "these",
  "those",
  "it",
  "its",
  "set",
  "up",
  "using",
  "via",
  "any",
  "new",
]);

// ─── Core functions ─────────────────────────────────────────────────────────────

/** Lowercase, split on non-alphanumeric, and filter stop words. */
export function tokenize(text: string, stopWords: Set<string> = DEFAULT_STOP_WORDS): Set<string> {
  const tokens = text
    .split(/[^a-zA-Z0-9]+/)
    .map((w) => w.toLowerCase())
    .filter((w) => w.length > 2 && !stopWords.has(w));
  return new Set(tokens);
}

/** Jaccard similarity: |A ∩ B| / |A ∪ B|. Returns 0 when both sets are empty. */
export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Search Jira for potential duplicates of the given summary + description.
 *
 * 1. Extract top 3 keywords from the input text
 * 2. Run a JQL text search scoped to the project
 * 3. Score each result with Jaccard similarity
 * 4. Return candidates above `threshold`, sorted descending
 */
export async function findDuplicates(
  jira: JiraClient,
  summary: string,
  description: string | undefined,
  projectKey: string,
  threshold = 0.3,
): Promise<DuplicateCandidate[]> {
  const inputText = description ? `${summary} ${description}` : summary;
  const inputTokens = tokenize(inputText);
  if (inputTokens.size === 0) return [];

  // Pick top 3 keywords (longest first — more specific)
  const keywords = [...inputTokens].sort((a, b) => b.length - a.length).slice(0, 3);
  const searchText = keywords.join(" ");

  const jql = `project = "${projectKey}" AND text ~ "${searchText}" ORDER BY updated DESC`;

  const { issues } = await jira.searchIssues(jql, undefined, 20);

  const candidates: DuplicateCandidate[] = [];
  for (const issue of issues) {
    const candidateTokens = tokenize(issue.fields.summary);
    const similarity = jaccardSimilarity(inputTokens, candidateTokens);
    if (similarity >= threshold) {
      candidates.push({
        issueKey: issue.key,
        summary: issue.fields.summary,
        status: issue.fields.status?.name ?? "Unknown",
        similarity,
      });
    }
  }

  return candidates.sort((a, b) => b.similarity - a.similarity);
}
