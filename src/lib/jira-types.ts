/**
 * Jira types and interfaces shared across the Jira client modules.
 */

// ── Input / Output types ─────────────────────────────────────────────────────

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
  namedFields?: Record<string, string | null>;
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
  namedFields?: Record<string, string | null>;
  comment?: string;
  parentKey?: string;
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

/** Issue shape returned by search and sprint issue endpoints. */
export interface SearchIssue {
  key: string;
  id: string;
  fields: {
    summary: string;
    status?: { name: string; statusCategory?: { name: string; key?: string } };
    issuetype?: { name: string };
    priority?: { name: string };
    assignee?: { displayName: string };
    created?: string;
    updated?: string;
    labels?: string[];
    components?: { name: string }[];
    fixVersions?: { name: string }[];
  };
}

/** Sprint from Jira Agile REST API. */
export interface JiraSprint {
  id: number;
  name: string;
  state: "active" | "future" | "closed";
  startDate?: string;
  endDate?: string;
  completeDate?: string;
  goal?: string;
  boardId?: number;
}

/** Changelog entry from issue changelog API. */
export interface ChangelogEntry {
  id: string;
  author: { displayName: string; accountId: string };
  created: string;
  items: Array<{
    field: string;
    fromString: string | null;
    toString: string | null;
  }>;
}

// ── Schema types ─────────────────────────────────────────────────────────────

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

// ── Internal types (used by jira-schema and jira-client) ─────────────────────

export interface JiraErrorResponse {
  errors?: Record<string, string>;
  errorMessages?: string[];
}

/** Response from GET /rest/api/3/issue/{key}/transitions */
export interface TransitionsResponse {
  transitions: Array<{ id: string; name: string; to: { name: string } }>;
}

/** Response from GET /rest/api/3/issueLinkType */
export interface IssueLinkTypesResponse {
  issueLinkTypes: Array<{ name: string; inward: string; outward: string }>;
}

/** Shape returned by the issue createmeta endpoints (new + legacy). */
export interface CreateMetaResponse {
  issueTypes?: Array<{ id: string; name: string; subtask?: boolean }>;
  values?: Array<{ id: string; name: string; subtask?: boolean }>;
  projects?: Array<{ issuetypes?: Array<{ id: string; name: string; subtask?: boolean }> }>;
}

/** Shape returned by field-meta endpoints. */
export interface FieldMetaResponse {
  fields?: RawFieldMeta[];
  values?: RawFieldMeta[];
}

/** Raw field from createmeta field endpoints. */
export interface RawFieldMeta {
  fieldId?: string;
  key?: string;
  name: string;
  required?: boolean;
  schema?: { type?: string; system?: string; custom?: string };
  allowedValues?: Array<{ id: string; name?: string; value?: string; label?: string }>;
}

/** Board configuration from Agile REST API. */
export interface BoardConfigResponse {
  name: string;
  type: string;
  estimation?: { field?: { displayName?: string } };
  columnConfig?: {
    columns?: Array<{ name: string; statuses?: Array<{ name?: string; id?: string }> }>;
  };
}

/** Board issue response for team detection. */
export interface BoardIssueResponse {
  issues?: Array<{ fields?: Record<string, { id?: string; name?: string; title?: string }> }>;
}

/** Project status response. */
export interface ProjectStatusEntry {
  name: string;
  statuses?: Array<{ id: string; name: string; statusCategory?: { name: string } }>;
}

/** Search response for sample tickets. */
export interface SampleSearchResponse {
  issues?: Array<{
    key: string;
    fields: {
      summary: string;
      issuetype?: { name: string };
      priority?: { name: string };
      status?: { name: string };
      labels?: string[];
    };
  }>;
}

/** Raw issue response from getIssue (typed fields we access). */
export interface RawIssueResponse {
  key: string;
  id: string;
  fields: {
    summary: string;
    description?: Record<string, unknown>;
    issuetype?: { name: string };
    priority?: { name: string };
    status?: { name: string };
    labels?: string[];
    components?: Array<{ name: string }>;
    parent?: { key: string };
    assignee?: { displayName: string };
    reporter?: { displayName: string };
    created: string;
    updated: string;
    comment?: {
      comments?: Array<{
        author?: { displayName: string };
        created: string;
        body: Record<string, unknown>;
      }>;
    };
    [customField: string]: unknown;
  };
}

/** Shared shape for field resolution across create/update. */
export interface FieldResolvable {
  storyPoints?: number;
  components?: string[];
  namedFields?: Record<string, string | null>;
}

export interface SprintListResponse {
  maxResults: number;
  startAt: number;
  isLast: boolean;
  values: JiraSprint[];
}

export interface ChangelogResponse {
  maxResults: number;
  startAt: number;
  isLast: boolean;
  values: ChangelogEntry[];
}
