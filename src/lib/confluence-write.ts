/**
 * Confluence write operations: create/update pages with optimistic concurrency.
 *
 * Extracted from `confluence.ts` to keep that file under the 400-line cap.
 * Exported as standalone functions taking a typed `RequestFn` so they can be
 * tested in isolation and reused by other clients.
 */

import { fetchWithRetry } from "./http-utils.js";

// ── Types ─────────────────────────────────────────────────────────────────

/** Generic JSON request signature used by the write helpers. */
export type ConfluenceReadFn = <T>(path: string, params?: Record<string, string>) => Promise<T>;

interface ApiPageBare {
  id: string | number;
  title?: string;
  version?: { number?: number };
  _links?: { webui?: string };
}

/**
 * Join a Confluence `webui` link onto `baseUrl` without double-prepending the
 * `/wiki` segment (PUB-7).
 *
 * Confluence's v2 API sometimes returns webui values that already include
 * `/wiki/...` (e.g. `/wiki/spaces/ENG/pages/999`) and sometimes returns the
 * tail only (e.g. `/spaces/ENG/pages/999`). Naive concatenation
 * (`${baseUrl}/wiki${webui}`) produced URLs like
 * `https://x.atlassian.net/wiki/wiki/spaces/...` for the first form.
 *
 * Exported so the read paths in `confluence.ts` (mapPage, mapAttachment,
 * searchCQL) can share the same normaliser.
 */
export function buildConfluenceWebUrl(baseUrl: string, webui: string | undefined): string | undefined {
  if (!webui) return undefined;
  if (/^https?:\/\//i.test(webui)) return webui;
  const trimmedBase = baseUrl.replace(/\/+$/, "");
  // If webui already starts with /wiki (with a separator) trust it; otherwise prepend /wiki.
  const startsWithWiki = webui === "/wiki" || webui.startsWith("/wiki/") || webui.startsWith("/wiki?");
  const path = startsWithWiki ? webui : `/wiki${webui.startsWith("/") ? "" : "/"}${webui}`;
  return `${trimmedBase}${path}`;
}

export interface PageWriteResult {
  id: string;
  title: string;
  version: number;
  url?: string;
}

interface WriteContext {
  baseUrl: string;
  headers: Record<string, string>;
  timeoutMs: number;
  /** Acquire a slot in the client's shared concurrency semaphore. */
  acquire: () => Promise<void>;
  release: () => void;
}

// ── Write request primitive ───────────────────────────────────────────────

/**
 * Execute a POST/PUT/DELETE against Confluence with the shared retry policy.
 * Surfaces 409 (version conflict) as an explicit error.
 *
 * The API token lives inside `headers` and is never logged — only status
 * codes and request paths appear in error messages.
 */
export async function writeRequest<T>(
  ctx: WriteContext,
  method: "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  const url = new URL(path, ctx.baseUrl).toString();

  await ctx.acquire();
  try {
    const res = await fetchWithRetry(url, {
      method,
      headers: { ...ctx.headers, "Content-Type": "application/json" },
      body,
      timeoutMs: ctx.timeoutMs,
      label: "Confluence",
    });

    if (res.status === 409) {
      const detail = await readErrorBody(res, 200);
      throw new Error(`Confluence version conflict (409) on ${method} ${path}${detail ? ` — ${detail}` : ""}`);
    }

    if (!res.ok) {
      // PUB-12: include the response body so 4xx errors carry actionable
      // detail (e.g. "title must not be blank") rather than a bare status.
      const detail = await readErrorBody(res, 500);
      throw new Error(
        `Confluence API error (status ${res.status}) on ${method} ${path}${detail ? ` — ${detail}` : ""}`,
      );
    }

    if (res.status === 204) return undefined as unknown as T;
    return (await res.json()) as T;
  } finally {
    ctx.release();
  }
}

/**
 * Read and truncate a non-2xx Confluence response body for inclusion in an
 * error message (PUB-12). Returns "" if reading or truncation fails — the
 * caller already has the status code to surface.
 */
async function readErrorBody(res: Response, maxChars: number): Promise<string> {
  try {
    const txt = await res.text();
    if (!txt) return "";
    const trimmed = txt.length > maxChars ? `${txt.slice(0, maxChars)}…` : txt;
    // Collapse whitespace so multi-line HTML responses don't blow up the log.
    return trimmed.replaceAll(/\s+/g, " ").trim();
  } catch {
    return "";
  }
}

// ── Page write operations ─────────────────────────────────────────────────

/**
 * Fetch the current version number of a Confluence page. Required for
 * optimistic-concurrency updates via `updatePage`.
 */
export async function getPageVersion(read: ConfluenceReadFn, pageId: string): Promise<number> {
  const raw = await read<{ version?: { number?: number } }>(`/wiki/api/v2/pages/${pageId}`);
  const num = raw.version?.number;
  if (typeof num !== "number" || !Number.isFinite(num)) {
    throw new Error(`Confluence page ${pageId} returned no version number`);
  }
  return num;
}

/**
 * Resolve the space key of an existing page. Used to enforce project-scoped
 * write allow-lists before an update — callers reject pages whose space is
 * not in `confluenceSpaces`. Throws if the page has no resolvable space.
 */
export async function getPageSpaceKey(read: ConfluenceReadFn, pageId: string): Promise<string> {
  const page = await read<{ spaceId?: string | number }>(`/wiki/api/v2/pages/${pageId}`);
  const spaceId = page.spaceId != null ? String(page.spaceId) : "";
  if (!spaceId) {
    throw new Error(`Confluence page ${pageId} returned no spaceId`);
  }
  const spaceResp = await read<{ results: Array<{ id: string | number; key?: string }> }>("/wiki/api/v2/spaces", {
    ids: spaceId,
    limit: "1",
  });
  const key = spaceResp.results[0]?.key;
  if (!key) {
    throw new Error(`Confluence space with id ${spaceId} not found (page ${pageId})`);
  }
  return key;
}

/**
 * Create a new Confluence page. `body` must be storage-format XHTML
 * (typically produced by `markdownToStorage`).
 */
export async function createPage(
  ctx: WriteContext,
  read: ConfluenceReadFn,
  input: { spaceKey: string; title: string; body: string; parentId?: string },
): Promise<PageWriteResult> {
  if (!input.spaceKey) throw new Error("createPage requires a spaceKey");
  if (!input.title) throw new Error("createPage requires a title");

  // v2 API needs the numeric space id, not the key. Look it up first.
  const spaceResp = await read<{ results: Array<{ id: string }> }>("/wiki/api/v2/spaces", {
    keys: input.spaceKey,
    limit: "1",
  });
  const spaceId = spaceResp.results[0]?.id;
  if (!spaceId) throw new Error(`Confluence space "${input.spaceKey}" not found`);

  const payload: Record<string, unknown> = {
    spaceId,
    status: "current",
    title: input.title,
    body: { representation: "storage", value: input.body },
  };
  if (input.parentId) payload.parentId = input.parentId;

  const created = await writeRequest<ApiPageBare>(ctx, "POST", "/wiki/api/v2/pages", payload);

  return {
    id: String(created.id),
    title: created.title ?? input.title,
    version: created.version?.number ?? 1,
    url: buildConfluenceWebUrl(ctx.baseUrl, created._links?.webui),
  };
}

/**
 * Update an existing page. Requires the current version number for
 * optimistic concurrency. A 409 from Confluence is surfaced as an error
 * containing "version conflict" — never silently swallowed.
 */
export async function updatePage(
  ctx: WriteContext,
  read: ConfluenceReadFn,
  input: { pageId: string; title?: string; body: string; version: number },
): Promise<PageWriteResult> {
  if (!input.pageId) throw new Error("updatePage requires a pageId");
  if (!Number.isFinite(input.version)) throw new Error("updatePage requires a numeric version");

  // Title is required by the v2 API; if not supplied, fetch the current value.
  let title = input.title;
  if (!title) {
    const current = await read<ApiPageBare>(`/wiki/api/v2/pages/${input.pageId}`);
    title = current.title ?? "";
  }

  const payload = {
    id: input.pageId,
    status: "current",
    title,
    body: { representation: "storage", value: input.body },
    version: { number: input.version + 1 },
  };

  const updated = await writeRequest<ApiPageBare>(ctx, "PUT", `/wiki/api/v2/pages/${input.pageId}`, payload);

  return {
    id: String(updated.id),
    title: updated.title ?? title,
    version: updated.version?.number ?? input.version + 1,
    url: buildConfluenceWebUrl(ctx.baseUrl, updated._links?.webui),
  };
}
