/**
 * Confluence page attachment helpers for the `knowledge get-page` action.
 *
 * - `formatPageAttachments` renders a markdown table of the manifest.
 * - `runPageAttachmentDownloads` performs Stage-B safe downloads (validated
 *   host, sanitised filename, size cap) using Atlassian auth.
 */

import {
  ATLASSIAN_HOSTS,
  DOWNLOAD_DIR_CONFIG_KEY,
  defaultDownloadDir,
  downloadToDir,
  humanReadableSize,
  sanitizeFilename,
} from "../lib/attachments.js";
import { resolveConfig } from "../lib/config.js";
import type { ConfluenceAttachment } from "../lib/confluence.js";
import type { KnowledgeBase } from "../lib/db.js";

export interface KnowledgeDownloadParams {
  download?: boolean;
  attachmentIds?: string[];
}

// Re-exported so existing test imports `../tools/knowledge-attachments.js`
// keep working after GEN-7 dedupe.
export { humanReadableSize, defaultDownloadDir };

export function formatPageAttachments(attachments: ConfluenceAttachment[]): string {
  if (attachments.length === 0) return "";
  let out = `\n\n## Attachments (${attachments.length})\n\n`;
  out += `| Filename | Type | Size | URL |\n|---|---|---|---|\n`;
  for (const a of attachments) {
    const flag = a.isImage ? " (image)" : "";
    out += `| ${a.filename}${flag} | ${a.mediaType} | ${humanReadableSize(a.size)} | ${a.url} |\n`;
  }
  return out;
}

/**
 * Confluence content/CDN hosts. Tightened from bare `atlassian.com` (ATT-5):
 * the apex matched marketing/community sites; only attachment-serving hosts
 * remain. Add explicit hosts if a real download requires them.
 *
 * Sourced from the shared `ATLASSIAN_HOSTS` list (GEN-7).
 */
const CONFLUENCE_HOSTS = ATLASSIAN_HOSTS;

export async function runPageAttachmentDownloads(
  kb: KnowledgeBase,
  attachments: ConfluenceAttachment[],
  params: KnowledgeDownloadParams,
): Promise<string> {
  let config: ReturnType<typeof resolveConfig>;
  try {
    config = resolveConfig(kb);
  } catch (err: unknown) {
    return `\n\n## Downloads\nFAILED — Atlassian credentials missing: ${err instanceof Error ? err.message : String(err)}\n`;
  }
  // ATT-1: per-call directory overrides removed; the directory is sourced
  // exclusively from the stored config so writes can't escape the configured
  // root.
  const dir = kb.getConfig(DOWNLOAD_DIR_CONFIG_KEY) || defaultDownloadDir();
  const filter = params.attachmentIds;
  const targets = attachments.filter(
    (a) => !filter || filter.length === 0 || filter.includes(a.id) || filter.includes(a.filename),
  );
  if (targets.length === 0) {
    return `\n\n## Downloads\nNo matching attachments to download.\n`;
  }
  const siteHost = (() => {
    try {
      return new URL(config.siteUrl).hostname;
    } catch {
      return "";
    }
  })();
  const allowedHosts = Array.from(new Set([siteHost, ...CONFLUENCE_HOSTS])).filter(Boolean);
  const headers = {
    Authorization: `Basic ${Buffer.from(`${config.email}:${config.apiToken}`).toString("base64")}`,
    Accept: "*/*",
  };

  const lines: string[] = [`\n\n## Downloads (${targets.length})\n`];
  for (const att of targets) {
    try {
      const result = await downloadToDir(att.url, dir, att.filename, { headers, allowedHosts });
      lines.push(
        `- **${result.filename}** → \`${result.path}\` (${humanReadableSize(result.bytes)}, ${result.contentType ?? att.mediaType})`,
      );
    } catch (err: unknown) {
      lines.push(`- **${sanitizeFilename(att.filename)}** FAILED: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
