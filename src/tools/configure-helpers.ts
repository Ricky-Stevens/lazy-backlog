import type { KnowledgeBase } from "../lib/db.js";
import type { JiraClient } from "../lib/jira.js";
import { analyzeTeamInsights } from "../lib/team-insights.js";
import type { TicketData } from "../lib/team-rules.js";

type AnalyzeBacklogFn = (
  tickets: TicketData[],
  threshold: number,
) => {
  rules: Array<{
    category: string;
    rule_key: string;
    issue_type: string | null;
    rule_value: string;
    confidence: number;
    sample_size: number;
  }>;
  totalTickets: number;
  qualityPassed: number;
  qualityFailed: number;
  avgQualityScore: number;
  rulesByCategory: Record<string, number>;
};
type AdfToTextFn = (adf: unknown) => string;

/** Dependencies injected by the caller so tests can mock them. */
export interface LearnDeps {
  jira: JiraClient;
  analyzeBacklog: AnalyzeBacklogFn;
  adfToText: AdfToTextFn;
}

// ── Ticket Fetching ──────────────────────────────────────────────────────────

function mapIssueToTicket(
  issue: { key: string; fields: Record<string, unknown> },
  spField: string | undefined,
  adfToText: AdfToTextFn,
): TicketData {
  const f = issue.fields as Record<string, unknown>;
  const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
  const nested = (key: string) => f[key] as Record<string, unknown> | undefined;
  const nestedName = (key: string, fallback: string): string => {
    const name = nested(key)?.name;
    return typeof name === "string" ? name : fallback;
  };
  return {
    key: issue.key,
    summary: str(f.summary),
    description: adfToText(f.description),
    issueType: nestedName("issuetype", "Unknown"),
    priority: nestedName("priority", "Medium"),
    storyPoints: ((spField ? f[spField] : null) ?? f.story_points ?? f.storyPoints ?? f.customfield_10016 ?? null) as
      | number
      | null,
    labels: (f.labels || []) as string[],
    components: ((f.components || []) as Array<{ name?: string }>).map((c) =>
      typeof c.name === "string" ? c.name : String(c),
    ),
    status: nestedName("status", "Unknown"),
    assignee: nested("assignee")?.displayName ? String(nested("assignee")?.displayName) : null,
    created: str(f.created),
    updated: str(f.updated),
    resolutionDate: typeof f.resolutiondate === "string" ? f.resolutiondate : null,
    changelog: [],
  };
}

async function fetchTickets(
  jira: JiraClient,
  resolvedProjectKey: string,
  maxTickets: number,
  adfToText: AdfToTextFn,
  boardId?: string,
): Promise<TicketData[]> {
  const jql = `status in (Done, Closed, Resolved) ORDER BY updated DESC`;
  const spField = jira.storyPointsFieldId;
  const allTickets: TicketData[] = [];
  let startAt = 0;
  const pageSize = Math.min(50, maxTickets);

  while (allTickets.length < maxTickets) {
    const batch = boardId
      ? await jira.searchBoardIssues(boardId, jql, pageSize, startAt)
      : await jira.searchIssues(`project = ${resolvedProjectKey} AND ${jql}`, undefined, pageSize, startAt);
    if (batch.issues.length === 0) break;

    for (const issue of batch.issues) {
      allTickets.push(mapIssueToTicket(issue, spField, adfToText));
    }

    startAt += batch.issues.length;
    if (batch.issues.length < pageSize || startAt >= batch.total) break;
  }

  return allTickets;
}

// ── Changelog Enrichment ─────────────────────────────────────────────────────

async function enrichChangelogs(allTickets: TicketData[], jira: JiraClient): Promise<void> {
  const CONCURRENCY = 5;
  for (let i = 0; i < allTickets.length; i += CONCURRENCY) {
    const clBatch = allTickets.slice(i, i + CONCURRENCY);
    const changelogs = await Promise.all(
      clBatch.map(async (t) => {
        try {
          const entries = await jira.getIssueChangelog(t.key);
          return entries.flatMap((e) =>
            e.items.map((item) => ({
              field: item.field,
              from: item.fromString,
              to: item.toString,
              timestamp: e.created,
            })),
          );
        } catch {
          return [];
        }
      }),
    );
    for (let j = 0; j < clBatch.length; j++) {
      const ticket = clBatch[j];
      if (ticket) ticket.changelog = changelogs[j] ?? [];
    }
  }
}

// ── Insight Storage ─────────────────────────────────────────────────────────

function buildInsightRecords(
  allTickets: TicketData[],
): Array<{ category: string; key: string; data: unknown; sampleSize: number; confidence: number }> {
  const insights = analyzeTeamInsights(allTickets);
  const records: Array<{ category: string; key: string; data: unknown; sampleSize: number; confidence: number }> = [];

  for (const est of insights.estimation) {
    records.push({
      category: "estimation",
      key: est.issueType,
      data: est,
      sampleSize: est.sampleSize,
      confidence: est.sampleSize >= 10 ? 0.8 : 0.5,
    });
  }
  for (const own of insights.ownership) {
    records.push({
      category: "ownership",
      key: own.component,
      data: own,
      sampleSize: own.sampleSize,
      confidence: own.sampleSize >= 10 ? 0.8 : 0.5,
    });
  }
  for (const tmpl of insights.templates) {
    records.push({
      category: "templates",
      key: tmpl.issueType,
      data: tmpl,
      sampleSize: tmpl.sampleSize,
      confidence: tmpl.sampleSize >= 10 ? 0.8 : 0.5,
    });
  }
  records.push({
    category: "patterns",
    key: "global",
    data: insights.patterns,
    sampleSize: allTickets.length,
    confidence: allTickets.length >= 20 ? 0.8 : 0.5,
  });

  return records;
}

// ── Learn Team Conventions ───────────────────────────────────────────────────

export async function learnTeamConventions(
  deps: LearnDeps,
  kb: KnowledgeBase,
  resolvedProjectKey: string,
  maxTickets = 200,
  qualityThreshold = 60,
  boardId?: string,
): Promise<string> {
  const { jira, analyzeBacklog, adfToText } = deps;
  const allTickets = await fetchTickets(jira, resolvedProjectKey, maxTickets, adfToText, boardId);

  if (allTickets.length === 0) return "## Team Conventions\nNo completed tickets found — skipped.\n";

  await enrichChangelogs(allTickets, jira);

  const result = analyzeBacklog(allTickets, qualityThreshold);

  kb.upsertTeamRules(
    result.rules.map((r) => ({
      category: r.category,
      rule_key: r.rule_key,
      issue_type: r.issue_type,
      rule_value: r.rule_value,
      confidence: r.confidence,
      sample_size: r.sample_size,
    })),
  );

  // Extract and store team insights (estimation, ownership, templates, patterns)
  const insightRecords = buildInsightRecords(allTickets);
  kb.upsertInsights(insightRecords);

  const jql = `project = ${resolvedProjectKey} AND status in (Done, Closed, Resolved) ORDER BY updated DESC`;
  kb.recordAnalysis({
    project_key: resolvedProjectKey,
    tickets_fetched: result.totalTickets,
    tickets_quality_passed: result.qualityPassed,
    quality_threshold: qualityThreshold,
    rules_extracted: result.rules.length,
    jql_used: jql,
    analyzed_at: new Date().toISOString(),
  });

  return (
    "## Team Conventions\n" +
    `Analyzed ${result.totalTickets} tickets → ${result.rules.length} rules + ${insightRecords.length} insights extracted\n` +
    `Quality: ${result.qualityPassed}/${result.totalTickets} passed (avg score: ${result.avgQualityScore.toFixed(1)}/100)\n`
  );
}
