/**
 * Jira REST API v3 client — schema discovery, ticket CRUD, and ADF conversion.
 *
 * Features:
 * - Schema-driven field resolution (display names → custom field IDs)
 * - Auto-fill required fields from discovered schema
 * - Team auto-assignment from board detection
 * - Markdown → Atlassian Document Format conversion
 */

import type { ProjectConfig } from "../config/schema.js";

// ── Types ─────────────────────────────────────────────────────────────────────

/** Input for creating a new Jira issue. */
export interface JiraTicketInput {
  summary: string;
  description?: string;
  issueType: string;
  priority?: string;
  labels?: string[];
  storyPoints?: number;
  parentKey?: string;
  components?: string[];
  /** Custom fields by display name → value name, resolved to IDs via schema. */
  namedFields?: Record<string, string>;
}

/** Input for updating an existing Jira issue. Only provided fields are changed. */
export interface JiraTicketUpdate {
  issueKey: string;
  summary?: string;
  description?: string;
  priority?: string;
  labels?: string[];
  storyPoints?: number;
  components?: string[];
  namedFields?: Record<string, string>;
  comment?: string;
}

/** Minimal response from issue creation. */
export interface CreatedTicket {
  id: string;
  key: string;
  self: string;
}

/** Full issue details returned by getIssue(). */
export interface JiraIssueDetail {
  key: string;
  id: string;
  summary: string;
  description?: string;
  issueType: string;
  priority: string;
  status: string;
  labels: string[];
  components: string[];
  parentKey?: string;
  assignee?: string;
  reporter?: string;
  storyPoints?: number;
  created: string;
  updated: string;
  comments: { author: string; created: string; body: string }[];
  url: string;
}

interface JiraErrorResponse {
  errors?: Record<string, string>;
  errorMessages?: string[];
}

/** Shared shape for field resolution across create/update. */
interface FieldResolvable {
  storyPoints?: number;
  components?: string[];
  namedFields?: Record<string, string>;
}

// ── ADF Builder ───────────────────────────────────────────────────────────────

/** Minimal ADF node types for Jira descriptions. */
type AdfNode =
  | { type: "doc"; version: 1; content: AdfNode[] }
  | { type: "paragraph"; content: AdfNode[] }
  | { type: "heading"; attrs: { level: number }; content: AdfNode[] }
  | { type: "text"; text: string; marks?: { type: string; attrs?: Record<string, string> }[] }
  | { type: "bulletList"; content: AdfNode[] }
  | { type: "orderedList"; content: AdfNode[] }
  | { type: "listItem"; content: AdfNode[] }
  | { type: "taskList"; attrs: { localId: string }; content: AdfNode[] }
  | { type: "taskItem"; attrs: { localId: string; state: "TODO" | "DONE" }; content: AdfNode[] }
  | { type: "codeBlock"; attrs?: { language?: string }; content: AdfNode[] }
  | { type: "rule" }
  | { type: "hardBreak" };

function textNode(text: string, marks?: { type: string; attrs?: Record<string, string> }[]): AdfNode {
  return marks?.length ? { type: "text", text, marks } : { type: "text", text };
}

function paragraph(text: string): AdfNode {
  return { type: "paragraph", content: parseInline(text) };
}

/** Parse inline markdown (bold, italic, code, links) into ADF text nodes. */
function parseInline(text: string): AdfNode[] {
  const nodes: AdfNode[] = [];
  // Markdown links, bold, italic, inline code, or bare URLs
  const re = /(\[([^\]]+)]\(([^)]+)\)|\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`|(?<![(\[])(https?:\/\/[^\s)>\]]+))/g;
  let last = 0;
  let match: RegExpExecArray | null = re.exec(text);

  while (match !== null) {
    if (match.index > last) nodes.push(textNode(text.slice(last, match.index)));
    if (match[2] && match[3]) nodes.push(textNode(match[2], [{ type: "link", attrs: { href: match[3] } }]));
    else if (match[4]) nodes.push(textNode(match[4], [{ type: "strong" }]));
    else if (match[5]) nodes.push(textNode(match[5], [{ type: "em" }]));
    else if (match[6]) nodes.push(textNode(match[6], [{ type: "code" }]));
    else if (match[7]) nodes.push(textNode(match[7], [{ type: "link", attrs: { href: match[7] } }]));
    last = match.index + match[0].length;
    match = re.exec(text);
  }

  if (last < text.length) nodes.push(textNode(text.slice(last)));
  if (nodes.length === 0) nodes.push(textNode(text || " "));
  return nodes;
}

/** Try to parse a heading line into an ADF heading node. */
function parseHeading(line: string): AdfNode | null {
  const headingRe = /^(#{1,6})\s+(.+)/;
  const hm = headingRe.exec(line);
  if (!hm) return null;
  return { type: "heading", attrs: { level: hm[1]?.length ?? 1 }, content: parseInline(hm[2] ?? "") };
}

/** Parse a fenced code block starting at index `i`. Returns the node and the new index. */
function parseCodeBlock(lines: string[], i: number): { node: AdfNode; next: number } {
  const lang = lines[i]?.slice(3).trim() || undefined;
  const codeLines: string[] = [];
  i++;
  while (i < lines.length && !lines[i]?.startsWith("```")) {
    codeLines.push(lines[i] ?? "");
    i++;
  }
  i++;
  const node = {
    type: "codeBlock",
    ...(lang ? { attrs: { language: lang } } : {}),
    content: [textNode(codeLines.join("\n"))],
  } as AdfNode;
  return { node, next: i };
}

let taskIdCounter = 0;
function nextTaskId(): string {
  return `task-${++taskIdCounter}`;
}

const taskItemRe = /^[-*]\s\[([ xX])]\s/;

/** Collect consecutive task list items and return a taskList node. */
function parseTaskList(lines: string[], i: number): { node: AdfNode; next: number } {
  const items: AdfNode[] = [];
  while (i < lines.length && taskItemRe.test(lines[i] ?? "")) {
    const line = lines[i] ?? "";
    const m = taskItemRe.exec(line);
    const state = m?.[1] === " " ? "TODO" : "DONE";
    const text = line.replace(taskItemRe, "");
    items.push({ type: "taskItem", attrs: { localId: nextTaskId(), state }, content: parseInline(text) });
    i++;
  }
  const listId = nextTaskId();
  return { node: { type: "taskList", attrs: { localId: listId }, content: items }, next: i };
}

/** Detect indent level (number of leading spaces) of a line. */
function indentLevel(line: string): number {
  const m = /^( *)/.exec(line);
  return m?.[1]?.length ?? 0;
}

/** Check if a line (after stripping indent) is a bullet or ordered list item. Returns the type and stripped text, or null. */
function detectListItem(line: string): { listType: "bulletList" | "orderedList"; text: string } | null {
  const stripped = line.trimStart();
  const bullet = /^[-*]\s(.*)/.exec(stripped);
  if (bullet) return { listType: "bulletList", text: bullet[1] ?? "" };
  const ordered = /^\d+\.\s(.*)/.exec(stripped);
  if (ordered) return { listType: "orderedList", text: ordered[1] ?? "" };
  return null;
}

/** Recursively collect list items at the given indent level, nesting deeper items. */
function parseList(lines: string[], i: number, baseIndent: number): { node: AdfNode; next: number } {
  const firstItem = detectListItem(lines[i] ?? "");
  const listType = firstItem?.listType ?? "bulletList";
  const items: AdfNode[] = [];

  while (i < lines.length) {
    const line = lines[i] ?? "";
    const indent = indentLevel(line);

    // Stop if we've dedented past our level or hit a non-list / blank line at our level
    if (indent < baseIndent) break;
    if (indent === baseIndent) {
      const item = detectListItem(line);
      if (!item) break;

      const itemContent: AdfNode[] = [paragraph(item.text)];

      // Check if next line is indented deeper — that's a nested list
      i++;
      if (i < lines.length && detectListItem(lines[i] ?? "") && indentLevel(lines[i] ?? "") > baseIndent) {
        const nested = parseList(lines, i, indentLevel(lines[i] ?? ""));
        itemContent.push(nested.node);
        i = nested.next;
      }

      items.push({ type: "listItem", content: itemContent });
      continue;
    }

    // Line is indented deeper than base but we're not inside an item — shouldn't happen, skip
    i++;
  }

  return { node: { type: listType, content: items }, next: i };
}

/** Convert markdown-ish text to an ADF document node. */
export function markdownToAdf(md: string): AdfNode {
  const lines = md.split("\n");
  const content: AdfNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";

    // Headings
    const heading = parseHeading(line);
    if (heading) {
      content.push(heading);
      i++;
      continue;
    }

    // Horizontal rule
    if (/^---+$/.test(line.trim())) {
      content.push({ type: "rule" });
      i++;
      continue;
    }

    // Code block
    if (line.startsWith("```")) {
      const result = parseCodeBlock(lines, i);
      content.push(result.node);
      i = result.next;
      continue;
    }

    // Task list (must check before bullet list since `- [ ]` also matches `[-*]\s`)
    if (taskItemRe.test(line)) {
      const result = parseTaskList(lines, i);
      content.push(result.node);
      i = result.next;
      continue;
    }

    // Bullet or ordered list
    if (detectListItem(line)) {
      const result = parseList(lines, i, 0);
      content.push(result.node);
      i = result.next;
      continue;
    }

    // Empty line — skip
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Regular paragraph
    content.push(paragraph(line));
    i++;
  }

  return { type: "doc", version: 1, content };
}

/** Extract plain text from an ADF node tree (for display). */
function adfToText(node: Record<string, unknown>): string {
  if (!node) return "";
  if (node.type === "text") return (node.text as string) || "";
  if (node.type === "hardBreak") return "\n";
  if (Array.isArray(node.content)) {
    const inner = node.content.map((n: Record<string, unknown>) => adfToText(n)).join("");
    if (node.type === "paragraph" || node.type === "heading") return `${inner}\n`;
    if (node.type === "listItem") return `- ${inner}\n`;
    if (node.type === "codeBlock") return `\`\`\`\n${inner}\n\`\`\`\n`;
    return inner;
  }
  return "";
}

// ── Jira Client ───────────────────────────────────────────────────────────────

const REQUEST_TIMEOUT_MS = 15_000;

/** Authenticated GET helper for Jira REST API (used by discoverSchema). */
async function jiraGet<T>(baseUrl: string, headers: Record<string, string>, path: string): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Jira ${res.status} ${path}`);
  return res.json() as Promise<T>;
}

/** Build Basic auth headers from Atlassian credentials. */
function authHeaders(email: string, apiToken: string): Record<string, string> {
  const credentials = `${email}:${apiToken}`;
  return {
    Authorization: `Basic ${Buffer.from(credentials).toString("base64")}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

export class JiraClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly projectKey: string;
  private readonly schema: JiraSchema | null;

  constructor(config: ProjectConfig & { jiraProjectKey: string }, schema?: JiraSchema | null) {
    this.baseUrl = config.siteUrl.replace(/\/$/, "");
    this.projectKey = config.jiraProjectKey;
    this.headers = authHeaders(config.email, config.apiToken);
    this.schema = schema || null;
  }

  // ── HTTP ──

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

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

    if (res.status === 204) return undefined as T;
    return res.json() as Promise<T>;
  }

  // ── Issue CRUD ──

  /** Create a single Jira issue. */
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

  /** Fetch a Jira issue with key fields for display. */
  async getIssue(issueKey: string): Promise<JiraIssueDetail> {
    const base =
      "summary,description,issuetype,priority,status,labels,components,parent,assignee,reporter,created,updated,comment";
    const spFieldId = this.resolveFieldId("Story Points");
    const fieldList = spFieldId ? `${base},${spFieldId}` : base;

    const raw = await this.request<Record<string, any>>("GET", `/rest/api/3/issue/${issueKey}?fields=${fieldList}`);
    const f = raw.fields;

    return {
      key: raw.key,
      id: raw.id,
      summary: f.summary,
      description: f.description ? adfToText(f.description) : undefined,
      issueType: f.issuetype?.name,
      priority: f.priority?.name,
      status: f.status?.name,
      labels: f.labels || [],
      components: f.components?.map((c: { name: string }) => c.name) || [],
      parentKey: f.parent?.key,
      assignee: f.assignee?.displayName,
      reporter: f.reporter?.displayName,
      storyPoints: spFieldId ? f[spFieldId] : undefined,
      created: f.created,
      updated: f.updated,
      comments:
        f.comment?.comments
          ?.slice(-5)
          .map((c: { author?: { displayName: string }; created: string; body: Record<string, unknown> }) => ({
            author: c.author?.displayName,
            created: c.created,
            body: adfToText(c.body),
          })) || [],
      url: `${this.baseUrl}/browse/${raw.key}`,
    };
  }

  /** Update an existing Jira issue. Only provided fields are changed. */
  async updateIssue(input: JiraTicketUpdate): Promise<void> {
    const issue = await this.request<{ fields: { issuetype: { name: string } } }>(
      "GET",
      `/rest/api/3/issue/${input.issueKey}?fields=issuetype`,
    );
    const issueType = issue.fields.issuetype.name;
    const fields: Record<string, unknown> = {};

    if (input.summary != null) fields.summary = input.summary;
    if (input.description != null) fields.description = markdownToAdf(input.description);
    if (input.priority != null) fields.priority = { name: input.priority };
    if (input.labels != null) fields.labels = input.labels;

    this.resolveCustomFields(fields, input, issueType);

    const body: Record<string, unknown> = {};
    if (Object.keys(fields).length > 0) body.fields = fields;
    if (input.comment) {
      body.update = { comment: [{ add: { body: markdownToAdf(input.comment) } }] };
    }

    if (Object.keys(body).length === 0) throw new Error("No fields to update");
    await this.request<void>("PUT", `/rest/api/3/issue/${input.issueKey}`, body);
  }

  /** Create multiple issues sequentially. Returns successes and errors. */
  async createIssuesBatch(inputs: JiraTicketInput[]): Promise<{ issues: CreatedTicket[]; errors: string[] }> {
    const issues: CreatedTicket[] = [];
    const errors: string[] = [];

    for (const input of inputs) {
      try {
        issues.push(await this.createIssue(input));
      } catch (err) {
        errors.push(`${input.summary}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return { issues, errors };
  }

  // ── Schema-driven field resolution (shared by create & update) ──

  /**
   * Resolve storyPoints, components, and namedFields into Jira custom field IDs.
   * Mutates the `fields` object in place.
   */
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

    if (input.namedFields) {
      this.resolveNamedFields(fields, input.namedFields, issueType);
    }
  }

  /** Resolve namedFields (display name → value) into custom field IDs. Mutates `fields`. */
  private resolveNamedFields(
    fields: Record<string, unknown>,
    namedFields: Record<string, string>,
    issueType: string,
  ): void {
    for (const [fieldName, valueName] of Object.entries(namedFields)) {
      const fs = this.findFieldSchema(fieldName, issueType);
      if (!fs) continue;

      if (fs.allowedValues?.length) {
        const match = fs.allowedValues.find((v) => v.name.toLowerCase().includes(valueName.toLowerCase()));
        if (match) fields[fs.id] = { id: match.id };
      } else {
        fields[fs.id] = valueName;
      }
    }
  }

  /** Find a custom field ID by display name. Searches all issue types if none specified. */
  private resolveFieldId(fieldName: string, issueType?: string): string | null {
    if (!this.schema) return null;
    const types = issueType ? this.schema.issueTypes.filter((t) => t.name === issueType) : this.schema.issueTypes;
    for (const t of types) {
      const field = t.fields.find((f) => f.name === fieldName);
      if (field) return field.id;
    }
    return null;
  }

  /** Get full field schema (including allowedValues) by name or ID. */
  private findFieldSchema(fieldName: string, issueType: string): JiraFieldSchema | null {
    if (!this.schema) return null;
    const ts = this.schema.issueTypes.find((t) => t.name === issueType);
    return ts?.fields.find((f) => f.name === fieldName || f.id === fieldName) || null;
  }

  /** Auto-fill required custom fields not yet set (picks first allowed value). */
  private autoFillRequired(fields: Record<string, unknown>, issueType: string): void {
    if (!this.schema) return;
    const ts = this.schema.issueTypes.find((t) => t.name === issueType);
    if (!ts) return;

    const SYSTEM = new Set(["project", "issuetype", "summary", "parent", "issueType"]);
    for (const field of ts.fields) {
      if (!field.required || SYSTEM.has(field.system || field.id) || fields[field.id] !== undefined) continue;
      if (field.allowedValues?.length) fields[field.id] = { id: field.allowedValues[0]?.id };
    }

    // Auto-assign board team (plain UUID string per Atlassian docs)
    if (this.schema.board?.teamId && this.schema.board.teamFieldId) {
      if (fields[this.schema.board.teamFieldId] === undefined) {
        fields[this.schema.board.teamFieldId] = this.schema.board.teamId;
      }
    }
  }

  /** Generate a field guide string for an issue type (used in plan-tickets). */
  getFieldGuide(issueType: string): string | null {
    if (!this.schema) return null;
    const ts = this.schema.issueTypes.find((t) => t.name === issueType);
    if (!ts) return null;

    const lines = [`## Fields for ${issueType}\n`];
    for (const f of ts.fields) {
      let line = `- **${f.name}** (${f.id}) [${f.type}] — ${f.required ? "**REQUIRED**" : "optional"}`;
      if (f.allowedValues?.length) {
        const valueList = f.allowedValues.map((v) => `\`${v.name}\``).join(", ");
        line += `\n  Values: ${valueList}`;
      }
      lines.push(line);
    }
    return lines.join("\n");
  }

  get project(): string {
    return this.projectKey;
  }

  // ── Static: Schema discovery ──

  /**
   * Discover full Jira project schema via REST API.
   * Fetches issue types, fields, priorities, board config, team, statuses, and sample tickets.
   */
  static async discoverSchema(
    config: { siteUrl: string; email: string; apiToken: string },
    projectKey: string,
    boardId?: string,
  ): Promise<JiraSchema> {
    const baseUrl = config.siteUrl.replace(/\/$/, "");
    const headers = authHeaders(config.email, config.apiToken);
    const get = <T>(path: string) => jiraGet<T>(baseUrl, headers, path);

    const schema: JiraSchema = {
      projectKey,
      projectName: "",
      boardId: boardId || "",
      issueTypes: [],
      priorities: [],
    };

    // Project info
    const project = await get<{ name: string }>(`/rest/api/3/project/${projectKey}`);
    schema.projectName = project.name;

    // Issue types + fields
    let rawTypes: { id: string; name: string; subtask?: boolean }[];
    try {
      const meta = await get<{ issueTypes?: any[]; values?: any[] }>(
        `/rest/api/3/issue/createmeta/${projectKey}/issuetypes`,
      );
      rawTypes = meta.issueTypes || meta.values || [];
    } catch {
      const meta = await get<{ projects?: { issuetypes?: any[] }[] }>(
        `/rest/api/3/issue/createmeta?projectKeys=${projectKey}&expand=projects.issuetypes`,
      );
      rawTypes = meta.projects?.[0]?.issuetypes || [];
    }

    for (const it of rawTypes) {
      let rawFields: any[] = [];
      try {
        const fm = await get<{ fields?: any[]; values?: any[] }>(
          `/rest/api/3/issue/createmeta/${projectKey}/issuetypes/${it.id}`,
        );
        rawFields = fm.fields || fm.values || [];
      } catch {
        /* skip */
      }

      const fields: JiraFieldSchema[] = rawFields.map((f: any) => {
        const fld = f.fieldId ? f : { fieldId: f.key, ...f };
        return {
          id: fld.fieldId || fld.key,
          name: fld.name,
          required: fld.required || false,
          type: fld.schema?.type || "unknown",
          system: fld.schema?.system,
          custom: fld.schema?.custom,
          allowedValues: fld.allowedValues?.slice(0, 20)?.map((v: any) => ({
            id: v.id,
            name: v.name || v.value || v.label,
          })),
        };
      });

      schema.issueTypes.push({
        id: it.id,
        name: it.name,
        subtask: it.subtask || false,
        fields,
        requiredFields: fields.filter((f) => f.required).map((f) => f.id),
      });
    }

    // Priorities
    const priorities = await get<{ id: string; name: string }[]>("/rest/api/3/priority");
    schema.priorities = priorities.map((p) => ({ id: p.id, name: p.name }));

    // Board config + team detection
    if (boardId) {
      await JiraClient.discoverBoard(get, schema, boardId);
    }

    // Statuses + sample tickets
    await JiraClient.discoverStatusesAndSamples(get, schema, projectKey);

    return schema;
  }

  /** Discover board configuration and team assignment for a board. */
  private static async discoverBoard(
    get: <T>(path: string) => Promise<T>,
    schema: JiraSchema,
    boardId: string,
  ): Promise<void> {
    try {
      const bc = await get<any>(`/rest/agile/1.0/board/${boardId}/configuration`);
      schema.board = {
        name: bc.name,
        type: bc.type,
        estimationField: bc.estimation?.field?.displayName,
        columns: bc.columnConfig?.columns?.map((c: any) => ({
          name: c.name,
          statuses: c.statuses?.map((s: any) => s.name || s.id),
        })),
      };

      // Find team field dynamically from schema fields
      let teamFieldId: string | null = null;
      for (const it of schema.issueTypes) {
        const tf = it.fields.find((f) => f.custom?.toLowerCase().includes("team") || f.name === "Team");
        if (tf) {
          teamFieldId = tf.id;
          break;
        }
      }

      // Sample a board ticket to get the team value (no allowedValues in create meta)
      if (teamFieldId) {
        try {
          const board = await get<any>(`/rest/agile/1.0/board/${boardId}/issue?maxResults=1&fields=${teamFieldId}`);
          const teamValue = board.issues?.[0]?.fields?.[teamFieldId];
          if (teamValue?.id) {
            schema.board.teamFieldId = teamFieldId;
            schema.board.teamId = teamValue.id;
            schema.board.teamName = teamValue.name || teamValue.title;
          }
        } catch {
          /* best-effort */
        }
      }
    } catch {
      /* optional */
    }
  }

  /** Discover statuses and sample tickets for convention detection. */
  private static async discoverStatusesAndSamples(
    get: <T>(path: string) => Promise<T>,
    schema: JiraSchema,
    projectKey: string,
  ): Promise<void> {
    try {
      const statuses = await get<any[]>(`/rest/api/3/project/${projectKey}/statuses`);
      schema.statuses = statuses.map((st) => ({
        issueType: st.name,
        statuses: st.statuses?.map((s: any) => ({ id: s.id, name: s.name, category: s.statusCategory?.name })),
      }));
    } catch {
      /* optional */
    }

    try {
      const jql = `project = ${projectKey} ORDER BY created DESC`;
      const search = await get<{ issues?: any[] }>(
        `/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&maxResults=5&fields=summary,issuetype,priority,labels,status`,
      );
      schema.sampleTickets = search.issues?.map((issue: any) => ({
        key: issue.key,
        summary: issue.fields.summary,
        type: issue.fields.issuetype?.name,
        priority: issue.fields.priority?.name,
        status: issue.fields.status?.name,
        labels: issue.fields.labels,
      }));
    } catch {
      /* optional */
    }
  }

  // ── Static: Schema persistence ──

  /** Load schema from a JSON file path. */
  static loadSchema(schemaPath?: string): JiraSchema | null {
    if (!schemaPath) return null;
    try {
      return JSON.parse(require("node:fs").readFileSync(schemaPath, "utf-8")) as JiraSchema;
    } catch {
      return null;
    }
  }

  /** Load schema from SQLite config. */
  static loadSchemaFromDb(kb: { getConfig(key: string): string | undefined }): JiraSchema | null {
    const raw = kb.getConfig("jira-schema");
    if (!raw) return null;
    try {
      return JSON.parse(raw) as JiraSchema;
    } catch {
      return null;
    }
  }

  /** Save schema to SQLite config. */
  static saveSchemaToDb(kb: { setConfig(key: string, value: string): void }, schema: JiraSchema): void {
    kb.setConfig("jira-schema", JSON.stringify(schema));
  }
}

// ── Schema types ──────────────────────────────────────────────────────────────

/** Discovered Jira project schema — issue types, fields, priorities, board. */
export interface JiraSchema {
  projectKey: string;
  projectName: string;
  boardId: string;
  issueTypes: JiraIssueTypeSchema[];
  priorities: { id: string; name: string }[];
  board?: {
    name: string;
    type: string;
    estimationField?: string;
    columns?: { name: string; statuses?: string[] }[];
    teamFieldId?: string;
    /** Team UUID — sent as plain string per Atlassian Teams REST API. */
    teamId?: string;
    teamName?: string;
  };
  statuses?: {
    issueType: string;
    statuses: { id: string; name: string; category: string }[];
  }[];
  sampleTickets?: {
    key: string;
    summary: string;
    type: string;
    priority: string;
    status: string;
    labels: string[];
  }[];
}

/** Schema for a single issue type. */
export interface JiraIssueTypeSchema {
  id: string;
  name: string;
  subtask: boolean;
  fields: JiraFieldSchema[];
  requiredFields: string[];
}

/** Schema for a single field within an issue type. */
export interface JiraFieldSchema {
  id: string;
  name: string;
  required: boolean;
  type: string;
  system?: string;
  custom?: string;
  allowedValues?: { id: string; name: string }[];
}
