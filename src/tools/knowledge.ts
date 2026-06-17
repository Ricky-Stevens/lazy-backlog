import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildJiraClient, errorResponse, formatLabels, textResponse } from "../lib/config.js";
import type { ConfluenceAttachment } from "../lib/confluence.js";
import type { KnowledgeBase, PageSummary } from "../lib/db.js";
import { loadPageAttachments } from "../lib/indexer.js";
import {
  formatPageAttachments,
  type KnowledgeDownloadParams,
  runPageAttachmentDownloads,
} from "./knowledge-attachments.js";
import { handleStats } from "./knowledge-stats.js";
import { buildSuggestions } from "./suggestions.js";

export * from "./knowledge-attachments.js";
export * from "./knowledge-stats.js";

// ── Types ────────────────────────────────────────────────────────────────────

type ToolResponse = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

// ── Constants & pagination helpers (moved to knowledge-pagination.ts) ───────

export {
  MAX_PAGE_CHARS,
  MAX_PAGE_SIZE,
  MIN_PAGE_SIZE,
  type PaginationWindow,
  paginateContent,
} from "./knowledge-pagination.js";

import { MAX_PAGE_CHARS, MAX_PAGE_SIZE, MIN_PAGE_SIZE, paginateContent } from "./knowledge-pagination.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

export function formatSummaryLine(s: PageSummary): string {
  const preview = s.content_preview.replaceAll("\n", " ").trim();
  return `- **${s.title}** (${s.space_key}) [${formatLabels(s.labels)}]\n  ${preview}\u2026`;
}

// ── Intelligence Helpers ─────────────────────────────────────────────────────

function formatResultSummary(items: Array<{ page_type: string; updated_at?: string | null; source?: string }>): string {
  if (items.length <= 1) return "";

  const byType: Record<string, number> = {};
  const bySrc: Record<string, number> = {};
  let oldest = Number.POSITIVE_INFINITY;
  let newest = 0;

  for (const item of items) {
    byType[item.page_type] = (byType[item.page_type] || 0) + 1;
    if (item.source) bySrc[item.source] = (bySrc[item.source] || 0) + 1;
    if (item.updated_at) {
      const ts = new Date(item.updated_at).getTime();
      if (ts < oldest) oldest = ts;
      if (ts > newest) newest = ts;
    }
  }

  const typeParts = Object.entries(byType).map(([k, v]) => `${v} ${k}`);
  let summary = `\n\n**Result Summary:** ${items.length} results — ${typeParts.join(", ")}.`;

  if (newest > 0) {
    const newestDays = Math.floor((Date.now() - newest) / 86_400_000);
    const oldestDays = Math.floor((Date.now() - oldest) / 86_400_000);
    summary += ` Most recent: ${newestDays}d ago.`;
    if (oldestDays > 180) summary += ` Oldest: ${oldestDays}d ago (may need review).`;
  }
  if (Object.keys(bySrc).length > 1) {
    summary += ` Sources: ${Object.entries(bySrc)
      .map(([k, v]) => `${k}:${v}`)
      .join(", ")}.`;
  }

  return summary;
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

    const chunkSummary = formatResultSummary(chunks.map((c) => ({ page_type: c.page_type, source: c.source })));

    return textResponse(
      `${chunks.length} results (section-level):\n\n${lines.join("\n\n")}${chunkSummary}` +
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

  const pageSummary = formatResultSummary(results.map((r) => ({ page_type: r.page_type, source: r.source })));

  return textResponse(`${results.length} results:\n\n${lines.join("\n\n")}${pageSummary}`);
}

async function handleGetPage(
  params: { pageId?: string; page?: number; pageSize?: number } & KnowledgeDownloadParams,
  kb: KnowledgeBase,
): Promise<ToolResponse> {
  if (!params.pageId) return errorResponse("'pageId' is required for get-page action.");
  const page = kb.getPage(params.pageId);
  if (!page) return errorResponse(`Page ${params.pageId} not found in knowledge base.`);

  // E2 \u2014 Pagination instead of silent 15k truncation. Long pages return the
  // requested window with explicit continuation metadata so callers can fetch
  // the remainder by incrementing `page`.
  const requestedPage = params.page ?? 1;
  const requestedSize = params.pageSize ?? MAX_PAGE_CHARS;
  const window = paginateContent(page.content, requestedPage, requestedSize);

  let body = window.body;
  let paginationNote = "";
  if (window.totalPages > 1) {
    paginationNote =
      `\n\n---\n**Page ${window.page} of ${window.totalPages}** ` +
      `(${window.body.length}/${window.totalChars} chars; window=${window.effectiveSize}).` +
      (window.hasMore
        ? `\nFetch next: \`knowledge get-page\` with \`pageId='${page.id}'\` and \`page=${window.page + 1}\`.`
        : `\nThis is the final page \u2014 call with \`page=1\` to start over.`);
    body = `${body}${paginationNote}`;
  }

  // Freshness indicator. PAG-7: clamp negative day deltas to 0 so a
  // future-dated `updated_at` (clock skew, fixture data) isn't mislabelled as
  // "Fresh (-5d ago)" — that leaked a data-quality signal through what is
  // meant to be a recency indicator. Future dates render as "Future-dated
  // (clock skew?)" so the issue is visible without making the label lie.
  let freshness = "";
  if (page.updated_at) {
    const rawDays = Math.floor((Date.now() - new Date(page.updated_at).getTime()) / 86_400_000);
    if (rawDays < 0) {
      freshness = ` | **Future-dated (clock skew?)** (${rawDays}d)`;
    } else {
      const label = rawDays < 30 ? "Fresh" : rawDays < 90 ? "Aging" : "Stale — may need review";
      freshness = ` | **${label}** (${rawDays}d ago)`;
    }
  }

  // Related pages: search KB for pages with similar title keywords
  let relatedSection = "";
  try {
    const titleKeywords = page.title
      .split(/[\s\-_/]+/)
      .filter((w) => w.length > 3)
      .slice(0, 3)
      .join(" ");
    if (titleKeywords) {
      const related = kb.search(titleKeywords, { limit: 5 });
      const others = related.filter((r) => r.id !== page.id);
      if (others.length > 0) {
        relatedSection += `\n\n**Related pages:** ${others.map((r) => `${r.title} [${r.page_type}]`).join(", ")}`;
      }
    }
  } catch {
    /* graceful */
  }

  // Ticket references: search Jira for issues mentioning this page
  let ticketRefs = "";
  try {
    const { jira } = buildJiraClient(kb);
    const searchTerms = page.title
      .split(/\s+/)
      .slice(0, 4)
      .join(" ")
      .replace(/[\\"[\]()]/g, "");
    if (searchTerms.length > 3) {
      const { issues } = await jira.searchIssues(`summary ~ "${searchTerms}"`, undefined, 5);
      if (issues.length > 0) {
        ticketRefs = `\n**Referenced by:** ${issues.map((i) => `${i.key}`).join(", ")}`;
      }
    }
  } catch {
    /* graceful: skip if Jira not configured */
  }

  // Attachment manifest (graceful — empty list when none stored)
  let attachmentsSection = "";
  let downloadSection = "";
  let attachments: ConfluenceAttachment[] = [];
  try {
    attachments = loadPageAttachments(kb, page.id);
    attachmentsSection = formatPageAttachments(attachments);
  } catch {
    /* graceful: skip attachments */
  }
  if (params.download && attachments.length > 0) {
    downloadSection = await runPageAttachmentDownloads(kb, attachments, params);
  }

  const suggestions = buildSuggestions("knowledge", "get-page", {
    attachmentCount: attachments.length,
    downloaded: downloadSection.length > 0,
    totalPages: window.totalPages,
    hasMore: window.hasMore,
  });

  return textResponse(
    `# ${page.title}\n` +
      `${page.page_type} | ${page.space_key} | ${formatLabels(page.labels)} | ${page.updated_at ?? "?"}${freshness}\n` +
      (page.url ? `${page.url}\n` : "") +
      `---\n${body}${attachmentsSection}${downloadSection}${relatedSection}${ticketRefs}${suggestions}`,
  );
}

// ── Tool Registration ────────────────────────────────────────────────────────

export function registerKnowledgeTool(server: McpServer, getKb: () => KnowledgeBase) {
  server.registerTool(
    "knowledge",
    {
      description:
        "Knowledge base operations. Search indexed content from all sources (Confluence, GitHub, etc.). Use 'search' for full-text queries, 'get-page' for full content, 'stats' for KB dashboard with context summary, recent changes, stale docs, and health indicator.",
      inputSchema: z.object({
        action: z.enum(["search", "stats", "get-page"]),
        query: z.string().optional().describe("[search] Full-text search query"),
        pageId: z.string().optional().describe("[get-page] Page ID to retrieve"),
        source: z.string().optional().describe("Filter by source (e.g. 'confluence', 'github')"),
        pageType: z
          .enum(["adr", "design", "runbook", "meeting", "spec", "other"])
          .optional()
          .describe("Filter results by page type"),
        spaceKey: z.string().optional().describe("Filter by namespace/space key"),
        limit: z.number().default(5).describe("[search] Max results to return"),
        download: z
          .boolean()
          .default(false)
          .optional()
          .describe(
            "[get-page] When true, fetch page attachments to the configured download directory (config key 'downloadDir').",
          ),
        attachmentIds: z
          .array(z.string())
          .optional()
          .describe(
            "[get-page] Optional filter — only download attachments whose id or filename appears in this list. Defaults to all attachments.",
          ),
        page: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(
            "[get-page] 1-based pagination window. Default 1. Long pages return continuation metadata pointing to page+1.",
          ),
        pageSize: z
          .number()
          .int()
          .min(MIN_PAGE_SIZE)
          .max(MAX_PAGE_SIZE)
          .optional()
          .describe(
            `[get-page] Window size in characters. Default ${MAX_PAGE_CHARS}. Clamped to [${MIN_PAGE_SIZE}, ${MAX_PAGE_SIZE}].`,
          ),
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
        default: {
          const _exhaustive: never = params.action;
          return errorResponse(`Unknown action: ${_exhaustive}`);
        }
      }
    },
  );
}
