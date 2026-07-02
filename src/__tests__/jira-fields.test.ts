import { describe, expect, it } from "vitest";
import { autoFillRequired } from "../lib/jira-fields.js";
import type { JiraSchema } from "../lib/jira-types.js";

const TEAM_FIELD = "customfield_10001";
const TEAM_ID = "84f72150-15b1-4a1c-bc93-fae422839ca5";

function schemaWithTeam(): JiraSchema {
  return {
    projectKey: "BP",
    projectName: "Brand Protection",
    boardId: "101",
    priorities: [{ id: "3", name: "Medium" }],
    issueTypes: [
      { id: "1", name: "Task", subtask: false, fields: [], requiredFields: [] },
      { id: "5", name: "Sub-task", subtask: true, fields: [], requiredFields: [] },
    ],
    board: {
      name: "Team Dexter",
      type: "scrum",
      teamFieldId: TEAM_FIELD,
      teamId: TEAM_ID,
    },
  };
}

describe("autoFillRequired — board Team injection", () => {
  it("injects the board Team for a non-sub-task issue type", () => {
    const fields: Record<string, unknown> = {};
    autoFillRequired(schemaWithTeam(), fields, "Task");
    expect(fields[TEAM_FIELD]).toBe(TEAM_ID);
  });

  it("does NOT inject the board Team for a sub-task (it inherits from the parent)", () => {
    const fields: Record<string, unknown> = {};
    autoFillRequired(schemaWithTeam(), fields, "Sub-task");
    expect(fields[TEAM_FIELD]).toBeUndefined();
  });

  it("does NOT inject the board Team when the subtask flag is missing (unvalidated legacy schema)", () => {
    const schema = schemaWithTeam();
    // Simulate a persisted schema loaded via JSON.parse with no normalisation.
    delete (schema.issueTypes[1] as { subtask?: boolean }).subtask;
    const fields: Record<string, unknown> = {};
    autoFillRequired(schema, fields, "Sub-task");
    expect(fields[TEAM_FIELD]).toBeUndefined();
  });

  it("does not overwrite a Team value that was already set", () => {
    const fields: Record<string, unknown> = { [TEAM_FIELD]: "explicit-team" };
    autoFillRequired(schemaWithTeam(), fields, "Task");
    expect(fields[TEAM_FIELD]).toBe("explicit-team");
  });

  it("is a no-op when the board has no team configured", () => {
    const schema = schemaWithTeam();
    schema.board = { name: "Team Dexter", type: "scrum" };
    const fields: Record<string, unknown> = {};
    autoFillRequired(schema, fields, "Task");
    expect(fields[TEAM_FIELD]).toBeUndefined();
  });
});
