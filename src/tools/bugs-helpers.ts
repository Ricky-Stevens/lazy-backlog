import type { ProjectConfig } from "../config/schema.js";
import { buildJiraClient, errorResponse, textResponse } from "../lib/config.js";
import type { KnowledgeBase } from "../lib/db.js";
import type { JiraClient } from "../lib/jira.js";
import { DEFAULT_RULES, mergeWithDefaults } from "../lib/team-rules.js";
import { evaluateConventions, formatConventionsSection } from "../lib/team-rules-format.js";
import { assessCompleteness, inferSeverity, type ToolResponse } from "./bugs.js";

// ── find-bugs ────────────────────────────────────────────────────────────────

const DEFAULT_BUG_JQL = 'type = Bug AND status = "To Do" AND sprint is EMPTY ORDER BY created DESC';

export async function handleFindBugs(
  params: { jql?: string; maxResults?: number; dateRange?: string; component?: string },
  kb: KnowledgeBase,
): Promise<ToolResponse> {
  try {
    const { jira, config } = buildJiraClient(kb);
    let jql = params.jql || DEFAULT_BUG_JQL;
    if (!params.jql) {
      if (params.dateRange) {
        jql = jql.replace("ORDER BY", `AND created >= -${params.dateRange} ORDER BY`);
      }
      if (params.component) {
        const escaped = params.component.replaceAll("'", String.raw`\'`);
        jql = jql.replace("ORDER BY", `AND component = '${escaped}' ORDER BY`);
      }
    }
    const maxResults = params.maxResults ?? 20;
    const boardId = config.jiraBoardId;
    const { issues, total } = boardId
      ? await jira.searchBoardIssues(boardId, jql, maxResults)
      : await jira.searchIssues(jql, undefined, maxResults);

    if (issues.length === 0) {
      return textResponse("# Bug Triage\n\nNo untriaged bugs found matching criteria.");
    }

    let out = `# Untriaged Bugs (${issues.length} of ${total})\n\n`;
    out += "| Key | Summary | Reporter | Created | Priority |\n";
    out += "|-----|---------|----------|---------|----------|\n";
    for (const i of issues) {
      const f = i.fields;
      const reporter = (f as Record<string, unknown>).reporter as { displayName?: string } | undefined;
      const reporterName = reporter?.displayName || "Unknown";
      out += `| ${i.key} | ${(f.summary || "").slice(0, 50)} | ${reporterName} | ${(f.created || "").slice(0, 10)} | ${f.priority?.name || "None"} |\n`;
    }
    out += "\nUse `assess` with issueKeys to check completeness.";
    return textResponse(out);
  } catch (err: unknown) {
    return errorResponse(`Triage error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── search ───────────────────────────────────────────────────────────────────

export async function handleSearchBugs(
  params: { jql?: string; maxResults?: number },
  kb: KnowledgeBase,
): Promise<ToolResponse> {
  if (!params.jql) return errorResponse("jql is required for 'search' action.");
  try {
    const { jira, config } = buildJiraClient(kb);
    let jql = params.jql;
    const orderExec = /\s+(ORDER\s+BY\s+[^\n]+)$/i.exec(jql);
    const orderClause = orderExec ? ` ${orderExec[1]}` : "";
    const filterPart = orderExec ? jql.slice(0, orderExec.index) : jql;

    const bugFilter = /\btype\s*[=!]/i.test(filterPart) ? filterPart : `type = Bug AND (${filterPart})`;

    const projectScoped =
      config.jiraProjectKey && !/\bproject\s*[=!]/i.test(bugFilter)
        ? `project = ${config.jiraProjectKey} AND (${bugFilter})`
        : bugFilter;

    jql = `${projectScoped}${orderClause}`;
    const maxResults = params.maxResults ?? 50;
    const boardId = config.jiraBoardId;
    const result = boardId
      ? await jira.searchBoardIssues(boardId, jql, maxResults)
      : await jira.searchIssues(jql, undefined, maxResults);

    if (result.issues.length === 0) {
      return textResponse(`No bugs found for: \`${params.jql}\``);
    }

    let out = `# Bug Search (${result.issues.length}/${result.total})\n\n`;
    out += "| Key | Summary | Status | Priority | Assignee |\n";
    out += "|-----|---------|--------|----------|----------|\n";
    for (const issue of result.issues) {
      out += `| ${issue.key} | ${issue.fields.summary} | ${issue.fields.status?.name ?? "Unknown"} | ${issue.fields.priority?.name ?? "None"} | ${issue.fields.assignee?.displayName || "Unassigned"} |\n`;
    }
    return textResponse(out);
  } catch (err: unknown) {
    return errorResponse(`Bug search failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── assess ───────────────────────────────────────────────────────────────────

export async function handleAssess(
  params: { issueKeys?: string[]; autoComment?: boolean },
  kb: KnowledgeBase,
): Promise<ToolResponse> {
  if (!params.issueKeys?.length) {
    return errorResponse("issueKeys required for assess action.");
  }
  try {
    const { jira } = buildJiraClient(kb);

    let out = "# Bug Assessment\n\n";
    for (const key of params.issueKeys) {
      const issue = await jira.getIssue(key);
      const { score, missing } = assessCompleteness(issue.description, issue.labels, issue.components);

      out += `## ${key}: ${issue.summary}\n`;
      out += `**Completeness:** ${score}%\n`;

      if (missing.length > 0) {
        out += "**Missing:**\n";
        for (const m of missing) out += `- ${m}\n`;
      } else {
        out += "**Status:** Complete\n";
      }

      if (score < 60 && (params.autoComment ?? true)) {
        const missingList = missing.map((m) => `- ${m}`).join("\n");
        const comment = `This bug report is incomplete (score: ${score}%). Please add:\n${missingList}`;
        await jira.addComment(key, comment);
        await jira.addLabels(key, ["needs-info"]);
        out += "*Comment added + labeled `needs-info`*\n";
      }
      out += "\n";
    }
    return textResponse(out);
  } catch (err: unknown) {
    return errorResponse(`Triage error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── triage ───────────────────────────────────────────────────────────────────

async function triageSingleIssue(
  issueKey: string,
  params: { severity?: string; autoUpdate?: boolean; autoAssign?: boolean },
  jira: JiraClient,
  config: ProjectConfig,
  kb: KnowledgeBase,
): Promise<string> {
  const issue = await jira.getIssue(issueKey);
  const text = `${issue.summary} ${issue.description || ""}`;
  const inferred = inferSeverity(text);
  const severity = params.severity || inferred.severity;

  let out = `# Triage: ${issueKey}\n\n`;
  out += "## Severity Analysis\n\n";
  out += "| Key | Current | Recommended | Rationale |\n";
  out += "|-----|---------|-------------|----------|\n";
  out += `| ${issueKey} | ${issue.priority || "Unknown"} | ${inferred.severity} | ${inferred.matches.join(", ")} |\n\n`;

  if (params.autoUpdate && inferred.severity.toLowerCase() !== (issue.priority || "").toLowerCase()) {
    await jira.updateIssue({ issueKey, priority: inferred.severity });
  }

  const boardId = config.jiraBoardId;
  if (boardId) {
    out += await assignSprint(issueKey, severity, jira, boardId, params.autoAssign ?? false);
  }

  // Evaluate team conventions for the bug
  try {
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
    const conventions = evaluateConventions(
      {
        summary: issue.summary,
        description: issue.description,
        issueType: "Bug",
        labels: issue.labels,
        components: issue.components,
      },
      merged,
    );
    const conventionsText = formatConventionsSection(conventions);
    if (conventionsText) out += `\n${conventionsText}\n`;
  } catch {
    // conventions are best-effort
  }

  return out;
}

async function assignSprint(
  issueKey: string,
  severity: string,
  jira: JiraClient,
  boardId: string,
  autoAssign: boolean,
): Promise<string> {
  let out = "## Sprint Assignment\n\n";
  out += `**Severity:** ${severity}\n\n`;

  if (severity === "critical") {
    return out + (await assignCriticalSprint(issueKey, jira, boardId, severity, autoAssign));
  }

  if (severity === "high") {
    return out + (await assignHighSprint(issueKey, jira, boardId, severity, autoAssign));
  }

  return out + (await assignLowSprint(issueKey, jira, boardId, severity, autoAssign));
}

async function assignCriticalSprint(
  issueKey: string,
  jira: JiraClient,
  boardId: string,
  severity: string,
  autoAssign: boolean,
): Promise<string> {
  const activeSprints = await jira.listSprints(boardId, "active");
  const sprint = activeSprints[0];
  if (!sprint) return "No active sprint found. Create one first.\n";

  const { issues: sprintIssues } = await jira.getSprintIssues(String(sprint.id));
  const spField = jira.storyPointsFieldId;
  const getSP = (f: Record<string, unknown>) =>
    (spField ? (f[spField] as number | undefined) : undefined) ??
    (f.story_points as number | undefined) ??
    (f.customfield_10016 as number | undefined) ??
    0;
  const todoItems = sprintIssues
    .filter((i) => i.fields.status?.name === "To Do")
    .sort((a, b) => getSP(a.fields as Record<string, unknown>) - getSP(b.fields as Record<string, unknown>));

  let out = `**Recommendation:** Add to current sprint "${sprint.name}"\n`;
  const tradeOff = todoItems[0];
  if (tradeOff) {
    out += `**Trade-off suggestion:** Consider deferring ${tradeOff.key} (${tradeOff.fields.summary})\n`;
  }

  if (autoAssign) {
    await jira.moveIssuesToSprint(String(sprint.id), [issueKey]);
    await jira.addComment(issueKey, `Triaged as ${severity}. Assigned to sprint "${sprint.name}".`);
    out += "\n*Issue moved to sprint + comment added.*\n";
  }

  return out;
}

async function assignHighSprint(
  issueKey: string,
  jira: JiraClient,
  boardId: string,
  severity: string,
  autoAssign: boolean,
): Promise<string> {
  const futureSprints = await jira.listSprints(boardId, "future");
  const nextSprint = futureSprints[0];
  if (!nextSprint) return "No future sprints found. Create one or use the active sprint.\n";

  let out = `**Recommendation:** Add to next sprint "${nextSprint.name}"\n`;

  if (autoAssign) {
    await jira.moveIssuesToSprint(String(nextSprint.id), [issueKey]);
    await jira.addComment(issueKey, `Triaged as ${severity}. Assigned to sprint "${nextSprint.name}".`);
    out += "\n*Issue moved to sprint + comment added.*\n";
  }

  return out;
}

async function assignLowSprint(
  issueKey: string,
  jira: JiraClient,
  boardId: string,
  severity: string,
  autoAssign: boolean,
): Promise<string> {
  const futureSprints = await jira.listSprints(boardId, "future");
  const lastSprint = futureSprints.at(-1);
  if (!lastSprint) return "No future sprints available. Leave in backlog.\n";

  let out = `**Recommendation:** Add to backlog or future sprint "${lastSprint.name}"\n`;

  if (autoAssign) {
    await jira.moveIssuesToSprint(String(lastSprint.id), [issueKey]);
    await jira.addComment(issueKey, `Triaged as ${severity}. Assigned to sprint "${lastSprint.name}".`);
    out += "\n*Issue moved to sprint + comment added.*\n";
  }

  return out;
}

async function triageReport(issueKeys: string[], jira: JiraClient): Promise<string> {
  const severityCounts: Record<string, number> = {};
  const statusCounts: Record<string, number> = {};
  const incomplete: string[] = [];

  for (const key of issueKeys) {
    const issue = await jira.getIssue(key);
    const { severity } = inferSeverity(`${issue.summary} ${issue.description || ""}`);
    severityCounts[severity] = (severityCounts[severity] || 0) + 1;
    statusCounts[issue.status] = (statusCounts[issue.status] || 0) + 1;

    const { score } = assessCompleteness(issue.description, issue.labels, issue.components);
    if (score < 60) incomplete.push(key);
  }

  let out = `# Triage Report (${issueKeys.length} bugs)\n\n`;
  out += "## Severity Distribution\n\n";
  for (const [sev, count] of Object.entries(severityCounts)) {
    out += `- **${sev}:** ${count}\n`;
  }
  out += "\n## Status Distribution\n\n";
  for (const [status, count] of Object.entries(statusCounts)) {
    out += `- **${status}:** ${count}\n`;
  }
  if (incomplete.length > 0) {
    out += `\n## Incomplete Bugs (${incomplete.length})\n\n`;
    out += incomplete.map((k) => `- ${k}`).join("\n");
    out += "\n";
  }
  return out;
}

export async function handleTriage(
  params: {
    issueKeys?: string[];
    severity?: string;
    autoUpdate?: boolean;
    autoAssign?: boolean;
  },
  kb: KnowledgeBase,
): Promise<ToolResponse> {
  if (!params.issueKeys?.length) {
    return errorResponse("issueKeys required for triage action.");
  }
  try {
    const { jira, config } = buildJiraClient(kb);

    if (params.issueKeys.length === 1) {
      const issueKey = params.issueKeys[0] as string;
      const out = await triageSingleIssue(issueKey, params, jira, config, kb);
      return textResponse(out);
    }

    const out = await triageReport(params.issueKeys, jira);
    return textResponse(out);
  } catch (err: unknown) {
    return errorResponse(`Triage error: ${err instanceof Error ? err.message : String(err)}`);
  }
}
