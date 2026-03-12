import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildJiraClient, errorResponse, textResponse } from "../lib/config.js";
import type { KnowledgeBase } from "../lib/db.js";
import { JiraClient } from "../lib/jira.js";
import { DEFAULT_RULES, formatTeamStyleGuide, mergeWithDefaults } from "../lib/team-rules.js";
import { evaluateConventions, formatConventionsSection } from "../lib/team-rules-format.js";
import { handleBulkCreateAction, handleCreateAction } from "./issues-create.js";
import { handleGetAction, handleSearchAction } from "./issues-get.js";
import {
  boolPreprocess,
  buildKbContextSection,
  buildSchemaGuidance,
  FIELD_RULES,
  jsonPreprocess,
  retrieveKbContext,
} from "./issues-helpers.js";

// ── Barrel re-exports ─────────────────────────────────────────────────────────

export * from "./issues-create.js";
export * from "./issues-get.js";
export * from "./issues-helpers.js";

// ── Tool Registration ─────────────────────────────────────────────────────────

export function registerIssuesTool(server: McpServer, getKb: () => KnowledgeBase) {
  server.registerTool(
    "issues",
    {
      description:
        "Jira issue CRUD and planning. IMPORTANT: 'create' and 'bulk-create' ALWAYS return a preview first. You MUST show the preview to the user and wait for their explicit approval before calling again with confirmed=true. NEVER set confirmed=true without user approval. Actions: 'get' fetch one or many issue details (pass issueKey for single, issueKeys for bulk). 'create' create one issue (returns preview — user must approve before confirmed=true). 'bulk-create' create multiple (returns preview — user must approve before confirmed=true). 'update' modify fields, transition status, assign, or link. 'search' query via JQL (auto-scoped to configured board). 'epic-progress' show epic completion stats. 'decompose' break an epic into child stories. For bug-specific workflows (find, assess, triage) use the 'bugs' tool. For backlog listing and ranking use the 'backlog' tool. For sprint operations use the 'sprints' tool.",
      inputSchema: z.object({
        action: z.enum(["get", "create", "bulk-create", "update", "search", "epic-progress", "decompose"]),
        // Shared identifiers
        issueKey: z.string().optional().describe("[get, update] Single issue key, e.g. 'BP-42'"),
        issueKeys: z
          .array(z.string())
          .optional()
          .describe("[get] Array of issue keys for bulk fetch, e.g. ['BP-1','BP-2','BP-3']"),
        // create / update fields
        summary: z.string().optional().describe("[create, update] Issue title"),
        description: z.string().optional().describe("[create, update] Issue description (markdown, converted to ADF)"),
        issueType: z
          .string()
          .default("Task")
          .optional()
          .describe("[create] Issue type name, e.g. 'Task', 'Bug', 'Story'"),
        priority: z.string().optional().describe("[create, update] Priority name, e.g. 'High', 'Medium'"),
        labels: z.array(z.string()).optional().describe("[create, update] Labels in kebab-case, e.g. ['tech-debt']"),
        storyPoints: z.number().optional().describe("[create, update] Story points (Fibonacci: 1,2,3,5,8,13)"),
        parentKey: z
          .string()
          .optional()
          .describe("[create, bulk-create] Parent epic key, e.g. 'BP-10'. Alias for 'parent'"),
        components: z.array(z.string()).optional().describe("[create, update] Component names"),
        namedFields: z
          .record(z.string(), z.union([z.string(), z.null()]))
          .optional()
          .describe("[create, update] Custom fields as {'Field Name': 'Value Name'}. Pass null to clear a field."),
        comment: z.string().optional().describe("[update] Add a comment to the issue"),
        // bulk-create
        tickets: z.preprocess(
          jsonPreprocess,
          z
            .array(
              z.object({
                summary: z.string(),
                description: z.string().optional(),
                issueType: z.string().default("Task"),
                labels: z.array(z.string()).default([]),
                storyPoints: z.number().optional(),
                priority: z.string().default("Medium"),
                parentKey: z.string().optional(),
                components: z.array(z.string()).default([]),
                namedFields: z.record(z.string(), z.string()).optional(),
              }),
            )
            .optional()
            .describe("[bulk-create] Array of ticket objects to create"),
        ),
        confirmed: z
          .preprocess(boolPreprocess, z.boolean().default(false))
          .optional()
          .describe(
            "[create, bulk-create] ONLY set true AFTER showing the preview to the user AND receiving their explicit approval. Default false (preview only). NEVER set true on the first call.",
          ),
        // search
        jql: z.string().optional().describe("[search] JQL query string"),
        maxResults: z.number().max(100).default(50).optional().describe("[search] Max issues to return"),
        // parent epic
        parent: z.string().optional().describe("[create, update] Parent epic key, e.g. 'BP-10'"),
        // ranking
        rankBefore: z.string().optional().describe("[update] Rank this issue before the specified issue key"),
        rankAfter: z.string().optional().describe("[update] Rank this issue after the specified issue key"),
        // epic-progress / decompose
        epicKey: z.string().optional().describe("[epic-progress, decompose] Epic issue key"),
        // update extras
        status: z.string().optional().describe("[update] Transition to this status name, e.g. 'In Progress', 'Done'"),
        assignee: z.string().optional().describe("[update] Assignee account ID, or 'unassigned' to clear"),
        links: z
          .array(
            z.object({
              targetKey: z.string().describe("Issue key to link to"),
              linkType: z.string().describe("Link type name, e.g. 'Blocks', 'Relates'"),
              direction: z.enum(["inward", "outward"]).describe("Link direction from this issue's perspective"),
            }),
          )
          .optional()
          .describe("[update] Create issue links"),
        spaceKey: z
          .string()
          .optional()
          .describe("[create, bulk-create, decompose] Confluence space key to search for relevant context"),
      }),
    },
    async (params) => {
      const kb = getKb();

      // ── GET (single or bulk) ──
      if (params.action === "get") {
        return handleGetAction(params, kb);
      }

      // ── CREATE ──
      if (params.action === "create") {
        return handleCreateAction(params, kb);
      }

      // ── BULK-CREATE ──
      if (params.action === "bulk-create") {
        return handleBulkCreateAction(params, kb);
      }

      // ── UPDATE ──
      if (params.action === "update") {
        if (!params.issueKey) return errorResponse("issueKey is required for 'update' action.");
        try {
          const { jira, config } = buildJiraClient(kb);

          // Core field update (only if there are fields to update)
          const parentKey = params.parent || params.parentKey;
          const hasFieldUpdates =
            params.summary != null ||
            params.description != null ||
            params.priority != null ||
            params.labels != null ||
            params.storyPoints != null ||
            params.components != null ||
            params.namedFields != null ||
            params.comment != null ||
            parentKey != null;

          if (hasFieldUpdates) {
            await jira.updateIssue({
              issueKey: params.issueKey,
              summary: params.summary,
              description: params.description,
              priority: params.priority,
              labels: params.labels,
              storyPoints: params.storyPoints,
              components: params.components,
              namedFields: params.namedFields,
              comment: params.comment,
              parentKey,
            });
          }

          const url = `${config.siteUrl}/browse/${params.issueKey}`;
          const changes: string[] = [
            params.summary ? `Summary: ${params.summary}` : "",
            params.description ? "Description: updated" : "",
            params.priority ? `Priority: ${params.priority}` : "",
            params.labels ? `Labels: ${params.labels.join(", ")}` : "",
            params.storyPoints != null ? `Story Points: ${params.storyPoints}` : "",
            params.components ? `Components: ${params.components.join(", ")}` : "",
            params.namedFields ? `Custom fields: ${Object.keys(params.namedFields).join(", ")}` : "",
            parentKey ? `Parent: ${parentKey}` : "",
            params.comment ? "Comment: added" : "",
          ].filter(Boolean);

          // Status transition
          if (params.status) {
            const targetStatus = params.status;
            const transitions = await jira.getTransitions(params.issueKey);
            const match = transitions.find((t) => t.name.toLowerCase() === targetStatus.toLowerCase());
            if (!match) {
              const available = transitions.map((t) => t.name).join(", ");
              return errorResponse(
                `No transition matching "${params.status}" for ${params.issueKey}. Available: ${available}`,
              );
            }
            await jira.transitionIssue(params.issueKey, match.id);
            changes.push(`Status: transitioned via "${match.name}"`);
          }

          // Assignee
          if (params.assignee) {
            const accountId = params.assignee === "unassigned" ? null : params.assignee;
            await jira.assignIssue(params.issueKey, accountId);
            changes.push(`Assignee: ${params.assignee === "unassigned" ? "cleared" : params.assignee}`);
          }

          // Issue links
          if (params.links?.length) {
            for (const link of params.links) {
              const inward = link.direction === "inward" ? params.issueKey : link.targetKey;
              const outward = link.direction === "inward" ? link.targetKey : params.issueKey;
              await jira.linkIssues(inward, outward, link.linkType);
            }
            changes.push(`Links: ${params.links.length} link(s) created`);
          }

          // Ranking
          if (params.rankBefore || params.rankAfter) {
            await (
              jira as unknown as {
                rankIssue(key: string, opts: { rankBefore?: string; rankAfter?: string }): Promise<void>;
              }
            ).rankIssue(params.issueKey, {
              ...(params.rankBefore ? { rankBefore: params.rankBefore } : {}),
              ...(params.rankAfter ? { rankAfter: params.rankAfter } : {}),
            });
            changes.push(`Ranked: ${params.rankBefore ? `before ${params.rankBefore}` : `after ${params.rankAfter}`}`);
          }

          const changesList = changes.map((c) => `- ${c}`).join("\n");
          return textResponse(`Updated **${params.issueKey}** — ${url}\n\nChanges:\n${changesList}`);
        } catch (err: unknown) {
          return errorResponse(
            `Failed to update ${params.issueKey}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      // ── SEARCH ──
      if (params.action === "search") {
        return handleSearchAction(params, kb);
      }

      // ── EPIC-PROGRESS ──
      if (params.action === "epic-progress") {
        if (!params.epicKey) return errorResponse("epicKey is required for 'epic-progress' action.");
        try {
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
        } catch (err: unknown) {
          return errorResponse(`Failed to get epic progress: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // ── DECOMPOSE ──
      if (params.action === "decompose") {
        if (!params.epicKey) return errorResponse("epicKey is required for 'decompose' action.");

        try {
          const { jira } = buildJiraClient(kb);
          const schema = JiraClient.loadSchemaFromDb(kb);

          // Fetch the epic details
          const epic = await jira.getIssue(params.epicKey);

          // Search for existing children
          const children = await jira.searchIssues(`parent = ${params.epicKey}`);

          // Retrieve Confluence context for the epic description
          const epicDescription = epic.description || epic.summary;
          const ctx = retrieveKbContext(kb, epicDescription, params.spaceKey);

          const issueType = params.issueType || "Task";

          let plan = `# Epic Decomposition: ${epic.key}\n\n`;
          plan += `## Epic Details\n`;
          plan += `**Summary:** ${epic.summary}\n`;
          plan += `**Status:** ${epic.status} | **Priority:** ${epic.priority}\n`;
          if (epic.labels.length) plan += `**Labels:** ${epic.labels.join(", ")}\n`;
          if (epic.description) plan += `\n### Description\n${epic.description}\n`;
          plan += `\n`;

          // Existing stories
          if (children.issues.length > 0) {
            plan += `## Existing Stories (${children.issues.length}/${children.total})\n\n`;
            plan += `| Key | Summary | Status | Priority | Assignee |\n`;
            plan += `|-----|---------|--------|----------|----------|\n`;
            for (const issue of children.issues) {
              plan += `| ${issue.key} | ${issue.fields.summary} | ${issue.fields.status?.name ?? "Unknown"} | ${issue.fields.priority?.name ?? "None"} | ${issue.fields.assignee?.displayName || "Unassigned"} |\n`;
            }
            plan += `\n`;
          } else {
            plan += `## Existing Stories\nNone found.\n\n`;
          }

          plan += buildSchemaGuidance(schema, issueType);

          // Load team rules and merge with defaults
          const teamRules = kb.getTeamRules();
          const rules = teamRules.map((r) => ({
            category: r.category,
            rule_key: r.rule_key,
            issue_type: r.issue_type,
            rule_value: r.rule_value,
            confidence: r.confidence,
            sample_size: r.sample_size,
          }));
          const merged = mergeWithDefaults(rules, DEFAULT_RULES);
          const styleGuide = formatTeamStyleGuide(merged);
          if (styleGuide.trim()) {
            plan += `\n${styleGuide}\n`;
          }

          // Evaluate conventions for the epic as a representative ticket
          const conventions = evaluateConventions(
            { summary: epic.summary, description: epic.description, issueType, labels: epic.labels },
            merged,
          );
          const conventionsText = formatConventionsSection(conventions);
          if (conventionsText) plan += `\n${conventionsText}\n\n`;

          plan += buildKbContextSection(ctx);

          plan += `---\nUse **issues** (action=create or bulk-create) with parentKey="${params.epicKey}" to create child stories.\n`;
          plan += FIELD_RULES;
          return textResponse(plan);
        } catch (err: unknown) {
          return errorResponse(
            `Failed to decompose ${params.epicKey}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      return errorResponse(`Unknown action: ${params.action}`);
    },
  );
}
