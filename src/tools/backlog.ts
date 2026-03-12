import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildJiraClient, errorResponse, textResponse } from "../lib/config.js";
import type { KnowledgeBase } from "../lib/db.js";
import { jaccardSimilarity, tokenize } from "../lib/duplicate-detect.js";
import type { JiraClient, SearchIssue } from "../lib/jira.js";

// ── Types ────────────────────────────────────────────────────────────────────

type ToolResponse = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatIssueRow(issue: SearchIssue, spField: string | undefined): string {
  const f = issue.fields as Record<string, unknown>;
  const sp =
    (spField ? (f[spField] as number | undefined) : undefined) ??
    (f.story_points as number | undefined) ??
    (f.customfield_10016 as number | undefined);
  return `| ${issue.key} | ${issue.fields.summary} | ${issue.fields.issuetype?.name ?? "-"} | ${issue.fields.priority?.name ?? "-"} | ${sp ?? "-"} | ${issue.fields.assignee?.displayName || "Unassigned"} |`;
}

// ── Action Handlers ──────────────────────────────────────────────────────────

async function handleList(
  params: { maxResults?: number; detectDuplicates?: boolean },
  kb: KnowledgeBase,
): Promise<ToolResponse> {
  try {
    const { jira, config } = buildJiraClient(kb);
    const boardId = config.jiraBoardId;
    if (!boardId) return errorResponse("No board ID configured. Set JIRA_BOARD_ID or run configure.");

    const result = await jira.getBacklogIssues(boardId, params.maxResults || 50);

    if (result.issues.length === 0) {
      return textResponse("Board backlog is empty.");
    }

    let out = `# Board Backlog (${result.issues.length}/${result.total})\n\n`;
    out += "| Key | Summary | Type | Priority | SP | Assignee |\n";
    out += "|-----|---------|------|----------|----|----------|\n";
    const spField = jira.storyPointsFieldId;
    for (const issue of result.issues) {
      out += `${formatIssueRow(issue, spField)}\n`;
    }

    // Pairwise duplicate detection
    if (params.detectDuplicates && result.issues.length > 1) {
      const tokenized = result.issues.map((issue) => ({
        key: issue.key,
        summary: issue.fields.summary,
        tokens: tokenize(issue.fields.summary),
      }));
      const pairs: Array<{ a: string; b: string; summaryA: string; summaryB: string; similarity: number }> = [];
      for (let i = 0; i < tokenized.length; i++) {
        for (let j = i + 1; j < tokenized.length; j++) {
          const itemA = tokenized[i];
          const itemB = tokenized[j];
          if (!itemA || !itemB) continue;
          const sim = jaccardSimilarity(itemA.tokens, itemB.tokens);
          if (sim > 0.4) {
            pairs.push({
              a: itemA.key,
              b: itemB.key,
              summaryA: itemA.summary,
              summaryB: itemB.summary,
              similarity: sim,
            });
          }
        }
      }
      if (pairs.length > 0) {
        pairs.sort((a, b) => b.similarity - a.similarity);
        out += `\n## Potential Duplicates (${pairs.length} pairs)\n\n`;
        out += "| Issue A | Issue B | Overlap |\n";
        out += "|---------|---------|--------|\n";
        for (const p of pairs) {
          out += `| ${p.a}: ${p.summaryA.slice(0, 40)} | ${p.b}: ${p.summaryB.slice(0, 40)} | **${Math.round(p.similarity * 100)}%** |\n`;
        }
      }
    }

    return textResponse(out);
  } catch (err: unknown) {
    return errorResponse(`Backlog failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function buildBacklogJql(rawJql: string, projectKey?: string): string {
  const orderExec = /(?:^|\s+)(ORDER\s+BY\s+[^\n]+)$/i.exec(rawJql);
  const orderClause = orderExec ? ` ${orderExec[1]}` : " ORDER BY rank ASC";
  const filterPart = (orderExec ? rawJql.slice(0, orderExec.index) : rawJql).trim();

  const hasSprint = /\bsprint\b/i.test(filterPart);
  let backlogFilter: string;
  if (hasSprint) {
    backlogFilter = filterPart;
  } else if (filterPart) {
    backlogFilter = `sprint is EMPTY AND (${filterPart})`;
  } else {
    backlogFilter = "sprint is EMPTY";
  }

  const hasProject = /\bproject\s*(?:[=!]|in\b|is\b)/i.test(backlogFilter);
  const projectScoped = projectKey && !hasProject ? `project = ${projectKey} AND (${backlogFilter})` : backlogFilter;

  return `${projectScoped}${orderClause}`;
}

async function handleSearch(params: { jql?: string; maxResults?: number }, kb: KnowledgeBase): Promise<ToolResponse> {
  if (!params.jql) return errorResponse("jql is required for 'search' action.");
  try {
    const { jira, config } = buildJiraClient(kb);
    const maxResults = params.maxResults ?? 50;

    const result = config.jiraBoardId
      ? await jira.searchBacklogIssues(config.jiraBoardId, params.jql, maxResults)
      : await jira.searchIssues(buildBacklogJql(params.jql, config.jiraProjectKey), undefined, maxResults);

    if (result.issues.length === 0) {
      return textResponse(`No backlog items found for: \`${params.jql}\``);
    }

    const spField = jira.storyPointsFieldId;
    let out = `# Backlog Search (${result.issues.length}/${result.total})\n\n`;
    out += "| Key | Summary | Type | Priority | SP | Assignee |\n";
    out += "|-----|---------|------|----------|----|----------|\n";
    for (const issue of result.issues) {
      out += `${formatIssueRow(issue, spField)}\n`;
    }
    return textResponse(out);
  } catch (err: unknown) {
    return errorResponse(`Backlog search failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function resolvePosition(
  params: { issueKey: string; position: "top" | "bottom" },
  jira: JiraClient,
  boardId: string,
): Promise<ToolResponse | { rankBefore?: string; rankAfter?: string }> {
  if (params.position === "top") {
    const backlog = await jira.getBacklogIssues(boardId, 1);
    if (backlog.issues.length === 0) {
      return textResponse(`Backlog is empty — **${params.issueKey}** is already at the top.`);
    }
    const topKey = backlog.issues[0]?.key;
    if (!topKey || topKey === params.issueKey) {
      return textResponse(`**${params.issueKey}** is already at the top of the backlog.`);
    }
    return { rankBefore: topKey };
  }

  const backlog = await jira.getBacklogIssues(boardId, 1, 0);
  const totalItems = backlog.total;
  if (totalItems === 0) {
    return textResponse(`Backlog is empty — **${params.issueKey}** is already at the bottom.`);
  }
  const lastPage = await jira.getBacklogIssues(boardId, 1, Math.max(0, totalItems - 1));
  const lastKey = lastPage.issues[0]?.key;
  if (!lastKey || lastKey === params.issueKey) {
    return textResponse(`**${params.issueKey}** is already at the bottom of the backlog.`);
  }
  return { rankAfter: lastKey };
}

function describeRankDirection(params: { position?: string; rankBefore?: string; rankAfter?: string }): string {
  if (params.position) return `to ${params.position} of backlog`;
  return params.rankBefore ? `before ${params.rankBefore}` : `after ${params.rankAfter}`;
}

async function handleRank(
  params: {
    issueKey?: string;
    rankBefore?: string;
    rankAfter?: string;
    position?: "top" | "bottom";
  },
  kb: KnowledgeBase,
): Promise<ToolResponse> {
  if (!params.issueKey) return errorResponse("issueKey is required for 'rank' action.");
  if (!params.rankBefore && !params.rankAfter && !params.position) {
    return errorResponse("rankBefore, rankAfter, or position ('top'/'bottom') is required for 'rank' action.");
  }
  try {
    const { jira, config } = buildJiraClient(kb);

    let rankBefore = params.rankBefore;
    let rankAfter = params.rankAfter;

    if (params.position && !rankBefore && !rankAfter) {
      const boardId = config.jiraBoardId;
      if (!boardId) {
        return errorResponse("Board ID is required for position ranking. Run configure action=discover-jira first.");
      }
      const resolved = await resolvePosition({ issueKey: params.issueKey, position: params.position }, jira, boardId);
      if ("content" in resolved) return resolved;
      rankBefore = resolved.rankBefore;
      rankAfter = resolved.rankAfter;
    }

    await jira.rankIssue(params.issueKey, {
      ...(rankBefore ? { rankBefore } : {}),
      ...(rankAfter ? { rankAfter } : {}),
    });

    return textResponse(
      `Ranked **${params.issueKey}** ${describeRankDirection({ ...params, rankBefore, rankAfter })}.`,
    );
  } catch (err: unknown) {
    return errorResponse(`Failed to rank ${params.issueKey}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── Tool Registration ────────────────────────────────────────────────────────

export function registerBacklogTool(server: McpServer, getKb: () => KnowledgeBase) {
  server.registerTool(
    "backlog",
    {
      description:
        "Board backlog management. Actions: 'list' show the board's backlog items via Agile API (board-scoped). 'search' query backlog items via JQL (auto-enforces sprint is EMPTY and project filter). 'rank' reorder backlog items — use position='top'/'bottom' for common operations, or rankBefore/rankAfter for precise placement. To get full details or update a backlog item, use the 'issues' tool with get/update actions.",
      inputSchema: z.object({
        action: z.enum(["list", "search", "rank"]),
        maxResults: z.number().max(100).default(50).optional().describe("[list, search] Max issues to return"),
        detectDuplicates: z
          .boolean()
          .default(false)
          .optional()
          .describe("[list] Pairwise duplicate detection on backlog items (Jaccard similarity > 40%)"),
        jql: z.string().optional().describe("[search] JQL query string (auto-filtered to backlog items)"),
        issueKey: z.string().optional().describe("[rank] Issue key to reorder, e.g. 'BP-42'"),
        rankBefore: z.string().optional().describe("[rank] Rank this issue before the specified issue key"),
        rankAfter: z.string().optional().describe("[rank] Rank this issue after the specified issue key"),
        position: z
          .enum(["top", "bottom"])
          .optional()
          .describe("[rank] Move issue to top or bottom of the backlog. Requires board ID to be configured"),
      }),
    },
    async (params) => {
      const kb = getKb();

      switch (params.action) {
        case "list":
          return handleList(params, kb);
        case "search":
          return handleSearch(params, kb);
        case "rank":
          return handleRank(params, kb);
        default:
          return errorResponse(`Unknown action: ${params.action}`);
      }
    },
  );
}
