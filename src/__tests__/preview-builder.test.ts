import { describe, expect, it } from "vitest";
import type { DuplicateCandidate } from "../lib/duplicate-detect.js";
import type { AppliedConvention } from "../lib/team-rules-format.js";
import type { PreviewData } from "../tools/preview-builder.js";
import { buildBulkPreviewCard, buildPreviewCard } from "../tools/preview-builder.js";

// ── Fixtures ─────────────────────────────────────────────────────────────

function makePreviewData(overrides: Partial<PreviewData> = {}): PreviewData {
  return {
    fields: [
      { label: "Project", value: "PROJ" },
      { label: "Type", value: "Story" },
      { label: "Summary", value: "Add login page" },
    ],
    conventions: [],
    duplicates: [],
    ...overrides,
  };
}

const sampleConventions: AppliedConvention[] = [
  {
    category: "naming_convention",
    label: "Verb-first summary",
    status: "applied",
    confidence: 0.85,
    detail: '"Add..." matches pattern (85% confidence, 42 tickets)',
  },
];

const sampleDuplicates: DuplicateCandidate[] = [
  { issueKey: "PROJ-101", summary: "Create login page", status: "In Progress", similarity: 0.72 },
  { issueKey: "PROJ-55", summary: "Login UI", status: "Done", similarity: 0.45 },
];

// ── buildPreviewCard ─────────────────────────────────────────────────────

describe("buildPreviewCard", () => {
  it("renders field table with all fields", () => {
    const result = buildPreviewCard(makePreviewData());

    expect(result).toContain("# Ticket Preview");
    expect(result).toContain("| Field | Value |");
    expect(result).toContain("| **Project** | PROJ |");
    expect(result).toContain("| **Type** | Story |");
    expect(result).toContain("| **Summary** | Add login page |");
  });

  it("includes description section when provided", () => {
    const result = buildPreviewCard(makePreviewData({ description: "Implement OAuth2 login flow" }));

    expect(result).toContain("## Description");
    expect(result).toContain("Implement OAuth2 login flow");
  });

  it("includes conventions section when conventions array non-empty", () => {
    const result = buildPreviewCard(makePreviewData({ conventions: sampleConventions }));

    expect(result).toContain("## Team Conventions");
    expect(result).toContain("Verb-first summary");
  });

  it("includes duplicates table when duplicates array non-empty", () => {
    const result = buildPreviewCard(makePreviewData({ duplicates: sampleDuplicates }));

    expect(result).toContain("## Potential Duplicates");
    expect(result).toContain("| PROJ-101 | Create login page | In Progress | **72%** |");
    expect(result).toContain("| PROJ-55 | Login UI | Done | **45%** |");
  });

  it("includes KB context when provided", () => {
    const result = buildPreviewCard(makePreviewData({ kbContext: "Auth ADR recommends OAuth2" }));

    expect(result).toContain("## Knowledge Base Context");
    expect(result).toContain("Auth ADR recommends OAuth2");
  });

  it("includes schema guidance when provided", () => {
    const result = buildPreviewCard(makePreviewData({ schemaGuidance: "## Schema\nUse Story type" }));

    expect(result).toContain("## Schema\nUse Story type");
  });

  it("includes field rules when provided", () => {
    const result = buildPreviewCard(makePreviewData({ fieldRules: "## Field Rules\nRequired: summary" }));

    expect(result).toContain("## Field Rules\nRequired: summary");
  });

  it("omits optional sections when data is empty/missing", () => {
    const result = buildPreviewCard(makePreviewData());

    expect(result).not.toContain("## Description");
    expect(result).not.toContain("## Team Conventions");
    expect(result).not.toContain("## Potential Duplicates");
    expect(result).not.toContain("## Knowledge Base Context");
  });

  it("ends with confirmed: true prompt", () => {
    const result = buildPreviewCard(makePreviewData());

    expect(result).toContain("**Confirm?** Set `confirmed: true` to create this ticket.");
  });

  it("separates sections with horizontal rules", () => {
    const result = buildPreviewCard(makePreviewData({ description: "Some description", kbContext: "Some context" }));

    expect(result).toContain("---");
  });
});

// ── buildBulkPreviewCard ─────────────────────────────────────────────────

describe("buildBulkPreviewCard", () => {
  it("renders numbered ticket cards", () => {
    const tickets = [makePreviewData(), makePreviewData({ fields: [{ label: "Summary", value: "Fix bug" }] })];
    const result = buildBulkPreviewCard(tickets);

    expect(result).toContain("### Ticket 1");
    expect(result).toContain("### Ticket 2");
    expect(result).toContain("| **Summary** | Add login page |");
    expect(result).toContain("| **Summary** | Fix bug |");
  });

  it("handles single ticket with singular 'ticket'", () => {
    const result = buildBulkPreviewCard([makePreviewData()]);

    expect(result).toContain("# Bulk Preview (1 ticket)");
    expect(result).toContain("create all 1 ticket.");
  });

  it("handles multiple tickets with plural 'tickets'", () => {
    const result = buildBulkPreviewCard([makePreviewData(), makePreviewData()]);

    expect(result).toContain("# Bulk Preview (2 tickets)");
    expect(result).toContain("create all 2 tickets.");
  });

  it("shows confirm prompt at the end", () => {
    const result = buildBulkPreviewCard([makePreviewData()]);

    expect(result).toContain("**Confirm?** Set `confirmed: true`");
  });

  it("returns empty message for no tickets", () => {
    const result = buildBulkPreviewCard([]);

    expect(result).toContain("No tickets to preview.");
  });

  it("truncates long descriptions in bulk view", () => {
    const longDesc = "A".repeat(400);
    const result = buildBulkPreviewCard([makePreviewData({ description: longDesc })]);

    expect(result).toContain("A".repeat(300));
    expect(result).toContain("...");
    expect(result).not.toContain("A".repeat(400));
  });

  it("shows top duplicate warning inline", () => {
    const result = buildBulkPreviewCard([makePreviewData({ duplicates: sampleDuplicates })]);

    expect(result).toContain("Potential duplicate: **PROJ-101**");
    expect(result).toContain("72% overlap");
  });

  it("includes shared conventions from first ticket that has them", () => {
    const tickets = [makePreviewData(), makePreviewData({ conventions: sampleConventions })];
    const result = buildBulkPreviewCard(tickets);

    expect(result).toContain("## Team Conventions");
  });

  it("includes shared KB context from first ticket that has it", () => {
    const tickets = [makePreviewData(), makePreviewData({ kbContext: "Relevant ADR content" })];
    const result = buildBulkPreviewCard(tickets);

    expect(result).toContain("## Knowledge Base Context");
    expect(result).toContain("Relevant ADR content");
  });
});
