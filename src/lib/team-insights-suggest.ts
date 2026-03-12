/**
 * Smart defaults and description scaffolding from team insights.
 *
 * Consumes analyzed team insights to suggest field values, assignees,
 * and description templates for new ticket creation.
 */

import type { EstimationInsight, OwnershipInsight, PatternInsight, TemplateInsight } from "./team-insights-types.js";

// ─── Types ──────────────────────────────────────────────────────────────────────

export interface SmartDefaults {
  assignee?: { name: string; reason: string };
  storyPoints?: { value: number; reason: string };
  priority?: { value: string; reason: string };
  labels?: { additions: string[]; reason: string };
}

export interface DescriptionScaffold {
  template: string;
  acFormat: string;
  guidance: string;
}

export interface TicketContext {
  summary: string;
  issueType: string;
  description?: string;
  components?: string[];
  labels?: string[];
  storyPoints?: number;
  priority?: string;
}

// ─── Smart Defaults ─────────────────────────────────────────────────────────────

/** Generate smart default suggestions based on team insights. */
export function generateSmartDefaults(
  ticket: TicketContext,
  estimation: EstimationInsight[],
  ownership: OwnershipInsight[],
  patterns: PatternInsight,
): SmartDefaults {
  const defaults: SmartDefaults = {};

  // Suggest story points from estimation data if not already set
  if (ticket.storyPoints == null) {
    const est = estimation.find((e) => e.issueType === ticket.issueType);
    if (est && est.sampleSize >= 5) {
      const mostCommon = Object.entries(est.pointsDistribution).sort(([, a], [, b]) => b - a)[0];
      if (mostCommon) {
        defaults.storyPoints = {
          value: Number(mostCommon[0]),
          reason: `Most common for ${ticket.issueType} (${Math.round(mostCommon[1] * 100)}% of ${est.sampleSize} tickets)`,
        };
      }
    }
  }

  // Suggest assignee from component ownership
  if (ticket.components?.length) {
    const comp = ticket.components[0];
    const ownerData = comp ? ownership.find((o) => o.component === comp) : undefined;
    if (ownerData?.owners.length && ownerData.sampleSize >= 3) {
      const top = ownerData.owners[0];
      if (top) {
        defaults.assignee = {
          name: top.assignee,
          reason: `Owns ${top.percentage}% of ${comp} tickets (${top.ticketCount} tickets, avg ${top.avgCycleDays.toFixed(1)}d cycle)`,
        };
      }
    }
  }

  // Suggest priority from distribution patterns
  if (!ticket.priority) {
    const dist = patterns.priorityDistribution[ticket.issueType];
    if (dist) {
      const top = Object.entries(dist).sort(([, a], [, b]) => b - a)[0];
      if (top && top[0] !== "Medium") {
        defaults.priority = {
          value: top[0],
          reason: `${Math.round(top[1] * 100)}% of ${ticket.issueType} tickets use this priority`,
        };
      }
    }
  }

  // Suggest co-occurring labels
  if (ticket.labels?.length) {
    const suggestions = new Set<string>();
    for (const label of ticket.labels) {
      for (const co of patterns.labelCooccurrence) {
        if (co.cooccurrenceRate >= 0.5 && co.count >= 5) {
          if (co.labelA === label && !ticket.labels.includes(co.labelB)) suggestions.add(co.labelB);
          if (co.labelB === label && !ticket.labels.includes(co.labelA)) suggestions.add(co.labelA);
        }
      }
    }
    if (suggestions.size > 0) {
      defaults.labels = {
        additions: [...suggestions].slice(0, 3),
        reason: "Frequently co-occurs with specified labels",
      };
    }
  }

  return defaults;
}

// ─── Description Scaffold ───────────────────────────────────────────────────────

/** Generate a description scaffold from team template patterns. */
export function generateDescriptionScaffold(
  issueType: string,
  templates: TemplateInsight[],
): DescriptionScaffold | null {
  const tmpl = templates.find((t) => t.issueType === issueType);
  if (!tmpl || tmpl.sampleSize < 3) return null;

  const acFormats: Record<string, string> = {
    checkbox: "- [ ] Criterion here",
    "given-when-then": "Given ... When ... Then ...",
    numbered: "1. First criterion\n2. Second criterion",
    prose: "Describe expected outcome in paragraph form",
    none: "(No AC pattern detected)",
  };

  return {
    template: tmpl.templateSkeleton,
    acFormat: acFormats[tmpl.acFormat] ?? (acFormats.none as string),
    guidance:
      tmpl.headings.length > 0
        ? `Common sections: ${tmpl.headings
            .slice(0, 5)
            .map((h) => h.text)
            .join(", ")}`
        : "No common section pattern detected",
  };
}

// ─── Formatting ─────────────────────────────────────────────────────────────────

/** Format insights into a markdown section for the preview card. */
export function formatInsightsSection(
  defaults: SmartDefaults,
  scaffold: DescriptionScaffold | null,
  estimation: EstimationInsight[],
  ticket: TicketContext,
  reworkRates: PatternInsight["reworkRates"],
): string {
  const lines: string[] = [];
  const hasDefaults = defaults.storyPoints || defaults.assignee || defaults.priority || defaults.labels;
  const est = estimation.find((e) => e.issueType === ticket.issueType);
  const rework = ticket.components?.length
    ? reworkRates.find((r) => r.component === ticket.components?.[0])
    : undefined;

  if (!hasDefaults && !scaffold && !est && !rework) return "";

  lines.push("## Team Insights");
  lines.push("");

  // Smart defaults
  if (hasDefaults) {
    lines.push("### Suggested Defaults");
    lines.push("");
    if (defaults.storyPoints) {
      lines.push(`- **Story Points:** ${defaults.storyPoints.value} — ${defaults.storyPoints.reason}`);
    }
    if (defaults.assignee) {
      lines.push(`- **Assignee:** ${defaults.assignee.name} — ${defaults.assignee.reason}`);
    }
    if (defaults.priority) {
      lines.push(`- **Priority:** ${defaults.priority.value} — ${defaults.priority.reason}`);
    }
    if (defaults.labels) {
      lines.push(`- **Labels to add:** ${defaults.labels.additions.join(", ")} — ${defaults.labels.reason}`);
    }
    lines.push("");
  }

  // Estimation context
  if (est && est.sampleSize >= 5) {
    lines.push("### Estimation Context");
    lines.push("");
    lines.push(`- Median cycle time for ${ticket.issueType}: **${est.medianCycleDays.toFixed(1)} days**`);
    lines.push(`- Estimation accuracy: **${Math.round(est.estimationAccuracy * 100)}%**`);
    if (est.pointsToDaysRatio > 0) {
      lines.push(`- Points-to-days ratio: **${est.pointsToDaysRatio.toFixed(1)} days/point**`);
    }
    lines.push("");
  }

  // Rework warning
  if (rework && rework.reopenRate >= 0.15) {
    lines.push(
      `> **Rework alert:** ${rework.component} has a ${Math.round(rework.reopenRate * 100)}% reopen rate (${rework.reopenedTickets}/${rework.totalTickets} tickets). Consider extra review/testing.`,
    );
    lines.push("");
  }

  // Description scaffold
  if (scaffold) {
    lines.push("### Description Template");
    lines.push("");
    lines.push(scaffold.guidance);
    lines.push("");
    lines.push("```markdown");
    lines.push(scaffold.template);
    lines.push("```");
    lines.push("");
    lines.push(`**AC format:** ${scaffold.acFormat}`);
    lines.push("");
  }

  return lines.join("\n");
}
