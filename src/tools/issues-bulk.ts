import { buildJiraClient, errorResponse, resolveConfig, textResponse } from "../lib/config.js";
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
import { DEFAULT_RULES, mergeWithDefaults } from "../lib/team-rules.js";
import { evaluateConventions } from "../lib/team-rules-format.js";
import { buildDescriptionWithSpecRef, loadSourceSpec, persistSpecLink } from "./issues-create-spec.js";
import {
  buildKbContextSection,
  buildSchemaGuidance,
  FIELD_RULES,
  loadTeamInsights,
  retrieveKbContext,
} from "./issues-helpers.js";
import { buildBulkPreviewCard, type PreviewData } from "./preview-builder.js";

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

/** Build fields array for a bulk-create ticket preview. */
function buildBulkTicketFields(t: {
  summary: string;
  issueType: string;
  priority: string;
  labels: string[];
  storyPoints?: number;
  parentKey?: string;
  components: string[];
}): Array<{ label: string; value: string }> {
  const fields: Array<{ label: string; value: string }> = [
    { label: "Summary", value: t.summary },
    { label: "Type", value: t.issueType },
    { label: "Priority", value: t.priority },
  ];
  if (t.labels.length) fields.push({ label: "Labels", value: t.labels.join(", ") });
  if (t.storyPoints != null) fields.push({ label: "Story Points", value: String(t.storyPoints) });
  if (t.parentKey) fields.push({ label: "Parent", value: t.parentKey });
  if (t.components.length) fields.push({ label: "Components", value: t.components.join(", ") });
  return fields;
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

/** Best-effort duplicate detection for bulk-create (first ticket only). */
async function fetchBulkDuplicates(
  kb: KnowledgeBase,
  projectKey: string | undefined,
  firstTicket: { summary: string; description?: string },
): Promise<Awaited<ReturnType<typeof findDuplicates>>> {
  if (!projectKey) return [];
  try {
    const { jira } = buildJiraClient(kb);
    return await findDuplicates(jira, firstTicket.summary, firstTicket.description, projectKey);
  } catch {
    return [];
  }
}

/** Format the result of a bulk-create operation. */
function formatBulkResult(
  result: { issues: Array<{ key: string }>; errors: string[] },
  totalTickets: number,
  siteUrl: string,
) {
  const plural = totalTickets === 1 ? "" : "s";
  let out = `# Created ${result.issues.length}/${totalTickets} ticket${plural}\n\n`;
  for (const issue of result.issues) out += `- **${issue.key}** — ${siteUrl}/browse/${issue.key}\n`;
  if (result.errors.length > 0) {
    out += `\n## Errors (${result.errors.length})\n`;
    for (const err of result.errors) out += `- ${err}\n`;
  }
  return result.errors.length > 0 ? errorResponse(out) : textResponse(out);
}

function mapTicketToPreview(
  t: BulkTicket,
  index: number,
  merged: ReturnType<typeof mergeWithDefaults>,
  kbContextText: string,
  firstDuplicates: Awaited<ReturnType<typeof findDuplicates>>,
  schemaGuidance: string | undefined,
  bulkInsights: string,
): PreviewData {
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
  const isFirst = index === 0;
  return {
    fields: buildBulkTicketFields(t),
    description: t.description,
    conventions,
    kbContext: isFirst ? kbContextText : undefined,
    duplicates: isFirst ? firstDuplicates : [],
    schemaGuidance: isFirst ? schemaGuidance : undefined,
    fieldRules: isFirst ? FIELD_RULES : undefined,
    insights: isFirst && bulkInsights ? bulkInsights : undefined,
  };
}

// ── Types ────────────────────────────────────────────────────────────────────

export type BulkTicket = {
  summary: string;
  description?: string;
  issueType: string;
  labels: string[];
  storyPoints?: number;
  priority: string;
  parentKey?: string;
  components: string[];
  namedFields?: Record<string, string | null>;
};

// ── Bulk Create Handler ──────────────────────────────────────────────────────

/** Handle the 'bulk-create' action (preview + confirm flow). */
export async function handleBulkCreateAction(
  params: {
    tickets?: BulkTicket[];
    confirmed?: boolean;
    spaceKey?: string;
    sourcePageId?: string;
    sourcePageSource?: string;
  },
  kb: KnowledgeBase,
) {
  if (!params.tickets?.length) return errorResponse("tickets array is required for bulk create.");

  let config: ReturnType<typeof resolveConfig>;
  try {
    config = resolveConfig(kb);
  } catch (err: unknown) {
    return errorResponse(String(err));
  }

  if (!params.confirmed)
    return buildBulkPreview(
      kb,
      params.tickets,
      config.jiraProjectKey,
      params.spaceKey,
      params.sourcePageId,
      params.sourcePageSource,
    );
  return executeBulkCreate(kb, params.tickets, config, params.sourcePageId, params.sourcePageSource);
}

async function buildBulkPreview(
  kb: KnowledgeBase,
  tickets: BulkTicket[],
  projectKey: string | undefined,
  spaceKey?: string,
  sourcePageId?: string,
  sourcePageSource?: string,
) {
  const schema = JiraClient.loadSchemaFromDb(kb);
  const issueType = tickets[0]?.issueType || "Task";
  const sourceSpec = loadSourceSpec(kb, sourcePageId, sourcePageSource);
  const searchText = [tickets.map((t) => t.summary).join(" "), sourceSpec?.content ?? ""].join(" ");
  const ctx = retrieveKbContext(kb, searchText, spaceKey);
  const kbContextText = buildKbContextSection(ctx);

  const firstTicket = tickets[0] as BulkTicket;
  const firstDuplicates = await fetchBulkDuplicates(kb, projectKey, firstTicket);

  const rules = loadTeamRules(kb);
  const merged = mergeWithDefaults(rules, DEFAULT_RULES);
  const schemaGuidance = buildSchemaGuidance(schema, issueType);

  const bulkTicketCtx: TicketContext = {
    summary: firstTicket.summary,
    issueType: firstTicket.issueType,
    description: firstTicket.description,
    components: firstTicket.components,
    labels: firstTicket.labels,
    storyPoints: firstTicket.storyPoints,
    priority: firstTicket.priority,
  };
  const bulkInsights = buildTeamInsightsSection(kb, issueType, bulkTicketCtx);

  const previews: PreviewData[] = tickets.map((t, i) =>
    mapTicketToPreview(t, i, merged, kbContextText, firstDuplicates, schemaGuidance, bulkInsights),
  );

  let out = buildBulkPreviewCard(previews);
  const specSection = formatSpecContextSection(sourceSpec);
  if (specSection) out += specSection;
  else if (sourcePageId)
    out += `\n\n> **Source spec not found.** sourcePageId='${sourcePageId}' is not indexed in the KB. Run \`confluence spider\` first or omit the param.\n`;
  out += `\n---\n**STOP: Show this preview to the user and wait for their approval.** Do NOT proceed with \`confirmed=true\` until the user explicitly confirms. Ask the user to review the tickets above.\n`;
  return textResponse(out);
}

async function executeBulkCreate(
  kb: KnowledgeBase,
  tickets: BulkTicket[],
  config: ReturnType<typeof resolveConfig>,
  sourcePageId?: string,
  sourcePageSource?: string,
) {
  const projectKey = config.jiraProjectKey;
  if (!projectKey) return errorResponse("No project key. Run configure or pass projectKey.");

  const schema = JiraClient.loadSchemaFromDb(kb);
  const jira = new JiraClient({ ...config, jiraProjectKey: projectKey }, schema);
  const sourceSpec = loadSourceSpec(kb, sourcePageId, sourcePageSource);
  const inputs: JiraTicketInput[] = tickets.map((t) => ({
    summary: t.summary,
    description: buildDescriptionWithSpecRef(t.description, sourceSpec),
    issueType: t.issueType,
    priority: t.priority,
    labels: t.labels,
    storyPoints: t.storyPoints,
    parentKey: t.parentKey,
    components: t.components,
    namedFields: t.namedFields,
  }));

  const result = await jira.createIssuesBatch(inputs);

  // Best-effort link persistence for every successfully-created issue.
  let specSummary = "";
  if (sourceSpec && result.issues.length > 0) {
    const linkErrors: string[] = [];
    for (const issue of result.issues) {
      const { remoteLinkError } = await persistSpecLink(kb, jira, issue.key, sourceSpec);
      if (remoteLinkError) linkErrors.push(`${issue.key}: ${remoteLinkError}`);
    }
    specSummary = formatSpecLinkLine(sourceSpec);
    if (linkErrors.length > 0) {
      specSummary += `\n_Note: ${linkErrors.length} remote-link attempt(s) failed — ${linkErrors.slice(0, 3).join("; ")}${linkErrors.length > 3 ? "; …" : ""}_`;
    }
  } else if (sourcePageId && !sourceSpec) {
    specSummary = `\n_Note: sourcePageId='${sourcePageId}' was not found in the KB — skipping spec links._`;
  }

  const base = formatBulkResult(result, tickets.length, config.siteUrl);
  if (specSummary) {
    const text = base.content[0]?.text ?? "";
    return { ...base, content: [{ type: "text" as const, text: text + specSummary }] };
  }
  return base;
}
