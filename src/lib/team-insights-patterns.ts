/**
 * Pattern insight extraction for the Team Insights Analysis system.
 *
 * Discovers priority distributions, label co-occurrence patterns,
 * and rework (reopen) rates across completed tickets.
 */

import type { PatternInsight } from "./team-insights-types.js";
import type { TicketData } from "./team-rules-types.js";
import { groupBy } from "./utils.js";

// ─── Terminal statuses for rework detection ──────────────────────────────────────

const TERMINAL_STATUSES = new Set(["done", "closed", "resolved"]);

// ─── Priority distribution ───────────────────────────────────────────────────────

/**
 * Compute priority distribution grouped by issue type.
 * Returns { "Story": { "High": 5, "Medium": 30 }, ... }
 */
function computePriorityDistribution(tickets: TicketData[]): Record<string, Record<string, number>> {
  const byType = groupBy(tickets, (t) => t.issueType);
  const result: Record<string, Record<string, number>> = {};

  for (const [issueType, group] of byType) {
    const counts: Record<string, number> = {};
    for (const t of group) {
      counts[t.priority] = (counts[t.priority] ?? 0) + 1;
    }
    result[issueType] = counts;
  }

  return result;
}

// ─── Label co-occurrence ─────────────────────────────────────────────────────────

interface LabelPair {
  labelA: string;
  labelB: string;
  cooccurrenceRate: number;
  count: number;
}

/**
 * Find label pairs that frequently appear together.
 * Rate = pair_count / min(labelA_total, labelB_total).
 * Returns pairs with rate > 0.3 and count ≥ 3, sorted by rate desc, top 20.
 */
function computeLabelCooccurrence(tickets: TicketData[]): LabelPair[] {
  // Count individual label frequencies
  const labelFreq = new Map<string, number>();
  // Count pair frequencies
  const pairFreq = new Map<string, number>();

  for (const t of tickets) {
    if (t.labels.length < 2) {
      // Still count single labels for frequency
      for (const l of t.labels) {
        labelFreq.set(l, (labelFreq.get(l) ?? 0) + 1);
      }
      continue;
    }

    for (const l of t.labels) {
      labelFreq.set(l, (labelFreq.get(l) ?? 0) + 1);
    }

    // Generate sorted pairs to avoid duplicates
    const sorted = [...t.labels].sort();
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const key = `${sorted[i]}|||${sorted[j]}`;
        pairFreq.set(key, (pairFreq.get(key) ?? 0) + 1);
      }
    }
  }

  // Compute rates and filter
  const pairs: LabelPair[] = [];

  for (const [key, count] of pairFreq) {
    if (count < 3) continue;

    const [labelA, labelB] = key.split("|||") as [string, string];
    const freqA = labelFreq.get(labelA) ?? 0;
    const freqB = labelFreq.get(labelB) ?? 0;
    const minFreq = Math.min(freqA, freqB);

    if (minFreq === 0) continue;

    const rate = count / minFreq;
    if (rate > 0.3) {
      pairs.push({
        labelA,
        labelB,
        cooccurrenceRate: Math.round(rate * 100) / 100,
        count,
      });
    }
  }

  // Sort by rate desc, take top 20
  pairs.sort((a, b) => b.cooccurrenceRate - a.cooccurrenceRate);
  return pairs.slice(0, 20);
}

// ─── Rework rates ────────────────────────────────────────────────────────────────

interface ReworkRate {
  component: string;
  reopenRate: number;
  totalTickets: number;
  reopenedTickets: number;
}

/**
 * Detect tickets that were reopened (transitioned back from a terminal status).
 * Groups by component and computes reopen rates.
 * Returns components with ≥5 total tickets.
 */
function computeReworkRates(tickets: TicketData[]): ReworkRate[] {
  // Detect reopened tickets
  const componentStats = new Map<string, { total: number; reopened: number }>();

  for (const t of tickets) {
    const components = t.components.length > 0 ? t.components : ["unassigned"];
    const wasReopened = detectReopen(t);

    for (const comp of components) {
      let stats = componentStats.get(comp);
      if (!stats) {
        stats = { total: 0, reopened: 0 };
        componentStats.set(comp, stats);
      }
      stats.total++;
      if (wasReopened) stats.reopened++;
    }
  }

  // Filter and build result
  const rates: ReworkRate[] = [];

  for (const [component, stats] of componentStats) {
    if (stats.total < 5) continue;

    rates.push({
      component,
      reopenRate: Math.round((stats.reopened / stats.total) * 100) / 100,
      totalTickets: stats.total,
      reopenedTickets: stats.reopened,
    });
  }

  // Sort by reopen rate desc
  rates.sort((a, b) => b.reopenRate - a.reopenRate);
  return rates;
}

/**
 * Check if a ticket was reopened: any status transition TO a non-terminal status
 * AFTER the ticket was already in a terminal status.
 */
function detectReopen(ticket: TicketData): boolean {
  const statusChanges = ticket.changelog
    .filter((c) => c.field === "status")
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  let wasTerminal = false;

  for (const change of statusChanges) {
    if (change.to && TERMINAL_STATUSES.has(change.to.toLowerCase())) {
      wasTerminal = true;
    } else if (wasTerminal && change.to && !TERMINAL_STATUSES.has(change.to.toLowerCase())) {
      // Transitioned away from terminal → reopened
      return true;
    }
  }

  return false;
}

// ─── Main extractor ──────────────────────────────────────────────────────────────

/**
 * Extract cross-cutting pattern insights from completed tickets.
 *
 * Computes priority distributions, label co-occurrence patterns,
 * and rework (reopen) rates per component.
 */
export function extractPatternInsights(tickets: TicketData[]): PatternInsight {
  return {
    priorityDistribution: computePriorityDistribution(tickets),
    labelCooccurrence: computeLabelCooccurrence(tickets),
    reworkRates: computeReworkRates(tickets),
  };
}
