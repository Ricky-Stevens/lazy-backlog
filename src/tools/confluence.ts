import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { errorResponse, resolveConfig, textResponse } from "../lib/config.js";
import { ConfluenceClient } from "../lib/confluence.js";
import type { KnowledgeBase } from "../lib/db.js";
import { Spider } from "../lib/indexer.js";

// ── Types ────────────────────────────────────────────────────────────────────

type ToolResponse = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

// ── Action Handlers ──────────────────────────────────────────────────────────

async function handleSpider(
  params: {
    spaceKey?: string;
    rootPageId?: string;
    maxDepth: number;
    maxConcurrency: number;
    includeLabels: string[];
    excludeLabels: string[];
    force: boolean;
  },
  kb: KnowledgeBase,
): Promise<ToolResponse> {
  let config: ReturnType<typeof resolveConfig>;
  try {
    config = resolveConfig(kb);
  } catch (err: unknown) {
    return errorResponse(String(err));
  }

  if (params.force) {
    kb.rebuildFts();
  }

  const client = new ConfluenceClient(config);
  const spider = new Spider(client, kb);
  const result = await spider.crawl({
    spaceKey: params.spaceKey,
    rootPageId: params.rootPageId,
    maxDepth: params.maxDepth,
    maxConcurrency: params.maxConcurrency,
    includeLabels: params.includeLabels,
    excludeLabels: params.excludeLabels,
  });

  const lines = [`Indexed: ${result.indexed} | Unchanged: ${result.unchanged} | Skipped: ${result.skipped}`];

  if (result.errors.length > 0) {
    lines.push(`Errors (${result.errors.length}):`);
    for (const e of result.errors.slice(0, 5)) lines.push(`  ${e}`);
    if (result.errors.length > 5) lines.push(`  \u2026and ${result.errors.length - 5} more`);
  }

  const stats = kb.getStats();
  const typeBreakdown = Object.entries(stats.byType)
    .map(([k, v]) => `${k}:${v}`)
    .join(" ");
  lines.push(`\nKB total: ${stats.total} pages`, `Types: ${typeBreakdown}`);

  if (params.force) {
    lines.push("FTS index rebuilt.");
  }

  return textResponse(lines.join("\n"));
}

async function handleListSpaces(kb: KnowledgeBase): Promise<ToolResponse> {
  let config: ReturnType<typeof resolveConfig>;
  try {
    config = resolveConfig(kb);
  } catch (err: unknown) {
    return errorResponse(String(err));
  }

  const client = new ConfluenceClient(config);
  const spaces = await client.getSpaces();

  if (spaces.length === 0) return textResponse("No spaces found.");
  const text = spaces.map((s) => `${s.key}: ${s.name} (${s.type})`).join("\n");
  return textResponse(text);
}

// ── Tool Registration ────────────────────────────────────────────────────────

export function registerConfluenceTool(server: McpServer, getKb: () => KnowledgeBase) {
  server.registerTool(
    "confluence",
    {
      description:
        "Confluence source connector. Use 'spider' to crawl and index Confluence pages into the knowledge base. Use 'list-spaces' to discover available spaces. To search or browse indexed content, use the 'knowledge' tool.",
      inputSchema: z.object({
        action: z.enum(["spider", "list-spaces"]),
        spaceKey: z.string().optional().describe("[spider] Confluence space key to target"),
        rootPageId: z.string().optional().describe("[spider] Start crawling from this page ID"),
        maxDepth: z.number().default(10).describe("[spider] Max page tree depth to crawl"),
        maxConcurrency: z.number().default(5).describe("[spider] Parallel HTTP fetches"),
        includeLabels: z.array(z.string()).default([]).describe("[spider] Only index pages with these labels"),
        excludeLabels: z.array(z.string()).default([]).describe("[spider] Skip pages with these labels"),
        force: z.boolean().default(false).describe("[spider] Drop and rebuild the full-text index before crawling"),
      }),
    },
    async (params) => {
      const kb = getKb();

      switch (params.action) {
        case "spider":
          return handleSpider(params, kb);
        case "list-spaces":
          return handleListSpaces(kb);
        default: {
          const _exhaustive: never = params.action;
          return errorResponse(`Unknown action: ${_exhaustive}`);
        }
      }
    },
  );
}
