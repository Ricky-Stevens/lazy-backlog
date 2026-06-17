import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { errorResponse, resolveConfig, textResponse } from "../lib/config.js";
import { ConfluenceClient } from "../lib/confluence.js";
import type { KnowledgeBase } from "../lib/db.js";
import { Spider } from "../lib/indexer.js";
import { handlePublish } from "./confluence-publish.js";

// Barrel re-exports so tests / callers that imported from this file keep working.
export {
  ALLOW_ALL_SPACES_SENTINEL,
  buildPublishPreview,
  buildTransformationSummary,
  disallowedSpaceMessage,
  handlePublish,
  isSpaceAllowed,
} from "./confluence-publish.js";

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
    if (result.errors.length > 5) lines.push(`  …and ${result.errors.length - 5} more`);
  }

  const stats = kb.getStats();
  const typeBreakdown = Object.entries(stats.byType)
    .map(([k, v]) => `${k}:${v}`)
    .join(" ");
  lines.push(`\nKB total: ${stats.total} pages`, `Types: ${typeBreakdown}`);

  if (params.force) {
    lines.push("FTS index rebuilt.");
  }

  // Indexing quality report
  if (result.indexed > 0 && stats.total > 0) {
    const typeEntries = Object.entries(stats.byType);
    const otherCount = stats.byType.other ?? 0;
    const typeSummary = typeEntries
      .filter(([k]) => k !== "other")
      .map(([k, v]) => `${v} ${k}s`)
      .join(", ");
    const qualityParts = [typeSummary];
    if (otherCount > 0) {
      qualityParts.push(`${otherCount} classified 'other' — consider reviewing classification`);
    }
    lines.push(`\n**Quality:** ${qualityParts.join(". ")}.`);
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
        "Confluence source connector and write-back. Use 'spider' to crawl and index pages. Use 'list-spaces' to discover spaces. Use 'publish' to \"create page\" or \"update page\" from markdown — preview-and-confirm gated (never auto-writes). Publish is scoped to the configured `confluenceSpaces` allow-list: writes are fail-closed when the list is empty (use ['*'] to allow all). To search indexed content, use the 'knowledge' tool.",
      inputSchema: z.object({
        action: z.enum(["spider", "list-spaces", "publish"]),
        spaceKey: z.string().optional().describe("[spider|publish] Confluence space key"),
        rootPageId: z.string().optional().describe("[spider] Start crawling from this page ID"),
        maxDepth: z.number().default(10).describe("[spider] Max page tree depth to crawl"),
        maxConcurrency: z.number().default(5).describe("[spider] Parallel HTTP fetches"),
        includeLabels: z.array(z.string()).default([]).describe("[spider] Only index pages with these labels"),
        excludeLabels: z.array(z.string()).default([]).describe("[spider] Skip pages with these labels"),
        force: z.boolean().default(false).describe("[spider] Drop and rebuild the full-text index before crawling"),
        pageId: z.string().optional().describe("[publish] Existing page ID to update (omit to create new)"),
        title: z.string().optional().describe("[publish] Page title (required on create)"),
        content: z.string().optional().describe("[publish] Markdown content to convert and publish"),
        parentId: z.string().optional().describe("[publish] Optional parent page ID for new pages"),
        confirm: z.boolean().default(false).describe("[publish] Set true to write. False returns a preview only."),
      }),
    },
    async (params) => {
      const kb = getKb();

      switch (params.action) {
        case "spider":
          return handleSpider(params, kb);
        case "list-spaces":
          return handleListSpaces(kb);
        case "publish":
          return handlePublish(
            {
              spaceKey: params.spaceKey,
              pageId: params.pageId,
              title: params.title,
              content: params.content ?? "",
              parentId: params.parentId,
              confirm: params.confirm,
            },
            kb,
          );
        default: {
          const _exhaustive: never = params.action;
          return errorResponse(`Unknown action: ${_exhaustive}`);
        }
      }
    },
  );
}
