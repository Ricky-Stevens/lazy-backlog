import type { ProjectConfig } from "../config/schema.js";
import {
  buildConfluenceWebUrl,
  createPage as createPageHelper,
  getPageSpaceKey as getPageSpaceKeyHelper,
  getPageVersion as getPageVersionHelper,
  type PageWriteResult,
  updatePage as updatePageHelper,
} from "./confluence-write.js";
import { htmlToMarkdown, Semaphore } from "./html-to-markdown.js";
import { fetchWithRetry } from "./http-utils.js";

export type { PageWriteResult } from "./confluence-write.js";
export * from "./html-to-markdown.js";

// ── Confluence API response types ──────────────────────────────────────────

interface ApiPage {
  id: string;
  title: string;
  spaceId?: string;
  parentId?: string;
  status: string;
  authorId?: string;
  createdAt?: string;
  version?: { createdAt?: string };
  body?: {
    storage?: { value: string };
  };
  _links?: { webui?: string };
}

interface ApiSpace {
  id: string;
  key: string;
  name: string;
  type: string;
}

interface ApiLabel {
  name: string;
}

interface ApiAttachment {
  id: string;
  title?: string;
  fileSize?: number;
  mediaType?: string;
  downloadLink?: string;
  webuiLink?: string;
  version?: { createdAt?: string };
  _links?: { download?: string; webui?: string };
}

interface PaginatedResponse<T> {
  results: T[];
  _links?: { next?: string };
}

interface SearchResult {
  content?: ApiPage & {
    space?: { id: string; key: string };
    metadata?: { labels?: { results: ApiLabel[] } };
  };
}

// ── Domain types ───────────────────────────────────────────────────────────

export interface ConfluencePage {
  id: string;
  title: string;
  spaceId: string;
  spaceKey?: string;
  parentId?: string;
  status: string;
  body?: string;
  labels: string[];
  authorId?: string;
  createdAt?: string;
  updatedAt?: string;
  url?: string;
  attachments?: ConfluenceAttachment[];
}

export interface ConfluenceSpace {
  id: string;
  key: string;
  name: string;
  type: string;
}

export interface ConfluenceAttachment {
  id: string;
  filename: string;
  mediaType: string;
  size: number;
  /** Absolute download URL on the Confluence site. */
  url: string;
  /** Optional human-friendly webui link. */
  webuiUrl?: string;
  /** True when mediaType indicates an image. */
  isImage: boolean;
  createdAt?: string;
}

// ── Constants ──────────────────────────────────────────────────────────────

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_CONCURRENT_REQUESTS = 10;

// ── URL helper ────────────────────────────────────────────────────────────

function buildUrl(path: string, baseUrl: string, params?: Record<string, string>): URL {
  const url = new URL(path, baseUrl);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
  }
  return url;
}

// ── Client ─────────────────────────────────────────────────────────────────

export class ConfluenceClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly semaphore: Semaphore;

  constructor(config: ProjectConfig) {
    this.baseUrl = config.siteUrl.replace(/\/$/, "");
    const auth = Buffer.from(`${config.email}:${config.apiToken}`).toString("base64");
    this.headers = {
      Authorization: `Basic ${auth}`,
      Accept: "application/json",
    };
    this.semaphore = new Semaphore(MAX_CONCURRENT_REQUESTS);
  }

  private async request<T>(path: string, params?: Record<string, string>): Promise<T> {
    const url = buildUrl(path, this.baseUrl, params);

    await this.semaphore.acquire();
    try {
      const res = await fetchWithRetry(url.toString(), {
        headers: this.headers,
        timeoutMs: REQUEST_TIMEOUT_MS,
        label: "Confluence",
      });

      if (!res.ok) {
        throw new Error(`Confluence API error (status ${res.status})`);
      }

      return (await res.json()) as T;
    } finally {
      this.semaphore.release();
    }
  }

  /** Build the write context handed to standalone write helpers. */
  private writeCtx() {
    return {
      baseUrl: this.baseUrl,
      headers: this.headers,
      timeoutMs: REQUEST_TIMEOUT_MS,
      acquire: () => this.semaphore.acquire(),
      release: () => this.semaphore.release(),
    };
  }

  /** Read function bound to this client, used by the write helpers. */
  private readFn = <T>(path: string, params?: Record<string, string>): Promise<T> => this.request<T>(path, params);

  private async *paginateIter<T>(path: string, params?: Record<string, string>): AsyncGenerator<T> {
    let currentPath = path;
    let currentParams = params;

    while (true) {
      const response = await this.request<PaginatedResponse<T>>(currentPath, currentParams);
      for (const item of response.results) {
        yield item;
      }
      if (!response._links?.next) break;
      currentPath = response._links.next;
      currentParams = undefined;
    }
  }

  private async paginate<T>(path: string, params?: Record<string, string>): Promise<T[]> {
    const results: T[] = [];
    for await (const item of this.paginateIter<T>(path, params)) {
      results.push(item);
    }
    return results;
  }

  /** List all Confluence spaces accessible to the authenticated user. */
  async getSpaces(): Promise<ConfluenceSpace[]> {
    return this.paginate<ApiSpace>("/wiki/api/v2/spaces", { limit: "50" });
  }

  /** Fetch a single space by its key. */
  async getSpace(spaceKey: string): Promise<ConfluenceSpace | undefined> {
    const resp = await this.request<PaginatedResponse<ApiSpace>>("/wiki/api/v2/spaces", {
      keys: spaceKey,
      limit: "1",
    });
    return resp.results[0];
  }

  /** Lightweight page list — no body content. */
  async listPagesInSpace(spaceId: string): Promise<ConfluencePage[]> {
    const raw = await this.paginate<ApiPage>(`/wiki/api/v2/spaces/${spaceId}/pages`, {
      limit: "50",
    });
    return raw.map((p) => this.mapPage(p));
  }

  /**
   * Fetch a single page with body, labels, and attachment manifest in parallel.
   *
   * The attachment manifest is used to rewrite `<ri:attachment>` image
   * references to real download URLs before the storage HTML is converted to
   * markdown. Attachment errors are non-fatal — the page still returns.
   */
  async getPageFull(pageId: string): Promise<ConfluencePage> {
    const [rawResult, labelResult, attachmentResult] = await Promise.allSettled([
      this.request<ApiPage>(`/wiki/api/v2/pages/${pageId}`, {
        "body-format": "storage",
      }),
      this.request<PaginatedResponse<ApiLabel>>(`/wiki/api/v2/pages/${pageId}/labels`, { limit: "50" }),
      this.fetchAttachments(pageId),
    ]);

    if (rawResult.status === "rejected") {
      throw rawResult.reason;
    }
    const raw = rawResult.value;
    const labels = labelResult.status === "fulfilled" ? labelResult.value.results.map((l) => l.name) : [];
    const attachments = attachmentResult.status === "fulfilled" ? attachmentResult.value : [];

    // Build filename → URL manifest for image resolution.
    const attachmentUrls: Record<string, string> = {};
    for (const att of attachments) {
      attachmentUrls[att.filename] = att.url;
    }

    const page = this.mapPage(raw, attachmentUrls);
    page.labels = labels;
    page.attachments = attachments;
    return page;
  }

  /** Fetch the attachment manifest for a page. */
  async getPageAttachments(pageId: string): Promise<ConfluenceAttachment[]> {
    return this.fetchAttachments(pageId);
  }

  private async fetchAttachments(pageId: string): Promise<ConfluenceAttachment[]> {
    const raw = await this.paginate<ApiAttachment>(`/wiki/api/v2/pages/${pageId}/attachments`, {
      limit: "50",
    });
    return raw.map((a) => this.mapAttachment(a));
  }

  private mapAttachment(raw: ApiAttachment): ConfluenceAttachment {
    const filename = raw.title ?? raw.id;
    const mediaType = raw.mediaType ?? "application/octet-stream";
    const downloadPath = raw.downloadLink ?? raw._links?.download ?? "";
    const webuiPath = raw.webuiLink ?? raw._links?.webui ?? undefined;
    // PUB-7: webui paths may already include /wiki — use the shared normaliser
    // so we never double-prepend it.
    const url = downloadPath.startsWith("http")
      ? downloadPath
      : (buildConfluenceWebUrl(this.baseUrl, downloadPath) ?? `${this.baseUrl}/wiki`);
    const webuiUrl = buildConfluenceWebUrl(this.baseUrl, webuiPath);
    return {
      id: String(raw.id),
      filename,
      mediaType,
      size: raw.fileSize ?? 0,
      url,
      webuiUrl,
      isImage: mediaType.startsWith("image/"),
      createdAt: raw.version?.createdAt,
    };
  }

  /** Fetch direct child pages of a given page. */
  async getPageChildren(pageId: string): Promise<ConfluencePage[]> {
    const raw = await this.paginate<ApiPage>(`/wiki/api/v2/pages/${pageId}/children`, {
      limit: "50",
    });
    return raw.map((p) => this.mapPage(p));
  }

  /** Search Confluence via CQL query. Returns pages with body content. */
  async searchCQL(cql: string, limit = 25): Promise<ConfluencePage[]> {
    const result = await this.request<PaginatedResponse<SearchResult>>("/wiki/rest/api/search", {
      cql,
      limit: String(limit),
      expand: "content.body.storage",
    });

    return result.results.map((r) => {
      const c = r.content;
      if (!c) return { id: "0", title: "", spaceId: "", status: "current", labels: [], body: "" };
      return {
        id: String(c.id),
        title: c.title || "",
        spaceId: c.space?.id || "",
        spaceKey: c.space?.key || "",
        body: htmlToMarkdown(c.body?.storage?.value || ""),
        labels: (c.metadata?.labels?.results || []).map((l) => l.name),
        url: buildConfluenceWebUrl(this.baseUrl, c._links?.webui),
        status: c.status || "current",
      };
    });
  }

  /** Current version number of a page — required for `updatePage`. */
  async getPageVersion(pageId: string): Promise<number> {
    return getPageVersionHelper(this.readFn, pageId);
  }

  /**
   * Resolve the space key of an existing page. Used by `confluence publish`
   * to enforce the `confluenceSpaces` allow-list before any update write.
   */
  async getPageSpaceKey(pageId: string): Promise<string> {
    return getPageSpaceKeyHelper(this.readFn, pageId);
  }

  /**
   * One-shot fetch of page metadata: space key, title, and version. Used by
   * the publish flow (PUB-13) so a single update doesn't issue separate GETs
   * for the scope check, version probe, and title backfill.
   */
  async getPageMeta(pageId: string): Promise<{ spaceKey: string; title: string; version: number }> {
    const page = await this.request<{
      title?: string;
      spaceId?: string | number;
      version?: { number?: number };
    }>(`/wiki/api/v2/pages/${pageId}`);
    const version = page.version?.number;
    if (typeof version !== "number" || !Number.isFinite(version)) {
      throw new Error(`Confluence page ${pageId} returned no version number`);
    }
    const title = page.title ?? "";
    const spaceId = page.spaceId != null ? String(page.spaceId) : "";
    if (!spaceId) throw new Error(`Confluence page ${pageId} returned no spaceId`);
    const spaceResp = await this.request<{ results: Array<{ id: string | number; key?: string }> }>(
      "/wiki/api/v2/spaces",
      { ids: spaceId, limit: "1" },
    );
    const spaceKey = spaceResp.results[0]?.key;
    if (!spaceKey) throw new Error(`Confluence space with id ${spaceId} not found (page ${pageId})`);
    return { spaceKey, title, version };
  }

  /** Create a new Confluence page. `body` must be storage-format XHTML. */
  async createPage(input: {
    spaceKey: string;
    title: string;
    body: string;
    parentId?: string;
  }): Promise<PageWriteResult> {
    return createPageHelper(this.writeCtx(), this.readFn, input);
  }

  /**
   * Update an existing page. Requires the current version number. A 409 is
   * surfaced as an explicit error — never silently clobbered.
   */
  async updatePage(input: { pageId: string; title?: string; body: string; version: number }): Promise<PageWriteResult> {
    return updatePageHelper(this.writeCtx(), this.readFn, input);
  }

  private mapPage(raw: ApiPage, attachmentUrls?: Record<string, string>): ConfluencePage {
    return {
      id: String(raw.id),
      title: raw.title || "",
      spaceId: raw.spaceId || "",
      parentId: raw.parentId ? String(raw.parentId) : undefined,
      status: raw.status || "current",
      body: raw.body?.storage?.value
        ? htmlToMarkdown(raw.body.storage.value, { baseUrl: this.baseUrl, attachmentUrls })
        : undefined,
      labels: [],
      authorId: raw.authorId,
      createdAt: raw.createdAt,
      updatedAt: raw.version?.createdAt || raw.createdAt,
      url: buildConfluenceWebUrl(this.baseUrl, raw._links?.webui),
    };
  }
}
