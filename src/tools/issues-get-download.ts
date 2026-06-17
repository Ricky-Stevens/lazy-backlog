/**
 * Jira attachment download flow for the `issues get` action.
 *
 * Performs Stage-B safe downloads (validated host, sanitised filename, size
 * cap) against the Atlassian content host(s) using the project's API auth.
 */

import {
  ATLASSIAN_HOSTS,
  DOWNLOAD_DIR_CONFIG_KEY,
  defaultDownloadDir,
  downloadToDir,
  humanReadableSize,
  sanitizeFilename,
} from "../lib/attachments.js";
import type { KnowledgeBase } from "../lib/db.js";
import { authHeaders } from "../lib/jira-auth.js";
import type { JiraAttachment } from "../lib/jira-types.js";

// Re-exported for back-compat with any callers/tests that imported the
// previously-local helpers (GEN-7).
export { humanReadableSize };
export const defaultJiraDownloadDir = defaultDownloadDir;

export interface DownloadContext {
  dir: string;
  headers: Record<string, string>;
  allowedHosts: string[];
  maxBytes?: number;
  /** Optional filter — only attachments matching id or filename are downloaded. */
  filter?: string[];
}

/**
 * Atlassian-served attachment hosts (GEN-7).
 *
 * Built on top of the shared `ATLASSIAN_HOSTS` list with Jira-specific
 * additions (`jira-dev.com` for the legacy dev site). Confluence's list lives
 * in `knowledge-attachments.ts`; the shared base means future Atlassian host
 * changes only need a single edit in `attachments.ts`.
 *
 * Tightened from `atlassian.com` apex (ATT-5).
 */
const JIRA_ATTACHMENT_HOSTS = [...ATLASSIAN_HOSTS, "jira-dev.com"];

/**
 * Build the download context from the **configured** directory only.
 *
 * Per-call `downloadDir` overrides were removed for ATT-1 — the roadmap
 * (B4) specifies "files saved only into an explicit, configured directory".
 * Users set the directory via `configure set downloadDir`; the directory
 * lives in `kb.getConfig(DOWNLOAD_DIR_CONFIG_KEY)`. We fall back to a default
 * under `$HOME/lazy-backlog-downloads` when nothing is configured.
 */
export function buildJiraDownloadContext(
  kb: KnowledgeBase,
  config: { siteUrl: string; email: string; apiToken: string },
  filter: string[] | undefined,
): DownloadContext {
  const dir = kb.getConfig(DOWNLOAD_DIR_CONFIG_KEY) || defaultJiraDownloadDir();
  const headers = authHeaders(config.email, config.apiToken);
  let siteHost = "";
  try {
    siteHost = new URL(config.siteUrl).hostname;
  } catch {
    // validateSiteUrl in JiraClient catches malformed siteUrl; defensive only.
  }
  const allowedHosts = Array.from(new Set([siteHost, ...JIRA_ATTACHMENT_HOSTS].filter(Boolean)));
  return { dir, headers, allowedHosts, filter };
}

function attachmentMatches(att: JiraAttachment, filter: string[] | undefined): boolean {
  if (!filter || filter.length === 0) return true;
  return filter.some((f) => f === att.id || f === att.filename);
}

export async function runAttachmentDownloads(attachments: JiraAttachment[], ctx: DownloadContext): Promise<string> {
  const targets = attachments.filter((a) => attachmentMatches(a, ctx.filter));
  if (targets.length === 0) {
    return `\n## Downloads\nNo matching attachments to download.\n`;
  }
  const lines: string[] = [`\n## Downloads (${targets.length})\n`];
  for (const att of targets) {
    try {
      const result = await downloadToDir(att.url, ctx.dir, att.filename, {
        headers: ctx.headers,
        allowedHosts: ctx.allowedHosts,
        maxBytes: ctx.maxBytes,
      });
      lines.push(
        `- **${result.filename}** → \`${result.path}\` (${humanReadableSize(result.bytes)}, ${result.contentType ?? att.mimeType})`,
      );
    } catch (err: unknown) {
      lines.push(`- **${sanitizeFilename(att.filename)}** FAILED: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
