/**
 * KnowledgeBase mixin methods for team insights and backlog analysis.
 * Extracted from db.ts to keep files under the 400-line limit.
 */
import type { PreparedStatements } from "./db-schema.js";
import type { BacklogAnalysisRecord, StoredTeamRule } from "./db-types.js";

export type InsightRow = {
  category: string;
  insight_key: string;
  data: string;
  sample_size: number;
  confidence: number;
  updated_at: string;
};

/** Insert or update a single team insight. */
export function upsertInsight(
  stmts: PreparedStatements,
  category: string,
  key: string,
  data: unknown,
  sampleSize: number,
  confidence: number,
): void {
  stmts.upsertInsight.run(category, key, JSON.stringify(data), sampleSize, confidence);
}

/** Batch upsert team insights in a single transaction. */
export function upsertInsightsBatch(
  db: { transaction: (fn: () => void) => () => void },
  stmts: PreparedStatements,
  insights: Array<{ category: string; key: string; data: unknown; sampleSize: number; confidence: number }>,
): void {
  db.transaction(() => {
    for (const i of insights) {
      upsertInsight(stmts, i.category, i.key, i.data, i.sampleSize, i.confidence);
    }
  })();
}

/** Get all insights for a category. */
export function getInsights(stmts: PreparedStatements, category: string): InsightRow[] {
  return stmts.getInsightsByCategory.all(category) as InsightRow[];
}

/** Get all team insights across all categories. */
export function getAllInsights(stmts: PreparedStatements): InsightRow[] {
  return stmts.getAllInsights.all() as InsightRow[];
}

/** Clear insights, optionally filtered by category. */
export function clearInsights(stmts: PreparedStatements, category?: string): void {
  if (category) {
    stmts.deleteInsightsByCategory.run(category);
  } else {
    stmts.deleteAllInsights.run();
  }
}

// ── Team rules ──

export interface TeamRuleInput {
  category: string;
  rule_key: string;
  issue_type: string | null;
  rule_value: string;
  confidence: number;
  sample_size: number;
}

export function upsertTeamRule(stmts: PreparedStatements, rule: TeamRuleInput): void {
  stmts.upsertTeamRule.run(
    rule.category,
    rule.rule_key,
    rule.issue_type,
    rule.rule_value,
    rule.confidence,
    rule.sample_size,
    new Date().toISOString(),
  );
}

export function upsertTeamRulesBatch(
  db: { transaction: (fn: () => void) => () => void },
  stmts: PreparedStatements,
  rules: TeamRuleInput[],
): void {
  db.transaction(() => {
    for (const rule of rules) {
      upsertTeamRule(stmts, rule);
    }
  })();
}

export function getTeamRules(stmts: PreparedStatements, category?: string, issueType?: string): StoredTeamRule[] {
  if (category && issueType) return stmts.getTeamRulesByCategoryAndType.all(category, issueType) as StoredTeamRule[];
  if (category) return stmts.getTeamRulesByCategory.all(category) as StoredTeamRule[];
  if (issueType) return stmts.getTeamRulesByIssueType.all(issueType) as StoredTeamRule[];
  return stmts.getAllTeamRules.all() as StoredTeamRule[];
}

export function clearTeamRules(stmts: PreparedStatements): void {
  stmts.deleteAllTeamRules.run();
}

// ── Backlog analysis ──

/** Get the most recent backlog analysis record. */
export function getLatestAnalysis(stmts: PreparedStatements): BacklogAnalysisRecord | null {
  return (stmts.getLatestAnalysis.get() as BacklogAnalysisRecord) ?? null;
}

/** Record a backlog analysis run. */
export function recordAnalysis(stmts: PreparedStatements, record: Omit<BacklogAnalysisRecord, "id">): void {
  stmts.insertAnalysis.run(
    record.project_key,
    record.tickets_fetched,
    record.tickets_quality_passed,
    record.quality_threshold,
    record.rules_extracted,
    record.jql_used,
    record.analyzed_at,
  );
}
