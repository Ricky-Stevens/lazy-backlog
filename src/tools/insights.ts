import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildJiraClient, errorResponse, textResponse } from "../lib/config.js";
import type { KnowledgeBase } from "../lib/db.js";
import { formatTeamInsights } from "../lib/team-insights.js";
import { loadTeamInsights } from "./issues-helpers.js";
import { handleVelocityAction } from "./sprints-analytics.js";
import { handleRetroAction } from "./sprints-retro.js";

// ── Types ────────────────────────────────────────────────────────────────────

type ToolResponse = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

// ── Handlers ─────────────────────────────────────────────────────────────────

function handleTeamProfile(kb: KnowledgeBase): ToolResponse {
  const insights = loadTeamInsights(kb);
  const teamRules = kb.getTeamRules();

  const hasInsights =
    insights.estimation.length > 0 ||
    insights.ownership.length > 0 ||
    insights.templates.length > 0 ||
    Object.keys(insights.patterns.priorityDistribution).length > 0;

  if (!hasInsights && teamRules.length === 0) {
    return errorResponse(
      "No team profile data. Run configure action='setup' first to analyze your team's completed tickets.",
    );
  }

  const lines: string[] = ["# Team Profile\n"];

  if (hasInsights) {
    lines.push(formatTeamInsights(insights));
  }

  if (teamRules.length > 0) {
    lines.push("\n## Team Conventions\n");
    const byCategory = new Map<string, typeof teamRules>();
    for (const rule of teamRules) {
      const existing = byCategory.get(rule.category) ?? [];
      existing.push(rule);
      byCategory.set(rule.category, existing);
    }
    for (const [category, rules] of byCategory) {
      const label = category.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
      lines.push(`### ${label}`);
      for (const r of rules) {
        const conf = Math.round(r.confidence * 100);
        const typeTag = r.issue_type ? ` [${r.issue_type}]` : "";
        lines.push(`- **${r.rule_key}:** ${r.rule_value}${typeTag} (${conf}% confidence, n=${r.sample_size})`);
      }
      lines.push("");
    }
  }

  return textResponse(lines.join("\n"));
}

async function handleEpicProgress(params: { epicKey?: string }, kb: KnowledgeBase): Promise<ToolResponse> {
  if (!params.epicKey) return errorResponse("epicKey is required for 'epic-progress' action.");

  const { jira } = buildJiraClient(kb);
  const issues = await jira.getEpicIssues(params.epicKey);
  const spField = jira.storyPointsFieldId;

  let doneCount = 0;
  let inProgressCount = 0;
  let todoCount = 0;
  let totalPoints = 0;
  let completedPoints = 0;
  const remaining: Array<{ key: string; summary: string; status: string }> = [];

  for (const issue of issues) {
    const f = issue.fields as Record<string, unknown>;
    const statusName = issue.fields.status?.name ?? "Unknown";
    const cat = (issue.fields.status?.statusCategory?.name ?? "new").toLowerCase();
    const sp =
      (spField ? (f[spField] as number | undefined) : undefined) ??
      (f.story_points as number | undefined) ??
      (f.customfield_10016 as number | undefined) ??
      0;

    if (cat === "done") {
      doneCount++;
      completedPoints += sp;
    } else if (cat === "indeterminate" || cat === "in progress") {
      inProgressCount++;
      remaining.push({ key: issue.key, summary: issue.fields.summary, status: statusName });
    } else {
      todoCount++;
      remaining.push({ key: issue.key, summary: issue.fields.summary, status: statusName });
    }
    totalPoints += sp;
  }

  const total = issues.length;
  const pct = total > 0 ? Math.round((doneCount / total) * 100) : 0;
  const remainingPoints = totalPoints - completedPoints;

  let out = `# Epic Progress: ${params.epicKey}\n\n`;
  out += `**Total Issues:** ${total} | **Done:** ${doneCount} | **In Progress:** ${inProgressCount} | **To Do:** ${todoCount}\n`;
  out += `**Story Points:** ${totalPoints} total, ${completedPoints} completed, ${remainingPoints} remaining\n`;
  out += `**Completion:** ${pct}%\n`;

  if (remaining.length > 0) {
    out += `\n## Remaining Issues (${remaining.length})\n`;
    for (const r of remaining) {
      out += `- ${r.key} (${r.status}): ${r.summary}\n`;
    }
  }

  return textResponse(out);
}

// ── Tool Registration ────────────────────────────────────────────────────────

export function registerInsightsTool(server: McpServer, getKb: () => KnowledgeBase) {
  server.registerTool(
    "insights",
    {
      description:
        "Team intelligence and analytics. Use this tool for understanding team performance, patterns, and progress. " +
        "Actions: 'team-profile' — view stored team intelligence from setup: who owns what components, estimation patterns, " +
        "description templates, rework rates, and conventions (zero API calls — reads local analysis). " +
        "'epic-progress' — show epic completion stats (issues, story points, remaining work). " +
        "'velocity' — team velocity trends across past sprints. " +
        "'retro' — sprint retrospective data (scope creep, cycle time, time-in-status, carry-over).",
      inputSchema: z.object({
        action: z.enum(["team-profile", "epic-progress", "velocity", "retro"]),
        epicKey: z.string().optional().describe("[epic-progress] Epic issue key, e.g. 'BP-100'"),
        sprintId: z.string().optional().describe("[retro] Sprint ID. Omit to use most recent closed sprint"),
        sprintCount: z
          .number()
          .default(5)
          .optional()
          .describe("[velocity, retro] Number of past closed sprints to analyze"),
        trendMetrics: z
          .array(z.enum(["velocity", "bugRate", "scopeChange"]))
          .optional()
          .describe("[velocity] Metrics to compute: velocity (story points), bugRate, scopeChange"),
      }),
    },
    async (params) => {
      const kb = getKb();

      switch (params.action) {
        case "team-profile":
          return handleTeamProfile(kb);

        case "epic-progress":
          return handleEpicProgress(params, kb);

        case "velocity": {
          const { jira, config } = buildJiraClient(kb);
          const boardId = config.jiraBoardId ?? "";
          return handleVelocityAction(params, jira, boardId);
        }

        case "retro": {
          const { jira, config } = buildJiraClient(kb);
          const boardId = config.jiraBoardId ?? "";
          return handleRetroAction(params, jira, boardId, jira.storyPointsFieldId);
        }
      }
    },
  );
}
