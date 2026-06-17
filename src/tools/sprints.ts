import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildJiraClient, errorResponse, textResponse } from "../lib/config.js";
import type { KnowledgeBase } from "../lib/db.js";
import type { JiraClient } from "../lib/jira.js";
import { handleSmartGetAction } from "./sprints-get.js";
import { handleCreateSprintAction, handleMoveIssuesAction, handleUpdateSprintAction } from "./sprints-mutations.js";

// ── Barrel re-exports ─────────────────────────────────────────────────────────

export * from "./sprints-analytics.js";
export * from "./sprints-get.js";
export * from "./sprints-mutations.js";
export * from "./sprints-retro.js";
export * from "./sprints-utils.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatSprintRow(s: {
  id: number;
  name: string;
  state: string;
  startDate?: string;
  endDate?: string;
  goal?: string;
}): string {
  const start = s.startDate ? s.startDate.slice(0, 10) : "-";
  const end = s.endDate ? s.endDate.slice(0, 10) : "-";
  return `| ${s.id} | ${s.name} | ${s.state} | ${start} | ${end} | ${s.goal || "-"} |\n`;
}

function formatSprintsTable(
  sprints: Array<{ id: number; name: string; state: string; startDate?: string; endDate?: string; goal?: string }>,
): string {
  let out = "# Sprints\n\n";
  out += "| ID | Name | State | Start | End | Goal |\n";
  out += "|----|------|-------|-------|-----|------|\n";
  for (const s of sprints) {
    out += formatSprintRow(s);
  }
  return out;
}

async function handleListAction(
  params: { state?: "active" | "future" | "closed" },
  jira: JiraClient,
  boardId: string | undefined,
) {
  if (!boardId) return errorResponse("No board ID configured. Set JIRA_BOARD_ID or run configure.");

  const sprints = params.state
    ? await jira.listSprints(boardId, params.state)
    : [...(await jira.listSprints(boardId, "active")), ...(await jira.listSprints(boardId, "future"))];

  if (sprints.length === 0) return textResponse("No sprints found.");
  return textResponse(formatSprintsTable(sprints));
}

// ── Tool Registration ─────────────────────────────────────────────────────────

export function registerSprintsTool(server: McpServer, getKb: () => KnowledgeBase) {
  server.registerTool(
    "sprints",
    {
      description:
        "Jira sprint management. Actions: 'list' show sprints (use state='active' for \"current sprint\"). 'get' context-adaptive view — active shows dashboard + health, pass `since` for \"standup\" mode, closed shows release notes. 'create' new sprint. 'update' rename, set goal, or change dates. 'move-issues' assign issues to a sprint. For velocity/retros/epic-progress use 'insights'. For issue CRUD use 'issues'; for triage 'bugs'; for ranking 'backlog'.",
      inputSchema: z.object({
        action: z.enum(["list", "get", "create", "update", "move-issues"]),
        state: z.enum(["active", "future", "closed"]).optional().describe("[list] Filter sprints by state"),
        sprintId: z
          .string()
          .optional()
          .describe("[get, update, move-issues] Sprint ID to operate on. 'get' defaults to active sprint"),
        since: z
          .string()
          .optional()
          .describe("[get] ISO date or hours like '24h' — standup mode showing recent changes"),
        name: z.string().optional().describe("[create, update] Sprint name"),
        goal: z.string().optional().describe("[create, update] Sprint goal text"),
        startDate: z
          .string()
          .optional()
          .describe("[create, update] Sprint start date in ISO format, e.g. '2025-03-15'"),
        endDate: z.string().optional().describe("[create, update] Sprint end date in ISO format, e.g. '2025-03-29'"),
        issueKeys: z
          .array(z.string())
          .optional()
          .describe("[move-issues] Issue keys to move into the sprint, e.g. ['BP-1','BP-2']"),
        staleDays: z
          .number()
          .default(3)
          .optional()
          .describe("[get] Days without update before an in-progress item is flagged as stale"),
      }),
    },
    async (params) => {
      const kb = getKb();
      try {
        const { jira, config } = buildJiraClient(kb);
        const boardId = config.jiraBoardId;
        const spFieldId = jira.storyPointsFieldId;

        switch (params.action) {
          case "list":
            return handleListAction(params, jira, boardId);
          case "get":
            return handleSmartGetAction(params, jira, boardId ?? "", spFieldId);
          case "create":
            return handleCreateSprintAction(params, jira, boardId ?? "");
          case "update":
            return handleUpdateSprintAction(params, jira);
          case "move-issues":
            return handleMoveIssuesAction(params, jira);
          default:
            return errorResponse(`Unknown action: ${params.action}`);
        }
      } catch (err: unknown) {
        return errorResponse(`Sprint operation failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );
}
