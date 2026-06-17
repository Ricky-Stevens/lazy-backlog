import { buildJiraClient, errorResponse, textResponse } from "../lib/config.js";
import type { KnowledgeBase } from "../lib/db.js";
import type { JiraAttachment } from "../lib/jira-types.js";
import {
  buildJiraDownloadContext,
  type DownloadContext,
  humanReadableSize,
  runAttachmentDownloads,
} from "./issues-get-download.js";
import { buildSuggestions } from "./suggestions.js";

// ---------------------------------------------------------------------------
// Helper types
// ---------------------------------------------------------------------------

interface IssueDetail {
  id: string;
  key: string;
  summary: string;
  issueType: string;
  status: string;
  priority: string;
  storyPoints?: number | null;
  assignee?: string;
  reporter?: string;
  parentKey?: string;
  labels: string[];
  components: string[];
  created: string;
  updated: string;
  url: string;
  description?: string;
  comments: Array<{ author: string; created: string; body: string }>;
  attachments?: JiraAttachment[];
}

interface DevStatus {
  pullRequests: number;
  commits: number;
  builds: number;
}

interface FetchedIssue {
  key: string;
  summary: string;
  description?: string;
  comments: Array<{ author: string; created: string; body: string }>;
  dev: { pullRequests: number; commits: number };
}

// ---------------------------------------------------------------------------
// Key resolution
// ---------------------------------------------------------------------------

function resolveKeys(params: { issueKey?: string; issueKeys?: string[] }): string[] {
  if (params.issueKeys?.length) return params.issueKeys;
  if (params.issueKey) return [params.issueKey];
  return [];
}

// ---------------------------------------------------------------------------
// Single-issue formatting helpers
// ---------------------------------------------------------------------------

function formatIssueMetadata(issue: IssueDetail): string {
  let out = `# ${issue.key}: ${issue.summary}\n\n`;
  out += `**Type:** ${issue.issueType} | **Status:** ${issue.status} | **Priority:** ${issue.priority}\n`;
  if (issue.storyPoints != null) out += `**Story Points:** ${issue.storyPoints}\n`;
  if (issue.assignee) out += `**Assignee:** ${issue.assignee}\n`;
  if (issue.reporter) out += `**Reporter:** ${issue.reporter}\n`;
  if (issue.parentKey) out += `**Parent:** ${issue.parentKey}\n`;
  if (issue.labels.length) out += `**Labels:** ${issue.labels.join(", ")}\n`;
  if (issue.components.length) out += `**Components:** ${issue.components.join(", ")}\n`;
  out += `**Created:** ${issue.created} | **Updated:** ${issue.updated}\n`;
  out += `**URL:** ${issue.url}\n`;
  return out;
}

function formatDevStatus(dev: DevStatus): string {
  const devParts = [
    dev.pullRequests > 0 ? `${dev.pullRequests} PR(s)` : "No PRs",
    dev.commits > 0 ? `${dev.commits} commit(s)` : "No commits",
    dev.builds > 0 ? `${dev.builds} build(s)` : null,
  ].filter(Boolean);
  return `**Dev Activity:** ${devParts.join(" | ")}\n`;
}

function formatIssueLinks(
  links: Array<{ direction: string; linkType: string; issueKey: string; status: string; summary: string }>,
): string {
  if (links.length === 0) return "";
  let out = "\n**Links:**\n";
  for (const link of links) {
    const arrow = link.direction === "outward" ? "\u2192" : "\u2190";
    out += `- ${link.linkType} ${arrow} ${link.issueKey} (${link.status}): ${link.summary}\n`;
  }
  return out;
}

function formatComments(comments: Array<{ author: string; created: string; body: string }>): string {
  if (comments.length === 0) return "";
  let out = `\n## Recent Comments (${comments.length})\n`;
  for (const c of comments) out += `\n**${c.author}** (${c.created}):\n${c.body}\n`;
  return out;
}

/**
 * Render the attachment manifest for a ticket. Image attachments are emitted
 * as markdown image syntax (`![filename](url)`) so MCP clients that render
 * inline images can show them; non-image attachments are listed in a table
 * with filename, mime type, size, author, created date, and download URL.
 */
export function formatAttachments(attachments: JiraAttachment[] | undefined): string {
  if (!attachments || attachments.length === 0) return "";
  let out = `\n## Attachments (${attachments.length})\n\n`;
  out += `| Filename | Type | Size | Author | Created |\n`;
  out += `|----------|------|------|--------|---------|\n`;
  for (const a of attachments) {
    const flag = a.isImage ? " (image)" : "";
    out += `| [${a.filename}](${a.url})${flag} | ${a.mimeType} | ${humanReadableSize(a.size)} | ${a.author ?? "?"} | ${a.created} |\n`;
  }
  const images = attachments.filter((a) => a.isImage);
  if (images.length > 0) {
    out += `\n### Image previews\n`;
    for (const img of images) {
      out += `![${img.filename}](${img.url})\n`;
    }
  }
  return out;
}

async function fetchIssueLinks(
  jira: unknown,
  key: string,
): Promise<Array<{ direction: string; linkType: string; issueKey: string; status: string; summary: string }>> {
  try {
    return await (
      jira as {
        getIssueLinks(
          key: string,
        ): Promise<Array<{ direction: string; linkType: string; issueKey: string; status: string; summary: string }>>;
      }
    ).getIssueLinks(key);
  } catch {
    return [];
  }
}

async function handleSingleIssue(
  jira: { getIssue(key: string): Promise<IssueDetail>; getDevStatus(id: string): Promise<DevStatus> },
  key: string,
  downloadCtx: DownloadContext | null,
) {
  const issue = await jira.getIssue(key);
  const dev = await jira.getDevStatus(issue.id);
  const links = await fetchIssueLinks(jira, key);

  let out = formatIssueMetadata(issue);
  out += formatDevStatus(dev);
  if (issue.description) out += `\n## Description\n${issue.description}\n`;
  out += formatIssueLinks(links);
  out += formatComments(issue.comments);
  out += formatAttachments(issue.attachments);

  let downloadSection = "";
  if (downloadCtx && issue.attachments && issue.attachments.length > 0) {
    downloadSection = await runAttachmentDownloads(issue.attachments, downloadCtx);
    out += downloadSection;
  }

  const hasMissingFields =
    !issue.description || !issue.assignee || issue.labels.length === 0 || issue.components.length === 0;
  const hasAttachments = (issue.attachments?.length ?? 0) > 0;
  const suggestions = buildSuggestions("issues", "get", {
    hasMissingFields,
    hasAttachments,
    downloaded: downloadSection.length > 0,
  });
  return textResponse(out + suggestions);
}

// ---------------------------------------------------------------------------
// Bulk-fetch formatting helpers
// ---------------------------------------------------------------------------

function formatBulkErrorRow(issue: { key: string; error: string } | null | undefined, fallbackKey: string): string {
  const key = issue ? issue.key : fallbackKey;
  const errMsg = issue && "error" in issue ? issue.error : "unknown";
  return `| ${key} | **ERROR:** ${errMsg} | - | - | - | - | - |\n`;
}

function formatBulkIssueRow(issue: IssueDetail, prs: number, commits: number): string {
  return `| ${issue.key} | ${issue.summary} | ${issue.issueType} | ${issue.status} | ${issue.priority} | ${prs || "None"} | ${commits || "None"} |\n`;
}

function formatNoDevActivitySection(fetched: FetchedIssue[]): string {
  const noDevActivity = fetched.filter((i) => i.dev.pullRequests === 0 && i.dev.commits === 0);
  if (noDevActivity.length === 0) return "";
  let out = `\n## No Dev Activity (${noDevActivity.length})\n`;
  for (const issue of noDevActivity) {
    out += `- **${issue.key}** (${issue.summary})\n`;
  }
  return out;
}

function formatCondensedDetails(fetched: FetchedIssue[]): string {
  let out = "";
  for (const issue of fetched) {
    out += `\n---\n## ${issue.key}: ${issue.summary}\n`;
    if (issue.description) out += `${issue.description}\n`;
    if (issue.comments.length > 0) {
      out += formatLatestComment(issue.comments);
    }
  }
  return out;
}

function formatLatestComment(comments: Array<{ author: string; created: string; body: string }>): string {
  const latest = comments.at(-1);
  if (!latest) return "";
  const truncated = latest.body.length > 200 ? `${latest.body.slice(0, 200)}...` : latest.body;
  return `\n*Latest comment by ${latest.author} (${latest.created}):* ${truncated}\n`;
}

async function handleBulkFetch(
  jira: { getIssue(key: string): Promise<IssueDetail>; getDevStatus(id: string): Promise<DevStatus> },
  keys: string[],
) {
  let out = `# Bulk Fetch (${keys.length} issues)\n\n`;
  out += `| Key | Summary | Type | Status | Priority | PRs | Commits |\n`;
  out += `|-----|---------|------|--------|----------|-----|--------|\n`;

  const issueResults = await Promise.all(
    keys.map((k) =>
      jira.getIssue(k).catch((err) => ({ key: k, error: err instanceof Error ? err.message : String(err) })),
    ),
  );
  const devResults = await Promise.all(
    issueResults.map((issue) => ("error" in issue ? Promise.resolve(null) : jira.getDevStatus(issue.id))),
  );

  const fetched: FetchedIssue[] = [];
  for (let idx = 0; idx < issueResults.length; idx++) {
    const issue = issueResults[idx];
    const dev = devResults[idx];
    if (!issue || "error" in issue) {
      out += formatBulkErrorRow(issue as { key: string; error: string } | null, keys[idx] ?? "?");
      continue;
    }
    const prs = dev?.pullRequests ?? 0;
    const commits = dev?.commits ?? 0;
    out += formatBulkIssueRow(issue, prs, commits);
    fetched.push({ ...issue, dev: { pullRequests: prs, commits } });
  }

  out += formatNoDevActivitySection(fetched);
  out += formatCondensedDetails(fetched);
  return textResponse(out);
}

// ---------------------------------------------------------------------------
// Exported handlers
// ---------------------------------------------------------------------------

/** Handle the 'get' action (single or bulk fetch with dev status enrichment). */
export async function handleGetAction(
  params: {
    issueKey?: string;
    issueKeys?: string[];
    /** When true, download attachments to the configured directory. */
    download?: boolean;
    /** Optional filter: only download attachments matching these ids/filenames. */
    attachmentIds?: string[];
  },
  kb: KnowledgeBase,
) {
  const keys = resolveKeys(params);
  if (keys.length === 0) return errorResponse("issueKey or issueKeys is required for 'get' action.");

  try {
    const { jira, config } = buildJiraClient(kb);
    let downloadCtx: DownloadContext | null = null;
    if (params.download) {
      if (keys.length !== 1) {
        return errorResponse("download is only supported when fetching a single issue (issueKey, not issueKeys).");
      }
      // ATT-1: the download directory is sourced exclusively from the stored
      // config — no per-call override. The roadmap explicitly forbids writing
      // outside the configured directory.
      downloadCtx = buildJiraDownloadContext(kb, config, params.attachmentIds);
    }

    if (keys.length === 1) {
      return await handleSingleIssue(jira as Parameters<typeof handleSingleIssue>[0], keys[0] as string, downloadCtx);
    }
    return await handleBulkFetch(jira as Parameters<typeof handleBulkFetch>[0], keys);
  } catch (err: unknown) {
    return errorResponse(`Failed to fetch issues: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export type { JiraAttachment };

// ---------------------------------------------------------------------------
// Search helpers
// ---------------------------------------------------------------------------

function autoScopeJql(jql: string, projectKey: string): string {
  if (/\bproject\s*[=!]/i.test(jql)) return jql;
  const orderMatch = /\s+(ORDER\s+BY\s+.+)$/i.exec(jql);
  const orderClause = orderMatch ? ` ${orderMatch[1]}` : "";
  const filterPart = orderMatch ? jql.slice(0, orderMatch.index) : jql;
  return `project = ${projectKey} AND (${filterPart})${orderClause}`;
}

function shouldUseProjectSearch(jql: string): boolean {
  const isEpicQuery = /\btype\s*=\s*Epic\b/i.test(jql) || /\bissuetype\s*=\s*Epic\b/i.test(jql);
  const hasHistoryOps = /\b(was|changed|closedSprints|openSprints|futureSprints)\b/i.test(jql);
  return isEpicQuery || hasHistoryOps;
}

interface SearchIssue {
  key: string;
  fields: {
    summary: string;
    status?: { name: string };
    priority?: { name: string };
    assignee?: { displayName: string };
  };
}

function formatSearchResults(issues: SearchIssue[], total: number, originalJql: string): string {
  if (issues.length === 0) return `No issues found for JQL: \`${originalJql}\``;
  let out = `# Search Results (${issues.length}/${total})\n\n`;
  out += `| Key | Summary | Status | Priority | Assignee |\n`;
  out += `|-----|---------|--------|----------|----------|\n`;
  for (const issue of issues) {
    out += `| ${issue.key} | ${issue.fields.summary} | ${issue.fields.status?.name ?? "Unknown"} | ${issue.fields.priority?.name ?? "None"} | ${issue.fields.assignee?.displayName || "Unassigned"} |\n`;
  }
  return out;
}

/** Handle the 'search' action. */
export async function handleSearchAction(
  params: {
    jql?: string;
    maxResults?: number;
  },
  kb: KnowledgeBase,
) {
  if (!params.jql) return errorResponse("jql is required for 'search' action.");
  try {
    const { jira, config } = buildJiraClient(kb);
    const boardId = config.jiraBoardId;
    const jql = config.jiraProjectKey ? autoScopeJql(params.jql, config.jiraProjectKey) : params.jql;

    const useProjectSearch = shouldUseProjectSearch(jql);
    const result =
      boardId && !useProjectSearch
        ? await jira.searchBoardIssues(boardId, jql, params.maxResults)
        : await jira.searchIssues(jql, undefined, params.maxResults);

    const resultCount = result.issues.length;
    const suggestions = buildSuggestions("issues", "search", { resultCount });
    return textResponse(formatSearchResults(result.issues as SearchIssue[], result.total, params.jql) + suggestions);
  } catch (err: unknown) {
    return errorResponse(`Search failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
