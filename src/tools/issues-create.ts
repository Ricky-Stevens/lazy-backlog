import { buildJiraClient, errorResponse, resolveConfig, textResponse } from "../lib/config.js";
import type { KnowledgeBase } from "../lib/db.js";
import { JiraClient, type JiraTicketInput } from "../lib/jira.js";
import { DEFAULT_RULES, formatTeamStyleGuide, mergeWithDefaults } from "../lib/team-rules.js";
import {
  buildConfluenceSection,
  buildSchemaGuidance,
  FIELD_RULES,
  retrieveConfluenceContext,
} from "./issues-helpers.js";

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
    const ctx = retrieveConfluenceContext(kb, searchText, params.spaceKey);

    let out = `# Ticket Preview\n\n`;
    out += `| Field | Value |\n|-------|-------|\n`;
    out += `| Summary | ${params.summary} |\n`;
    out += `| Type | ${issueType} |\n`;
    out += `| Priority | ${params.priority || "Medium (default)"} |\n`;
    if (params.labels?.length) out += `| Labels | ${params.labels.join(", ")} |\n`;
    if (params.storyPoints != null) out += `| Story Points | ${params.storyPoints} |\n`;
    if (params.components?.length) out += `| Components | ${params.components.join(", ")} |\n`;
    if (params.parent || params.parentKey) out += `| Parent | ${params.parent || params.parentKey} |\n`;
    if (params.namedFields)
      out += `| Custom Fields | ${Object.entries(params.namedFields)
        .map(([k, v]) => `${k}: ${v}`)
        .join(", ")} |\n`;
    out += `\n`;
    if (params.description) out += `## Description\n${params.description}\n\n`;

    out += buildSchemaGuidance(schema, issueType);

    // Load team rules
    const teamRules = kb.getTeamRules();
    const rules = teamRules.map((r) => ({
      category: r.category,
      rule_key: r.rule_key,
      issue_type: r.issue_type,
      rule_value: r.rule_value,
      confidence: r.confidence,
      sample_size: r.sample_size,
    }));
    const merged = mergeWithDefaults(rules, DEFAULT_RULES);
    const styleGuide = formatTeamStyleGuide(merged);
    if (styleGuide.trim()) out += `\n${styleGuide}\n`;

    out += buildConfluenceSection(ctx);

    // List available epics if no parent specified
    // Epics are project-level — always use JQL search, not board-scoped endpoint
    if (!params.parent && !params.parentKey) {
      try {
        const { jira, config } = buildJiraClient(kb);
        const projectKey = config.jiraProjectKey;
        const epicJql = projectKey
          ? `project = ${projectKey} AND type = Epic AND status != Done ORDER BY updated DESC`
          : `type = Epic AND status != Done ORDER BY updated DESC`;
        const epicResult = await jira.searchIssues(epicJql, undefined, 10);
        if (epicResult.issues.length > 0) {
          out += `\n## Available Epics\n\n`;
          out += `No parent epic specified. Consider assigning to one of these:\n\n`;
          out += `| Key | Summary | Status |\n|-----|---------|--------|\n`;
          for (const epic of epicResult.issues) {
            out += `| ${epic.key} | ${epic.fields.summary} | ${epic.fields.status?.name ?? "-"} |\n`;
          }
          out += `\nTo assign, add \`parentKey\` to the create call.\n`;
        }
      } catch {
        // Epic listing is best-effort — don't fail the preview
      }
    }

    out += FIELD_RULES;
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
    const ctx = retrieveConfluenceContext(kb, searchText, params.spaceKey);

    const ticketCount = params.tickets.length;
    const plural = ticketCount === 1 ? "" : "s";

    let out = `# Ticket Preview: ${ticketCount} ticket${plural}\n`;
    out += `Project: ${projectKey || "(not set)"}\n\n`;

    for (const [i, t] of params.tickets.entries()) {
      const componentsList = t.components.join(",");
      const meta = [
        t.issueType,
        t.priority,
        t.storyPoints == null ? "" : `${t.storyPoints}pts`,
        t.labels.length ? t.labels.join(",") : "",
        t.parentKey ? `parent: ${t.parentKey}` : "",
        t.components.length ? `components: ${componentsList}` : "",
      ].filter(Boolean);
      out += `${i + 1}. **${t.summary}** [${meta.join(" | ")}]\n${t.description || "(no description)"}\n\n`;
    }

    out += buildSchemaGuidance(schema, issueType);

    // Load team rules
    const teamRules = kb.getTeamRules();
    const rules = teamRules.map((r) => ({
      category: r.category,
      rule_key: r.rule_key,
      issue_type: r.issue_type,
      rule_value: r.rule_value,
      confidence: r.confidence,
      sample_size: r.sample_size,
    }));
    const merged = mergeWithDefaults(rules, DEFAULT_RULES);
    const styleGuide = formatTeamStyleGuide(merged);
    if (styleGuide.trim()) out += `\n${styleGuide}\n`;

    out += buildConfluenceSection(ctx);
    out += FIELD_RULES;
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
