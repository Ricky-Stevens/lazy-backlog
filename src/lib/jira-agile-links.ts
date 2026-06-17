/**
 * Jira issue-link operations — transitions, assignee, links, remote links,
 * issue-link types, and link removal.
 *
 * Extracted from jira-agile.ts to keep that file under the 400-line cap. All
 * functions accept a `request` callback to avoid circular deps with JiraClient.
 */
import type { IssueLinkTypesResponse, TransitionsResponse } from "./jira-types.js";

export type RequestFn = <T>(method: string, path: string, body?: unknown) => Promise<T>;

const ISSUE_KEY_RE = /^[A-Z][A-Z0-9_]+-\d+$/;
function validateIssueKey(key: string): void {
  if (!ISSUE_KEY_RE.test(key)) throw new Error(`Invalid issue key: "${key}" — expected format like ABC-123`);
}

/** Get available transitions for an issue. */
export async function getTransitions(
  request: RequestFn,
  issueKey: string,
): Promise<Array<{ id: string; name: string; to: { name: string } }>> {
  validateIssueKey(issueKey);
  const res = await request<TransitionsResponse>(
    "GET",
    `/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`,
  );
  return res.transitions;
}

/** Transition an issue to a new status. */
export async function transitionIssue(request: RequestFn, issueKey: string, transitionId: string): Promise<void> {
  validateIssueKey(issueKey);
  await request<void>("POST", `/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`, {
    transition: { id: transitionId },
  });
}

/** Assign an issue to a user (null to unassign). */
export async function assignIssue(request: RequestFn, issueKey: string, accountId: string | null): Promise<void> {
  validateIssueKey(issueKey);
  await request<void>("PUT", `/rest/api/3/issue/${encodeURIComponent(issueKey)}/assignee`, { accountId });
}

/** Create a link between two issues. */
export async function linkIssues(
  request: RequestFn,
  inwardKey: string,
  outwardKey: string,
  linkType: string,
): Promise<void> {
  validateIssueKey(inwardKey);
  validateIssueKey(outwardKey);
  await request<void>("POST", "/rest/api/3/issueLink", {
    type: { name: linkType },
    inwardIssue: { key: inwardKey },
    outwardIssue: { key: outwardKey },
  });
}

/** Get available issue link types. */
export async function getIssueLinkTypes(
  request: RequestFn,
): Promise<Array<{ name: string; inward: string; outward: string }>> {
  const res = await request<IssueLinkTypesResponse>("GET", "/rest/api/3/issueLinkType");
  return res.issueLinkTypes;
}

/**
 * Attach a remote/web link to an issue (e.g. a Confluence source-spec URL).
 *
 * Uses Jira's remote-link endpoint, which is distinct from issue-to-issue
 * links — it accepts arbitrary URLs. Returns the new link's id.
 */
export async function addRemoteLink(
  request: RequestFn,
  issueKey: string,
  link: { url: string; title: string; summary?: string; relationship?: string; iconUrl?: string; globalId?: string },
): Promise<{ id: number }> {
  validateIssueKey(issueKey);
  if (!link.url) throw new Error("addRemoteLink requires a url");
  if (!link.title) throw new Error("addRemoteLink requires a title");
  const body: Record<string, unknown> = {
    object: {
      url: link.url,
      title: link.title,
      ...(link.summary ? { summary: link.summary } : {}),
      ...(link.iconUrl ? { icon: { url16x16: link.iconUrl, title: link.title } } : {}),
    },
    ...(link.relationship ? { relationship: link.relationship } : {}),
    ...(link.globalId ? { globalId: link.globalId } : {}),
  };
  return request<{ id: number }>("POST", `/rest/api/3/issue/${encodeURIComponent(issueKey)}/remotelink`, body);
}

/** Get links for an issue, parsed into a flat array with direction info. */
export async function getIssueLinks(
  request: RequestFn,
  issueKey: string,
): Promise<
  Array<{
    id: string;
    type: string;
    direction: "inward" | "outward";
    linkedIssue: { key: string; summary: string; status: string };
  }>
> {
  validateIssueKey(issueKey);
  const raw = await request<{
    fields: {
      issuelinks: Array<{
        id: string;
        type: { name: string };
        inwardIssue?: { key: string; fields: { summary: string; status: { name: string } } };
        outwardIssue?: { key: string; fields: { summary: string; status: { name: string } } };
      }>;
    };
  }>("GET", `/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=issuelinks`);

  const links: Array<{
    id: string;
    type: string;
    direction: "inward" | "outward";
    linkedIssue: { key: string; summary: string; status: string };
  }> = [];
  for (const link of raw.fields.issuelinks) {
    if (link.inwardIssue) {
      links.push({
        id: link.id,
        type: link.type.name,
        direction: "inward",
        linkedIssue: {
          key: link.inwardIssue.key,
          summary: link.inwardIssue.fields?.summary ?? "",
          status: link.inwardIssue.fields?.status?.name ?? "Unknown",
        },
      });
    }
    if (link.outwardIssue) {
      links.push({
        id: link.id,
        type: link.type.name,
        direction: "outward",
        linkedIssue: {
          key: link.outwardIssue.key,
          summary: link.outwardIssue.fields?.summary ?? "",
          status: link.outwardIssue.fields?.status?.name ?? "Unknown",
        },
      });
    }
  }
  return links;
}

/** Remove an issue link by its ID. */
export async function removeIssueLink(request: RequestFn, linkId: string): Promise<void> {
  await request<void>("DELETE", `/rest/api/3/issueLink/${encodeURIComponent(linkId)}`);
}
