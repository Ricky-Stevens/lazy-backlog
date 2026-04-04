/**
 * Jira REST API v3 client — ticket CRUD, search, and schema-driven field resolution.
 *
 * Agile/sprint operations, ADF conversion, types, and schema discovery are in
 * separate modules and re-exported from this barrel for backward compatibility.
 */
import type { ProjectConfig } from "../config/schema.js";
import { adfToText, markdownToAdf } from "./adf.js";
import { fetchWithRetry } from "./http-utils.js";
import * as agile from "./jira-agile.js";
import { authHeaders, validateSiteUrl } from "./jira-auth.js";
import { discoverSchema, loadSchema, loadSchemaFromDb, saveSchemaToDb } from "./jira-schema.js";
import type {
  ChangelogEntry,
  CreatedTicket,
  FieldResolvable,
  JiraErrorResponse,
  JiraFieldSchema,
  JiraIssueDetail,
  JiraSchema,
  JiraTicketInput,
  JiraTicketUpdate,
  RawIssueResponse,
  SearchIssue,
} from "./jira-types.js";

export * from "./adf.js";
export * from "./jira-auth.js";
export * from "./jira-schema.js";
export * from "./jira-types.js";

const ISSUE_KEY_RE = /^[A-Z][A-Z0-9_]+-\d+$/;
const REQUEST_TIMEOUT_MS = 15_000;

function validateIssueKey(key: string): void {
  if (!ISSUE_KEY_RE.test(key)) throw new Error(`Invalid issue key: "${key}" — expected format like ABC-123`);
}

export class JiraClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly projectKey: string;
  private readonly schema: JiraSchema | null;

  constructor(config: ProjectConfig & { jiraProjectKey: string }, schema?: JiraSchema | null) {
    validateSiteUrl(config.siteUrl);
    this.baseUrl = config.siteUrl.replace(/\/$/, "");
    this.projectKey = config.jiraProjectKey;
    this.headers = authHeaders(config.email, config.apiToken);
    this.schema = schema || null;
  }

  private fetchWithRetry(method: string, url: string, body?: unknown): Promise<Response> {
    return fetchWithRetry(url, {
      method,
      headers: this.headers,
      body,
      timeoutMs: REQUEST_TIMEOUT_MS,
      label: "Jira",
    });
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchWithRetry(method, `${this.baseUrl}${path}`, body);
    if (!res.ok) {
      const text = await res.text();
      let detail = text.slice(0, 500);
      try {
        const err = JSON.parse(text) as JiraErrorResponse;
        const msgs = [...(err.errorMessages || []), ...Object.entries(err.errors || {}).map(([k, v]) => `${k}: ${v}`)];
        if (msgs.length > 0) detail = msgs.join("; ");
      } catch {
        /* use raw text */
      }
      throw new Error(`Jira ${res.status} ${method} ${path}: ${detail}`);
    }
    if (res.status === 204 || res.status === 201) {
      const text = await res.text();
      if (!text) return undefined as T;
      return JSON.parse(text) as T;
    }
    return res.json() as Promise<T>;
  }

  private get req(): agile.RequestFn {
    return this.request.bind(this);
  }

  // ── Issue CRUD ──

  async createIssue(input: JiraTicketInput): Promise<CreatedTicket> {
    const fields: Record<string, unknown> = {
      project: { key: this.projectKey },
      summary: input.summary,
      issuetype: { name: input.issueType },
    };
    if (input.description) fields.description = markdownToAdf(input.description);
    if (input.priority) fields.priority = { name: input.priority };
    if (input.labels?.length) fields.labels = input.labels;
    if (input.parentKey) fields.parent = { key: input.parentKey };
    this.resolveCustomFields(fields, input, input.issueType);
    this.autoFillRequired(fields, input.issueType);
    return this.request<CreatedTicket>("POST", "/rest/api/3/issue", { fields });
  }

  async getIssue(issueKey: string): Promise<JiraIssueDetail> {
    validateIssueKey(issueKey);
    const base =
      "summary,description,issuetype,priority,status,labels,components,parent,assignee,reporter,created,updated,comment";
    const spFieldId = this.resolveFieldId("Story Points");
    const fieldList = spFieldId ? `${base},${spFieldId}` : base;
    const raw = await this.request<RawIssueResponse>(
      "GET",
      `/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=${fieldList}`,
    );
    const f = raw.fields;
    return {
      key: raw.key,
      id: raw.id,
      summary: f.summary,
      description: f.description ? adfToText(f.description) : undefined,
      issueType: f.issuetype?.name ?? "",
      priority: f.priority?.name ?? "",
      status: f.status?.name ?? "",
      labels: f.labels || [],
      components: f.components?.map((c) => c.name) || [],
      parentKey: f.parent?.key,
      assignee: f.assignee?.displayName,
      reporter: f.reporter?.displayName,
      storyPoints: spFieldId ? (f[spFieldId] as number | undefined) : undefined,
      created: f.created,
      updated: f.updated,
      comments:
        f.comment?.comments?.slice(-5).map((c) => ({
          author: c.author?.displayName ?? "",
          created: c.created,
          body: adfToText(c.body),
        })) || [],
      url: `${this.baseUrl}/browse/${encodeURIComponent(raw.key)}`,
    };
  }

  async updateIssue(input: JiraTicketUpdate): Promise<void> {
    validateIssueKey(input.issueKey);
    const encodedKey = encodeURIComponent(input.issueKey);
    const issue = await this.request<{ fields: { issuetype: { name: string } } }>(
      "GET",
      `/rest/api/3/issue/${encodedKey}?fields=issuetype`,
    );
    const issueType = issue.fields.issuetype.name;
    const fields: Record<string, unknown> = {};
    if (input.summary != null) fields.summary = input.summary;
    if (input.description != null) fields.description = markdownToAdf(input.description);
    if (input.priority != null) fields.priority = { name: input.priority };
    if (input.labels != null) fields.labels = input.labels;
    if (input.parentKey != null) fields.parent = { key: input.parentKey };
    this.resolveCustomFields(fields, input, issueType);
    const body: Record<string, unknown> = {};
    if (Object.keys(fields).length > 0) body.fields = fields;
    if (input.comment) body.update = { comment: [{ add: { body: markdownToAdf(input.comment) } }] };
    if (Object.keys(body).length === 0) throw new Error("No fields to update");
    await this.request<void>("PUT", `/rest/api/3/issue/${encodedKey}`, body);
  }

  async createIssuesBatch(inputs: JiraTicketInput[]): Promise<{ issues: CreatedTicket[]; errors: string[] }> {
    const issues: CreatedTicket[] = [];
    const errors: string[] = [];
    for (const input of inputs) {
      try {
        issues.push(await this.createIssue(input));
      } catch (err: unknown) {
        errors.push(`${input.summary}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { issues, errors };
  }

  get storyPointsFieldId(): string | undefined {
    return this.resolveFieldId("Story Points") ?? undefined;
  }

  // ── Search ──

  private static readonly DEFAULT_SEARCH_FIELDS = [
    "summary",
    "status",
    "issuetype",
    "priority",
    "assignee",
    "created",
    "updated",
    "labels",
    "components",
    "fixVersions",
  ];

  async searchIssues(
    jql: string,
    fields?: string[],
    maxResults = 50,
    startAt = 0,
  ): Promise<{ issues: SearchIssue[]; total: number }> {
    const fieldList = [...(fields || JiraClient.DEFAULT_SEARCH_FIELDS)];
    const spFieldId = this.resolveFieldId("Story Points");
    if (spFieldId && !fieldList.includes(spFieldId)) fieldList.push(spFieldId);
    const params = new URLSearchParams({
      jql,
      fields: fieldList.join(","),
      maxResults: String(Math.min(maxResults, 100)),
      startAt: String(startAt),
    });
    const res = await this.request<{ issues: SearchIssue[]; total?: number; maxResults?: number }>(
      "GET",
      `/rest/api/3/search/jql?${params.toString()}`,
    );
    return { issues: res.issues, total: res.total ?? res.issues.length };
  }

  private buildFieldList(extra?: string[]): string {
    const fl = [...(extra || JiraClient.DEFAULT_SEARCH_FIELDS)];
    const spFieldId = this.resolveFieldId("Story Points");
    if (spFieldId && !fl.includes(spFieldId)) fl.push(spFieldId);
    return fl.join(",");
  }

  // ── Agile delegates (see jira-agile.ts) ──

  async listSprints(boardId: string, state?: "active" | "future" | "closed") {
    return agile.listSprints(this.req, boardId, state);
  }
  async getSprint(sprintId: string) {
    return agile.getSprint(this.req, sprintId);
  }
  async getSprintIssues(sprintId: string, fields?: string[]) {
    return agile.getSprintIssues(this.req, sprintId, this.buildFieldList(fields));
  }
  async createSprint(boardId: string, name: string, opts?: { goal?: string; startDate?: string; endDate?: string }) {
    return agile.createSprint(this.req, boardId, name, opts);
  }
  async moveIssuesToSprint(sprintId: string, issueKeys: string[]) {
    return agile.moveIssuesToSprint(this.req, sprintId, issueKeys);
  }
  async getTransitions(issueKey: string) {
    return agile.getTransitions(this.req, issueKey);
  }
  async transitionIssue(issueKey: string, transitionId: string) {
    return agile.transitionIssue(this.req, issueKey, transitionId);
  }
  async assignIssue(issueKey: string, accountId: string | null) {
    return agile.assignIssue(this.req, issueKey, accountId);
  }
  async linkIssues(inwardKey: string, outwardKey: string, linkType: string) {
    return agile.linkIssues(this.req, inwardKey, outwardKey, linkType);
  }
  async removeIssueLink(linkId: string) {
    return agile.removeIssueLink(this.req, linkId);
  }
  async getIssueLinkTypes() {
    return agile.getIssueLinkTypes(this.req);
  }
  async getIssueChangelog(issueKey: string): Promise<ChangelogEntry[]> {
    return agile.getIssueChangelog(this.req, issueKey);
  }
  async addComment(issueKey: string, body: string) {
    return agile.addComment(this.req, issueKey, body);
  }
  async addLabels(issueKey: string, labels: string[]) {
    return agile.addLabels(this.req, issueKey, labels);
  }
  async rankIssue(issueKey: string, options: { rankBefore?: string; rankAfter?: string }) {
    return agile.rankIssue(this.req, issueKey, options);
  }
  async getBacklogIssues(boardId: string, maxResults = 50, startAt = 0) {
    return agile.getBacklogIssues(this.req, boardId, this.buildFieldList(), maxResults, startAt);
  }
  async searchBoardIssues(boardId: string, jql?: string, maxResults = 50, startAt = 0) {
    return agile.searchBoardIssues(this.req, boardId, this.buildFieldList(), jql, maxResults, startAt);
  }
  async searchBacklogIssues(boardId: string, jql?: string, maxResults = 50, startAt = 0) {
    return agile.searchBacklogIssues(this.req, boardId, this.buildFieldList(), jql, maxResults, startAt);
  }
  async getIssueLinks(issueKey: string) {
    return agile.getIssueLinks(this.req, issueKey);
  }
  async getDevStatus(issueId: string) {
    return agile.getDevStatus(this.req, issueId);
  }
  async getSprintDetails(sprintId: string) {
    return agile.getSprintDetails(this.req, sprintId);
  }
  async updateSprint(
    sprintId: string,
    updates: { goal?: string; name?: string; startDate?: string; endDate?: string },
  ) {
    return agile.updateSprint(this.req, sprintId, updates);
  }
  async getEpicIssues(epicKey: string): Promise<SearchIssue[]> {
    validateIssueKey(epicKey);
    return (await this.searchIssues(`"Epic Link" = ${epicKey} OR parent = ${epicKey}`)).issues;
  }

  // ── Schema-driven field resolution ──

  private resolveCustomFields(fields: Record<string, unknown>, input: FieldResolvable, issueType: string): void {
    if (input.storyPoints != null) {
      const id = this.resolveFieldId("Story Points", issueType);
      fields[id || "story_points"] = input.storyPoints;
    }
    if (input.components?.length) {
      const allowed = this.findFieldSchema("components", issueType)?.allowedValues || [];
      fields.components = input.components.map((name) => {
        const match = allowed.find((v) => v.name.toLowerCase() === name.toLowerCase());
        return match ? { id: match.id } : { name };
      });
    }
    if (input.namedFields) this.resolveNamedFields(fields, input.namedFields, issueType);
  }

  private resolveNamedFields(
    fields: Record<string, unknown>,
    namedFields: Record<string, string | null>,
    issueType: string,
  ): void {
    for (const [fieldName, valueName] of Object.entries(namedFields)) {
      const fs = this.findFieldSchema(fieldName, issueType);
      if (!fs) continue;
      if (valueName === null) {
        fields[fs.id] = null;
        continue;
      }
      if (fs.allowedValues?.length) {
        const match = fs.allowedValues.find((v) => v.name.toLowerCase().includes(valueName.toLowerCase()));
        if (match) fields[fs.id] = { id: match.id };
      } else {
        fields[fs.id] = valueName;
      }
    }
  }

  private resolveFieldId(fieldName: string, issueType?: string): string | null {
    if (!this.schema) return null;
    const types = issueType ? this.schema.issueTypes.filter((t) => t.name === issueType) : this.schema.issueTypes;
    for (const t of types) {
      const field = t.fields.find((f) => f.name === fieldName);
      if (field) return field.id;
    }
    return null;
  }

  private findFieldSchema(fieldName: string, issueType: string): JiraFieldSchema | null {
    if (!this.schema) return null;
    const ts = this.schema.issueTypes.find((t) => t.name === issueType);
    return ts?.fields.find((f) => f.name === fieldName || f.id === fieldName) || null;
  }

  private autoFillRequired(fields: Record<string, unknown>, issueType: string): void {
    if (!this.schema) return;
    const ts = this.schema.issueTypes.find((t) => t.name === issueType);
    if (!ts) return;
    const SYSTEM = new Set(["project", "issuetype", "summary", "parent", "issueType"]);
    for (const field of ts.fields) {
      if (!field.required || SYSTEM.has(field.system || field.id) || fields[field.id] !== undefined) continue;
      if (field.allowedValues?.length) fields[field.id] = { id: field.allowedValues[0]?.id };
    }
    if (this.schema.board?.teamId && this.schema.board.teamFieldId) {
      if (fields[this.schema.board.teamFieldId] === undefined) {
        fields[this.schema.board.teamFieldId] = this.schema.board.teamId;
      }
    }
  }

  getFieldGuide(issueType: string): string | null {
    if (!this.schema) return null;
    const ts = this.schema.issueTypes.find((t) => t.name === issueType);
    if (!ts) return null;
    const lines = [`## Fields for ${issueType}\n`];
    for (const f of ts.fields) {
      let line = `- **${f.name}** (${f.id}) [${f.type}] — ${f.required ? "**REQUIRED**" : "optional"}`;
      if (f.allowedValues?.length) {
        const vals = f.allowedValues.map((v) => `\`${v.name}\``).join(", ");
        line += `\n  Values: ${vals}`;
      }
      lines.push(line);
    }
    return lines.join("\n");
  }

  get project(): string {
    return this.projectKey;
  }

  // ── Static: Schema (delegated to jira-schema.ts) ──
  static readonly discoverSchema = discoverSchema;
  static readonly loadSchema = loadSchema;
  static readonly loadSchemaFromDb = loadSchemaFromDb;
  static readonly saveSchemaToDb = saveSchemaToDb;
}
