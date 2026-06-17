import { createHash } from "node:crypto";
import type { PageType, SpiderOptions } from "../config/schema.js";
import { chunkMarkdown, stripBoilerplate } from "./chunker.js";
import type { ConfluenceAttachment, ConfluenceClient, ConfluencePage } from "./confluence.js";
import type { IndexedPage, KnowledgeBase } from "./db.js";
import { toErrMsg } from "./utils.js";

/**
 * Compute a stable fingerprint over the fields that materially affect indexed
 * content. Hashing title + body + sorted labels lets the spider notice
 * content-only or label-only edits even when the source's `updated_at` did not
 * advance (e.g. a Confluence label was added without re-saving the page).
 *
 * Exported for tests and for any code path that needs to compute the same hash
 * Spider would.
 */
export function computeContentHash(page: Pick<ConfluencePage, "title" | "body" | "labels" | "attachments">): string {
  const sortedLabels = [...(page.labels ?? [])].sort((a, b) => a.localeCompare(b));
  const attachmentFingerprint = [...(page.attachments ?? [])]
    .map((a) => `${a.id}:${a.filename}:${a.size ?? ""}`)
    .sort((a, b) => a.localeCompare(b));
  // DB-1: JSON-encode the payload so field boundaries are explicit. The old
  // form concatenated title/body/labels with single-byte separators which made
  // the encoding ambiguous — e.g. labels=['a,b'] collided with labels=['a','b']
  // because the in-band separator was unescaped, and embedded null bytes in
  // body collided too. JSON's quote-and-array literal removes that whole class
  // of collisions for any input the source can produce.
  // DB-2: fold attachments into the hash so attachment-only edits (rename,
  // swap, delete) force a re-index AND a manifest re-write on the next crawl.
  const payload = JSON.stringify({
    t: page.title,
    b: page.body ?? "",
    l: sortedLabels,
    a: attachmentFingerprint,
  });
  return createHash("sha256").update(payload).digest("hex");
}

/** Storage key prefix for per-page Confluence attachment manifests. */
export const ATTACHMENT_CONFIG_PREFIX = "confluence-attachments:";

/** Build the kb config key used to store a page's attachment manifest. */
export function attachmentConfigKey(pageId: string): string {
  return `${ATTACHMENT_CONFIG_PREFIX}${pageId}`;
}

/** Load the attachment manifest previously stored for a page, or [] when none. */
export function loadPageAttachments(kb: KnowledgeBase, pageId: string): ConfluenceAttachment[] {
  const raw = kb.getConfig(attachmentConfigKey(pageId));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as ConfluenceAttachment[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Persist (or clear) the attachment manifest for a page in the kb config store. */
export function storePageAttachments(kb: KnowledgeBase, pageId: string, attachments: ConfluenceAttachment[]): void {
  kb.setConfig(attachmentConfigKey(pageId), JSON.stringify(attachments));
}

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
    // DB-4: each batch item tracks the source ConfluencePage so we can
    // (a) replay persistAttachments() only after the page+chunks transaction
    // commits, and (b) attribute `result.indexed` only on successful flush.
    const batch: { indexed: IndexedPage; source: ConfluencePage }[] = [];
    const concurrency = options.maxConcurrency ?? 5;

    const flushPending = (): void => {
      if (batch.length === 0) return;
      try {
        const written = this.flushBatch(batch.map((b) => b.indexed));
        // DB-4: increment indexed AFTER the transaction commits. On throw the
        // counter never moves, so the returned result is honest.
        result.indexed += written;
        // DB-2: persist attachments only after the page row commits — this
        // prevents writing a fresh manifest against a page that didn't land.
        for (const { source } of batch) this.persistAttachments(source);
      } catch (err: unknown) {
        // Record the batch as errored against every page in the batch so the
        // caller sees the failure scope. We do NOT increment `indexed`.
        for (const { source } of batch) {
          result.errors.push(`${source.id} (${source.title}) [flush]: ${toErrMsg(err)}`);
        }
      } finally {
        batch.length = 0;
      }
    };

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

          // Incremental: skip if unchanged since last index. Hash covers
          // content + title + labels + attachments so label-only OR
          // attachment-only edits trigger a re-index even when the source's
          // `updated_at` was not bumped.
          const hash = computeContentHash(fullPage);
          if (!this.kb.needsReindex(fullPage.id, fullPage.updatedAt, hash)) {
            result.unchanged++;
            return;
          }

          batch.push({ indexed: toIndexedPage(fullPage, spaceKey), source: fullPage });
        } catch (err: unknown) {
          result.errors.push(`${page.id} (${page.title}): ${toErrMsg(err)}`);
        }
      });

      await Promise.all(promises);

      // Flush batch every 50 pages
      if (batch.length >= 50) flushPending();
    }

    flushPending();
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

    // GEN-9: batch in groups of 50 (matches crawlSpace); attachment manifests
    // persist only after the page+chunk transaction commits.
    const batch: { indexed: IndexedPage; source: ConfluencePage }[] = [];

    const flushPending = (): void => {
      if (batch.length === 0) return;
      try {
        const written = this.flushBatch(batch.map((b) => b.indexed));
        result.indexed += written;
        for (const { source } of batch) this.persistAttachments(source);
      } catch (err: unknown) {
        for (const { source } of batch) {
          result.errors.push(`${source.id} (${source.title}) [flush]: ${toErrMsg(err)}`);
        }
      } finally {
        batch.length = 0;
      }
    };

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
          const hash = computeContentHash(page);
          if (this.kb.needsReindex(page.id, page.updatedAt, hash)) {
            // GEN-9: buffer up to 50 pages; flushPending() commits + persists
            // attachments + bumps the indexed counter atomically (DB-3 / DB-4).
            batch.push({ indexed: toIndexedPage(page, spaceKey), source: page });
            if (batch.length >= 50) flushPending();
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
        result.errors.push(`${pageId}: ${toErrMsg(err)}`);
      }
    };

    await crawlRecursive(rootPageId, 0);
    // Final flush — any pages collected during the recursive walk that
    // haven't yet hit the 50-page threshold land here (GEN-9).
    flushPending();
    return result;
  }

  /**
   * Atomically upsert pages + chunks (DB-3). Returns the number of pages
   * written so callers attribute their `result.indexed` counter only after
   * the transaction commits (DB-4). CPU-bound chunking runs OUTSIDE the
   * sqlite transaction window so we don't extend it unnecessarily.
   */
  private flushBatch(pages: IndexedPage[]): number {
    if (pages.length === 0) return 0;
    const entries = pages.map((page) => ({
      page,
      chunks: chunkMarkdown(stripBoilerplate(page.content)),
    }));
    return this.kb.upsertPagesWithChunks(entries);
  }

  private persistAttachments(page: ConfluencePage): void {
    if (page.attachments && page.attachments.length > 0) {
      storePageAttachments(this.kb, page.id, page.attachments);
    } else {
      // Clear any previously stored manifest so we don't leak stale data.
      storePageAttachments(this.kb, page.id, []);
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
    content_hash: computeContentHash(page),
  };
}
