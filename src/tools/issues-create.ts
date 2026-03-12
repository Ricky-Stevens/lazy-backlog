import { buildJiraClient, errorResponse, resolveConfig, textResponse } from "../lib/config.js";
import type { KnowledgeBase } from "../lib/db.js";
import { findDuplicates } from "../lib/duplicate-detect.js";
import { JiraClient, type JiraTicketInput } from "../lib/jira.js";
import { DEFAULT_RULES, mergeWithDefaults } from "../lib/team-rules.js";
import { evaluateConventions } from "../lib/team-rules-format.js";
import { buildKbContextSection, buildSchemaGuidance, FIELD_RULES, retrieveKbContext } from "./issues-helpers.js";
import { buildBulkPreviewCard, buildPreviewCard, type PreviewData } from "./preview-builder.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function loadTeamRules(kb: KnowledgeBase) {
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

function buildFields(params: {
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

// ── Create ───────────────────────────────────────────────────────────────────

/** Handle the 'create' action (preview + confirm flow). */
export async function handleCreateAction(
  params: {
    summary?: string;
    description?: string;
    issueType?: string;
    priority?: string;
    labels?: string[];
    storyPoints?: number;
    parent?: string;
    parentKey?: string;
    components?: string[];
    namedFields?: Record<string, string | null>;
    confirmed?: boolean;
    spaceKey?: string;
  },
  kb: KnowledgeBase,
) {
  if (!params.summary) return errorResponse("summary is required for 'create' action.");

  // Preview mode (default) — gather context and show what will be created
  if (!params.confirmed) {
    const schema = JiraClient.loadSchemaFromDb(kb);
    const issueType = params.issueType || "Task";
    const searchText = `${params.summary} ${params.description || ""}`;
    const ctx = retrieveKbContext(kb, searchText, params.spaceKey);

    // Duplicate detection
    let duplicates: Awaited<ReturnType<typeof findDuplicates>> = [];
    let epicsSection = "";
    try {
      const { jira, config } = buildJiraClient(kb);
      const projectKey = config.jiraProjectKey;
      if (projectKey) {
        duplicates = await findDuplicates(jira, params.summary, params.description, projectKey);
      }

      // List available epics if no parent specified
      if (!params.parent && !params.parentKey && projectKey) {
        const epicJql = `project = ${projectKey} AND type = Epic AND status != Done ORDER BY updated DESC`;
        const epicResult = await jira.searchIssues(epicJql, undefined, 10);
        if (epicResult.issues.length > 0) {
          epicsSection += `\n## Available Epics\n\n`;
          epicsSection += `No parent epic specified. Consider assigning to one of these:\n\n`;
          epicsSection += `| Key | Summary | Status |\n|-----|---------|--------|\n`;
          for (const epic of epicResult.issues) {
            epicsSection += `| ${epic.key} | ${epic.fields.summary} | ${epic.fields.status?.name ?? "-"} |\n`;
          }
          epicsSection += `\nTo assign, add \`parentKey\` to the create call.\n`;
        }
      }
    } catch {
      // Duplicate check and epic listing are best-effort
    }

    // Team conventions
    const rules = loadTeamRules(kb);
    const merged = mergeWithDefaults(rules, DEFAULT_RULES);
    const conventions = evaluateConventions(
      {
        summary: params.summary,
        description: params.description,
        issueType,
        labels: params.labels,
        storyPoints: params.storyPoints,
        components: params.components,
      },
      merged,
    );

    const kbContextText = buildKbContextSection(ctx);

    const previewData: PreviewData = {
      fields: buildFields({ summary: params.summary, issueType, ...params }),
      description: params.description,
      conventions,
      kbContext: kbContextText,
      duplicates,
      schemaGuidance: buildSchemaGuidance(schema, issueType),
      fieldRules: FIELD_RULES,
    };

    let out = buildPreviewCard(previewData);
    if (epicsSection) out += `\n\n${epicsSection}`;
    out += `\n---\n**STOP: Show this preview to the user and wait for their approval.** Do NOT proceed with \`confirmed=true\` until the user explicitly confirms. Ask the user to review the fields, description, and epic assignment above.\n`;
    return textResponse(out);
  }

  // Confirmed — actually create
  try {
    const { jira, config } = buildJiraClient(kb);
    const input: JiraTicketInput = {
      summary: params.summary,
      description: params.description,
      issueType: params.issueType || "Task",
      priority: params.priority,
      labels: params.labels,
      storyPoints: params.storyPoints,
      parentKey: params.parent || params.parentKey,
      components: params.components,
      namedFields: params.namedFields,
    };
    const created = await jira.createIssue(input);
    return textResponse(
      `Created **${created.key}** — ${config.siteUrl}/browse/${created.key}\n\nSummary: ${params.summary}`,
    );
  } catch (err: unknown) {
    return errorResponse(`Failed to create issue: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── Bulk Create ──────────────────────────────────────────────────────────────

/** Handle the 'bulk-create' action (preview + confirm flow). */
export async function handleBulkCreateAction(
  params: {
    tickets?: Array<{
      summary: string;
      description?: string;
      issueType: string;
      labels: string[];
      storyPoints?: number;
      priority: string;
      parentKey?: string;
      components: string[];
      namedFields?: Record<string, string | null>;
    }>;
    confirmed?: boolean;
    spaceKey?: string;
  },
  kb: KnowledgeBase,
) {
  if (!params.tickets?.length) return errorResponse("tickets array is required for 'bulk-create' action.");

  let config: ReturnType<typeof resolveConfig>;
  try {
    config = resolveConfig(kb);
  } catch (err: unknown) {
    return errorResponse(String(err));
  }

  const projectKey = config.jiraProjectKey;

  // Preview mode (default) — show what will be created with context
  if (!params.confirmed) {
    const schema = JiraClient.loadSchemaFromDb(kb);
    const issueType = params.tickets[0]?.issueType || "Task";
    const searchText = params.tickets.map((t) => t.summary).join(" ");
    const ctx = retrieveKbContext(kb, searchText, params.spaceKey);
    const kbContextText = buildKbContextSection(ctx);

    // Duplicate detection for first ticket (best-effort)
    let firstDuplicates: Awaited<ReturnType<typeof findDuplicates>> = [];
    try {
      if (projectKey) {
        const { jira } = buildJiraClient(kb);
        const first = params.tickets[0];
        if (first) {
          firstDuplicates = await findDuplicates(jira, first.summary, first.description, projectKey);
        }
      }
    } catch {
      // best-effort
    }

    // Team conventions
    const rules = loadTeamRules(kb);
    const merged = mergeWithDefaults(rules, DEFAULT_RULES);
    const schemaGuidance = buildSchemaGuidance(schema, issueType);

    const previews: PreviewData[] = params.tickets.map((t, i) => {
      const conventions = evaluateConventions(
        {
          summary: t.summary,
          description: t.description,
          issueType: t.issueType,
          labels: t.labels,
          storyPoints: t.storyPoints,
          components: t.components,
        },
        merged,
      );
      const fields: Array<{ label: string; value: string }> = [
        { label: "Summary", value: t.summary },
        { label: "Type", value: t.issueType },
        { label: "Priority", value: t.priority },
      ];
      if (t.labels.length) fields.push({ label: "Labels", value: t.labels.join(", ") });
      if (t.storyPoints != null) fields.push({ label: "Story Points", value: String(t.storyPoints) });
      if (t.parentKey) fields.push({ label: "Parent", value: t.parentKey });
      if (t.components.length) fields.push({ label: "Components", value: t.components.join(", ") });

      return {
        fields,
        description: t.description,
        conventions,
        kbContext: i === 0 ? kbContextText : undefined,
        duplicates: i === 0 ? firstDuplicates : [],
        schemaGuidance: i === 0 ? schemaGuidance : undefined,
        fieldRules: i === 0 ? FIELD_RULES : undefined,
      };
    });

    let out = buildBulkPreviewCard(previews);
    out += `\n---\n**STOP: Show this preview to the user and wait for their approval.** Do NOT proceed with \`confirmed=true\` until the user explicitly confirms. Ask the user to review the tickets above.\n`;
    return textResponse(out);
  }

  // Confirmed — actually create
  if (!projectKey) return errorResponse("No project key. Run configure or pass projectKey.");

  const schema = JiraClient.loadSchemaFromDb(kb);
  const jira = new JiraClient({ ...config, jiraProjectKey: projectKey }, schema);
  const inputs: JiraTicketInput[] = params.tickets.map((t) => ({
    summary: t.summary,
    description: t.description,
    issueType: t.issueType,
    priority: t.priority,
    labels: t.labels,
    storyPoints: t.storyPoints,
    parentKey: t.parentKey,
    components: t.components,
    namedFields: t.namedFields,
  }));

  const result = await jira.createIssuesBatch(inputs);
  const totalTickets = params.tickets.length;
  const plural = totalTickets === 1 ? "" : "s";
  let out = `# Created ${result.issues.length}/${totalTickets} ticket${plural}\n\n`;
  for (const issue of result.issues) out += `- **${issue.key}** — ${config.siteUrl}/browse/${issue.key}\n`;
  if (result.errors.length > 0) {
    out += `\n## Errors (${result.errors.length})\n`;
    for (const err of result.errors) out += `- ${err}\n`;
  }
  return result.errors.length > 0 ? errorResponse(out) : textResponse(out);
}
