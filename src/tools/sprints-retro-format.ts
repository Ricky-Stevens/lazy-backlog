/**
 * Output-section formatters for the sprint retro action.
 * Extracted from sprints-retro.ts to keep that file under the 400-line cap.
 *
 * Each formatter takes computed data and returns a markdown fragment. The main
 * handler in sprints-retro.ts composes these into the final retro report.
 */
import type { SearchIssue } from "../lib/jira.js";
import { getStoryPoints } from "./sprints-utils.js";

export interface CycleDataItem {
  key: string;
  summary: string;
  issueType: string;
  cycleTimeDays: number;
}

export function formatHeader(sprint: { name: string; startDate?: string; endDate?: string; goal?: string }): string {
  let out = `# Retrospective: ${sprint.name}\n\n`;
  if (sprint.startDate && sprint.endDate) {
    out += `**Period:** ${sprint.startDate.slice(0, 10)} to ${sprint.endDate.slice(0, 10)}\n`;
  }
  if (sprint.goal) out += `**Goal:** ${sprint.goal}\n`;
  return out;
}

export function formatHealthSection(
  health: { overall: string },
  velocity: { average: number; trend: string; trendSlope: number; sprints: { completed: number }[] },
  completionRate: number,
  completedSP: number,
  carryOverCount: number,
  bugRatio: number,
): string {
  let out = `\n## Sprint Health: ${health.overall.toUpperCase()}\n\n`;
  out += `- **Completion Rate:** ${completionRate}%\n`;
  out += `- **Velocity:** ${velocity.sprints[0]?.completed ?? completedSP} pts completed\n`;
  out += `- **Average Velocity:** ${velocity.average} pts\n`;
  out += `- **Trend:** ${velocity.trend} (slope: ${velocity.trendSlope})\n`;
  out += `- **Carry-over:** ${carryOverCount} issues\n`;
  out += `- **Bug Ratio:** ${bugRatio}%\n`;
  return out;
}

function percentile(sorted: number[], p: number): number {
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.max(0, rank - 1)] ?? 0;
}

export function formatCycleTimeSection(cycleData: CycleDataItem[]): string {
  if (cycleData.length === 0) return "";
  const sorted = [...cycleData.map((d) => d.cycleTimeDays)].sort((a, b) => a - b);
  let out = `\n## Cycle Time\n\n`;
  out += `**Median:** ${percentile(sorted, 50)} days | **P75:** ${percentile(sorted, 75)} days | **P90:** ${percentile(sorted, 90)} days\n`;
  return out;
}

export function formatSummarySection(
  issueCount: number,
  completedCount: number,
  carryOverCount: number,
  totalSP: number,
  completedSP: number,
  completionRate: number,
): string {
  let out = `\n## Summary\n\n`;
  out += `- **Total issues:** ${issueCount}\n`;
  out += `- **Completed:** ${completedCount}\n`;
  out += `- **Carry-over:** ${carryOverCount}\n`;
  out += `- **Total SP:** ${totalSP}\n`;
  out += `- **Completed SP:** ${completedSP}\n`;
  out += `- **Completion rate:** ${completionRate}%\n`;
  return out;
}

export function formatCompletedByType(completedByType: Map<string, SearchIssue[]>): string {
  if (completedByType.size === 0) return "";
  let out = `\n## Completed by Type\n\n`;
  for (const [type, typeIssues] of completedByType) {
    out += `### ${type} (${typeIssues.length})\n`;
    for (const issue of typeIssues) {
      out += `- ${issue.key}: ${issue.fields.summary}\n`;
    }
    out += "\n";
  }
  return out;
}

export function formatCarryOver(carryOver: SearchIssue[]): string {
  if (carryOver.length === 0) return "";
  let out = `## Carry-over Items (${carryOver.length})\n\n`;
  for (const issue of carryOver) {
    out += `- **${issue.key}**: ${issue.fields.summary} [${issue.fields.status?.name ?? "Unknown"}]\n`;
  }
  out += "\n";
  return out;
}

export function formatIssueBreakdown(issues: SearchIssue[]): string {
  let out = "## Issue Breakdown\n\n";
  const byType: Record<string, number> = {};
  for (const issue of issues) {
    const type = issue.fields.issuetype?.name ?? "Unknown";
    byType[type] = (byType[type] || 0) + 1;
  }
  for (const [type, count] of Object.entries(byType)) {
    out += `- **${type}**: ${count}\n`;
  }
  return out;
}

export function formatScopeCreep(issues: SearchIssue[], sprintStartDate: string | undefined): string {
  if (!sprintStartDate) return "";
  const sprintStart = new Date(sprintStartDate);
  const scopeCreepIssues = issues.filter((i) => {
    const created = i.fields.created;
    return created ? new Date(created) > sprintStart : false;
  });
  const scopeCreepPct = issues.length > 0 ? Math.round((scopeCreepIssues.length / issues.length) * 100) : 0;

  let out = `\n## Scope Creep\n\n`;
  out += `**Added mid-sprint:** ${scopeCreepIssues.length} of ${issues.length} issues (${scopeCreepPct}%)\n`;
  if (scopeCreepIssues.length > 0) {
    out += "\n";
    for (const issue of scopeCreepIssues) {
      const createdDate = issue.fields.created ? issue.fields.created.slice(0, 10) : "unknown";
      out += `- ${issue.key}: ${issue.fields.summary} (added ${createdDate})\n`;
    }
  }
  out += "\n";
  return out;
}

/** Build per-type cycle time from changelog-based cycle data (In Progress → Done). */
function buildTypeTimings(cycleData: CycleDataItem[]): Map<string, number[]> {
  const typeTimings = new Map<string, number[]>();
  for (const item of cycleData) {
    const timings = typeTimings.get(item.issueType) ?? [];
    timings.push(item.cycleTimeDays);
    typeTimings.set(item.issueType, timings);
  }
  return typeTimings;
}

function formatSlowItems(cycleData: CycleDataItem[]): string {
  if (cycleData.length === 0) return "";
  const avgCycle = cycleData.reduce((sum, d) => sum + d.cycleTimeDays, 0) / cycleData.length;
  const slowItems = cycleData.filter((d) => d.cycleTimeDays > avgCycle * 1.5);
  if (slowItems.length === 0) return "";

  let out = `\n**Notably slow items** (>1.5x average cycle time of ${Math.round(avgCycle * 10) / 10} days):\n`;
  for (const item of slowItems) {
    out += `- ${item.key}: ${item.summary} (${item.cycleTimeDays} days, ${item.issueType})\n`;
  }
  return out;
}

export function formatTimeInStatus(cycleData: CycleDataItem[]): string {
  if (cycleData.length === 0) return "";
  const typeTimings = buildTypeTimings(cycleData);
  if (typeTimings.size === 0) return "";

  let out = `\n## Time in Status\n\n`;
  out += "| Issue Type | Avg Cycle Time (days) | Issues |\n";
  out += "|------------|----------------------|--------|\n";
  for (const [issueType, timings] of typeTimings) {
    const avg = Math.round((timings.reduce((a, b) => a + b, 0) / timings.length) * 10) / 10;
    out += `| ${issueType} | ${avg} | ${timings.length} |\n`;
  }
  out += formatSlowItems(cycleData);
  out += "\n";
  return out;
}

export function formatVelocityTrend(velocity: {
  sprints: { sprintName: string; committed: number; completed: number; carryOver: number }[];
  trend: string;
  trendSlope: number;
}): string {
  if (velocity.sprints.length === 0) return "";
  let out = "\n## Velocity Trend\n\n";
  out += "| Sprint | Committed | Completed | Carry-Over |\n";
  out += "|--------|-----------|-----------|------------|\n";
  for (const s of velocity.sprints) {
    out += `| ${s.sprintName} | ${s.committed} SP | ${s.completed} SP | ${s.carryOver} SP |\n`;
  }
  out += `\nTrend: ${velocity.trend} (slope: ${velocity.trendSlope.toFixed(2)} SP/sprint)\n`;
  return out;
}

export function formatEstimationAccuracy(completedSP: number, totalSP: number, velocityAvg: number): string {
  const deliveryRate = totalSP > 0 ? Math.round((completedSP / totalSP) * 100) : 0;
  let out = "\n## Estimation Accuracy\n\n";
  out += `This sprint: ${completedSP}/${totalSP} = ${deliveryRate}% delivery rate\n`;
  if (velocityAvg > 0) {
    const diff = completedSP - velocityAvg;
    const label = diff >= 0 ? "above" : "below";
    out += `Compared to average velocity (${Math.round(velocityAvg)} SP): ${Math.abs(Math.round(diff))} SP ${label} average\n`;
  }
  return out;
}

export function formatWorkloadDistribution(completed: SearchIssue[], spFieldId: string | undefined): string {
  const assigneeMap = new Map<string, { sp: number; issues: number }>();
  for (const issue of completed) {
    const assignee = (issue.fields as Record<string, unknown>).assignee
      ? (((issue.fields as Record<string, unknown>).assignee as { displayName?: string })?.displayName ?? "Unassigned")
      : "Unassigned";
    const sp = getStoryPoints(issue.fields, spFieldId);
    const existing = assigneeMap.get(assignee) ?? { sp: 0, issues: 0 };
    existing.sp += sp;
    existing.issues += 1;
    assigneeMap.set(assignee, existing);
  }
  if (assigneeMap.size <= 1) return "";

  let out = "\n## Workload Distribution\n\n";
  out += "| Assignee | Completed SP | Issues |\n";
  out += "|----------|-------------|--------|\n";
  const entries = [...assigneeMap.entries()];
  const spValues = entries.map(([, d]) => d.sp);
  const mean = spValues.reduce((a, b) => a + b, 0) / spValues.length;

  for (const [name, data] of entries) {
    out += `| ${name} | ${data.sp} | ${data.issues} |\n`;
  }
  const imbalanced = entries.some(([, d]) => mean > 0 && (d.sp > mean * 2 || d.sp < mean * 0.5));
  out += `\nBalance: ${imbalanced ? "imbalanced" : "even"}\n`;
  return out;
}
