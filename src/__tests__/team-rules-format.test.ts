import { describe, expect, it } from "vitest";
import { type AppliedConvention, evaluateConventions, formatConventionsSection } from "../lib/team-rules-format.js";
import type { TeamRule } from "../lib/team-rules-types.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function first(arr: AppliedConvention[]): AppliedConvention {
  const item = arr[0];
  if (!item) throw new Error("Expected at least one convention");
  return item;
}

function makeRule(overrides: Partial<TeamRule>): TeamRule {
  return {
    category: "naming_convention",
    rule_key: "verb_first_summary",
    issue_type: null,
    rule_value: "true",
    confidence: 0.85,
    sample_size: 50,
    ...overrides,
  };
}

// ─── evaluateConventions ────────────────────────────────────────────────────

describe("evaluateConventions", () => {
  it("returns empty array when no rules provided", () => {
    const result = evaluateConventions({ summary: "Add login page", issueType: "Story" }, []);
    expect(result).toEqual([]);
  });

  describe("naming_convention", () => {
    const namingRule = makeRule({ category: "naming_convention", rule_key: "verb_first_summary" });

    it('returns "applied" for verb-first summary', () => {
      const result = evaluateConventions({ summary: "Add login page", issueType: "Story" }, [namingRule]);
      expect(result).toHaveLength(1);
      expect(first(result).status).toBe("applied");
      expect(first(result).category).toBe("naming_convention");
      expect(first(result).label).toBe("Verb-first summary");
    });

    it('returns "warning" for non-verb-first summary', () => {
      const result = evaluateConventions({ summary: "Login page should be added", issueType: "Story" }, [namingRule]);
      expect(result).toHaveLength(1);
      expect(first(result).status).toBe("warning");
      expect(first(result).detail).toContain("action verb");
    });

    it("filters rules by issue_type when set", () => {
      const typedRule = makeRule({ category: "naming_convention", rule_key: "verb_first_summary", issue_type: "Bug" });
      const result = evaluateConventions({ summary: "Fix crash on login", issueType: "Story" }, [typedRule]);
      expect(result).toEqual([]);
    });
  });

  describe("label_patterns", () => {
    const formatRule = makeRule({
      category: "label_patterns",
      rule_key: "format",
      rule_value: "kebab-case",
      confidence: 0.9,
    });

    it('returns "applied" when all labels match kebab-case', () => {
      const result = evaluateConventions(
        { summary: "Add feature", issueType: "Story", labels: ["tech-debt", "api-v2"] },
        [formatRule],
      );
      expect(result).toHaveLength(1);
      expect(first(result).status).toBe("applied");
      expect(first(result).category).toBe("label_patterns");
    });

    it('returns "warning" for non-kebab-case labels', () => {
      const result = evaluateConventions(
        { summary: "Add feature", issueType: "Story", labels: ["TechDebt", "api-v2"] },
        [formatRule],
      );
      expect(result).toHaveLength(1);
      expect(first(result).status).toBe("warning");
    });

    it("skips when no labels on ticket", () => {
      const result = evaluateConventions({ summary: "Add feature", issueType: "Story" }, [formatRule]);
      expect(result).toEqual([]);
    });
  });

  describe("story_points", () => {
    const fibRule = makeRule({
      category: "story_points",
      rule_key: "scale",
      rule_value: "fibonacci",
      confidence: 0.95,
    });
    const medianRule = makeRule({
      category: "story_points",
      rule_key: "median",
      rule_value: "5",
      confidence: 0.8,
    });

    it('returns "applied" for valid fibonacci value', () => {
      const result = evaluateConventions({ summary: "Add feature", issueType: "Story", storyPoints: 5 }, [fibRule]);
      expect(result).toHaveLength(1);
      expect(first(result).status).toBe("applied");
      expect(first(result).detail).toContain("valid fibonacci");
    });

    it('returns "warning" for non-fibonacci value', () => {
      const result = evaluateConventions({ summary: "Add feature", issueType: "Story", storyPoints: 4 }, [fibRule]);
      expect(result).toHaveLength(1);
      expect(first(result).status).toBe("warning");
      expect(first(result).detail).toContain("not a fibonacci");
    });

    it('returns "info" for median comparison', () => {
      const result = evaluateConventions({ summary: "Add feature", issueType: "Story", storyPoints: 8 }, [medianRule]);
      expect(result).toHaveLength(1);
      expect(first(result).status).toBe("info");
      expect(first(result).detail).toContain("median 5");
    });

    it("skips when storyPoints is undefined", () => {
      const result = evaluateConventions({ summary: "Add feature", issueType: "Story" }, [fibRule, medianRule]);
      expect(result).toEqual([]);
    });
  });

  describe("component_patterns", () => {
    const compRules: TeamRule[] = [
      makeRule({ category: "component_patterns", rule_key: "common", rule_value: "backend", confidence: 0.9 }),
      makeRule({ category: "component_patterns", rule_key: "common", rule_value: "frontend", confidence: 0.85 }),
    ];

    it('returns "applied" when all components are known', () => {
      const result = evaluateConventions(
        { summary: "Add feature", issueType: "Story", components: ["Backend", "Frontend"] },
        compRules,
      );
      expect(result).toHaveLength(1);
      expect(first(result).status).toBe("applied");
      expect(first(result).detail).toBe("All components recognized by team");
    });

    it('returns "warning" for unknown components', () => {
      const result = evaluateConventions(
        { summary: "Add feature", issueType: "Story", components: ["Backend", "Mobile"] },
        compRules,
      );
      expect(result).toHaveLength(1);
      expect(first(result).status).toBe("warning");
      expect(first(result).detail).toContain("Mobile");
    });

    it("skips when no components on ticket", () => {
      const result = evaluateConventions({ summary: "Add feature", issueType: "Story" }, compRules);
      expect(result).toEqual([]);
    });
  });

  describe("description_structure", () => {
    const descRule = makeRule({
      category: "description_structure",
      rule_key: "has_ac",
      rule_value: "true",
      confidence: 0.75,
    });

    it('returns "applied" when description has acceptance criteria', () => {
      const result = evaluateConventions(
        { summary: "Add feature", issueType: "Story", description: "## Acceptance Criteria\n- Login works" },
        [descRule],
      );
      expect(result).toHaveLength(1);
      expect(first(result).status).toBe("applied");
    });

    it('returns "warning" when acceptance criteria missing', () => {
      const result = evaluateConventions(
        { summary: "Add feature", issueType: "Story", description: "Just a plain description" },
        [descRule],
      );
      expect(result).toHaveLength(1);
      expect(first(result).status).toBe("warning");
      expect(first(result).detail).toContain("Missing acceptance criteria");
    });
  });
});

// ─── formatConventionsSection ───────────────────────────────────────────────

describe("formatConventionsSection", () => {
  it("returns empty string for empty array", () => {
    expect(formatConventionsSection([])).toBe("");
  });

  it("formats conventions as markdown table with correct status icons", () => {
    const conventions: AppliedConvention[] = [
      {
        category: "naming_convention",
        label: "Verb-first summary",
        status: "applied",
        confidence: 0.85,
        detail: "Matches pattern",
      },
      {
        category: "story_points",
        label: "Fibonacci points",
        status: "warning",
        confidence: 0.9,
        detail: "4 is not fibonacci",
      },
      { category: "story_points", label: "Team median", status: "info", confidence: 0.8, detail: "4 vs median 5" },
    ];
    const output = formatConventionsSection(conventions);

    expect(output).toContain("## Team Conventions (1 applied, 2 suggestions)");
    expect(output).toContain("| Convention | Status | Detail |");
    expect(output).toContain("| Verb-first summary | \u2705 | Matches pattern |");
    expect(output).toContain("| Fibonacci points | \u26a0\ufe0f | 4 is not fibonacci |");
    expect(output).toContain("| Team median | \u2139\ufe0f | 4 vs median 5 |");
  });

  it("shows correct count with all applied", () => {
    const conventions: AppliedConvention[] = [
      { category: "naming_convention", label: "Verb-first", status: "applied", confidence: 0.9, detail: "OK" },
      { category: "label_patterns", label: "Labels", status: "applied", confidence: 0.8, detail: "OK" },
    ];
    const output = formatConventionsSection(conventions);
    expect(output).toContain("(2 applied, 0 suggestions)");
  });
});
