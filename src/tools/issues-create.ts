import { buildJiraClient, errorResponse, textResponse } from "../lib/config.js";
import type { KnowledgeBase } from "../lib/db.js";
import { findDuplicates } from "../lib/duplicate-detect.js";
import { JiraClient, type JiraTicketInput } from "../lib/jira.js";
import { formatSpecContextSection, formatSpecLinkLine } from "../lib/spec-context.js";
import type { TicketContext } from "../lib/team-insights-suggest.js";
import {
  formatInsightsSection,
  generateDescriptionScaffold,
  generateSmartDefaults,
} from "../lib/team-insights-suggest.js";
import { DEFAULT_RULES, formatTeamStyleGuide, mergeWithDefaults } from "../lib/team-rules.js";
import { evaluateConventions, formatConventionsSection } from "../lib/team-rules-format.js";
import { uploadAttachmentsFromPaths } from "./issues-attachments.js";
import { buildDescriptionWithSpecRef, loadSourceSpec, persistSpecLink } from "./issues-create-spec.js";
import {
  buildKbContextSection,
  buildSchemaGuidance,
  FIELD_RULES,
  loadTeamInsights,
  retrieveKbContext,
} from "./issues-helpers.js";
import { buildPreviewCard, type PreviewData } from "./preview-builder.js";
import { buildSuggestions } from "./suggestions.js";

// Re-export the Stage D spec helpers so callers that import them via
// `tools/issues-create.js` (or `tools/issues.js`) keep working.
export * from "./issues-create-spec.js";

// ── Shared Helpers ───────────────────────────────────────────────────────────

export function loadTeamRules(kb: KnowledgeBase) {
  const teamRules = kb.getTeamRules();
  return teamRules.map((r) => ({
    category: r.category,
    rule_key: r.rule_key,
    issue_type: r.issue_type,
    rule_value: r.rule_value,
    confidence: r.confidence,
    sample_size: r.sample_size,
  }));
}

export function buildFields(params: {
  summary: string;
  issueType: string;
  priority?: string;
  labels?: string[];
  storyPoints?: number;
  components?: string[];
  parent?: string;
  parentKey?: string;
  namedFields?: Record<string, string | null>;
}): Array<{ label: string; value: string }> {
  const fields: Array<{ label: string; value: string }> = [
    { label: "Summary", value: params.summary },
    { label: "Type", value: params.issueType },
    { label: "Priority", value: params.priority || "Medium (default)" },
  ];
  if (params.labels?.length) fields.push({ label: "Labels", value: params.labels.join(", ") });
  if (params.storyPoints != null) fields.push({ label: "Story Points", value: String(params.storyPoints) });
  if (params.components?.length) fields.push({ label: "Components", value: params.components.join(", ") });
  if (params.parent || params.parentKey)
    fields.push({ label: "Parent", value: (params.parent || params.parentKey) as string });
  if (params.namedFields)
    fields.push({
      label: "Custom Fields",
      value: Object.entries(params.namedFields)
        .map(([k, v]) => `${k}: ${v}`)
        .join(", "),
    });
  return fields;
}

/** Best-effort duplicate detection and epic listing. */
async function fetchDuplicatesAndEpics(
  kb: KnowledgeBase,
  summary: string,
  description: string | undefined,
  hasParent: boolean,
): Promise<{ duplicates: Awaited<ReturnType<typeof findDuplicates>>; epicsSection: string }> {
  let duplicates: Awaited<ReturnType<typeof findDuplicates>> = [];
  let epicsSection = "";
  try {
    const { jira, config } = buildJiraClient(kb);
    const projectKey = config.jiraProjectKey;
    if (!projectKey) return { duplicates, epicsSection };

    duplicates = await findDuplicates(jira, summary, description, projectKey);

    if (!hasParent) {
      const epicJql = `project = ${projectKey} AND type = Epic AND status != Done ORDER BY updated DESC`;
      const epicResult = await jira.searchIssues(epicJql, undefined, 10);
      epicsSection = formatEpicsSection(epicResult.issues);
    }
  } catch {
    // best-effort
  }
  return { duplicates, epicsSection };
}

function formatEpicsSection(
  epics: Array<{ key: string; fields: { summary: string; status?: { name: string } | null } }>,
): string {
  if (epics.length === 0) return "";
  let out = `\n## Available Epics\n\n`;
  out += `No parent epic specified. Consider assigning to one of these:\n\n`;
  out += `| Key | Summary | Status |\n|-----|---------|--------|\n`;
  for (const epic of epics) {
    out += `| ${epic.key} | ${epic.fields.summary} | ${epic.fields.status?.name ?? "-"} |\n`;
  }
  out += `\nTo assign, add \`parentKey\` to the create call.\n`;
  return out;
}

function buildTeamInsightsSection(kb: KnowledgeBase, issueType: string, ticketCtx: TicketContext): string {
  const teamInsights = loadTeamInsights(kb);
  const smartDefaults = generateSmartDefaults(
    ticketCtx,
    teamInsights.estimation,
    teamInsights.ownership,
    teamInsights.patterns,
  );
  const scaffold = generateDescriptionScaffold(issueType, teamInsights.templates);
  return formatInsightsSection(
    smartDefaults,
    scaffold,
    teamInsights.estimation,
    ticketCtx,
    teamInsights.patterns.reworkRates,
  );
}

function buildConventions(
  kb: KnowledgeBase,
  ticket: {
    summary: string;
    description?: string;
    issueType: string;
    labels?: string[];
    storyPoints?: number;
    components?: string[];
  },
) {
  const rules = loadTeamRules(kb);
  const merged = mergeWithDefaults(rules, DEFAULT_RULES);
  return evaluateConventions(ticket, merged);
}

/** Shared params shape for create flows. */
interface CreateParamsBase {
  summary: string;
  description?: string;
  issueType?: string;
  priority?: string;
  labels?: string[];
  storyPoints?: number;
  parent?: string;
  parentKey?: string;
  components?: string[];
  namedFields?: Record<string, string | null>;
  spaceKey?: string;
  attachments?: string[];
  /** Optional Confluence (or future source) page id used as grounding context. */
  sourcePageId?: string;
  /** Source the page id belongs to. Defaults to "confluence" for backwards compat. */
  sourcePageSource?: string;
}

/** Build the confirmed-creation response for a single ticket. */
async function executeCreate(kb: KnowledgeBase, params: CreateParamsBase) {
  const { jira, config } = buildJiraClient(kb);
  const sourceSpec = loadSourceSpec(kb, params.sourcePageId, params.sourcePageSource);
  const description = buildDescriptionWithSpecRef(params.description, sourceSpec);

  const input: JiraTicketInput = {
    summary: params.summary,
    description,
    issueType: params.issueType || "Task",
    priority: params.priority,
    labels: params.labels,
    storyPoints: params.storyPoints,
    parentKey: params.parent || params.parentKey,
    components: params.components,
    namedFields: params.namedFields,
  };
  const created = await jira.createIssue(input);

  let attachmentLine = "";
  if (params.attachments && params.attachments.length > 0) {
    const outcome = await uploadAttachmentsFromPaths(jira, created.key, params.attachments);
    const parts = [`${outcome.uploaded}/${params.attachments.length} attachment(s) uploaded`];
    if (outcome.errors.length > 0) parts.push(`errors: ${outcome.errors.join("; ")}`);
    attachmentLine = `\nAttachments: ${parts.join(" — ")}`;
  }

  let specLinkLine = "";
  if (sourceSpec) {
    const { remoteLinkError } = await persistSpecLink(kb, jira, created.key, sourceSpec);
    specLinkLine = formatSpecLinkLine(sourceSpec);
    if (remoteLinkError) {
      specLinkLine += `\n_Note: could not attach Jira remote link — ${remoteLinkError}_`;
    }
  } else if (params.sourcePageId) {
    specLinkLine = `\n_Note: sourcePageId='${params.sourcePageId}' was not found in the KB — skipping spec link. Run \`confluence spider\` to index it._`;
  }

  const suggestions = buildSuggestions("issues", "create", {
    confirmed: true,
    hasAttachments: (params.attachments?.length ?? 0) > 0,
    hasSourceSpec: !!sourceSpec,
  });
  return textResponse(
    `Created **${created.key}** — ${config.siteUrl}/browse/${created.key}\n\nSummary: ${params.summary}${attachmentLine}${specLinkLine}${suggestions}`,
  );
}

// ── Create ───────────────────────────────────────────────────────────────────

/** Handle the 'create' action (preview + confirm flow). */
export async function handleCreateAction(
  params: Partial<CreateParamsBase> & { confirmed?: boolean },
  kb: KnowledgeBase,
) {
  if (!params.summary) {
    return errorResponse(
      "summary is required for 'create' action. Pass summary, description, issueType, and priority as top-level parameters — not inside a tickets array. " +
        "The tickets array is only for bulk creation of multiple tickets. Example: action='create' summary='Fix login bug' issueType='Bug' priority='High'",
    );
  }
  if (params.confirmed) return executeCreateConfirmed(kb, params as typeof params & { summary: string });
  return buildCreatePreview(kb, params as typeof params & { summary: string });
}

async function buildCreatePreview(kb: KnowledgeBase, params: CreateParamsBase) {
  const schema = JiraClient.loadSchemaFromDb(kb);
  const issueType = params.issueType || "Task";
  const sourceSpec = loadSourceSpec(kb, params.sourcePageId, params.sourcePageSource);
  // Use the spec body as additional search context when present so retrieveKbContext
  // pulls related ADRs/designs alongside the spec itself.
  const searchText = [params.summary, params.description ?? "", sourceSpec?.content ?? ""].join(" ");
  const ctx = retrieveKbContext(kb, searchText, params.spaceKey);

  const hasParent = !!(params.parent || params.parentKey);
  const { duplicates, epicsSection } = await fetchDuplicatesAndEpics(kb, params.summary, params.description, hasParent);

  const conventions = buildConventions(kb, {
    summary: params.summary,
    description: params.description,
    issueType,
    labels: params.labels,
    storyPoints: params.storyPoints,
    components: params.components,
  });

  const ticketCtx: TicketContext = {
    summary: params.summary,
    issueType,
    description: params.description,
    components: params.components,
    labels: params.labels,
    storyPoints: params.storyPoints,
    priority: params.priority,
  };
  const insightsSection = buildTeamInsightsSection(kb, issueType, ticketCtx);

  const previewData: PreviewData = {
    fields: buildFields({ ...params, summary: params.summary, issueType }),
    description: params.description,
    conventions,
    kbContext: buildKbContextSection(ctx),
    duplicates,
    schemaGuidance: buildSchemaGuidance(schema, issueType),
    fieldRules: FIELD_RULES,
    insights: insightsSection || undefined,
  };

  let out = buildPreviewCard(previewData);
  const specSection = formatSpecContextSection(sourceSpec);
  if (specSection) out += specSection;
  else if (params.sourcePageId)
    out += `\n\n> **Source spec not found.** sourcePageId='${params.sourcePageId}' is not indexed in the KB. Run \`confluence spider\` first or omit the param.\n`;
  if (epicsSection) out += `\n\n${epicsSection}`;
  out += `\n---\n**STOP: Show this preview to the user and wait for their approval.** Do NOT proceed with \`confirmed=true\` until the user explicitly confirms. Ask the user to review the fields, description, and epic assignment above.\n`;
  return textResponse(out);
}

async function executeCreateConfirmed(kb: KnowledgeBase, params: CreateParamsBase) {
  try {
    return await executeCreate(kb, params);
  } catch (err: unknown) {
    return errorResponse(`Failed to create issue: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── Decompose ────────────────────────────────────────────────────────────────

export function formatEpicDetails(epic: {
  key: string;
  summary: string;
  status: string;
  priority: string;
  labels: string[];
  description?: string;
}) {
  let plan = `# Epic Decomposition: ${epic.key}\n\n`;
  plan += `## Epic Details\n`;
  plan += `**Summary:** ${epic.summary}\n`;
  plan += `**Status:** ${epic.status} | **Priority:** ${epic.priority}\n`;
  if (epic.labels.length) plan += `**Labels:** ${epic.labels.join(", ")}\n`;
  if (epic.description) plan += `\n### Description\n${epic.description}\n`;
  plan += `\n`;
  return plan;
}

export function formatExistingChildren(children: {
  issues: Array<{
    key: string;
    fields: {
      summary: string;
      status?: { name: string };
      priority?: { name: string };
      assignee?: { displayName: string };
    };
  }>;
  total: number;
}) {
  if (children.issues.length === 0) return `## Existing Stories\nNone found.\n\n`;

  let plan = `## Existing Stories (${children.issues.length}/${children.total})\n\n`;
  plan += `| Key | Summary | Status | Priority | Assignee |\n`;
  plan += `|-----|---------|--------|----------|----------|\n`;
  for (const issue of children.issues) {
    plan += `| ${issue.key} | ${issue.fields.summary} | ${issue.fields.status?.name ?? "Unknown"} | ${issue.fields.priority?.name ?? "None"} | ${issue.fields.assignee?.displayName || "Unassigned"} |\n`;
  }
  plan += `\n`;
  return plan;
}

export function buildTeamStyleSection(kb: KnowledgeBase) {
  const teamRules = kb.getTeamRules();
  const rules = teamRules.map((r) => ({
    category: r.category,
    rule_key: r.rule_key,
    issue_type: r.issue_type,
    rule_value: r.rule_value,
    confidence: r.confidence,
    sample_size: r.sample_size,
  }));
  return mergeWithDefaults(rules, DEFAULT_RULES);
}

export async function handleDecomposeAction(
  params: {
    epicKey?: string;
    issueType?: string;
    spaceKey?: string;
  },
  kb: KnowledgeBase,
) {
  if (!params.epicKey) return errorResponse("epicKey is required for 'decompose' action.");

  try {
    const { jira } = buildJiraClient(kb);
    const schema = JiraClient.loadSchemaFromDb(kb);

    const epic = await jira.getIssue(params.epicKey);
    const children = await jira.searchIssues(`parent = ${params.epicKey}`);

    const epicDescription = epic.description || epic.summary;
    const ctx = retrieveKbContext(kb, epicDescription, params.spaceKey);
    const issueType = params.issueType || "Task";

    let plan = formatEpicDetails(epic);
    plan += formatExistingChildren(children);
    plan += buildSchemaGuidance(schema, issueType);

    const merged = buildTeamStyleSection(kb);
    const styleGuide = formatTeamStyleGuide(merged);
    if (styleGuide.trim()) {
      plan += `\n${styleGuide}\n`;
    }

    const conventions = evaluateConventions(
      { summary: epic.summary, description: epic.description, issueType, labels: epic.labels },
      merged,
    );
    const conventionsText = formatConventionsSection(conventions);
    if (conventionsText) plan += `\n${conventionsText}\n\n`;

    plan += buildKbContextSection(ctx);
    plan += `---\nUse **issues** (action=create with tickets array) with parentKey="${params.epicKey}" to create child stories.\n`;
    plan += FIELD_RULES;
    return textResponse(plan);
  } catch (err: unknown) {
    return errorResponse(`Failed to decompose ${params.epicKey}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
