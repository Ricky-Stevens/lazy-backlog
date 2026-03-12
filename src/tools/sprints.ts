import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildJiraClient, errorResponse, textResponse } from "../lib/config.js";
import { groupBy, type KnowledgeBase } from "../lib/db.js";
import { handleHealthAction } from "./sprints-analytics.js";
import { handleCreateSprintAction, handleGoalAction, handleMoveIssuesAction } from "./sprints-mutations.js";
import { getStoryPoints } from "./sprints-utils.js";

// ── Barrel re-exports ─────────────────────────────────────────────────────────

export * from "./sprints-analytics.js";
export * from "./sprints-mutations.js";
export * from "./sprints-retro.js";
export * from "./sprints-utils.js";

// ── Tool Registration ─────────────────────────────────────────────────────────

export function registerSprintsTool(server: McpServer, getKb: () => KnowledgeBase) {
  server.registerTool(
    "sprints",
    {
      description:
        "Jira sprint management. Use this tool for sprint CRUD and health checks. Actions: 'list' show sprints (use state='active' for current sprint). 'get' sprint details with full issue breakdown. 'create' a new sprint. 'move-issues' assign issues to a sprint. 'health' active sprint progress, stale items, capacity. 'goal' read or set sprint goal. For velocity, retros, epic progress, and team intelligence use the 'insights' tool. For individual issues use 'issues'. For bug workflows use 'bugs'. For backlog use 'backlog'.",
      inputSchema: z.object({
        action: z.enum(["list", "get", "create", "move-issues", "health", "goal"]),
        state: z.enum(["active", "future", "closed"]).optional().describe("[list] Filter sprints by state"),
        sprintId: z.string().optional().describe("[get, move-issues, health, goal] Sprint ID to operate on"),
        name: z.string().optional().describe("[create] Name for the new sprint"),
        goal: z
          .string()
          .optional()
          .describe("[create, goal] Sprint goal text. For 'goal' action: set this to update, omit to read"),
        startDate: z.string().optional().describe("[create] Sprint start date in ISO format, e.g. '2025-03-15'"),
        endDate: z.string().optional().describe("[create] Sprint end date in ISO format, e.g. '2025-03-29'"),
        issueKeys: z
          .array(z.string())
          .optional()
          .describe("[move-issues] Issue keys to move into the sprint, e.g. ['BP-1','BP-2']"),
        staleDays: z
          .number()
          .default(3)
          .optional()
          .describe("[health] Days without update before an in-progress item is flagged as stale"),
      }),
    },
    async (params) => {
      const kb = getKb();
      try {
        const { jira, config } = buildJiraClient(kb);
        const boardId = config.jiraBoardId;
        const spFieldId = jira.storyPointsFieldId;

        switch (params.action) {
          // ── List sprints ──
          case "list": {
            if (!boardId) return errorResponse("No board ID configured. Set JIRA_BOARD_ID or run configure.");

            let sprints: Awaited<ReturnType<typeof jira.listSprints>>;
            if (params.state) {
              sprints = await jira.listSprints(boardId, params.state);
            } else {
              const [active, future] = await Promise.all([
                jira.listSprints(boardId, "active"),
                jira.listSprints(boardId, "future"),
              ]);
              sprints = [...active, ...future];
            }

            if (sprints.length === 0) return textResponse("No sprints found.");

            let out = "# Sprints\n\n";
            out += "| ID | Name | State | Start | End | Goal |\n";
            out += "|----|------|-------|-------|-----|------|\n";
            for (const s of sprints) {
              const start = s.startDate ? s.startDate.slice(0, 10) : "-";
              const end = s.endDate ? s.endDate.slice(0, 10) : "-";
              out += `| ${s.id} | ${s.name} | ${s.state} | ${start} | ${end} | ${s.goal || "-"} |\n`;
            }
            return textResponse(out);
          }

          // ── Get sprint details ──
          case "get": {
            if (!params.sprintId) return errorResponse("sprintId is required for 'get' action.");

            const [sprint, sprintDetails, sprintIssuesRes] = await Promise.all([
              jira.getSprint(params.sprintId),
              jira.getSprintDetails(params.sprintId),
              jira.getSprintIssues(params.sprintId),
            ]);
            const issues = sprintIssuesRes.issues;

            const byStatus = groupBy(issues, (i) => i.fields.status?.name ?? "Unknown");
            const byAssignee = groupBy(issues, (i) => i.fields.assignee?.displayName ?? "Unassigned");

            let totalSP = 0;
            let doneSP = 0;
            let inProgressSP = 0;

            for (const issue of issues) {
              const sp = getStoryPoints(issue.fields, spFieldId);
              totalSP += sp;
              const status = (issue.fields.status?.name ?? "").toLowerCase();
              if (status === "done" || status === "closed" || status === "resolved") doneSP += sp;
              else if (status.includes("progress")) inProgressSP += sp;
            }

            // Prefer goal from sprintDetails (getSprintDetails), fall back to getSprint
            const sprintGoal = sprintDetails.goal ?? sprint.goal;

            let out = `# ${sprint.name}\n\n`;
            out += `**State:** ${sprint.state}`;
            if (sprint.startDate) out += ` | **Start:** ${sprint.startDate.slice(0, 10)}`;
            if (sprint.endDate) out += ` | **End:** ${sprint.endDate.slice(0, 10)}`;
            out += "\n";
            if (sprintGoal) out += `**Goal:** ${sprintGoal}\n`;
            out += `\n**Story Points:** ${totalSP} total | ${doneSP} done | ${inProgressSP} in progress\n`;

            out += "\n## Issues by Status\n\n";
            for (const [status, statusIssues] of byStatus) {
              out += `### ${status} (${statusIssues.length})\n`;
              for (const issue of statusIssues) {
                const sp = getStoryPoints(issue.fields, spFieldId);
                const spLabel = sp ? ` [${sp}pts]` : "";
                out += `- ${issue.key}: ${issue.fields.summary}${spLabel}\n`;
              }
              out += "\n";
            }

            out += "## Per-Assignee Breakdown\n\n";
            for (const [assignee, assigneeIssues] of byAssignee) {
              const assigneeSP = assigneeIssues.reduce((sum, i) => sum + getStoryPoints(i.fields, spFieldId), 0);
              out += `### ${assignee} (${assigneeIssues.length} issues, ${assigneeSP} SP)\n`;
              for (const issue of assigneeIssues) {
                out += `- ${issue.key}: ${issue.fields.summary} [${issue.fields.status?.name ?? "Unknown"}]\n`;
              }
              out += "\n";
            }

            return textResponse(out);
          }

          // ── Create sprint ──
          case "create":
            return handleCreateSprintAction(params, jira, boardId ?? "");

          // ── Move issues ──
          case "move-issues":
            return handleMoveIssuesAction(params, jira);

          // ── Sprint health (with capacity) ──
          case "health":
            return handleHealthAction(params, jira, boardId ?? "", spFieldId);

          // ── Goal ──
          case "goal":
            return handleGoalAction(params, jira);

          default:
            return errorResponse(`Unknown action: ${params.action}`);
        }
      } catch (err: unknown) {
        return errorResponse(`Sprint operation failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );
}
