/**
 * Schema-driven field resolution helpers for JiraClient.
 *
 * Pulled out of jira.ts to keep that file under the 400-line cap. These
 * helpers are deliberately pure / schema-only — they never make HTTP calls.
 */

import type { FieldResolvable, JiraFieldSchema, JiraSchema } from "./jira-types.js";

export function resolveFieldId(schema: JiraSchema | null, fieldName: string, issueType?: string): string | null {
  if (!schema) return null;
  const types = issueType ? schema.issueTypes.filter((t) => t.name === issueType) : schema.issueTypes;
  for (const t of types) {
    const field = t.fields.find((f) => f.name === fieldName);
    if (field) return field.id;
  }
  return null;
}

export function findFieldSchema(
  schema: JiraSchema | null,
  fieldName: string,
  issueType: string,
): JiraFieldSchema | null {
  if (!schema) return null;
  const ts = schema.issueTypes.find((t) => t.name === issueType);
  return ts?.fields.find((f) => f.name === fieldName || f.id === fieldName) || null;
}

export function resolveCustomFields(
  schema: JiraSchema | null,
  fields: Record<string, unknown>,
  input: FieldResolvable,
  issueType: string,
): void {
  if (input.storyPoints != null) {
    const id = resolveFieldId(schema, "Story Points", issueType);
    fields[id || "story_points"] = input.storyPoints;
  }
  if (input.components?.length) {
    const allowed = findFieldSchema(schema, "components", issueType)?.allowedValues || [];
    fields.components = input.components.map((name) => {
      const match = allowed.find((v) => v.name.toLowerCase() === name.toLowerCase());
      return match ? { id: match.id } : { name };
    });
  }
  if (input.namedFields) resolveNamedFields(schema, fields, input.namedFields, issueType);
}

export function resolveNamedFields(
  schema: JiraSchema | null,
  fields: Record<string, unknown>,
  namedFields: Record<string, string | null>,
  issueType: string,
): void {
  for (const [fieldName, valueName] of Object.entries(namedFields)) {
    const fs = findFieldSchema(schema, fieldName, issueType);
    if (!fs) continue;
    if (valueName === null) {
      fields[fs.id] = null;
      continue;
    }
    if (fs.allowedValues?.length) {
      const match = fs.allowedValues.find((v) => v.name.toLowerCase().includes(valueName.toLowerCase()));
      if (match) fields[fs.id] = { id: match.id };
    } else {
      fields[fs.id] = valueName;
    }
  }
}

export function autoFillRequired(schema: JiraSchema | null, fields: Record<string, unknown>, issueType: string): void {
  if (!schema) return;
  const ts = schema.issueTypes.find((t) => t.name === issueType);
  if (!ts) return;
  const SYSTEM = new Set(["project", "issuetype", "summary", "parent", "issueType"]);
  for (const field of ts.fields) {
    if (!field.required || SYSTEM.has(field.system || field.id) || fields[field.id] !== undefined) continue;
    if (field.allowedValues?.length) fields[field.id] = { id: field.allowedValues[0]?.id };
  }
  // Sub-tasks inherit their Team from the parent; Jira rejects an explicit Team
  // on a sub-task ("... is a subtask, and inherits the team assignment from its
  // parent"). Inject the board Team only when the schema explicitly marks the type
  // as not a sub-task. Team is optional, so an unvalidated legacy schema missing the
  // subtask flag safely skips the default rather than risking a sub-task failure.
  if (ts.subtask === false && schema.board?.teamId && schema.board.teamFieldId) {
    if (fields[schema.board.teamFieldId] === undefined) {
      fields[schema.board.teamFieldId] = schema.board.teamId;
    }
  }
}

export function buildFieldGuide(schema: JiraSchema | null, issueType: string): string | null {
  if (!schema) return null;
  const ts = schema.issueTypes.find((t) => t.name === issueType);
  if (!ts) return null;
  const lines = [`## Fields for ${issueType}\n`];
  for (const f of ts.fields) {
    let line = `- **${f.name}** (${f.id}) [${f.type}] — ${f.required ? "**REQUIRED**" : "optional"}`;
    if (f.allowedValues?.length) {
      const vals = f.allowedValues.map((v) => `\`${v.name}\``).join(", ");
      line += `\n  Values: ${vals}`;
    }
    lines.push(line);
  }
  return lines.join("\n");
}
