/**
 * Team Insights Analysis — barrel module and orchestrator.
 *
 * Coordinates all insight extractors and provides a single entry point
 * for analyzing completed Jira tickets to extract deep team insights.
 */

import { extractEstimationInsights } from "./team-insights-estimation.js";
import { extractOwnershipInsights } from "./team-insights-ownership.js";
import { extractPatternInsights } from "./team-insights-patterns.js";
import { extractTemplateInsights } from "./team-insights-templates.js";
import type { TeamInsights } from "./team-insights-types.js";
import type { TicketData } from "./team-rules-types.js";

// ─── Orchestrator ────────────────────────────────────────────────────────────────

/**
 * Analyze completed tickets and extract deep team insights across
 * estimation, ownership, templates, and cross-cutting patterns.
 *
 * Each extractor operates independently on the full ticket set.
 * All functions are pure — no side effects, no DB access.
 */
export function analyzeTeamInsights(tickets: TicketData[]): TeamInsights {
  return {
    estimation: extractEstimationInsights(tickets),
    ownership: extractOwnershipInsights(tickets),
    templates: extractTemplateInsights(tickets),
    patterns: extractPatternInsights(tickets),
  };
}

// ─── Summary formatter ───────────────────────────────────────────────────────────

/**
 * Format team insights into a human-readable markdown summary.
 */
export function formatTeamInsights(insights: TeamInsights): string {
  const sections: string[] = [];

  // Estimation insights
  if (insights.estimation.length > 0) {
    const lines = ["## Estimation Insights", ""];
    for (const e of insights.estimation) {
      lines.push(`### ${e.issueType} (n=${e.sampleSize})`);
      lines.push(`- Median cycle time: **${e.medianCycleDays} business days**`);
      if (e.pointsToDaysRatio > 0) {
        lines.push(`- Points-to-days ratio: **${e.pointsToDaysRatio}** days/point`);
        lines.push(`- Estimation accuracy: **${Math.round(e.estimationAccuracy * 100)}%**`);
      }
      const pointsStr = Object.entries(e.pointsDistribution)
        .sort(([a], [b]) => Number(a) - Number(b))
        .map(([pts, count]) => `${pts}pts(${count})`)
        .join(", ");
      if (pointsStr) lines.push(`- Points distribution: ${pointsStr}`);
      lines.push("");
    }
    sections.push(lines.join("\n"));
  }

  // Ownership insights
  if (insights.ownership.length > 0) {
    const lines = ["## Ownership Insights", ""];
    for (const o of insights.ownership) {
      lines.push(`### ${o.component} (n=${o.sampleSize})`);
      for (const owner of o.owners) {
        const pct = Math.round(owner.percentage * 100);
        const cycle = owner.avgCycleDays > 0 ? `, avg ${owner.avgCycleDays}d` : "";
        lines.push(`- ${owner.assignee}: ${owner.ticketCount} tickets (${pct}%${cycle})`);
      }
      lines.push("");
    }
    sections.push(lines.join("\n"));
  }

  // Template insights
  if (insights.templates.length > 0) {
    const lines = ["## Template Insights", ""];
    for (const t of insights.templates) {
      lines.push(`### ${t.issueType} (n=${t.sampleSize})`);
      lines.push(`- AC format: **${t.acFormat}**`);
      if (t.avgAcItems > 0) lines.push(`- Avg AC items: ${t.avgAcItems}`);
      if (t.headings.length > 0) {
        const headingStr = t.headings.map((h) => `"${h.text}" (${Math.round(h.frequency * 100)}%)`).join(", ");
        lines.push(`- Common headings: ${headingStr}`);
      }
      lines.push("");
    }
    sections.push(lines.join("\n"));
  }

  // Pattern insights
  const p = insights.patterns;
  if (Object.keys(p.priorityDistribution).length > 0 || p.labelCooccurrence.length > 0 || p.reworkRates.length > 0) {
    const lines = ["## Pattern Insights", ""];

    if (p.labelCooccurrence.length > 0) {
      lines.push("### Label Co-occurrence");
      for (const pair of p.labelCooccurrence.slice(0, 10)) {
        lines.push(`- ${pair.labelA} + ${pair.labelB}: ${Math.round(pair.cooccurrenceRate * 100)}% (n=${pair.count})`);
      }
      lines.push("");
    }

    if (p.reworkRates.length > 0) {
      lines.push("### Rework Rates");
      for (const r of p.reworkRates) {
        lines.push(
          `- ${r.component}: ${Math.round(r.reopenRate * 100)}% reopen rate (${r.reopenedTickets}/${r.totalTickets})`,
        );
      }
      lines.push("");
    }

    sections.push(lines.join("\n"));
  }

  return sections.join("\n") || "No insights available — insufficient data.";
}

// ─── Barrel re-exports ───────────────────────────────────────────────────────────

export { extractEstimationInsights } from "./team-insights-estimation.js";
export { extractOwnershipInsights } from "./team-insights-ownership.js";
export { extractPatternInsights } from "./team-insights-patterns.js";
export { extractTemplateInsights } from "./team-insights-templates.js";
export type {
  EstimationInsight,
  OwnershipInsight,
  PatternInsight,
  TeamInsights,
  TemplateInsight,
} from "./team-insights-types.js";
