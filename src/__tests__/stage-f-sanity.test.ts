// Stage F — Hardening, Docs & Deep Sanity Check
//
// Cross-cutting wiring + documentation assertions. These tests guard against
// regressions in the 8-tool / 25-action contract, tool description budget,
// suggestions coverage for the new flows (attachments, publish, spec→ticket,
// status write-back), and the README/CLAUDE.md count documentation.
//
// The tests deliberately assert on observable behaviour (registered tools,
// rendered suggestion strings) rather than implementation internals.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { z } from "zod";
import { KnowledgeBase } from "../lib/db.js";
import { registerBacklogTool } from "../tools/backlog.js";
import { registerBugsTool } from "../tools/bugs.js";
import { registerConfigureTool } from "../tools/configure.js";
import { registerConfluenceTool } from "../tools/confluence.js";
import { registerInsightsTool } from "../tools/insights.js";
import { registerIssuesTool } from "../tools/issues.js";
import { registerKnowledgeTool } from "../tools/knowledge.js";
import { registerSprintsTool } from "../tools/sprints.js";
import { buildSuggestions } from "../tools/suggestions.js";
import { createMockServer } from "./helpers/mock-server.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Rough token estimate. The MCP runtime sees these descriptions as text the
// model has to read on every request — keeping it conservative (~chars/4)
// matches OpenAI/Anthropic-style BPE in the safe direction.
function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// Pull the string set out of any of the Zod action declarations the project uses:
// z.enum([...]), z.literal("x"), or a union of literals. Tolerates Zod returning
// either an array or a Set for `.options` across minor versions.
function extractActions(node: z.ZodTypeAny): string[] {
  const anyNode = node as unknown as {
    _def?: { typeName?: string; values?: unknown; value?: unknown; options?: unknown };
    options?: unknown;
    value?: unknown;
  };
  const def = anyNode._def;
  if (!def) return [];

  if (def.typeName === "ZodLiteral" || "value" in (anyNode as object)) {
    const v = anyNode.value ?? def.value;
    return typeof v === "string" ? [v] : [];
  }

  const rawOpts = anyNode.options ?? def.options ?? def.values;
  if (rawOpts instanceof Set) return [...(rawOpts as Set<string>)];
  if (Array.isArray(rawOpts)) {
    // Could be ['a','b'] or [ZodLiteral, ZodLiteral, ...] (union of literals).
    return rawOpts.flatMap((entry) => (typeof entry === "string" ? [entry] : extractActions(entry as z.ZodTypeAny)));
  }
  return [];
}

// ── 8 tools / 25 actions contract ────────────────────────────────────────────

describe("Stage F — 8 tools / 25 actions contract", () => {
  let kb: KnowledgeBase;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "lb-stage-f-"));
    kb = new KnowledgeBase(join(tmpDir, "test.db"));
  });

  afterEach(() => {
    kb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("registers exactly 8 MCP tools", () => {
    const { server, toolNames } = createMockServer();
    const getKb = () => kb;

    registerConfigureTool(server, getKb);
    registerConfluenceTool(server, getKb);
    registerKnowledgeTool(server, getKb);
    registerInsightsTool(server, getKb);
    registerBacklogTool(server, getKb);
    registerBugsTool(server, getKb);
    registerIssuesTool(server, getKb);
    registerSprintsTool(server, getKb);

    expect(toolNames()).toEqual([
      "configure",
      "confluence",
      "knowledge",
      "insights",
      "backlog",
      "bugs",
      "issues",
      "sprints",
    ]);
  });

  it("exposes exactly 25 actions across all tools (with publish on confluence)", () => {
    const { server, getToolMetadata } = createMockServer();
    const getKb = () => kb;

    registerConfigureTool(server, getKb);
    registerConfluenceTool(server, getKb);
    registerKnowledgeTool(server, getKb);
    registerInsightsTool(server, getKb);
    registerBacklogTool(server, getKb);
    registerBugsTool(server, getKb);
    registerIssuesTool(server, getKb);
    registerSprintsTool(server, getKb);

    const expected: Record<string, string[]> = {
      configure: ["setup", "set", "get"],
      confluence: ["spider", "list-spaces", "publish"],
      knowledge: ["search", "stats", "get-page"],
      insights: ["team-profile", "epic-progress", "retro", "plan"],
      backlog: ["list", "rank"],
      bugs: ["triage"],
      issues: ["get", "create", "update", "search"],
      sprints: ["list", "get", "create", "update", "move-issues"],
    };

    let total = 0;
    for (const [toolName, expectedActions] of Object.entries(expected)) {
      const meta = getToolMetadata(toolName);
      const schema = meta.inputSchema as z.ZodObject<z.ZodRawShape>;
      const actionField = schema.shape.action as z.ZodTypeAny;
      const actualActions = extractActions(actionField);
      // Order-independent comparison — Zod versions may return Set vs Array.
      expect([...actualActions].sort(), `${toolName} actions`).toEqual([...expectedActions].sort());
      total += expectedActions.length;
    }

    expect(total).toBe(25);
  });

  it("every tool description is at most 150 tokens (approx)", () => {
    const { server, getToolMetadata } = createMockServer();
    const getKb = () => kb;

    registerConfigureTool(server, getKb);
    registerConfluenceTool(server, getKb);
    registerKnowledgeTool(server, getKb);
    registerInsightsTool(server, getKb);
    registerBacklogTool(server, getKb);
    registerBugsTool(server, getKb);
    registerIssuesTool(server, getKb);
    registerSprintsTool(server, getKb);

    const tools = ["configure", "confluence", "knowledge", "insights", "backlog", "bugs", "issues", "sprints"];
    for (const name of tools) {
      const meta = getToolMetadata(name);
      expect(meta.description, `${name} description is non-empty`).toBeTruthy();
      const tokens = approxTokens(meta.description);
      expect(tokens, `${name} description (~${tokens} tokens)`).toBeLessThanOrEqual(150);
    }
  });

  it("tool descriptions cross-reference sibling tools for disambiguation", () => {
    const { server, getToolMetadata } = createMockServer();
    const getKb = () => kb;
    registerConfluenceTool(server, getKb);
    registerKnowledgeTool(server, getKb);
    registerSprintsTool(server, getKb);
    registerInsightsTool(server, getKb);
    registerIssuesTool(server, getKb);
    registerBacklogTool(server, getKb);
    registerBugsTool(server, getKb);

    // Confluence write-back must point read-back queries at `knowledge`.
    expect(getToolMetadata("confluence").description).toMatch(/knowledge/);
    // `sprints` must defer analytics to `insights`.
    expect(getToolMetadata("sprints").description).toMatch(/insights/);
    // `insights` should point CRUD at `issues`.
    expect(getToolMetadata("insights").description).toMatch(/issues/);
    // `backlog` should defer JQL to `issues`.
    expect(getToolMetadata("backlog").description).toMatch(/issues/);
    // `bugs` must point general CRUD at `issues`.
    expect(getToolMetadata("bugs").description).toMatch(/issues/);
    // `issues` must point spec write-back at `confluence publish`.
    expect(getToolMetadata("issues").description).toMatch(/confluence publish/);
  });

  it("publish action is registered and discoverable on the confluence tool", () => {
    const { server, getToolMetadata } = createMockServer();
    registerConfluenceTool(server, () => kb);
    const meta = getToolMetadata("confluence");
    expect(meta.description.toLowerCase()).toContain("publish");

    const schema = meta.inputSchema as z.ZodObject<z.ZodRawShape>;
    const actionField = schema.shape.action as z.ZodTypeAny;
    const actions = extractActions(actionField);
    expect(actions).toContain("publish");

    // The publish flow's gating params must be advertised on the schema.
    expect(Object.keys(schema.shape)).toEqual(
      expect.arrayContaining(["spaceKey", "pageId", "title", "content", "parentId", "confirm"]),
    );
  });
});

// ── buildSuggestions coverage for Stage A–D flows ────────────────────────────

describe("Stage F — suggestions coverage", () => {
  it("issues get with attachments suggests downloading them locally", () => {
    const suggestions = buildSuggestions("issues", "get", { hasAttachments: true, downloaded: false });
    expect(suggestions).toMatch(/download/i);
    expect(suggestions).toMatch(/download=true/);
  });

  it("issues get with downloaded=true does NOT suggest re-downloading", () => {
    const suggestions = buildSuggestions("issues", "get", { hasAttachments: true, downloaded: true });
    expect(suggestions).not.toMatch(/Download attachments/);
  });

  it("issues create with attachments suggests verifying the upload", () => {
    const suggestions = buildSuggestions("issues", "create", { confirmed: true, hasAttachments: true });
    expect(suggestions).toMatch(/uploaded attachments/i);
  });

  it("issues create with sourcePageId suggests publishing status back", () => {
    const suggestions = buildSuggestions("issues", "create", { confirmed: true, hasSourceSpec: true });
    expect(suggestions).toMatch(/confluence publish/);
    expect(suggestions).toMatch(/epic-progress/);
  });

  it("knowledge get-page with attachments suggests downloading them", () => {
    const suggestions = buildSuggestions("knowledge", "get-page", { attachmentCount: 3, downloaded: false });
    expect(suggestions).toMatch(/download=true/);
  });

  it("knowledge get-page with hasMore=true suggests pagination", () => {
    const suggestions = buildSuggestions("knowledge", "get-page", { totalPages: 3, hasMore: true });
    expect(suggestions).toMatch(/page=N\+1/);
  });

  it("confluence publish preview suggests the confirm follow-up", () => {
    const suggestions = buildSuggestions("confluence", "publish", { confirmed: false });
    expect(suggestions).toMatch(/confirm: true/);
  });

  it("confluence publish confirmed-create suggests re-indexing the new page", () => {
    const suggestions = buildSuggestions("confluence", "publish", { confirmed: true, isUpdate: false });
    expect(suggestions).toMatch(/confluence spider/);
  });

  it("confluence publish confirmed-update suggests refreshing the KB copy", () => {
    const suggestions = buildSuggestions("confluence", "publish", { confirmed: true, isUpdate: true });
    expect(suggestions).toMatch(/confluence spider/);
  });

  it("insights epic-progress with hasSpecLink suggests confluence publish write-back", () => {
    const suggestions = buildSuggestions("insights", "epic-progress", { hasSpecLink: true });
    expect(suggestions).toMatch(/confluence publish/);
    expect(suggestions).toMatch(/pageId/);
  });

  it("insights epic-progress with epicComplete + hasSpecLink suggests freshness update", () => {
    const suggestions = buildSuggestions("insights", "epic-progress", {
      epicComplete: true,
      hasSpecLink: true,
      behindSchedule: false,
    });
    expect(suggestions).toMatch(/update the spec/i);
  });
});

// ── README / CLAUDE.md documentation contract ────────────────────────────────

describe("Stage F — documentation contract", () => {
  it("README documents 8 tools, 25 actions and the new publish action", () => {
    const readme = readFileSync(join(REPO_ROOT, "README.md"), "utf-8");
    expect(readme).toMatch(/8 tools, 25 actions/);
    expect(readme).toMatch(/publish/);
    expect(readme).toMatch(/Preview-and-confirm/i);
    // Download config key must be documented.
    expect(readme).toMatch(/downloadDir/);
    // Rich content fidelity section.
    expect(readme).toMatch(/Rich Content Fidelity/i);
    // Spec→ticket loop documented.
    expect(readme).toMatch(/Spec.*Ticket/i);
    // Content-hash sync surfaced.
    expect(readme).toMatch(/[Cc]ontent.?[Hh]ash/);
  });

  it("CLAUDE.md is updated to 8 tools / 25 actions with the publish action and downloadDir key", () => {
    const claude = readFileSync(join(REPO_ROOT, "CLAUDE.md"), "utf-8");
    expect(claude).toMatch(/8 (MCP )?[Tt]ools.*25 [Aa]ctions/);
    expect(claude).toMatch(/publish/);
    expect(claude).toMatch(/downloadDir/);
  });
});
