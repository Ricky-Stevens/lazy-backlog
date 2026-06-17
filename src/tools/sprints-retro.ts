import { computeSprintHealth, computeVelocity } from "../lib/analytics.js";
import { errorResponse, textResponse } from "../lib/config.js";
import { groupBy } from "../lib/db.js";
import type { JiraClient, SearchIssue } from "../lib/jira.js";
import {
  type CycleDataItem,
  formatCarryOver,
  formatCompletedByType,
  formatCycleTimeSection,
  formatEstimationAccuracy,
  formatHeader,
  formatHealthSection,
  formatIssueBreakdown,
  formatScopeCreep,
  formatSummarySection,
  formatTimeInStatus,
  formatVelocityTrend,
  formatWorkloadDistribution,
} from "./sprints-retro-format.js";
import { fetchSprintData, getStoryPoints } from "./sprints-utils.js";
import { buildSuggestions } from "./suggestions.js";

// Re-export the cycle-data type so existing importers (tests etc.) keep working.
export type { CycleDataItem } from "./sprints-retro-format.js";

interface SprintReportData {
  completed: SearchIssue[];
  carryOver: SearchIssue[];
  totalSP: number;
  completedSP: number;
}

const DONE_STATUSES = new Set(["done", "closed", "resolved"]);

// ── Data helpers ──

function classifyIssues(issues: SearchIssue[], spFieldId: string | undefined): SprintReportData {
  const completed: SearchIssue[] = [];
  const carryOver: SearchIssue[] = [];
  let totalSP = 0;
  let completedSP = 0;

  for (const issue of issues) {
    const sp = getStoryPoints(issue.fields, spFieldId);
    totalSP += sp;
    const status = (issue.fields.status?.name ?? "").toLowerCase();
    if (DONE_STATUSES.has(status)) {
      completed.push(issue);
      completedSP += sp;
    } else {
      carryOver.push(issue);
    }
  }

  return { completed, carryOver, totalSP, completedSP };
}

function mapSprintIssueData(issues: SearchIssue[], spFieldId: string | undefined) {
  return issues.map((i) => ({
    key: i.key,
    summary: i.fields.summary,
    issueType: i.fields.issuetype?.name || "Unknown",
    status: i.fields.status?.name || "Unknown",
    statusCategory: i.fields.status?.statusCategory?.name,
    storyPoints: getStoryPoints(i.fields, spFieldId) || undefined,
    assignee: (i.fields as Record<string, unknown>).assignee
      ? ((i.fields as Record<string, unknown>).assignee as { displayName?: string })?.displayName
      : undefined,
  }));
}

async function collectCycleData(completed: SearchIssue[], jira: JiraClient): Promise<CycleDataItem[]> {
  const cycleData: CycleDataItem[] = [];

  for (const issue of completed) {
    try {
      const changelog = await jira.getIssueChangelog(issue.key);
      const times = extractStatusTimes(changelog);
      if (times.startTime && times.endTime) {
        const days = (times.endTime.getTime() - times.startTime.getTime()) / (1000 * 60 * 60 * 24);
        cycleData.push({
          key: issue.key,
          summary: issue.fields.summary ?? issue.key,
          issueType: issue.fields.issuetype?.name ?? "Unknown",
          cycleTimeDays: Math.round(days * 10) / 10,
        });
      }
    } catch {
      // Skip issues where changelog isn't available — best-effort cycle data.
    }
  }

  return cycleData;
}

function extractStatusTimes(changelog: { created: string; items: { field: string; toString: string | null }[] }[]) {
  let startTime: Date | null = null;
  let endTime: Date | null = null;

  for (const entry of changelog) {
    for (const item of entry.items) {
      if (item.field !== "status") continue;
      if (item.toString === "In Progress" && !startTime) {
        startTime = new Date(entry.created);
      }
      if ((item.toString === "Done" || item.toString === "Closed") && !endTime) {
        endTime = new Date(entry.created);
      }
    }
  }

  return { startTime, endTime };
}

// ── Main handler ──

/** Handle the 'retro' action (comprehensive retrospective data pack). */
export async function handleRetroAction(
  params: {
    sprintId?: string;
    sprintCount?: number;
  },
  jira: JiraClient,
  boardId: string,
  spFieldId: string | undefined,
) {
  if (!boardId) return errorResponse("No board ID configured. Set JIRA_BOARD_ID or run configure.");

  let sprintId = params.sprintId;

  if (!sprintId) {
    const closed = await jira.listSprints(boardId, "closed");
    if (closed.length === 0) return errorResponse("No closed sprints found.");
    const latest = closed.at(-1);
    if (!latest) return errorResponse("No closed sprints found.");
    sprintId = String(latest.id);
  }

  const [sprint, sprintIssuesRes] = await Promise.all([jira.getSprint(sprintId), jira.getSprintIssues(sprintId)]);
  const issues = sprintIssuesRes.issues;

  const { completed, carryOver, totalSP, completedSP } = classifyIssues(issues, spFieldId);
  const completionRate = totalSP > 0 ? Math.round((completedSP / totalSP) * 100) : 0;
  const completedByType = groupBy(completed, (i) => i.fields.issuetype?.name ?? "Unknown");

  const sprintIssueData = mapSprintIssueData(issues, spFieldId);
  const sprintCount = params.sprintCount ?? 5;
  const historicalData = await fetchSprintData(jira, boardId, sprintCount);
  const velocity = computeVelocity(
    historicalData.length > 0 ? historicalData : [{ id: sprintId, name: sprint.name, issues: sprintIssueData }],
  );
  const health = computeSprintHealth({ id: sprintId, name: sprint.name, issues: sprintIssueData }, velocity.average);

  const cycleData = await collectCycleData(completed, jira);

  const bugCount = issues.filter((i) => (i.fields.issuetype?.name ?? "").toLowerCase() === "bug").length;
  const bugRatio = issues.length > 0 ? Math.round((bugCount / issues.length) * 100) : 0;

  // Sprint-over-sprint comparison: compare this sprint to trailing 3-sprint average
  let comparisonSection = "";
  if (velocity.sprints.length > 1) {
    const trailing = velocity.sprints.slice(1, 4); // skip index 0 (current sprint)
    if (trailing.length > 0) {
      const avgCompleted = Math.round(trailing.reduce((s, sp) => s + sp.completed, 0) / trailing.length);
      const avgCarryOver = Math.round((trailing.reduce((s, sp) => s + sp.carryOver, 0) / trailing.length) * 10) / 10;
      const currentCompleted = velocity.sprints[0]?.completed ?? completedSP;
      const currentCarryOver = carryOver.length;

      const velDelta = avgCompleted > 0 ? Math.round(((currentCompleted - avgCompleted) / avgCompleted) * 100) : 0;
      const carryDelta = avgCarryOver > 0 ? Math.round(((currentCarryOver - avgCarryOver) / avgCarryOver) * 100) : 0;

      const trend = velDelta > 5 ? "improving" : velDelta < -5 ? "declining" : "stable";

      comparisonSection = `\n## vs ${trailing.length}-Sprint Average\n\n`;
      comparisonSection += `- **Velocity:** ${velDelta >= 0 ? "+" : ""}${velDelta}% (${currentCompleted} vs ${avgCompleted} SP)\n`;
      comparisonSection += `- **Carry-over:** ${carryDelta >= 0 ? "+" : ""}${carryDelta}% (${currentCarryOver} vs ${avgCarryOver})\n`;
      comparisonSection += `- **Trend:** ${trend}\n`;
    }
  }

  const out =
    formatHeader(sprint) +
    formatHealthSection(health, velocity, completionRate, completedSP, carryOver.length, bugRatio) +
    formatVelocityTrend(velocity) +
    formatEstimationAccuracy(completedSP, totalSP, velocity.average) +
    comparisonSection +
    formatCycleTimeSection(cycleData) +
    formatSummarySection(issues.length, completed.length, carryOver.length, totalSP, completedSP, completionRate) +
    formatCompletedByType(completedByType) +
    formatCarryOver(carryOver) +
    formatWorkloadDistribution(completed, spFieldId) +
    formatIssueBreakdown(issues) +
    formatScopeCreep(issues, sprint.startDate) +
    formatTimeInStatus(cycleData);

  const suggestions = buildSuggestions("insights", "retro", {});
  return textResponse(out + suggestions);
}
