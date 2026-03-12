/**
 * Estimation insight extraction for the Team Insights Analysis system.
 *
 * Analyzes completed tickets to compute cycle time, points-to-days ratios,
 * and estimation accuracy per issue type.
 */

import type { EstimationInsight } from "./team-insights-types.js";
import type { TicketData } from "./team-rules-types.js";
import { mean, median, stddev } from "./team-rules-utils.js";
import { groupBy } from "./utils.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────────

/**
 * Count weekdays (Mon–Fri) between two ISO date strings.
 * Both start and end dates are inclusive if they fall on weekdays.
 */
export function businessDaysBetween(start: string, end: string): number {
  const startDate = new Date(start);
  const endDate = new Date(end);

  if (endDate <= startDate) return 0;

  let count = 0;
  const current = new Date(startDate);
  // Move to start of day to avoid time-of-day issues
  current.setUTCHours(0, 0, 0, 0);
  const endNorm = new Date(endDate);
  endNorm.setUTCHours(0, 0, 0, 0);

  while (current <= endNorm) {
    const day = current.getUTCDay();
    // 0 = Sunday, 6 = Saturday
    if (day !== 0 && day !== 6) {
      count++;
    }
    current.setUTCDate(current.getUTCDate() + 1);
  }

  return Math.max(count, 1);
}

// ─── Main extractor ──────────────────────────────────────────────────────────────

/**
 * Extract estimation insights from completed tickets.
 *
 * Groups by issue type and computes:
 * - Median cycle time in business days
 * - Points distribution
 * - Points-to-days ratio (how many days per story point)
 * - Estimation accuracy (consistency of the points→days mapping)
 */
export function extractEstimationInsights(tickets: TicketData[]): EstimationInsight[] {
  // Only tickets with both created and resolutionDate
  const resolved = tickets.filter((t) => t.resolutionDate && t.created);

  if (resolved.length === 0) return [];

  // Compute cycle days for each ticket
  const withCycle = resolved.map((t) => ({
    ...t,
    cycleDays: businessDaysBetween(t.created, t.resolutionDate as string),
  }));

  const byType = groupBy(withCycle, (t) => t.issueType);
  const insights: EstimationInsight[] = [];

  for (const [issueType, group] of byType) {
    if (group.length < 3) continue;

    const cycleDaysArr = group.map((t) => t.cycleDays);
    const medianCycleDays = median(cycleDaysArr);

    // Points distribution
    const pointsDistribution: Record<number, number> = {};
    for (const t of group) {
      if (t.storyPoints != null && t.storyPoints > 0) {
        pointsDistribution[t.storyPoints] = (pointsDistribution[t.storyPoints] ?? 0) + 1;
      }
    }

    // Points-to-days ratio and estimation accuracy (only for tickets with points)
    const withPoints = group.filter((t) => t.storyPoints != null && t.storyPoints > 0);
    let pointsToDaysRatio = 0;
    let estimationAccuracy = 0;

    if (withPoints.length >= 2) {
      const pointsArr = withPoints.map((t) => t.storyPoints as number);
      const cycleForPointed = withPoints.map((t) => t.cycleDays);
      const medianPoints = median(pointsArr);

      pointsToDaysRatio = medianPoints > 0 ? median(cycleForPointed) / medianPoints : 0;

      // Accuracy: how consistent is the days/points ratio across tickets
      const ratios = withPoints.map((t) => t.cycleDays / (t.storyPoints as number));
      const ratioMean = mean(ratios);
      const ratioStddev = stddev(ratios);

      if (ratioMean > 0) {
        estimationAccuracy = Math.max(0, Math.min(1, 1 - ratioStddev / ratioMean));
      }
    }

    insights.push({
      issueType,
      medianCycleDays,
      pointsToDaysRatio: Math.round(pointsToDaysRatio * 100) / 100,
      estimationAccuracy: Math.round(estimationAccuracy * 100) / 100,
      pointsDistribution,
      sampleSize: group.length,
    });
  }

  return insights;
}
