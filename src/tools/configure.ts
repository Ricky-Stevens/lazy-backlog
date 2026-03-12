import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { adfToText } from "../lib/adf.js";
import { errorResponse, resolveConfig, textResponse } from "../lib/config.js";
import { ConfluenceClient } from "../lib/confluence.js";
import type { KnowledgeBase } from "../lib/db.js";
import { Spider } from "../lib/indexer.js";
import { JiraClient, type JiraSchema } from "../lib/jira.js";
import { analyzeBacklog } from "../lib/team-rules.js";
import { learnTeamConventions } from "./configure-helpers.js";

// ── Types ────────────────────────────────────────────────────────────────────

type ToolResponse = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatSchemaResult(schema: JiraSchema): string {
  const types = schema.issueTypes.map((t) => t.name).join(", ");
  const fields = schema.issueTypes.reduce((n, t) => n + t.fields.length, 0);
  const lines = [
    `${schema.projectName} (${schema.projectKey}):`,
    `- ${schema.issueTypes.length} issue types: ${types}`,
    `- ${fields} fields mapped`,
    `- ${schema.priorities.length} priorities`,
  ];
  if (schema.board) {
    lines.push(`- Board: ${schema.board.name} (${schema.board.type})`);
    if (schema.board.teamName) lines.push(`- Team: ${schema.board.teamName}`);
  }
  return lines.join("\n");
}

async function spiderSpaces(
  config: ReturnType<typeof resolveConfig>,
  kb: KnowledgeBase,
  spaceKeys: string[],
  maxDepth: number,
): Promise<string> {
  const client = new ConfluenceClient(config);
  const spider = new Spider(client, kb);
  let indexed = 0;
  let unchanged = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const spaceKey of spaceKeys) {
    const r = await spider.crawl({ spaceKey, maxDepth, maxConcurrency: 5, includeLabels: [], excludeLabels: [] });
    indexed += r.indexed;
    unchanged += r.unchanged;
    skipped += r.skipped;
    errors.push(...r.errors);
  }

  const stats = kb.getStats();
  const lines = [
    `Indexed: ${indexed} | Unchanged: ${unchanged} | Skipped: ${skipped}`,
    `KB total: ${stats.total} pages`,
    `Types: ${Object.entries(stats.byType)
      .map(([k, v]) => `${k}:${v}`)
      .join(" ")}`,
  ];
  if (errors.length > 0) lines.push(`Errors: ${errors.length} (first: ${errors[0]})`);
  return lines.join("\n");
}

// ── Action Handlers ──────────────────────────────────────────────────────────

function handleSet(
  params: {
    jiraProjectKey?: string;
    jiraBoardId?: string;
    confluenceSpaces?: string[];
    rootPageIds?: string[];
  },
  kb: KnowledgeBase,
): ToolResponse {
  if (!process.env.ATLASSIAN_SITE_URL || !process.env.ATLASSIAN_EMAIL || !process.env.ATLASSIAN_API_TOKEN) {
    return errorResponse(
      "Atlassian auth not configured. Set ATLASSIAN_SITE_URL, ATLASSIAN_EMAIL, ATLASSIAN_API_TOKEN as env vars in your MCP server config.",
    );
  }

  const existing = kb.getConfig("atlassian");
  let current: Record<string, unknown> = {};
  if (existing) {
    try {
      current = JSON.parse(existing);
    } catch {
      /* fresh start */
    }
  }

  if (params.jiraProjectKey !== undefined) current.jiraProjectKey = params.jiraProjectKey;
  if (params.jiraBoardId !== undefined) current.jiraBoardId = params.jiraBoardId;
  if (params.confluenceSpaces !== undefined) current.confluenceSpaces = params.confluenceSpaces;
  if (params.rootPageIds !== undefined) current.rootPageIds = params.rootPageIds;

  kb.setConfig("atlassian", JSON.stringify(current));

  const parts: string[] = [];
  if (typeof current.jiraProjectKey === "string") parts.push(`Project: ${current.jiraProjectKey}`);
  if (typeof current.jiraBoardId === "string") parts.push(`Board: ${current.jiraBoardId}`);
  const spaces = (current.confluenceSpaces as string[])?.join(", ");
  if (spaces) parts.push(`Spaces: ${spaces}`);

  return textResponse(`Saved. ${parts.join(" | ") || "No settings changed."}`);
}

function handleGet(kb: KnowledgeBase): ToolResponse {
  let config: ReturnType<typeof resolveConfig>;
  try {
    config = resolveConfig(kb);
  } catch (err: unknown) {
    return errorResponse(String(err));
  }

  const maskedUrl = config.siteUrl
    .replace(/\/\/([^.]+)\./, "//***.")
    .replace(/\.atlassian\.net[^\s]*/, ".atlassian.net");
  const lines: string[] = ["# Current Configuration\n"];

  const envOrDb = (envKey: string, value: string | undefined): string => {
    if (process.env[envKey]) return `${value} (env: ${envKey})`;
    return value ? `${value} (SQLite)` : "(not set)";
  };

  lines.push(
    `**Site URL:** ${maskedUrl} (env: ATLASSIAN_SITE_URL)`,
    `**Email:** ${config.email} (env: ATLASSIAN_EMAIL)`,
    `**Jira Project Key:** ${envOrDb("JIRA_PROJECT_KEY", config.jiraProjectKey)}`,
    `**Jira Board ID:** ${envOrDb("JIRA_BOARD_ID", config.jiraBoardId)}`,
    `**Confluence Spaces:** ${config.confluenceSpaces.length > 0 ? config.confluenceSpaces.join(", ") : "(none)"}${process.env.CONFLUENCE_SPACES ? " (env: CONFLUENCE_SPACES)" : " (SQLite)"}`,
    `**Root Page IDs:** ${config.rootPageIds.length > 0 ? config.rootPageIds.join(", ") : "(none)"}`,
  );

  const schema = JiraClient.loadSchemaFromDb(kb);
  const stats = kb.getStats();
  const teamRules = kb.getTeamRules();
  const allInsights = kb.getAllInsights();

  const schemaStatus = schema
    ? `Discovered (${schema.issueTypes.length} types)`
    : "Not run — use configure action='setup'";
  const kbStatus = stats.total > 0 ? `${stats.total} pages indexed` : "Empty";
  const rulesStatus = teamRules.length > 0 ? `${teamRules.length} rules learned` : "Not analyzed";
  const insightsStatus =
    allInsights.length > 0
      ? `${allInsights.length} insights stored — use insights action='team-profile' to view`
      : "Not analyzed";

  lines.push(
    "",
    "## Setup Status",
    `**Jira Schema:** ${schemaStatus}`,
    `**Confluence KB:** ${kbStatus}`,
    `**Team Conventions:** ${rulesStatus}`,
    `**Team Intelligence:** ${insightsStatus}`,
  );

  return textResponse(lines.join("\n"));
}

function validateSetupParams(
  projectKey: string | undefined,
  boardId: string | undefined,
  spaces: string[],
): ToolResponse | null {
  const missing: string[] = [];
  if (!projectKey) {
    missing.push("1. **projectKey** (REQUIRED): Jira project key — the prefix on ticket IDs, e.g. 'BP', 'ENG'");
  }
  if (!boardId) {
    missing.push(
      "2. **boardId** (recommended): Jira board ID — found in the board URL /board/123. Needed for sprint management",
    );
  }
  if (spaces.length === 0) {
    missing.push(
      "3. **spaceKeys** (recommended): Confluence space keys to spider for project context, e.g. ['ENG','PM']. " +
        "Spidering Confluence is what makes ticket planning context-aware. Say 'none' only if you don't use Confluence",
    );
  }
  if (missing.length > 0 && !projectKey) {
    return errorResponse(
      "Setup needs more info. Ask the user for:\n" +
        missing.join("\n") +
        "\n\nThen call: configure action='setup' projectKey='...' boardId='...' spaceKeys=['...']",
    );
  }
  return null;
}

function persistSetupConfig(
  kb: KnowledgeBase,
  projectKey: string,
  boardId: string | undefined,
  spaces: string[],
): void {
  const existing = kb.getConfig("atlassian");
  let current: Record<string, unknown> = {};
  if (existing) {
    try {
      current = JSON.parse(existing);
    } catch {
      /* fresh start */
    }
  }
  current.jiraProjectKey = projectKey;
  if (boardId) current.jiraBoardId = boardId;
  if (spaces.length > 0) current.confluenceSpaces = spaces;
  kb.setConfig("atlassian", JSON.stringify(current));
}

async function runConfluencePhase(
  config: ReturnType<typeof resolveConfig>,
  kb: KnowledgeBase,
  spaces: string[],
  maxDepth: number,
  output: string[],
): Promise<void> {
  if (spaces.length > 0) {
    try {
      output.push(`## Confluence\n${await spiderSpaces(config, kb, spaces, maxDepth)}\n`);
    } catch (err: unknown) {
      output.push(`## Confluence: FAILED\n${err instanceof Error ? err.message : String(err)}\n`);
    }
  } else {
    output.push(
      "## Confluence\n**Not configured.** Confluence context makes ticket planning much richer. " +
        "To enable, re-run setup with spaceKeys or set the CONFLUENCE_SPACES env var.\n",
    );
  }
}

async function handleSetup(
  params: {
    projectKey?: string;
    boardId?: string;
    spaceKeys?: string[];
    maxDepth: number;
    maxTickets: number;
    qualityThreshold: number;
  },
  kb: KnowledgeBase,
): Promise<ToolResponse> {
  let config: ReturnType<typeof resolveConfig>;
  try {
    config = resolveConfig(kb);
  } catch (err: unknown) {
    return errorResponse(String(err));
  }

  const output: string[] = ["# Setup Results\n"];
  const projectKey = params.projectKey || config.jiraProjectKey;
  const boardId = params.boardId || config.jiraBoardId;
  const spaces = params.spaceKeys || config.confluenceSpaces || [];

  const validationError = validateSetupParams(projectKey, boardId, spaces);
  if (validationError) return validationError;

  const resolvedProjectKey = projectKey as string;
  persistSetupConfig(kb, resolvedProjectKey, boardId, spaces);

  // Phase 1: Jira Schema Discovery
  let schema: JiraSchema | null = null;
  try {
    schema = await JiraClient.discoverSchema(config, resolvedProjectKey, boardId);
    JiraClient.saveSchemaToDb(kb, schema);
    output.push(`## Jira Schema\n${formatSchemaResult(schema)}\n`);
  } catch (err: unknown) {
    return errorResponse(`Jira discovery failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Phase 2: Confluence Spider
  await runConfluencePhase(config, kb, spaces, params.maxDepth, output);

  // Phase 3: Learn Team Conventions
  try {
    const jira = new JiraClient({ ...config, jiraProjectKey: resolvedProjectKey }, schema);
    output.push(
      await learnTeamConventions(
        { jira, analyzeBacklog, adfToText },
        kb,
        resolvedProjectKey,
        params.maxTickets,
        params.qualityThreshold,
        boardId,
      ),
    );
  } catch (err: unknown) {
    output.push(`## Team Conventions: FAILED\n${err instanceof Error ? err.message : String(err)}\n`);
  }

  output.push("---\nSetup complete. You can now use **issues**, **sprints**, **plan**, and **confluence** tools.");
  return textResponse(output.join("\n"));
}

// ── Tool Registration ────────────────────────────────────────────────────────

export function registerConfigureTool(server: McpServer, getKb: () => KnowledgeBase) {
  server.registerTool(
    "configure",
    {
      description:
        "Project configuration. Actions: 'setup' — REQUIRED before using any other tool. Needs projectKey, boardId, and spaceKeys (Confluence). If any are missing, ask the user for ALL THREE before calling. Discovers Jira schema, spiders Confluence pages for context, and learns team conventions from existing tickets. 'set' — save individual settings. 'get' — view current config and setup status. After setup, use 'issues' for issue CRUD, 'bugs' for bug workflows, 'backlog' for backlog management, 'sprints' for sprint ops, 'insights' for team intelligence + velocity + retros + epic progress, 'knowledge' for KB search, 'confluence' for wiki crawling.",
      inputSchema: z.object({
        action: z.enum(["setup", "set", "get"]),
        jiraProjectKey: z.string().optional().describe("[set] Jira project key, e.g. 'BP'"),
        jiraBoardId: z.string().optional().describe("[set] Jira board ID, e.g. '266'"),
        confluenceSpaces: z
          .array(z.string())
          .optional()
          .describe("[set] Confluence space keys to index, e.g. ['ENG','PM']"),
        rootPageIds: z.array(z.string()).optional().describe("[set] Specific Confluence page IDs to spider from"),
        projectKey: z
          .string()
          .optional()
          .describe("[setup] Jira project key (REQUIRED — from env JIRA_PROJECT_KEY or pass here)"),
        boardId: z
          .string()
          .optional()
          .describe("[setup] Jira board ID (optional — from env JIRA_BOARD_ID or pass here)"),
        spaceKeys: z.preprocess(
          (val) => (typeof val === "string" ? JSON.parse(val) : val),
          z
            .array(z.string())
            .optional()
            .describe(
              "[setup] Confluence space keys to spider (from env CONFLUENCE_SPACES or pass here). Omit or pass empty array to skip Confluence",
            ),
        ),
        maxDepth: z.number().default(10).describe("[setup] Max Confluence page tree depth"),
        maxTickets: z.number().default(200).describe("[setup] Max recent tickets to analyze for team conventions"),
        qualityThreshold: z
          .number()
          .default(60)
          .describe("[setup] Min quality score (0-100) for a ticket to be used as a convention pattern"),
      }),
    },
    async (params) => {
      const kb = getKb();

      switch (params.action) {
        case "set":
          return handleSet(params, kb);
        case "get":
          return handleGet(kb);
        case "setup":
          return handleSetup(params, kb);
      }
    },
  );
}
