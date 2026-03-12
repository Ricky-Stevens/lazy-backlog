/**
 * Team conventions evaluation and formatting.
 *
 * Evaluates a proposed ticket against learned team rules and produces
 * a structured list of applied conventions with a markdown table output.
 */

import type { TeamRule } from "./team-rules-types.js";

// ─── Types ──────────────────────────────────────────────────────────────────────

export interface AppliedConvention {
  category: string;
  label: string;
  status: "applied" | "warning" | "info";
  confidence: number;
  detail: string;
}

interface TicketInput {
  summary: string;
  description?: string;
  issueType: string;
  labels?: string[];
  storyPoints?: number;
  components?: string[];
}

// ─── Helpers ────────────────────────────────────────────────────────────────────

const ACTION_VERB_RE =
  /^(add|fix|implement|create|update|remove|migrate|refactor|investigate|design|build|enable|disable|configure|deploy|test|integrate|optimize|extract)\b/i;

function rulesForCategory(rules: TeamRule[], category: string, issueType?: string): TeamRule[] {
  return rules.filter((r) => r.category === category && (r.issue_type === null || r.issue_type === issueType));
}

function findRule(rules: TeamRule[], category: string, key: string, issueType?: string): TeamRule | undefined {
  return rules.find(
    (r) => r.category === category && r.rule_key === key && (r.issue_type === null || r.issue_type === issueType),
  );
}

function ruleSuffix(rule: TeamRule): string {
  const parts: string[] = [];
  if (rule.confidence > 0) parts.push(`${Math.round(rule.confidence * 100)}% confidence`);
  if (rule.sample_size > 0) parts.push(`${rule.sample_size} tickets`);
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

// ─── Evaluators ─────────────────────────────────────────────────────────────────

function evalNaming(ticket: TicketInput, rules: TeamRule[]): AppliedConvention[] {
  const conventions: AppliedConvention[] = [];
  const rule = findRule(rules, "naming_convention", "verb_first_summary", ticket.issueType);
  if (!rule) return conventions;

  const matches = ACTION_VERB_RE.test(ticket.summary.trim());
  conventions.push({
    category: "naming_convention",
    label: "Verb-first summary",
    status: matches ? "applied" : "warning",
    confidence: rule.confidence,
    detail: matches
      ? `"${ticket.summary.split(/\s+/)[0]}..." matches pattern${ruleSuffix(rule)}`
      : `Summary should start with an action verb${ruleSuffix(rule)}`,
  });
  return conventions;
}

function evalLabels(ticket: TicketInput, rules: TeamRule[]): AppliedConvention[] {
  const conventions: AppliedConvention[] = [];
  const labelRules = rulesForCategory(rules, "label_patterns", ticket.issueType);
  if (labelRules.length === 0 || !ticket.labels?.length) return conventions;

  const formatRule = findRule(rules, "label_patterns", "format", ticket.issueType);
  if (formatRule) {
    const pattern = formatRule.rule_value; // e.g. "kebab-case"
    const allMatch = ticket.labels.every((l) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(l));
    conventions.push({
      category: "label_patterns",
      label: `${pattern} labels`,
      status: allMatch ? "applied" : "warning",
      confidence: formatRule.confidence,
      detail: allMatch
        ? `\`${ticket.labels.join("`, `")}\` follow convention${ruleSuffix(formatRule)}`
        : `Labels should use ${pattern}${ruleSuffix(formatRule)}`,
    });
  }
  return conventions;
}

function evalPoints(ticket: TicketInput, rules: TeamRule[]): AppliedConvention[] {
  const conventions: AppliedConvention[] = [];
  if (ticket.storyPoints == null) return conventions;

  const fibRule = findRule(rules, "story_points", "scale", ticket.issueType);
  const medianRule = findRule(rules, "story_points", "median", ticket.issueType);

  if (fibRule) {
    const scale = fibRule.rule_value; // e.g. "fibonacci"
    const validValues = new Set([1, 2, 3, 5, 8, 13, 21]);
    const isValid = validValues.has(ticket.storyPoints);
    conventions.push({
      category: "story_points",
      label: `${scale.charAt(0).toUpperCase() + scale.slice(1)} points`,
      status: isValid ? "applied" : "warning",
      confidence: fibRule.confidence,
      detail: isValid
        ? `${ticket.storyPoints} is a valid ${scale} value${ruleSuffix(fibRule)}`
        : `${ticket.storyPoints} is not a ${scale} value${ruleSuffix(fibRule)}`,
    });
  }

  if (medianRule) {
    const median = Number(medianRule.rule_value);
    if (!Number.isNaN(median)) {
      conventions.push({
        category: "story_points",
        label: "Team median points",
        status: "info",
        confidence: medianRule.confidence,
        detail: `${ticket.storyPoints} vs team median ${median} for ${ticket.issueType}s${ruleSuffix(medianRule)}`,
      });
    }
  }
  return conventions;
}

function evalComponents(ticket: TicketInput, rules: TeamRule[]): AppliedConvention[] {
  const conventions: AppliedConvention[] = [];
  if (!ticket.components?.length) return conventions;

  const compRules = rulesForCategory(rules, "component_patterns", ticket.issueType);
  const knownComponents = new Set(
    compRules.filter((r) => r.rule_key === "common").map((r) => r.rule_value.toLowerCase()),
  );

  if (knownComponents.size === 0) return conventions;

  const unrecognized = ticket.components.filter((c) => !knownComponents.has(c.toLowerCase()));
  conventions.push({
    category: "component_patterns",
    label: "Known components",
    status: unrecognized.length === 0 ? "applied" : "warning",
    confidence: Math.max(...compRules.map((r) => r.confidence), 0),
    detail:
      unrecognized.length === 0 ? `All components recognized by team` : `Unrecognized: ${unrecognized.join(", ")}`,
  });
  return conventions;
}

function evalDescription(ticket: TicketInput, rules: TeamRule[]): AppliedConvention[] {
  const conventions: AppliedConvention[] = [];
  const rule = findRule(rules, "description_structure", "has_ac", ticket.issueType);
  if (!rule) return conventions;

  const desc = ticket.description ?? "";
  const hasAC = /acceptance\s*criteria|AC:|given\s.*when\s.*then/i.test(desc);
  conventions.push({
    category: "description_structure",
    label: "Description structure",
    status: hasAC ? "applied" : "warning",
    confidence: rule.confidence,
    detail: hasAC
      ? `Includes acceptance criteria section${ruleSuffix(rule)}`
      : `Missing acceptance criteria section${ruleSuffix(rule)}`,
  });
  return conventions;
}

// ─── Public API ─────────────────────────────────────────────────────────────────

/** Evaluate a proposed ticket against team rules and return applied conventions. */
export function evaluateConventions(ticket: TicketInput, rules: TeamRule[]): AppliedConvention[] {
  return [
    ...evalNaming(ticket, rules),
    ...evalLabels(ticket, rules),
    ...evalPoints(ticket, rules),
    ...evalComponents(ticket, rules),
    ...evalDescription(ticket, rules),
  ];
}

/** Format conventions as a markdown table section. */
export function formatConventionsSection(conventions: AppliedConvention[]): string {
  if (conventions.length === 0) return "";

  const applied = conventions.filter((c) => c.status === "applied").length;
  const suggestions = conventions.length - applied;

  const statusIcon = (s: AppliedConvention["status"]): string =>
    s === "applied" ? "\u2705" : s === "warning" ? "\u26a0\ufe0f" : "\u2139\ufe0f";

  const lines: string[] = [
    `## Team Conventions (${applied} applied, ${suggestions} suggestions)`,
    "",
    "| Convention | Status | Detail |",
    "|------------|--------|--------|",
  ];

  for (const c of conventions) {
    lines.push(`| ${c.label} | ${statusIcon(c.status)} | ${c.detail} |`);
  }

  return lines.join("\n");
}
