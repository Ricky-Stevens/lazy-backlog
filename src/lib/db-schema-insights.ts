/**
 * Prepared statements for team rules, backlog analysis, and team insights.
 * Extracted from db-schema.ts to keep that file under the 400-line cap.
 *
 * Schema (CREATE TABLE) for these tables still lives in db-schema.ts's
 * `initSchema()`. This module only provides the statement preparations because
 * they are bulky and natural to colocate with their helper functions in
 * db-insights.ts.
 */
import type { SqliteDatabase, Statement } from "./sqlite.js";

/** Prepared statements for team rules + backlog analysis + team insights. */
export interface InsightsStatements {
  upsertTeamRule: Statement;
  getAllTeamRules: Statement;
  getTeamRulesByCategory: Statement;
  getTeamRulesByCategoryAndType: Statement;
  getTeamRulesByIssueType: Statement;
  deleteAllTeamRules: Statement;
  insertAnalysis: Statement;
  getLatestAnalysis: Statement;
  upsertInsight: Statement;
  getInsightsByCategory: Statement;
  getAllInsights: Statement;
  deleteInsightsByCategory: Statement;
  deleteAllInsights: Statement;
}

/** Pre-prepare all team-rule / analysis / insight statements. */
export function prepareInsightsStatements(db: SqliteDatabase): InsightsStatements {
  return {
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
    // Team insight statements
    upsertInsight: db.prepare(
      `INSERT OR REPLACE INTO team_insights (category, insight_key, data, sample_size, confidence, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`,
    ),
    getInsightsByCategory: db.prepare("SELECT * FROM team_insights WHERE category = ?"),
    getAllInsights: db.prepare("SELECT * FROM team_insights"),
    deleteInsightsByCategory: db.prepare("DELETE FROM team_insights WHERE category = ?"),
    deleteAllInsights: db.prepare("DELETE FROM team_insights"),
  };
}
