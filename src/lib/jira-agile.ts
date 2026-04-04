/**
 * Jira Agile REST API operations — sprints, backlog, ranking, board search,
 * transitions, links, changelog, comments, labels, and dev status.
 *
 * All functions accept a `request` callback for use by JiraClient without circular deps.
 */
import { markdownToAdf } from "./adf.js";
import type {
  ChangelogEntry,
  ChangelogResponse,
  IssueLinkTypesResponse,
  JiraSprint,
  SearchIssue,
  SprintListResponse,
  TransitionsResponse,
} from "./jira-types.js";

export type RequestFn = <T>(method: string, path: string, body?: unknown) => Promise<T>;
const ISSUE_KEY_RE = /^[A-Z][A-Z0-9_]+-\d+$/;
function validateIssueKey(key: string): void {
  if (!ISSUE_KEY_RE.test(key)) throw new Error(`Invalid issue key: "${key}" — expected format like ABC-123`);
}

// ── Sprints ──────────────────────────────────────────────────────────────────

/** List sprints for a board, optionally filtered by state. Handles pagination. */
export async function listSprints(
  request: RequestFn,
  boardId: string,
  state?: "active" | "future" | "closed",
): Promise<JiraSprint[]> {
  const sprints: JiraSprint[] = [];
  let startAt = 0;
  let isLast = false;

  while (!isLast) {
    let path = `/rest/agile/1.0/board/${encodeURIComponent(boardId)}/sprint?startAt=${startAt}`;
    if (state) path += `&state=${encodeURIComponent(state)}`;
    const res = await request<SprintListResponse>("GET", path);
    sprints.push(...res.values);
    isLast = res.isLast;
    startAt += res.maxResults;
  }

  return sprints;
}

/** Get a single sprint by ID. */
export async function getSprint(request: RequestFn, sprintId: string): Promise<JiraSprint> {
  return request<JiraSprint>("GET", `/rest/agile/1.0/sprint/${encodeURIComponent(sprintId)}`);
}

/** Get issues in a sprint. Handles pagination. */
export async function getSprintIssues(
  request: RequestFn,
  sprintId: string,
  fieldList: string,
): Promise<{ issues: SearchIssue[]; total: number }> {
  const allIssues: SearchIssue[] = [];
  let startAt = 0;
  let total = 0;
  let done = false;

  while (!done) {
    const res = await request<{ issues: SearchIssue[]; total: number; maxResults: number }>(
      "GET",
      `/rest/agile/1.0/sprint/${encodeURIComponent(sprintId)}/issue?startAt=${startAt}&fields=${fieldList}`,
    );
    allIssues.push(...res.issues);
    total = res.total;
    startAt += res.maxResults;
    done = startAt >= total;
  }

  return { issues: allIssues, total };
}

/** Create a new sprint on a board. */
export async function createSprint(
  request: RequestFn,
  boardId: string,
  name: string,
  opts?: { goal?: string; startDate?: string; endDate?: string },
): Promise<JiraSprint> {
  const sprintBody: Record<string, unknown> = { name, originBoardId: boardId };
  if (opts?.goal) sprintBody.goal = opts.goal;
  if (opts?.startDate) sprintBody.startDate = opts.startDate;
  if (opts?.endDate) sprintBody.endDate = opts.endDate;
  return request<JiraSprint>("POST", "/rest/agile/1.0/sprint", sprintBody);
}

/** Move issues into a sprint. */
export async function moveIssuesToSprint(request: RequestFn, sprintId: string, issueKeys: string[]): Promise<void> {
  await request<void>("POST", `/rest/agile/1.0/sprint/${encodeURIComponent(sprintId)}/issue`, {
    issues: issueKeys,
  });
}

/** Get full sprint details including goal. */
export async function getSprintDetails(
  request: RequestFn,
  sprintId: string,
): Promise<{ id: number; name: string; state: string; goal?: string; startDate?: string; endDate?: string }> {
  const raw = await request<{
    id: number;
    name: string;
    state: string;
    goal?: string;
    startDate?: string;
    endDate?: string;
  }>("GET", `/rest/agile/1.0/sprint/${encodeURIComponent(sprintId)}`);
  return {
    id: raw.id,
    name: raw.name,
    state: raw.state,
    goal: raw.goal,
    startDate: raw.startDate,
    endDate: raw.endDate,
  };
}

/** Update sprint goal and other fields. */
export async function updateSprint(
  request: RequestFn,
  sprintId: string,
  updates: { goal?: string; name?: string; startDate?: string; endDate?: string },
): Promise<void> {
  await request<void>("PUT", `/rest/agile/1.0/sprint/${encodeURIComponent(sprintId)}`, updates);
}

// ── Transitions & Links ──────────────────────────────────────────────────────

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

// ── Changelog ────────────────────────────────────────────────────────────────

/** Get the full changelog for an issue. Handles pagination. */
export async function getIssueChangelog(request: RequestFn, issueKey: string): Promise<ChangelogEntry[]> {
  validateIssueKey(issueKey);
  const encodedKey = encodeURIComponent(issueKey);
  const entries: ChangelogEntry[] = [];
  let startAt = 0;
  let isLast = false;

  while (!isLast) {
    const res = await request<ChangelogResponse>("GET", `/rest/api/3/issue/${encodedKey}/changelog?startAt=${startAt}`);
    entries.push(...res.values);
    isLast = res.isLast;
    startAt += res.maxResults;
  }

  return entries;
}

// ── Comments & Labels ────────────────────────────────────────────────────────

/** Add a comment to an issue (markdown converted to ADF). */
export async function addComment(request: RequestFn, issueKey: string, body: string): Promise<void> {
  validateIssueKey(issueKey);
  await request<unknown>("POST", `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`, {
    body: markdownToAdf(body),
  });
}

/** Add labels to an issue without replacing existing ones. */
export async function addLabels(request: RequestFn, issueKey: string, labels: string[]): Promise<void> {
  validateIssueKey(issueKey);
  await request<void>("PUT", `/rest/api/3/issue/${encodeURIComponent(issueKey)}`, {
    update: { labels: labels.map((l) => ({ add: l })) },
  });
}

// ── Ranking & Backlog ────────────────────────────────────────────────────────

/** Reorder an issue in the backlog by ranking it before or after another issue. */
export async function rankIssue(
  request: RequestFn,
  issueKey: string,
  options: { rankBefore?: string; rankAfter?: string },
): Promise<void> {
  validateIssueKey(issueKey);
  if (!options.rankBefore && !options.rankAfter) {
    throw new Error("rankIssue requires exactly one of rankBefore or rankAfter");
  }
  if (options.rankBefore) validateIssueKey(options.rankBefore);
  if (options.rankAfter) validateIssueKey(options.rankAfter);

  const body: Record<string, unknown> = { issues: [issueKey] };
  if (options.rankBefore) body.rankBeforeIssue = options.rankBefore;
  if (options.rankAfter) body.rankAfterIssue = options.rankAfter;

  await request<void>("PUT", "/rest/agile/1.0/issue/rank", body);
}

/** Fetch backlog issues (not in any sprint) for a board, ordered by rank. */
export async function getBacklogIssues(
  request: RequestFn,
  boardId: string,
  fields: string,
  maxResults = 50,
  startAt = 0,
): Promise<{ issues: SearchIssue[]; total: number }> {
  const res = await request<{ issues: SearchIssue[]; total: number; maxResults: number }>(
    "GET",
    `/rest/agile/1.0/board/${encodeURIComponent(boardId)}/backlog?startAt=${startAt}&maxResults=${Math.min(maxResults, 100)}&fields=${fields}`,
  );
  return { issues: res.issues, total: res.total };
}

/** Search issues scoped to a specific board (Agile API). Only returns issues belonging to the board. */
export async function searchBoardIssues(
  request: RequestFn,
  boardId: string,
  fields: string,
  jql?: string,
  maxResults = 50,
  startAt = 0,
): Promise<{ issues: SearchIssue[]; total: number }> {
  const params = new URLSearchParams({
    startAt: String(startAt),
    maxResults: String(Math.min(maxResults, 100)),
    fields,
  });
  if (jql) params.set("jql", jql);
  const res = await request<{ issues: SearchIssue[]; total: number; maxResults: number }>(
    "GET",
    `/rest/agile/1.0/board/${encodeURIComponent(boardId)}/issue?${params.toString()}`,
  );
  return { issues: res.issues, total: res.total };
}

/** Search backlog issues scoped to a specific board with optional JQL filter. */
export async function searchBacklogIssues(
  request: RequestFn,
  boardId: string,
  fields: string,
  jql?: string,
  maxResults = 50,
  startAt = 0,
): Promise<{ issues: SearchIssue[]; total: number }> {
  const params = new URLSearchParams({
    startAt: String(startAt),
    maxResults: String(Math.min(maxResults, 100)),
    fields,
  });
  if (jql) params.set("jql", jql);
  const res = await request<{ issues: SearchIssue[]; total: number; maxResults: number }>(
    "GET",
    `/rest/agile/1.0/board/${encodeURIComponent(boardId)}/backlog?${params.toString()}`,
  );
  return { issues: res.issues, total: res.total };
}

// ── Issue Links (detail) ─────────────────────────────────────────────────────

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

// ── Dev Status ───────────────────────────────────────────────────────────────

/** Fetch dev status (PRs, commits, builds) for an issue. Returns counts; best-effort (returns empty on 403/404). */
export async function getDevStatus(
  request: RequestFn,
  issueId: string,
): Promise<{
  pullRequests: number;
  commits: number;
  builds: number;
  reviews: number;
}> {
  const empty = { pullRequests: 0, commits: 0, builds: 0, reviews: 0 };
  try {
    const res = await request<{
      summary: {
        pullrequest?: { overall?: { count?: number; stateCount?: number } };
        repository?: { overall?: { count?: number } };
        build?: { overall?: { count?: number } };
        review?: { overall?: { count?: number } };
      };
    }>("GET", `/rest/dev-status/latest/issue/summary?issueId=${encodeURIComponent(issueId)}`);
    const s = res.summary;
    return {
      pullRequests: s.pullrequest?.overall?.count ?? 0,
      commits: s.repository?.overall?.count ?? 0,
      builds: s.build?.overall?.count ?? 0,
      reviews: s.review?.overall?.count ?? 0,
    };
  } catch {
    return empty;
  }
}
