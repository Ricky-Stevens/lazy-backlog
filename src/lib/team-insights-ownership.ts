/**
 * Ownership insight extraction for the Team Insights Analysis system.
 *
 * Identifies component owners by analyzing assignee distribution
 * and per-owner cycle times across completed tickets.
 */

import { businessDaysBetween } from "./team-insights-estimation.js";
import type { OwnershipInsight } from "./team-insights-types.js";
import type { TicketData } from "./team-rules-types.js";
import { mean } from "./team-rules-utils.js";

// ─── Types ───────────────────────────────────────────────────────────────────────

interface OwnerStats {
  count: number;
  cycleDays: number[];
}

// ─── Main extractor ──────────────────────────────────────────────────────────────

/**
 * Extract ownership insights from completed tickets.
 *
 * Builds a component → assignee map, computes ticket counts,
 * ownership percentages, and average cycle times per owner.
 * Returns top 5 owners per component, only for components with ≥3 tickets.
 */
export function extractOwnershipInsights(tickets: TicketData[]): OwnershipInsight[] {
  // Only tickets with an assignee
  const assigned = tickets.filter((t) => t.assignee != null);

  if (assigned.length === 0) return [];

  // Build component → assignee → stats map
  const componentMap = new Map<string, Map<string, OwnerStats>>();

  for (const t of assigned) {
    const components = t.components.length > 0 ? t.components : ["unassigned"];
    const cycleDays = t.resolutionDate && t.created ? businessDaysBetween(t.created, t.resolutionDate) : null;

    for (const comp of components) {
      let assigneeMap = componentMap.get(comp);
      if (!assigneeMap) {
        assigneeMap = new Map<string, OwnerStats>();
        componentMap.set(comp, assigneeMap);
      }

      const assignee = t.assignee as string;
      let stats = assigneeMap.get(assignee);
      if (!stats) {
        stats = { count: 0, cycleDays: [] };
        assigneeMap.set(assignee, stats);
      }

      stats.count++;
      if (cycleDays != null) {
        stats.cycleDays.push(cycleDays);
      }
    }
  }

  // Build insights
  const insights: OwnershipInsight[] = [];

  for (const [component, assigneeMap] of componentMap) {
    // Total tickets for this component
    let total = 0;
    for (const stats of assigneeMap.values()) {
      total += stats.count;
    }

    if (total < 3) continue;

    // Sort owners by count desc, take top 5
    const sorted = [...assigneeMap.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 5);

    const owners = sorted.map(([assignee, stats]) => ({
      assignee,
      ticketCount: stats.count,
      percentage: Math.round((stats.count / total) * 100) / 100,
      avgCycleDays: stats.cycleDays.length > 0 ? Math.round(mean(stats.cycleDays) * 100) / 100 : 0,
    }));

    insights.push({
      component,
      owners,
      sampleSize: total,
    });
  }

  // Sort by sample size desc for consistent output
  insights.sort((a, b) => b.sampleSize - a.sampleSize);

  return insights;
}
