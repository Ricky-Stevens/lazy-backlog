import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { computeVelocity } from "../lib/analytics.js";
import { buildJiraClient, errorResponse, textResponse } from "../lib/config.js";
import type { EpicSpecLink, KnowledgeBase } from "../lib/db.js";
import {
  buildSpecStatusSection,
  type EpicChildIssue,
  type EpicProgressSummary,
  summariseEpicStatus,
} from "../lib/spec-context.js";
import { formatTeamInsights } from "../lib/team-insights.js";
import { handlePlanAction } from "./insights-plan.js";
import { loadTeamInsights } from "./issues-helpers.js";
import { handleRetroAction } from "./sprints-retro.js";
import { fetchSprintData } from "./sprints-utils.js";
import { buildSuggestions } from "./suggestions.js";

// ── Types ────────────────────────────────────────────────────────────────────

type ToolResponse = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

// ── Handlers ─────────────────────────────────────────────────────────────────

function detectAnomalies(kb: KnowledgeBase): string[] {
  const anomalies: string[] = [];
  try {
    const allInsights = kb.getAllInsights();
    if (allInsights.length === 0) return anomalies;

    // Check ownership: single point of failure (>50% of a component)
    const ownershipRows = allInsights.filter((r) => r.category === "ownership");
    for (const row of ownershipRows) {
      try {
        const data = JSON.parse(row.data) as {
          component: string;
          owners: Array<{ assignee: string; percentage: number }>;
        };
        for (const owner of data.owners ?? []) {
          if (owner.percentage > 50) {
            anomalies.push(
              `**${data.component}**: ${owner.assignee} handles ${Math.round(owner.percentage)}% — single point of failure risk`,
            );
          }
        }
      } catch {
        /* skip malformed */
      }
    }

    // Check estimation: slow issue types (pointsToDaysRatio > 2x average)
    const estRows = allInsights.filter((r) => r.category === "estimation");
    const estData: Array<{ issueType: string; pointsToDaysRatio: number }> = [];
    for (const row of estRows) {
      try {
        const data = JSON.parse(row.data) as { issueType: string; pointsToDaysRatio: number };
        if (data.pointsToDaysRatio > 0) estData.push(data);
      } catch {
        /* skip */
      }
    }
    if (estData.length > 1) {
      const avgRatio = estData.reduce((s, d) => s + d.pointsToDaysRatio, 0) / estData.length;
      for (const d of estData) {
        if (d.pointsToDaysRatio > avgRatio * 2) {
          const multiplier = Math.round((d.pointsToDaysRatio / avgRatio) * 10) / 10;
          anomalies.push(`**${d.issueType}**: ${multiplier}x avg cycle time per point — slow issue type`);
        }
      }
    }
  } catch {
    /* graceful degradation */
  }
  return anomalies;
}

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
      const label = category.replaceAll("_", " ").replace(/\b\w/g, (c) => c.toUpperCase());
      lines.push(`### ${label}`);
      for (const r of rules) {
        const conf = Math.round(r.confidence * 100);
        const typeTag = r.issue_type ? ` [${r.issue_type}]` : "";
        lines.push(`- **${r.rule_key}:** ${r.rule_value}${typeTag} (${conf}% confidence, n=${r.sample_size})`);
      }
      lines.push("");
    }
  }

  const anomalies = detectAnomalies(kb);
  if (anomalies.length > 0) {
    lines.push("\n## Anomalies\n");
    for (const a of anomalies) lines.push(`- ${a}`);
    lines.push("");
  }

  return textResponse(lines.join("\n"));
}

async function handleEpicProgress(params: { epicKey?: string }, kb: KnowledgeBase): Promise<ToolResponse> {
  if (!params.epicKey) return errorResponse("epicKey is required for 'epic-progress' action.");

  try {
    const { jira, config } = buildJiraClient(kb);
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

    // Forecast based on velocity
    if (remainingPoints > 0) {
      const boardId = config.jiraBoardId ?? "";
      if (boardId) {
        try {
          const sprintData = await fetchSprintData(jira, boardId, 5);
          if (sprintData.length > 0) {
            const velocity = computeVelocity(sprintData);
            if (velocity.average > 0) {
              const sprintsRemaining = Math.ceil(remainingPoints / velocity.average);
              const weeksRemaining = sprintsRemaining * 2;
              const estDate = new Date();
              estDate.setDate(estDate.getDate() + weeksRemaining * 7);
              const dateStr = estDate.toISOString().slice(0, 10);

              out += `\n## Forecast\n`;
              out += `**At current velocity (~${Math.round(velocity.average)} SP/sprint), estimated completion in ${sprintsRemaining} sprint${sprintsRemaining === 1 ? "" : "s"} (~${dateStr})**\n`;

              const stddev = Math.sqrt(
                velocity.sprints.reduce((sum, s) => sum + (s.completed - velocity.average) ** 2, 0) /
                  velocity.sprints.length,
              );
              if (velocity.trendSlope < -1 || stddev > velocity.average * 0.3) {
                out += "\n> Warning: High uncertainty -- velocity is unstable\n";
              }
            }
          }
        } catch {
          // Velocity data unavailable — skip forecast
        }
      }
    }

    // Blocker chain detection: check first 10 non-done issues for blocking links
    try {
      const epicKeys = new Set(issues.map((i) => i.key));
      const blockers: Array<{ blocker: string; blocked: string[]; blockedSP: number }> = [];
      const toCheck = remaining.slice(0, 10);

      for (const r of toCheck) {
        try {
          const links = await jira.getIssueLinks(r.key);
          const blockedKeys = links
            .filter((l) => l.direction === "outward" && /block/i.test(l.type) && epicKeys.has(l.linkedIssue.key))
            .map((l) => l.linkedIssue.key);

          if (blockedKeys.length > 0) {
            let blockedSP = 0;
            for (const bk of blockedKeys) {
              const blocked = issues.find((i) => i.key === bk);
              if (blocked) {
                const f = blocked.fields as Record<string, unknown>;
                blockedSP +=
                  (spField ? (f[spField] as number | undefined) : undefined) ??
                  (f.story_points as number | undefined) ??
                  (f.customfield_10016 as number | undefined) ??
                  0;
              }
            }
            blockers.push({ blocker: r.key, blocked: blockedKeys, blockedSP });
          }
        } catch {
          /* skip if links unavailable */
        }
      }

      if (blockers.length > 0) {
        out += `\n## Blockers\n`;
        for (const b of blockers) {
          const status = remaining.find((r) => r.key === b.blocker)?.status ?? "Unknown";
          out += `- **${b.blocker}** (${status}) blocks ${b.blocked.join(", ")}`;
          if (b.blockedSP > 0) out += ` (${b.blockedSP} SP)`;
          out += `\n`;
        }
        const totalBlockedSP = blockers.reduce((s, b) => s + b.blockedSP, 0);
        if (totalBlockedSP > 0) {
          out += `\nResolving blockers unblocks **${totalBlockedSP} SP** on the critical path.\n`;
        }
      }
    } catch {
      /* graceful: skip blocker detection if links unavailable */
    }

    // ── Stage D: spec write-back + freshness loop ─────────────────────────
    const summary: EpicProgressSummary = summariseEpicStatus(
      issues.map<EpicChildIssue>((issue) => {
        const f = issue.fields as Record<string, unknown>;
        const sp =
          (spField ? (f[spField] as number | undefined) : undefined) ??
          (f.story_points as number | undefined) ??
          (f.customfield_10016 as number | undefined) ??
          0;
        return {
          key: issue.key,
          summary: issue.fields.summary,
          statusName: issue.fields.status?.name ?? "Unknown",
          statusCategory: issue.fields.status?.statusCategory?.name ?? "new",
          storyPoints: sp,
        };
      }),
    );

    let specLinks: EpicSpecLink[] = [];
    let staleFlagged = 0;
    try {
      specLinks = kb.getSpecLinksByIssue(params.epicKey);
      if (summary.isComplete) {
        for (const link of specLinks) {
          kb.markEpicCompleted(link.issue_key, link.page_id);
          // Only flag stale the first time the epic completes, to avoid
          // re-flagging a spec the user has already refreshed.
          if (!link.stale_flagged_at) {
            if (kb.flagSpecStale(link.issue_key, link.page_id)) staleFlagged++;
          }
        }
      }
    } catch (err) {
      console.error(
        `[insights epic-progress] spec link bookkeeping failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (specLinks.length > 0) {
      out += `\n## Source Spec${specLinks.length === 1 ? "" : "s"}\n`;
      for (const link of specLinks) {
        const target = link.page_url
          ? `[${link.page_title ?? link.page_id}](${link.page_url})`
          : (link.page_title ?? link.page_id);
        const flags: string[] = [];
        if (link.completed_at || summary.isComplete) flags.push("epic complete");
        if (link.stale_flagged_at) flags.push("stale — needs refresh");
        else if (staleFlagged > 0) flags.push("flagged stale now");
        out += `- ${target} (page ${link.page_id}, source ${link.source})${flags.length > 0 ? ` — ${flags.join(", ")}` : ""}\n`;
      }
      out += `\n### Implementation Status (markdown to publish)\n\n`;
      out += `> Pass the content below to \`confluence publish\` with the page id above to write the status back into the spec.\n\n`;
      // Use the first spec link's page title as a stand-in for the epic summary.
      // Avoids an extra Jira fetch — best signal we have without a getIssue call.
      const epicSummaryText = specLinks[0]?.page_title ?? null;
      out += "```markdown\n";
      out += buildSpecStatusSection(params.epicKey, config.siteUrl, summary, { epicSummary: epicSummaryText });
      out += "\n```\n";
    }

    const behindSchedule = summary.remainingPoints > summary.completedPoints;
    const suggestions = buildSuggestions("insights", "epic-progress", {
      behindSchedule,
      hasSpecLink: specLinks.length > 0,
      epicComplete: summary.isComplete,
    });
    return textResponse(out + suggestions);
  } catch (err: unknown) {
    return errorResponse(
      `Failed to get epic progress for ${params.epicKey}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ── Tool Registration ────────────────────────────────────────────────────────

export function registerInsightsTool(server: McpServer, getKb: () => KnowledgeBase) {
  server.registerTool(
    "insights",
    {
      description:
        "Team intelligence and analytics. Actions: 'team-profile' — stored team intelligence (ownership, estimation, templates, rework, conventions; reads local analysis). " +
        "'epic-progress' — completion stats + velocity forecast; offers \"publish status\" write-back via 'confluence publish' when a source spec is linked. " +
        "'retro' — sprint retrospective (scope creep, cycle time, workload, carry-over). " +
        "'plan' — sprint planning (velocity, carryover, capacity, recommended backlog items). " +
        "For issue CRUD use 'issues'; for ranking 'backlog'; for sprint CRUD 'sprints'.",
      inputSchema: z.object({
        action: z.enum(["team-profile", "epic-progress", "retro", "plan"]),
        epicKey: z.string().optional().describe("[epic-progress] Epic issue key, e.g. 'BP-100'"),
        sprintId: z.string().optional().describe("[retro] Sprint ID. Omit to use most recent closed sprint"),
        sprintCount: z
          .number()
          .default(5)
          .optional()
          .describe("[retro, plan] Number of past closed sprints to analyze"),
      }),
    },
    async (params) => {
      const kb = getKb();

      switch (params.action) {
        case "team-profile":
          return handleTeamProfile(kb);

        case "epic-progress":
          return handleEpicProgress(params, kb);

        case "plan":
          return handlePlanAction(params, kb);

        case "retro": {
          try {
            const { jira, config } = buildJiraClient(kb);
            const boardId = config.jiraBoardId ?? "";
            return await handleRetroAction(params, jira, boardId, jira.storyPointsFieldId);
          } catch (err: unknown) {
            return errorResponse(`Retro failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
    },
  );
}
