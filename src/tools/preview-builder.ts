/**
 * Structured preview card builder for ticket creation flows.
 *
 * Produces rich markdown previews that include field tables, description,
 * team conventions, KB context, and duplicate warnings.
 */

import type { DuplicateCandidate } from "../lib/duplicate-detect.js";
import type { AppliedConvention } from "../lib/team-rules-format.js";
import { formatConventionsSection } from "../lib/team-rules-format.js";

// ─── Types ──────────────────────────────────────────────────────────────────────

export interface PreviewData {
  fields: Array<{ label: string; value: string }>;
  description?: string;
  conventions: AppliedConvention[];
  kbContext?: string;
  duplicates: DuplicateCandidate[];
  schemaGuidance?: string;
  fieldRules?: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────────

function buildFieldsTable(fields: Array<{ label: string; value: string }>): string {
  if (fields.length === 0) return "";

  const lines: string[] = ["| Field | Value |", "|-------|-------|"];

  for (const f of fields) {
    lines.push(`| **${f.label}** | ${f.value} |`);
  }

  return lines.join("\n");
}

function buildDuplicatesSection(duplicates: DuplicateCandidate[]): string {
  if (duplicates.length === 0) return "";

  const lines: string[] = [
    "## Potential Duplicates",
    "",
    "| Key | Summary | Status | Overlap |",
    "|-----|---------|--------|---------|",
  ];

  for (const d of duplicates) {
    const pct = Math.round(d.similarity * 100);
    lines.push(`| ${d.issueKey} | ${d.summary} | ${d.status} | **${pct}%** |`);
  }

  lines.push("");
  lines.push("> \u26a0\ufe0f Review these before confirming. Use `issues action=get issueKey=<KEY>` to inspect.");

  return lines.join("\n");
}

function separator(): string {
  return "\n\n---\n\n";
}

// ─── Public API ─────────────────────────────────────────────────────────────────

/** Build a full preview card for a single ticket. */
export function buildPreviewCard(data: PreviewData): string {
  const sections: string[] = ["# Ticket Preview"];

  // Fields table
  if (data.fields.length > 0) {
    sections.push(buildFieldsTable(data.fields));
  }

  // Description
  if (data.description) {
    sections.push(`## Description\n\n${data.description}`);
  }

  // Schema guidance
  if (data.schemaGuidance) {
    sections.push(data.schemaGuidance);
  }

  // Field rules
  if (data.fieldRules) {
    sections.push(data.fieldRules);
  }

  // Team conventions
  const conventionsText = formatConventionsSection(data.conventions);
  if (conventionsText) {
    sections.push(conventionsText);
  }

  // KB context
  if (data.kbContext) {
    sections.push(`## Knowledge Base Context\n\n${data.kbContext}`);
  }

  // Duplicates
  const duplicatesText = buildDuplicatesSection(data.duplicates);
  if (duplicatesText) {
    sections.push(duplicatesText);
  }

  // Confirm prompt
  sections.push("**Confirm?** Set `confirmed: true` to create this ticket.");

  return sections.join(separator());
}

/** Build a compact bulk preview card for multiple tickets. */
export function buildBulkPreviewCard(tickets: PreviewData[]): string {
  if (tickets.length === 0) return "# Bulk Preview\n\nNo tickets to preview.";

  const plural = tickets.length === 1 ? "ticket" : "tickets";
  const sections: string[] = [`# Bulk Preview (${tickets.length} ${plural})`];

  for (const [i, data] of tickets.entries()) {
    const ticketLines: string[] = [`### Ticket ${i + 1}`];

    // Compact fields table
    if (data.fields.length > 0) {
      ticketLines.push("");
      ticketLines.push(buildFieldsTable(data.fields));
    }

    // Description (truncated for bulk)
    if (data.description) {
      const truncated = data.description.length > 300 ? `${data.description.slice(0, 300)}...` : data.description;
      ticketLines.push("");
      ticketLines.push(`**Description:** ${truncated}`);
    }

    // Duplicates warning (inline for bulk)
    const topDupe = data.duplicates[0];
    if (topDupe) {
      const pct = Math.round(topDupe.similarity * 100);
      ticketLines.push("");
      ticketLines.push(
        `> \u26a0\ufe0f Potential duplicate: **${topDupe.issueKey}** — ${topDupe.summary} (${pct}% overlap)`,
      );
    }

    sections.push(ticketLines.join("\n"));
  }

  // Shared conventions section (from first ticket that has them)
  const firstWithConventions = tickets.find((t) => t.conventions.length > 0);
  if (firstWithConventions) {
    const conventionsText = formatConventionsSection(firstWithConventions.conventions);
    if (conventionsText) {
      sections.push(conventionsText);
    }
  }

  // Shared KB context (from first ticket that has it)
  const firstWithKb = tickets.find((t) => t.kbContext);
  if (firstWithKb?.kbContext) {
    sections.push(`## Knowledge Base Context\n\n${firstWithKb.kbContext}`);
  }

  // Shared schema guidance
  const firstWithSchema = tickets.find((t) => t.schemaGuidance);
  if (firstWithSchema?.schemaGuidance) {
    sections.push(firstWithSchema.schemaGuidance);
  }

  // Shared field rules
  const firstWithRules = tickets.find((t) => t.fieldRules);
  if (firstWithRules?.fieldRules) {
    sections.push(firstWithRules.fieldRules);
  }

  // Confirm prompt
  sections.push(`**Confirm?** Set \`confirmed: true\` to create all ${tickets.length} ${plural}.`);

  return sections.join(separator());
}
