import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildJiraClient, errorResponse, textResponse } from "../lib/config.js";
import type { KnowledgeBase } from "../lib/db.js";
import { JiraClient } from "../lib/jira.js";
import { handleBulkCreateAction } from "./issues-bulk.js";
import { handleCreateAction, handleDecomposeAction } from "./issues-create.js";
import { handleGetAction, handleSearchAction } from "./issues-get.js";
import { boolPreprocess, checkEnrichmentGaps, jsonPreprocess } from "./issues-helpers.js";

// ── Barrel re-exports ─────────────────────────────────────────────────────────

export * from "./issues-bulk.js";
export * from "./issues-create.js";
export * from "./issues-get.js";
export * from "./issues-helpers.js";

// ── Params type alias (inferred from the Zod schema) ─────────────────────────

/** Minimal type for the tool callback params — keeps handler signatures readable. */
interface IssueParams {
  action: string;
  issueKey?: string;
  issueKeys?: string[];
  summary?: string;
  description?: string;
  issueType?: string;
  priority?: string;
  labels?: string[];
  storyPoints?: number;
  parentKey?: string;
  components?: string[];
  namedFields?: Record<string, string | null>;
  comment?: string;
  tickets?: Array<{
    summary: string;
    description?: string;
    issueType: string;
    labels: string[];
    storyPoints?: number;
    priority: string;
    parentKey?: string;
    components: string[];
    namedFields?: Record<string, string>;
  }>;
  confirmed?: boolean;
  jql?: string;
  maxResults?: number;
  parent?: string;
  rankBefore?: string;
  rankAfter?: string;
  epicKey?: string;
  status?: string;
  assignee?: string;
  links?: Array<{ targetKey: string; linkType: string; direction: "inward" | "outward" }>;
  removeLinks?: Array<{ targetKey: string; linkType: string }>;
  spaceKey?: string;
}

// ── Update helpers ───────────────────────────────────────────────────────────

function collectFieldChanges(params: IssueParams, parentKey: string | undefined): string[] {
  return [
    params.summary ? `Summary: ${params.summary}` : "",
    params.description ? "Description: updated" : "",
    params.priority ? `Priority: ${params.priority}` : "",
    params.labels ? `Labels: ${params.labels.join(", ")}` : "",
    params.storyPoints == null ? "" : `Story Points: ${params.storyPoints}`,
    params.components ? `Components: ${params.components.join(", ")}` : "",
    params.namedFields ? `Custom fields: ${Object.keys(params.namedFields).join(", ")}` : "",
    parentKey ? `Parent: ${parentKey}` : "",
    params.comment ? "Comment: added" : "",
  ].filter(Boolean);
}

function hasFieldUpdates(params: IssueParams, parentKey: string | undefined): boolean {
  return (
    params.summary != null ||
    params.description != null ||
    params.priority != null ||
    params.labels != null ||
    params.storyPoints != null ||
    params.components != null ||
    params.namedFields != null ||
    params.comment != null ||
    parentKey != null
  );
}

async function applyStatusTransition(
  jira: InstanceType<typeof JiraClient>,
  issueKey: string,
  status: string,
  changes: string[],
) {
  const transitions = await jira.getTransitions(issueKey);
  const match = transitions.find((t) => t.name.toLowerCase() === status.toLowerCase());
  if (!match) {
    const available = transitions.map((t) => t.name).join(", ");
    return errorResponse(`No transition matching "${status}" for ${issueKey}. Available: ${available}`);
  }
  await jira.transitionIssue(issueKey, match.id);
  changes.push(`Status: transitioned via "${match.name}"`);
  return null;
}

async function applyAssignee(
  jira: InstanceType<typeof JiraClient>,
  issueKey: string,
  assignee: string,
  changes: string[],
) {
  const accountId = assignee === "unassigned" ? null : assignee;
  await jira.assignIssue(issueKey, accountId);
  changes.push(`Assignee: ${assignee === "unassigned" ? "cleared" : assignee}`);
}

async function applyLinks(
  jira: InstanceType<typeof JiraClient>,
  issueKey: string,
  links: NonNullable<IssueParams["links"]>,
  changes: string[],
) {
  for (const link of links) {
    const inward = link.direction === "inward" ? issueKey : link.targetKey;
    const outward = link.direction === "inward" ? link.targetKey : issueKey;
    await jira.linkIssues(inward, outward, link.linkType);
  }
  changes.push(`Links: ${links.length} link(s) created`);
}

async function applyRemoveLinks(
  jira: InstanceType<typeof JiraClient>,
  issueKey: string,
  removeLinks: NonNullable<IssueParams["removeLinks"]>,
  changes: string[],
) {
  const existingLinks = await jira.getIssueLinks(issueKey);
  let removed = 0;
  for (const toRemove of removeLinks) {
    const match = existingLinks.find((l) => l.type === toRemove.linkType && l.linkedIssue.key === toRemove.targetKey);
    if (match) {
      await jira.removeIssueLink(match.id);
      removed++;
    }
  }
  changes.push(`Links: ${removed} link(s) removed`);
}

async function applyRanking(
  jira: InstanceType<typeof JiraClient>,
  issueKey: string,
  rankBefore: string | undefined,
  rankAfter: string | undefined,
  changes: string[],
) {
  await (
    jira as unknown as {
      rankIssue(key: string, opts: { rankBefore?: string; rankAfter?: string }): Promise<void>;
    }
  ).rankIssue(issueKey, {
    ...(rankBefore ? { rankBefore } : {}),
    ...(rankAfter ? { rankAfter } : {}),
  });
  const rankDesc = rankBefore ? `before ${rankBefore}` : `after ${rankAfter}`;
  changes.push(`Ranked: ${rankDesc}`);
}

// ── Action handlers ──────────────────────────────────────────────────────────

async function handleUpdateAction(params: IssueParams, kb: KnowledgeBase) {
  if (!params.issueKey) return errorResponse("issueKey is required for 'update' action.");
  try {
    const { jira, config } = buildJiraClient(kb);
    const parentKey = params.parent || params.parentKey;

    if (hasFieldUpdates(params, parentKey)) {
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
    const changes = collectFieldChanges(params, parentKey);

    if (params.status) {
      const err = await applyStatusTransition(jira, params.issueKey, params.status, changes);
      if (err) return err;
    }

    if (params.assignee) {
      await applyAssignee(jira, params.issueKey, params.assignee, changes);
    }

    if (params.links?.length) {
      await applyLinks(jira, params.issueKey, params.links, changes);
    }

    if (params.removeLinks?.length) {
      await applyRemoveLinks(jira, params.issueKey, params.removeLinks, changes);
    }

    if (params.rankBefore || params.rankAfter) {
      await applyRanking(jira, params.issueKey, params.rankBefore, params.rankAfter, changes);
    }

    const changesList = changes.map((c) => `- ${c}`).join("\n");
    let response = `Updated **${params.issueKey}** — ${url}\n\nChanges:\n${changesList}`;

    // Enrichment gap check
    try {
      const updated = await jira.getIssue(params.issueKey);
      const schema = JiraClient.loadSchemaFromDb(kb);
      const spFieldId = schema?.board?.estimationField;
      const { gaps, suggestions } = checkEnrichmentGaps(
        { fields: updated as unknown as Record<string, unknown> },
        spFieldId,
      );
      if (gaps.length > 0) {
        response += `\n\n## Enrichment Suggestions\n`;
        for (let i = 0; i < gaps.length; i++) {
          response += `\n- **${gaps[i]}**\n  ${suggestions[i]}\n`;
        }
      }
    } catch {
      // best-effort enrichment check
    }

    return textResponse(response);
  } catch (err: unknown) {
    return errorResponse(`Failed to update ${params.issueKey}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── Tool Registration ─────────────────────────────────────────────────────────

export function registerIssuesTool(server: McpServer, getKb: () => KnowledgeBase) {
  server.registerTool(
    "issues",
    {
      description:
        "Jira issue CRUD. 'create' returns preview first — set confirmed=true only after user approval. Pass tickets array for bulk, epicKey without summary to decompose. Actions: 'get' fetch issue(s). 'create' single/bulk/decompose. 'update' fields/status/assignee/links. 'search' JQL query. Use 'insights' for analytics, 'bugs' for triage, 'backlog' for ranking, 'sprints' for sprint ops.",
      inputSchema: z.object({
        action: z.enum(["get", "create", "update", "search"]),
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
        parentKey: z.string().optional().describe("[create] Parent epic key, e.g. 'BP-10'. Alias for 'parent'"),
        components: z.array(z.string()).optional().describe("[create, update] Component names"),
        namedFields: z
          .record(z.string(), z.union([z.string(), z.null()]))
          .optional()
          .describe("[create, update] Custom fields as {'Field Name': 'Value Name'}. Pass null to clear a field."),
        comment: z.string().optional().describe("[update] Add a comment to the issue"),
        // bulk-create (via create action with tickets array)
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
            .describe("[create] Array of ticket objects for bulk creation"),
        ),
        confirmed: z
          .preprocess(boolPreprocess, z.boolean().default(false))
          .optional()
          .describe(
            "[create] ONLY set true AFTER showing the preview to the user AND receiving their explicit approval. Default false (preview only). NEVER set true on the first call.",
          ),
        // search
        jql: z.string().optional().describe("[search] JQL query string"),
        maxResults: z.number().max(100).default(50).optional().describe("[search] Max issues to return"),
        // parent epic
        parent: z.string().optional().describe("[create, update] Parent epic key, e.g. 'BP-10'"),
        // ranking
        rankBefore: z.string().optional().describe("[update] Rank this issue before the specified issue key"),
        rankAfter: z.string().optional().describe("[update] Rank this issue after the specified issue key"),
        // decompose (via create action with epicKey and no summary)
        epicKey: z.string().optional().describe("[create] Epic key for decomposition — pass without summary"),
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
        removeLinks: z
          .array(
            z.object({
              targetKey: z.string().describe("Issue key of the linked issue to remove"),
              linkType: z.string().describe("Link type name, e.g. 'Blocks', 'Relates'"),
            }),
          )
          .optional()
          .describe("[update] Remove issue links by target key and link type"),
        spaceKey: z.string().optional().describe("[create] Confluence space key to search for relevant context"),
      }),
    },
    async (params) => {
      const kb = getKb();

      switch (params.action) {
        case "get":
          return handleGetAction(params, kb);
        case "create": {
          if (params.tickets && params.tickets.length > 0) return handleBulkCreateAction(params, kb);
          if (params.epicKey && !params.summary) return handleDecomposeAction(params, kb);
          return handleCreateAction(params, kb);
        }
        case "update":
          return handleUpdateAction(params, kb);
        case "search":
          return handleSearchAction(params, kb);
        default:
          return errorResponse(`Unknown action: ${params.action}`);
      }
    },
  );
}
