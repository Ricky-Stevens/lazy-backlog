import { describe, expect, it } from "vitest";
import { analyzeTeamInsights } from "../lib/team-insights.js";
import { businessDaysBetween, extractEstimationInsights } from "../lib/team-insights-estimation.js";
import { extractOwnershipInsights } from "../lib/team-insights-ownership.js";
import { extractPatternInsights } from "../lib/team-insights-patterns.js";
import {
  formatInsightsSection,
  generateDescriptionScaffold,
  generateSmartDefaults,
} from "../lib/team-insights-suggest.js";
import { extractTemplateInsights } from "../lib/team-insights-templates.js";
import type { TicketData } from "../lib/team-rules-types.js";

function makeTicket(overrides: Partial<TicketData> = {}): TicketData {
  return {
    key: "TEST-1",
    summary: "Test ticket",
    description: "",
    issueType: "Story",
    priority: "Medium",
    storyPoints: null,
    labels: [],
    components: [],
    status: "Done",
    assignee: null,
    created: "2025-01-06T10:00:00Z", // Monday
    updated: "2025-01-10T10:00:00Z",
    resolutionDate: "2025-01-10T10:00:00Z", // Friday
    changelog: [],
    ...overrides,
  };
}

// ─── businessDaysBetween ──────────────────────────────────────────────────────

describe("businessDaysBetween", () => {
  it("returns 0 for same timestamp (end <= start)", () => {
    expect(businessDaysBetween("2025-01-06T10:00:00Z", "2025-01-06T10:00:00Z")).toBe(0);
  });

  it("counts Mon-Fri as 5", () => {
    expect(businessDaysBetween("2025-01-06T00:00:00Z", "2025-01-10T00:00:00Z")).toBe(5);
  });

  it("spans weekend: Fri to Mon = 2 (Fri + Mon)", () => {
    expect(businessDaysBetween("2025-01-10T00:00:00Z", "2025-01-13T00:00:00Z")).toBe(2);
  });

  it("full week Mon-Fri = 5", () => {
    expect(businessDaysBetween("2025-01-06T00:00:00Z", "2025-01-10T00:00:00Z")).toBe(5);
  });

  it("returns 0 when end < start", () => {
    expect(businessDaysBetween("2025-01-10T00:00:00Z", "2025-01-06T00:00:00Z")).toBe(0);
  });
});

// ─── extractEstimationInsights ────────────────────────────────────────────────

describe("extractEstimationInsights", () => {
  it("returns per-type insights with correct medianCycleDays", () => {
    const tickets = [
      makeTicket({
        key: "T-1",
        created: "2025-01-06T00:00:00Z",
        resolutionDate: "2025-01-10T00:00:00Z",
        storyPoints: 3,
      }),
      makeTicket({
        key: "T-2",
        created: "2025-01-06T00:00:00Z",
        resolutionDate: "2025-01-08T00:00:00Z",
        storyPoints: 2,
      }),
      makeTicket({
        key: "T-3",
        created: "2025-01-06T00:00:00Z",
        resolutionDate: "2025-01-07T00:00:00Z",
        storyPoints: 1,
      }),
    ];
    const insights = extractEstimationInsights(tickets);
    expect(insights).toHaveLength(1);
    expect(insights[0]?.issueType).toBe("Story");
    expect(insights[0]?.medianCycleDays).toBe(3); // median of [5, 3, 2] = 3
    expect(insights[0]?.sampleSize).toBe(3);
  });

  it("computes pointsToDaysRatio", () => {
    const tickets = [
      makeTicket({
        key: "T-1",
        created: "2025-01-06T00:00:00Z",
        resolutionDate: "2025-01-10T00:00:00Z",
        storyPoints: 5,
      }),
      makeTicket({
        key: "T-2",
        created: "2025-01-06T00:00:00Z",
        resolutionDate: "2025-01-10T00:00:00Z",
        storyPoints: 5,
      }),
      makeTicket({
        key: "T-3",
        created: "2025-01-06T00:00:00Z",
        resolutionDate: "2025-01-10T00:00:00Z",
        storyPoints: 5,
      }),
    ];
    const insights = extractEstimationInsights(tickets);
    // All 5 days / 5 points = 1.0
    expect(insights[0]?.pointsToDaysRatio).toBe(1);
  });

  it("skips tickets without resolutionDate", () => {
    const tickets = [
      makeTicket({ key: "T-1", resolutionDate: null }),
      makeTicket({ key: "T-2", resolutionDate: null }),
      makeTicket({ key: "T-3", resolutionDate: null }),
    ];
    expect(extractEstimationInsights(tickets)).toEqual([]);
  });

  it("requires min 3 samples per type", () => {
    const tickets = [makeTicket({ key: "T-1" }), makeTicket({ key: "T-2" })];
    expect(extractEstimationInsights(tickets)).toEqual([]);
  });
});

// ─── extractOwnershipInsights ─────────────────────────────────────────────────

describe("extractOwnershipInsights", () => {
  it("returns top owners per component sorted by count", () => {
    const tickets = [
      makeTicket({ key: "T-1", assignee: "Alice", components: ["frontend"] }),
      makeTicket({ key: "T-2", assignee: "Alice", components: ["frontend"] }),
      makeTicket({ key: "T-3", assignee: "Bob", components: ["frontend"] }),
    ];
    const insights = extractOwnershipInsights(tickets);
    expect(insights).toHaveLength(1);
    expect(insights[0]?.component).toBe("frontend");
    expect(insights[0]?.owners[0]?.assignee).toBe("Alice");
    expect(insights[0]?.owners[0]?.ticketCount).toBe(2);
  });

  it("computes correct percentages", () => {
    const tickets = [
      makeTicket({ key: "T-1", assignee: "Alice", components: ["api"] }),
      makeTicket({ key: "T-2", assignee: "Alice", components: ["api"] }),
      makeTicket({ key: "T-3", assignee: "Bob", components: ["api"] }),
    ];
    const insights = extractOwnershipInsights(tickets);
    expect(insights[0]?.owners[0]?.percentage).toBeCloseTo(0.67, 1);
    expect(insights[0]?.owners[1]?.percentage).toBeCloseTo(0.33, 1);
  });

  it("skips tickets with no assignee", () => {
    const tickets = [
      makeTicket({ key: "T-1", assignee: null, components: ["frontend"] }),
      makeTicket({ key: "T-2", assignee: null, components: ["frontend"] }),
      makeTicket({ key: "T-3", assignee: null, components: ["frontend"] }),
    ];
    expect(extractOwnershipInsights(tickets)).toEqual([]);
  });

  it("requires min 3 tickets per component", () => {
    const tickets = [
      makeTicket({ key: "T-1", assignee: "Alice", components: ["api"] }),
      makeTicket({ key: "T-2", assignee: "Bob", components: ["api"] }),
    ];
    expect(extractOwnershipInsights(tickets)).toEqual([]);
  });

  it("handles tickets with multiple components", () => {
    const tickets = [
      makeTicket({ key: "T-1", assignee: "Alice", components: ["frontend", "api"] }),
      makeTicket({ key: "T-2", assignee: "Alice", components: ["frontend", "api"] }),
      makeTicket({ key: "T-3", assignee: "Bob", components: ["frontend"] }),
    ];
    const insights = extractOwnershipInsights(tickets);
    const frontend = insights.find((i) => i.component === "frontend");
    expect(frontend).toBeDefined();
    expect(frontend?.sampleSize).toBe(3);
  });
});

// ─── extractTemplateInsights ──────────────────────────────────────────────────

describe("extractTemplateInsights", () => {
  const descWithHeadings = "## Summary\nSome text\n## Acceptance Criteria\n- [ ] First\n- [ ] Second";

  it("extracts markdown headings from descriptions", () => {
    const tickets = Array.from({ length: 5 }, (_, i) => makeTicket({ key: `T-${i}`, description: descWithHeadings }));
    const insights = extractTemplateInsights(tickets);
    expect(insights).toHaveLength(1);
    expect(insights[0]?.headings.length).toBeGreaterThan(0);
    expect(insights[0]?.headings.some((h) => h.text === "summary")).toBe(true);
  });

  it("detects checkbox AC format", () => {
    const tickets = Array.from({ length: 5 }, (_, i) =>
      makeTicket({ key: `T-${i}`, description: "## AC\n- [ ] One\n- [ ] Two\n- [ ] Three" }),
    );
    const insights = extractTemplateInsights(tickets);
    expect(insights[0]?.acFormat).toBe("checkbox");
  });

  it("detects Given/When/Then format", () => {
    const desc = "## AC\nGiven a user\nWhen they click\nThen it works";
    const tickets = Array.from({ length: 5 }, (_, i) => makeTicket({ key: `T-${i}`, description: desc }));
    const insights = extractTemplateInsights(tickets);
    expect(insights[0]?.acFormat).toBe("given-when-then");
  });

  it("builds template skeleton from frequent headings", () => {
    const tickets = Array.from({ length: 5 }, (_, i) => makeTicket({ key: `T-${i}`, description: descWithHeadings }));
    const insights = extractTemplateInsights(tickets);
    expect(insights[0]?.templateSkeleton).toContain("## Summary");
  });

  it("requires min 5 tickets per type", () => {
    const tickets = Array.from({ length: 4 }, (_, i) => makeTicket({ key: `T-${i}`, description: descWithHeadings }));
    expect(extractTemplateInsights(tickets)).toEqual([]);
  });

  it("handles descriptions with no headings", () => {
    const tickets = Array.from({ length: 5 }, (_, i) =>
      makeTicket({ key: `T-${i}`, description: "Just some plain text without headings" }),
    );
    const insights = extractTemplateInsights(tickets);
    expect(insights).toHaveLength(1);
    expect(insights[0]?.headings).toEqual([]);
  });
});

// ─── extractPatternInsights ───────────────────────────────────────────────────

describe("extractPatternInsights", () => {
  it("groups priority distribution by issueType", () => {
    const tickets = [
      makeTicket({ key: "T-1", issueType: "Story", priority: "High" }),
      makeTicket({ key: "T-2", issueType: "Story", priority: "Medium" }),
      makeTicket({ key: "T-3", issueType: "Bug", priority: "High" }),
    ];
    const result = extractPatternInsights(tickets);
    expect(result.priorityDistribution.Story).toEqual({ High: 1, Medium: 1 });
    expect(result.priorityDistribution.Bug).toEqual({ High: 1 });
  });

  it("detects label co-occurrence pairs", () => {
    const tickets = Array.from({ length: 5 }, (_, i) => makeTicket({ key: `T-${i}`, labels: ["frontend", "react"] }));
    const result = extractPatternInsights(tickets);
    expect(result.labelCooccurrence.length).toBeGreaterThan(0);
    const pair = result.labelCooccurrence[0];
    expect([pair?.labelA, pair?.labelB].sort()).toEqual(["frontend", "react"]);
    expect(pair?.cooccurrenceRate).toBe(1); // always together
  });

  it("detects rework: Done -> In Progress counts as reopen", () => {
    const tickets = Array.from({ length: 5 }, (_, i) =>
      makeTicket({
        key: `T-${i}`,
        components: ["api"],
        changelog: [
          { field: "status", from: "In Progress", to: "Done", timestamp: "2025-01-08T00:00:00Z" },
          { field: "status", from: "Done", to: "In Progress", timestamp: "2025-01-09T00:00:00Z" },
        ],
      }),
    );
    const result = extractPatternInsights(tickets);
    const apiRework = result.reworkRates.find((r) => r.component === "api");
    expect(apiRework).toBeDefined();
    expect(apiRework?.reopenRate).toBe(1); // all 5 reopened
    expect(apiRework?.reopenedTickets).toBe(5);
  });

  it("rework rate per component calculated correctly", () => {
    const tickets = [
      // 3 normal + 2 reopened for "api" = 5 total, 40% rework
      ...Array.from({ length: 3 }, (_, i) => makeTicket({ key: `N-${i}`, components: ["api"], changelog: [] })),
      ...Array.from({ length: 2 }, (_, i) =>
        makeTicket({
          key: `R-${i}`,
          components: ["api"],
          changelog: [
            { field: "status", from: "In Progress", to: "Done", timestamp: "2025-01-08T00:00:00Z" },
            { field: "status", from: "Done", to: "In Progress", timestamp: "2025-01-09T00:00:00Z" },
          ],
        }),
      ),
    ];
    const result = extractPatternInsights(tickets);
    const apiRework = result.reworkRates.find((r) => r.component === "api");
    expect(apiRework?.reopenRate).toBe(0.4);
  });
});

// ─── analyzeTeamInsights ──────────────────────────────────────────────────────

describe("analyzeTeamInsights", () => {
  it("returns all four categories", () => {
    const tickets = Array.from({ length: 5 }, (_, i) =>
      makeTicket({ key: `T-${i}`, assignee: "Alice", components: ["ui"], storyPoints: 3 }),
    );
    const result = analyzeTeamInsights(tickets);
    expect(result).toHaveProperty("estimation");
    expect(result).toHaveProperty("ownership");
    expect(result).toHaveProperty("templates");
    expect(result).toHaveProperty("patterns");
  });

  it("handles empty ticket list", () => {
    const result = analyzeTeamInsights([]);
    expect(result.estimation).toEqual([]);
    expect(result.ownership).toEqual([]);
    expect(result.templates).toEqual([]);
    expect(result.patterns.priorityDistribution).toEqual({});
  });
});

// ─── generateSmartDefaults ────────────────────────────────────────────────────

describe("generateSmartDefaults", () => {
  it("suggests assignee from ownership data", () => {
    const ownership = [
      {
        component: "api",
        owners: [{ assignee: "Alice", ticketCount: 10, percentage: 0.7, avgCycleDays: 3 }],
        sampleSize: 14,
      },
    ];
    const defaults = generateSmartDefaults(
      { summary: "New ticket", issueType: "Story", components: ["api"] },
      [],
      ownership,
      { priorityDistribution: {}, labelCooccurrence: [], reworkRates: [] },
    );
    expect(defaults.assignee?.name).toBe("Alice");
  });

  it("suggests story points from estimation data", () => {
    const estimation = [
      {
        issueType: "Story",
        medianCycleDays: 5,
        pointsToDaysRatio: 1,
        estimationAccuracy: 0.8,
        pointsDistribution: { 3: 10, 5: 4 },
        sampleSize: 14,
      },
    ];
    const defaults = generateSmartDefaults({ summary: "New ticket", issueType: "Story" }, estimation, [], {
      priorityDistribution: {},
      labelCooccurrence: [],
      reworkRates: [],
    });
    expect(defaults.storyPoints?.value).toBe(3);
  });

  it("suggests priority from pattern data", () => {
    const patterns = {
      priorityDistribution: { Story: { High: 20, Medium: 5, Low: 2 } },
      labelCooccurrence: [],
      reworkRates: [],
    };
    const defaults = generateSmartDefaults({ summary: "New ticket", issueType: "Story" }, [], [], patterns);
    expect(defaults.priority?.value).toBe("High");
  });

  it("suggests co-occurring labels", () => {
    const patterns = {
      priorityDistribution: {},
      labelCooccurrence: [{ labelA: "frontend", labelB: "react", cooccurrenceRate: 0.8, count: 10 }],
      reworkRates: [],
    };
    const defaults = generateSmartDefaults(
      { summary: "New ticket", issueType: "Story", labels: ["frontend"] },
      [],
      [],
      patterns,
    );
    expect(defaults.labels?.additions).toContain("react");
  });
});

// ─── generateDescriptionScaffold ──────────────────────────────────────────────

describe("generateDescriptionScaffold", () => {
  it("returns null when no template for issue type", () => {
    expect(generateDescriptionScaffold("Story", [])).toBeNull();
  });

  it("returns null when sampleSize < 3", () => {
    const templates = [
      {
        issueType: "Story",
        headings: [],
        acFormat: "none" as const,
        avgAcItems: 0,
        templateSkeleton: "",
        sampleSize: 2,
      },
    ];
    expect(generateDescriptionScaffold("Story", templates)).toBeNull();
  });

  it("returns scaffold with template and guidance", () => {
    const templates = [
      {
        issueType: "Story",
        headings: [{ text: "summary", frequency: 0.8 }],
        acFormat: "checkbox" as const,
        avgAcItems: 3,
        templateSkeleton: "## Summary\n[Describe the summary]",
        sampleSize: 10,
      },
    ];
    const result = generateDescriptionScaffold("Story", templates);
    expect(result).not.toBeNull();
    expect(result?.template).toContain("## Summary");
    expect(result?.acFormat).toContain("[ ]");
  });
});

// ─── formatInsightsSection ────────────────────────────────────────────────────

describe("formatInsightsSection", () => {
  it("returns empty string when no data", () => {
    const result = formatInsightsSection({}, null, [], { summary: "x", issueType: "Story" }, []);
    expect(result).toBe("");
  });

  it("includes risk signal for high rework rates", () => {
    const rework = [{ component: "api", reopenRate: 0.25, totalTickets: 20, reopenedTickets: 5 }];
    const result = formatInsightsSection(
      { storyPoints: { value: 3, reason: "test" } },
      null,
      [],
      { summary: "x", issueType: "Story", components: ["api"] },
      rework,
    );
    expect(result).toContain("Rework alert");
    expect(result).toContain("25%");
  });
});
