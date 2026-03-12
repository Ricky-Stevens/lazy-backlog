import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { errorResponse, formatLabels, textResponse } from "../lib/config.js";
import type { KnowledgeBase, PageSummary } from "../lib/db.js";

// ── Types ────────────────────────────────────────────────────────────────────

type ToolResponse = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

// ── Constants ────────────────────────────────────────────────────────────────

export const MAX_PAGE_CHARS = 15_000;
export const MAX_CONTEXT_CHARS = 20_000;

// ── Helpers ──────────────────────────────────────────────────────────────────

export function formatSummaryLine(s: PageSummary): string {
  const preview = s.content_preview.replaceAll("\n", " ").trim();
  return `- **${s.title}** (${s.space_key}) [${formatLabels(s.labels)}]\n  ${preview}\u2026`;
}

export function appendSection(
  pages: PageSummary[],
  heading: string,
  maxItems: number,
  budget: number,
  emit: (s: string) => void,
): number {
  if (pages.length === 0 || budget <= 0) return budget;

  const header = `## ${heading} (${pages.length})\n\n`;
  emit(header);
  budget -= header.length;

  const items = pages.slice(0, maxItems);
  for (let i = 0; i < items.length; i++) {
    if (budget <= 100) {
      emit(`\u2026and ${pages.length - i} more\n\n`);
      break;
    }
    const p = items[i];
    if (!p) continue;
    const entry = `### ${p.title}\n${p.content_preview.trim()}\n\n`;
    emit(entry);
    budget -= entry.length;
  }

  return budget;
}

// ── Action Handlers ──────────────────────────────────────────────────────────

function handleSearch(
  params: { query: string; pageType?: string; spaceKey?: string; source?: string; limit: number },
  kb: KnowledgeBase,
): ToolResponse {
  const limit = Math.min(params.limit, 10);

  const chunks = kb.searchChunks(params.query, {
    pageType: params.pageType,
    spaceKey: params.spaceKey,
    source: params.source,
    limit,
  });

  if (chunks.length > 0) {
    const lines = chunks.map((c, i) => {
      const location = c.breadcrumb || c.heading || c.page_title;
      const urlSuffix = c.url ? ` ${c.url}` : "";
      return `${i + 1}. **${c.page_title}** \u203A ${location} [${c.page_type}]${urlSuffix}\n   ${c.snippet}`;
    });

    return textResponse(
      `${chunks.length} results (section-level):\n\n${lines.join("\n\n")}` +
        "\n\nUse **get-page** with a page ID for full content if needed.",
    );
  }

  const results = kb.search(params.query, {
    pageType: params.pageType,
    spaceKey: params.spaceKey,
    source: params.source,
    limit,
  });

  if (results.length === 0) return textResponse(`No results for "${params.query}".`);

  const lines = results.map((r, i) => {
    const urlSuffix = r.url ? ` ${r.url}` : "";
    return `${i + 1}. **${r.title}** [${r.page_type}]${urlSuffix}\n   ${r.snippet}`;
  });

  return textResponse(`${results.length} results:\n\n${lines.join("\n\n")}`);
}

function handleStats(
  params: { source?: string; spaceKey?: string; summarize: boolean },
  kb: KnowledgeBase,
): ToolResponse {
  const stats = kb.getStats();
  if (stats.total === 0) return textResponse("Knowledge base is empty.");

  if (params.summarize) {
    return handleSummarize(params, kb);
  }

  const types = Object.entries(stats.byType)
    .map(([k, v]) => `  ${k}: ${v}`)
    .join("\n");
  const spaces = Object.entries(stats.bySpace)
    .map(([k, v]) => `  ${k}: ${v}`)
    .join("\n");

  let out = `Total: ${stats.total}\n\nBy type:\n${types}\n\nBy space:\n${spaces}`;

  if (stats.bySource) {
    const sources = Object.entries(stats.bySource)
      .map(([k, v]) => `  ${k}: ${v}`)
      .join("\n");
    out += `\n\nBy source:\n${sources}`;
  }

  return textResponse(out);
}

function handleSummarize(params: { spaceKey?: string; source?: string }, kb: KnowledgeBase): ToolResponse {
  const stats = kb.getStats();
  if (stats.total === 0) return errorResponse("Knowledge base empty. Index content first.");

  const adrs = kb.getPageSummaries("adr", params.spaceKey, params.source);
  const designs = kb.getPageSummaries("design", params.spaceKey, params.source);
  const specs = kb.getPageSummaries("spec", params.spaceKey, params.source);

  let out = "# Project Context\n";
  out += `${stats.total} pages | ${Object.entries(stats.byType)
    .map(([k, v]) => `${k}:${v}`)
    .join(" ")}\n\n`;

  let budget = MAX_CONTEXT_CHARS - out.length;

  budget = appendSection(adrs, "ADRs", 20, budget, (s) => {
    out += s;
  });
  budget = appendSection(designs, "Design Docs", 10, budget, (s) => {
    out += s;
  });
  appendSection(specs, "Specs", 10, budget, (s) => {
    out += s;
  });

  return textResponse(out);
}

function handleGetPage(params: { pageId?: string }, kb: KnowledgeBase): ToolResponse {
  if (!params.pageId) return errorResponse("'pageId' is required for get-page action.");
  const page = kb.getPage(params.pageId);
  if (!page) return errorResponse(`Page ${params.pageId} not found in knowledge base.`);

  const body =
    page.content.length > MAX_PAGE_CHARS
      ? `${page.content.slice(0, MAX_PAGE_CHARS)}\n\n\u2026[truncated \u2014 ${page.content.length} chars total]`
      : page.content;

  return textResponse(
    `# ${page.title}\n` +
      `${page.page_type} | ${page.space_key} | ${formatLabels(page.labels)} | ${page.updated_at ?? "?"}\n` +
      (page.url ? `${page.url}\n` : "") +
      `---\n${body}`,
  );
}

function handleStaleDocs(
  params: { staleDays: number; spaceKey?: string; pageType?: string; source?: string },
  kb: KnowledgeBase,
): ToolResponse {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - params.staleDays);
  const cutoffStr = cutoff.toISOString();

  const stalePages = kb.getStalePages(cutoffStr, {
    spaceKey: params.spaceKey,
    pageType: params.pageType,
    source: params.source,
  });

  if (stalePages.length === 0) {
    return textResponse(`No pages older than ${params.staleDays} days found.`);
  }

  const lines = stalePages.map((p) => {
    const daysAgo = Math.floor((Date.now() - new Date(p.updated_at ?? p.indexed_at).getTime()) / (1000 * 60 * 60 * 24));
    return `- **${p.title}** (${p.space_key}) [${p.page_type}] \u2014 ${daysAgo}d ago`;
  });

  return textResponse(`${stalePages.length} stale pages (>${params.staleDays}d):\n\n${lines.join("\n")}`);
}

function handleWhatChanged(params: { since: string; source?: string }, kb: KnowledgeBase): ToolResponse {
  const pages = kb.getRecentlyIndexed(params.since, params.source);

  if (pages.length === 0) {
    return textResponse(`No changes since ${params.since.slice(0, 10)}.`);
  }

  const lines = pages.map((p) => {
    return `- **${p.title}** (${p.space_key}) [${p.page_type}] indexed ${p.indexed_at.slice(0, 10)}`;
  });

  return textResponse(`${pages.length} pages changed since ${params.since.slice(0, 10)}:\n\n${lines.join("\n")}`);
}

// ── Tool Registration ────────────────────────────────────────────────────────

export function registerKnowledgeTool(server: McpServer, getKb: () => KnowledgeBase) {
  server.registerTool(
    "knowledge",
    {
      description:
        "Knowledge base operations. Search indexed content from all sources (Confluence, GitHub, etc.). Use 'search' for full-text queries, 'get-page' for full content, 'stats' for KB overview, 'stale-docs' for outdated content, 'what-changed' for recent updates.",
      inputSchema: z.object({
        action: z.enum(["search", "stats", "get-page", "stale-docs", "what-changed"]),
        query: z.string().optional().describe("[search] Full-text search query"),
        pageId: z.string().optional().describe("[get-page] Page ID to retrieve"),
        source: z.string().optional().describe("Filter by source (e.g. 'confluence', 'github')"),
        pageType: z
          .enum(["adr", "design", "runbook", "meeting", "spec", "other"])
          .optional()
          .describe("Filter results by page type"),
        spaceKey: z.string().optional().describe("Filter by namespace/space key"),
        limit: z.number().default(5).describe("[search] Max results to return"),
        summarize: z
          .boolean()
          .default(false)
          .describe("[search, stats] Return a context summary (ADRs, designs, specs) instead of raw results"),
        staleDays: z
          .number()
          .default(90)
          .describe("[stale-docs] Pages not updated in this many days are considered stale"),
        since: z.string().optional().describe("[what-changed] ISO date — only show pages changed after this date"),
      }),
    },
    async (params) => {
      const kb = getKb();

      switch (params.action) {
        case "search": {
          if (!params.query) {
            return handleStats(params, kb);
          }
          return handleSearch({ query: params.query, ...params }, kb);
        }
        case "stats":
          return handleStats(params, kb);
        case "get-page":
          return handleGetPage(params, kb);
        case "stale-docs":
          return handleStaleDocs(params, kb);
        case "what-changed": {
          if (!params.since) return errorResponse("'since' (ISO date) is required for what-changed action.");
          return handleWhatChanged({ since: params.since, source: params.source }, kb);
        }
        default: {
          const _exhaustive: never = params.action;
          return errorResponse(`Unknown action: ${_exhaustive}`);
        }
      }
    },
  );
}
