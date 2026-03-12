import type { PageType, SpiderOptions } from "../config/schema.js";
import { chunkMarkdown, stripBoilerplate } from "./chunker.js";
import type { ConfluenceClient, ConfluencePage } from "./confluence.js";
import type { IndexedPage, KnowledgeBase } from "./db.js";

export interface SpiderProgress {
  pagesProcessed: number;
  pagesTotal: number;
  currentPage: string;
  skipped: number;
  errors: number;
}

export interface SpiderResult {
  indexed: number;
  skipped: number;
  unchanged: number;
  errors: string[];
}

// ── Label sets for O(1) lookup instead of O(n) .some()/.includes() ─────────

const ADR_LABELS = new Set(["adr", "architecture-decision", "decision-record"]);
const DESIGN_LABELS = new Set(["design", "design-doc", "technical-design", "rfc"]);
const RUNBOOK_LABELS = new Set(["runbook", "playbook", "operations", "incident"]);
const MEETING_LABELS = new Set(["meeting", "meeting-notes", "minutes"]);
const SPEC_LABELS = new Set(["spec", "specification", "requirements", "prd"]);

const RE_ADR_TITLE = /adr[-\s]?\d+/i;
const RE_MEETING_TITLE = /meeting\s*(notes|minutes)/i;
const RE_MEETING_DATE = /\d{4}[-/]\d{2}[-/]\d{2}.*meeting/i;
const RE_PRD_TITLE = /\bprd\b/i;

/** Classify a page based on title, labels, and content structure. */
export function classifyPage(page: ConfluencePage): PageType {
  const title = page.title.toLowerCase();
  const lowerLabels = page.labels.map((l) => l.toLowerCase());
  const hasLabel = (set: Set<string>) => lowerLabels.some((l) => set.has(l));

  // ADR detection
  if (
    RE_ADR_TITLE.test(page.title) ||
    hasLabel(ADR_LABELS) ||
    title.includes("architecture decision") ||
    title.includes("decision record") ||
    isAdrContent(page.body)
  ) {
    return "adr";
  }

  // Design doc
  if (
    hasLabel(DESIGN_LABELS) ||
    title.includes("design doc") ||
    title.includes("technical design") ||
    title.includes("rfc")
  ) {
    return "design";
  }

  // Runbook
  if (hasLabel(RUNBOOK_LABELS) || title.includes("runbook") || title.includes("playbook")) {
    return "runbook";
  }

  // Meeting notes
  if (hasLabel(MEETING_LABELS) || RE_MEETING_TITLE.test(page.title) || RE_MEETING_DATE.test(page.title)) {
    return "meeting";
  }

  // Spec
  if (
    hasLabel(SPEC_LABELS) ||
    title.includes("specification") ||
    title.includes("requirements") ||
    RE_PRD_TITLE.test(page.title)
  ) {
    return "spec";
  }

  return "other";
}

/** Check if content has ADR structure markers. Only examines first 500 chars. */
function isAdrContent(body: string | undefined): boolean {
  if (!body) return false;
  const head = body.slice(0, 500).toLowerCase();
  return head.includes("## status") && head.includes("## context") && head.includes("## decision");
}

// ── Spider with bounded concurrency + incremental sync ─────────────────────

export class Spider {
  private readonly visited = new Set<string>();

  constructor(
    private readonly client: ConfluenceClient,
    private readonly kb: KnowledgeBase,
  ) {}

  /** Crawl Confluence pages and index them into the knowledge base. Supports both space-wide and subtree crawling. */
  async crawl(options: SpiderOptions, onProgress?: (progress: SpiderProgress) => void): Promise<SpiderResult> {
    this.visited.clear();

    if (options.rootPageId) {
      return this.crawlTree(options, onProgress);
    }
    if (options.spaceKey) {
      return this.crawlSpace(options, onProgress);
    }
    throw new Error("Either spaceKey or rootPageId must be provided");
  }

  private async crawlSpace(
    options: SpiderOptions,
    onProgress?: (progress: SpiderProgress) => void,
  ): Promise<SpiderResult> {
    const spaceKey = options.spaceKey ?? "";
    if (!spaceKey) throw new Error("spaceKey is required");
    const space = await this.client.getSpace(spaceKey);
    if (!space) throw new Error(`Space '${spaceKey}' not found`);

    const pages = await this.client.listPagesInSpace(space.id);
    const total = pages.length;
    const result: SpiderResult = { indexed: 0, skipped: 0, unchanged: 0, errors: [] };
    const batch: IndexedPage[] = [];
    const concurrency = options.maxConcurrency ?? 5;

    // Process in concurrent batches
    for (let i = 0; i < pages.length; i += concurrency) {
      const chunk = pages.slice(i, i + concurrency);
      const promises = chunk.map(async (page, j) => {
        if (this.visited.has(page.id)) {
          result.skipped++;
          return;
        }
        this.visited.add(page.id);

        try {
          onProgress?.({
            pagesProcessed: i + j + 1,
            pagesTotal: total,
            currentPage: page.title,
            skipped: result.skipped + result.unchanged,
            errors: result.errors.length,
          });

          const fullPage = await this.client.getPageFull(page.id);
          fullPage.spaceKey = spaceKey;

          if (!this.shouldIndex(fullPage, options)) {
            result.skipped++;
            return;
          }

          // Incremental: skip if unchanged since last index
          if (!this.kb.needsReindex(fullPage.id, fullPage.updatedAt)) {
            result.unchanged++;
            return;
          }

          batch.push(toIndexedPage(fullPage, spaceKey));
          result.indexed++;
        } catch (err: unknown) {
          result.errors.push(`${page.id} (${page.title}): ${err}`);
        }
      });

      await Promise.all(promises);

      // Flush batch every 50 pages
      if (batch.length >= 50) {
        this.flushBatch(batch);
        batch.length = 0;
      }
    }

    if (batch.length > 0) this.flushBatch(batch);
    return result;
  }

  private async crawlTree(
    options: SpiderOptions,
    onProgress?: (progress: SpiderProgress) => void,
  ): Promise<SpiderResult> {
    const rootPageId = options.rootPageId;
    if (!rootPageId) throw new Error("rootPageId is required for tree crawling");
    const result: SpiderResult = { indexed: 0, skipped: 0, unchanged: 0, errors: [] };
    const spaceKey = options.spaceKey || "unknown";
    const maxDepth = options.maxDepth ?? 10;

    const crawlRecursive = async (pageId: string, depth: number): Promise<void> => {
      if (depth > maxDepth) return;
      if (this.visited.has(pageId)) return;
      this.visited.add(pageId);

      try {
        const page = await this.client.getPageFull(pageId);
        page.spaceKey = spaceKey;

        onProgress?.({
          pagesProcessed: result.indexed + result.skipped + result.unchanged,
          pagesTotal: this.visited.size,
          currentPage: page.title,
          skipped: result.skipped + result.unchanged,
          errors: result.errors.length,
        });

        if (this.shouldIndex(page, options)) {
          if (this.kb.needsReindex(page.id, page.updatedAt)) {
            const indexed = toIndexedPage(page, spaceKey);
            this.flushBatch([indexed]);
            result.indexed++;
          } else {
            result.unchanged++;
          }
        } else {
          result.skipped++;
        }

        const children = await this.client.getPageChildren(pageId);
        // Bounded concurrency for children
        const concurrency = options.maxConcurrency ?? 5;
        for (let i = 0; i < children.length; i += concurrency) {
          const chunk = children.slice(i, i + concurrency);
          await Promise.all(chunk.map((child) => crawlRecursive(child.id, depth + 1)));
        }
      } catch (err: unknown) {
        result.errors.push(`${pageId}: ${err}`);
      }
    };

    await crawlRecursive(rootPageId, 0);
    return result;
  }

  /** Upsert pages and generate chunks for each. */
  private flushBatch(pages: IndexedPage[]): void {
    this.kb.upsertMany(pages);
    for (const page of pages) {
      const cleaned = stripBoilerplate(page.content);
      const chunks = chunkMarkdown(cleaned);
      this.kb.upsertChunks(page.id, chunks);
    }
  }

  private shouldIndex(page: ConfluencePage, options: SpiderOptions): boolean {
    // Skip empty pages
    if (!page.body || page.body.trim().length === 0) return false;

    if (options.includeLabels && options.includeLabels.length > 0) {
      if (!page.labels.some((l) => options.includeLabels?.includes(l))) return false;
    }

    if (options.excludeLabels && options.excludeLabels.length > 0) {
      if (page.labels.some((l) => options.excludeLabels?.includes(l))) return false;
    }

    return true;
  }
}

function toIndexedPage(page: ConfluencePage, spaceKey: string): IndexedPage {
  return {
    id: page.id,
    space_key: spaceKey,
    title: page.title,
    url: page.url || null,
    content: page.body || "",
    page_type: classifyPage(page),
    labels: JSON.stringify(page.labels),
    parent_id: page.parentId || null,
    author_id: page.authorId || null,
    created_at: page.createdAt || null,
    updated_at: page.updatedAt || null,
    indexed_at: new Date().toISOString(),
    source: "confluence",
  };
}
