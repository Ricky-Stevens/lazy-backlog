/**
 * Confluence `publish` action — write-back of markdown to Confluence pages.
 *
 * Extracted from `confluence.ts` (PUB-3/4/5/6/13/14) to keep that file under
 * the 400-line cap while we expand the publish flow with:
 *
 *  - storage-XHTML preview excerpt + transformation summary (PUB-3)
 *  - re-fetch of target page immediately before PUT to shrink the TOCTOU
 *    window (PUB-4)
 *  - reject the combination of `pageId` + `spaceKey` (PUB-5)
 *  - resolve and validate `parentId`'s space on create (PUB-6)
 *  - single GET reused for scope check, title backfill, and version (PUB-13)
 *  - lazy ConfluenceClient instantiation on the preview path (PUB-14)
 *  - fail-closed empty allow-list with `['*']` opt-in sentinel (PUB-1)
 */

import { errorResponse, resolveConfig, textResponse } from "../lib/config.js";
import { ConfluenceClient } from "../lib/confluence.js";
import type { KnowledgeBase } from "../lib/db.js";
import { markdownToStorage } from "../lib/markdown-to-storage.js";
import { buildSuggestions } from "./suggestions.js";

type ToolResponse = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

export interface PublishParams {
  spaceKey?: string;
  pageId?: string;
  title?: string;
  content: string;
  parentId?: string;
  confirm: boolean;
}

/** Sentinel restoring legacy "publish anywhere" behaviour (PUB-1). */
export const ALLOW_ALL_SPACES_SENTINEL = "*";

function isAllowAllSpaces(allowed: readonly string[]): boolean {
  return allowed.length === 1 && allowed[0] === ALLOW_ALL_SPACES_SENTINEL;
}

/**
 * Check whether `spaceKey` is permitted by the configured allow-list.
 *
 * PUB-1: empty allow-list now means **deny** (writes are fail-closed). Reads
 * (spider / list-spaces) are unaffected — they don't go through this guard.
 * Use `['*']` to explicitly allow all reachable spaces. Match is
 * case-insensitive (Confluence space keys are case-insensitive in practice).
 */
export function isSpaceAllowed(spaceKey: string, allowed: readonly string[]): boolean {
  if (isAllowAllSpaces(allowed)) return true;
  if (allowed.length === 0) return false;
  const needle = spaceKey.toLowerCase();
  return allowed.some((s) => s.toLowerCase() === needle);
}

export function disallowedSpaceMessage(spaceKey: string, allowed: readonly string[]): string {
  if (allowed.length === 0) {
    return (
      `Refusing to publish — \`confluenceSpaces\` allow-list is empty. ` +
      `Set CONFLUENCE_SPACES (comma-separated keys) or run \`configure set confluenceSpaces=[...]\` ` +
      `to scope writes. Use \`['${ALLOW_ALL_SPACES_SENTINEL}']\` to explicitly allow all reachable spaces.`
    );
  }
  return (
    `Space "${spaceKey}" is not in the configured confluenceSpaces allow-list [${allowed.join(", ")}]. ` +
    `Refusing to publish — update CONFLUENCE_SPACES or run \`configure set\` to add this space.`
  );
}

// ── Transformation summary ─────────────────────────────────────────────────

/**
 * Diff-style summary of what the markdown→storage converter changed in the
 * source (PUB-3). The preview path advertises these so a confirm:true publish
 * cannot smuggle in script/style strips, javascript: link rewrites, or
 * silently demoted blocks without the reviewer seeing it.
 */
export interface TransformationSummary {
  scriptsStripped: number;
  stylesStripped: number;
  iframesStripped: number;
  eventHandlersStripped: number;
  dangerousLinksReplaced: number;
}

const RE_SCRIPT = /<script\b/gi;
const RE_STYLE = /<style\b/gi;
const RE_IFRAME = /<(iframe|object|embed|link|meta)\b/gi;
const RE_EVENT_HANDLER = /\son[a-z]+\s*=/gi;
const RE_DANGEROUS_HREF = /\]\(\s*(javascript|vbscript|data|file|mhtml):/gi;

export function buildTransformationSummary(markdown: string): TransformationSummary {
  return {
    scriptsStripped: (markdown.match(RE_SCRIPT) ?? []).length,
    stylesStripped: (markdown.match(RE_STYLE) ?? []).length,
    iframesStripped: (markdown.match(RE_IFRAME) ?? []).length,
    eventHandlersStripped: (markdown.match(RE_EVENT_HANDLER) ?? []).length,
    dangerousLinksReplaced: (markdown.match(RE_DANGEROUS_HREF) ?? []).length,
  };
}

function formatTransformationLine(summary: TransformationSummary): string {
  const parts: string[] = [];
  if (summary.scriptsStripped) parts.push(`${summary.scriptsStripped} <script> stripped`);
  if (summary.stylesStripped) parts.push(`${summary.stylesStripped} <style> stripped`);
  if (summary.iframesStripped) parts.push(`${summary.iframesStripped} <iframe>/embed stripped`);
  if (summary.eventHandlersStripped) parts.push(`${summary.eventHandlersStripped} event handlers stripped`);
  if (summary.dangerousLinksReplaced) parts.push(`${summary.dangerousLinksReplaced} dangerous link(s) neutralised`);
  if (parts.length === 0) return "**Sanitisation:** no changes";
  return `**Sanitisation:** ${parts.join("; ")}`;
}

// ── Preview ────────────────────────────────────────────────────────────────

const STORAGE_PREVIEW_MAX = 800;

export function buildPublishPreview(params: PublishParams, storage: string): string {
  const mode = params.pageId ? "Update" : "Create";
  const target = params.pageId ? `**Page ID:** ${params.pageId}` : `**Space:** ${params.spaceKey ?? "(missing)"}`;
  const summary = buildTransformationSummary(params.content);

  // PUB-3: surface the actual storage XHTML the API will receive, plus a
  // transformation summary, so the confirm-gate reflects what will land.
  const storageExcerpt =
    storage.length > STORAGE_PREVIEW_MAX ? `${storage.slice(0, STORAGE_PREVIEW_MAX)}\n…(truncated)` : storage;

  const lines = [
    "# Confluence Publish Preview",
    "",
    `**Mode:** ${mode}`,
    target,
    params.title ? `**Title:** ${params.title}` : "**Title:** _(unchanged on update)_",
    params.parentId ? `**Parent page ID:** ${params.parentId}` : "",
    "",
    `**Content length:** ${params.content.length} chars markdown → ${storage.length} chars storage`,
    formatTransformationLine(summary),
    "",
    "## Markdown (input)",
    "",
    params.content.length > STORAGE_PREVIEW_MAX
      ? `${params.content.slice(0, STORAGE_PREVIEW_MAX)}\n…(truncated)`
      : params.content,
    "",
    "## Storage XHTML (will be POST/PUT)",
    "",
    "```xml",
    storageExcerpt,
    "```",
    "",
    "---",
    "",
    "**Nothing has been written.** Set `confirm: true` to publish.",
  ].filter((l) => l !== "");

  return lines.join("\n");
}

// ── Handler ─────────────────────────────────────────────────────────────────

export async function handlePublish(params: PublishParams, kb: KnowledgeBase): Promise<ToolResponse> {
  // PUB-5: pageId and spaceKey are mutually exclusive — silently ignoring
  // spaceKey on update lets callers think they're targeting a different space.
  if (params.pageId && params.spaceKey) {
    return errorResponse(
      "publish accepts either `pageId` (update existing page) OR `spaceKey` (create new page) — not both. " +
        `Got pageId="${params.pageId}" and spaceKey="${params.spaceKey}".`,
    );
  }
  if (!params.pageId && !params.spaceKey) {
    return errorResponse("publish requires either `pageId` (update) or `spaceKey` + `title` (create).");
  }
  if (!params.pageId && !params.title) {
    return errorResponse("publish (create) requires a `title`.");
  }
  if (!params.content || params.content.trim() === "") {
    return errorResponse("publish requires non-empty `content` (markdown).");
  }

  let config: ReturnType<typeof resolveConfig>;
  try {
    config = resolveConfig(kb);
  } catch (err: unknown) {
    return errorResponse(String(err));
  }
  const allowed = config.confluenceSpaces ?? [];

  // PUB-1: writes fail closed when no allow-list configured.
  // Reject before even constructing the storage so the LLM sees the cause.
  if (!isAllowAllSpaces(allowed) && allowed.length === 0) {
    return errorResponse(disallowedSpaceMessage(params.spaceKey ?? "", allowed));
  }

  const storage = markdownToStorage(params.content);

  // Create path: validate spaceKey before any network.
  if (!params.pageId && params.spaceKey && !isSpaceAllowed(params.spaceKey, allowed)) {
    return errorResponse(disallowedSpaceMessage(params.spaceKey, allowed));
  }

  // PUB-14: don't instantiate ConfluenceClient until we actually need it.
  let client: ConfluenceClient | null = null;
  const getClient = () => {
    if (!client) client = new ConfluenceClient(config);
    return client;
  };

  // Update path: hoist a single GET that gives us spaceKey + title + version
  // (PUB-13). This replaces the previous getPageSpaceKey + getPageVersion +
  // updatePage-internal-title-backfill cascade.
  let resolved: { spaceKey: string; title: string; version: number } | null = null;
  if (params.pageId) {
    try {
      resolved = await getClient().getPageMeta(params.pageId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return errorResponse(`Failed to resolve target page for ${params.pageId}: ${msg}`);
    }
    if (!isSpaceAllowed(resolved.spaceKey, allowed)) {
      return errorResponse(
        `${disallowedSpaceMessage(resolved.spaceKey, allowed)} (page ${params.pageId} lives in space "${resolved.spaceKey}")`,
      );
    }
  }

  // PUB-6: validate parentId resolves into the same allowed target space.
  // Skipped when allow-list is permissive — `['*']` opted into wildcard.
  if (!params.pageId && params.parentId && !isAllowAllSpaces(allowed)) {
    try {
      const parent = await getClient().getPageMeta(params.parentId);
      const targetSpace = params.spaceKey as string;
      if (parent.spaceKey.toLowerCase() !== targetSpace.toLowerCase()) {
        return errorResponse(
          `parentId ${params.parentId} lives in space "${parent.spaceKey}" but publish target is "${targetSpace}". ` +
            "Refusing to create a page under a parent in a different space.",
        );
      }
      if (!isSpaceAllowed(parent.spaceKey, allowed)) {
        return errorResponse(
          `${disallowedSpaceMessage(parent.spaceKey, allowed)} (parentId ${params.parentId} lives in space "${parent.spaceKey}")`,
        );
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return errorResponse(`Failed to resolve parent page ${params.parentId}: ${msg}`);
    }
  }

  // Preview path: never writes.
  if (!params.confirm) {
    const preview = buildPublishPreview(params, storage);
    const next = buildSuggestions("confluence", "publish", { confirmed: false, isUpdate: !!params.pageId });
    return textResponse(preview + next);
  }

  try {
    if (params.pageId) {
      // PUB-4: re-fetch the page meta immediately before the PUT to shrink the
      // TOCTOU window. If the page has been moved out of the allowed space
      // since the first scope check, abort now. Race is not eliminated — a
      // truly concurrent admin-move could still slip through — but the window
      // collapses from "from scope check to write" to "from re-check to write".
      const fresh = await getClient().getPageMeta(params.pageId);
      if (!isSpaceAllowed(fresh.spaceKey, allowed)) {
        return errorResponse(
          `${disallowedSpaceMessage(fresh.spaceKey, allowed)} (page ${params.pageId} was moved to "${fresh.spaceKey}" between checks)`,
        );
      }
      const result = await getClient().updatePage({
        pageId: params.pageId,
        title: params.title ?? fresh.title,
        body: storage,
        version: fresh.version,
      });
      const next = buildSuggestions("confluence", "publish", { confirmed: true, isUpdate: true });
      return textResponse(
        [
          "**Page updated.**",
          `- ID: ${result.id}`,
          `- Title: ${result.title}`,
          `- New version: ${result.version}`,
          result.url ? `- URL: ${result.url}` : "",
        ]
          .filter(Boolean)
          .join("\n") + next,
      );
    }

    // Create path — we already validated spaceKey + title above.
    const result = await getClient().createPage({
      spaceKey: params.spaceKey as string,
      title: params.title as string,
      body: storage,
      parentId: params.parentId,
    });
    const next = buildSuggestions("confluence", "publish", { confirmed: true, isUpdate: false });
    return textResponse(
      [
        "**Page created.**",
        `- ID: ${result.id}`,
        `- Title: ${result.title}`,
        `- Version: ${result.version}`,
        result.url ? `- URL: ${result.url}` : "",
      ]
        .filter(Boolean)
        .join("\n") + next,
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return errorResponse(`Publish failed: ${msg}`);
  }
}
