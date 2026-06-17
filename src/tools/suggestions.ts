// ── Contextual Suggestions ──────────────────────────────────────────────────
// Appended to tool responses to guide users toward logical next actions.
// ~130 lines. No side effects — pure string output.

// ── Types ───────────────────────────────────────────────────────────────────

interface SuggestionRule {
  tool: string;
  action: string;
  condition: (ctx: Record<string, unknown>) => boolean;
  text: string;
}

// ── Rules ───────────────────────────────────────────────────────────────────

const RULES: SuggestionRule[] = [
  // backlog list
  {
    tool: "backlog",
    action: "list",
    condition: (ctx) => (ctx.orphanedCount as number) > 0,
    text: "Assign parent epics to orphaned items \u2192 `issues update`",
  },
  {
    tool: "backlog",
    action: "list",
    condition: (ctx) => (ctx.unestimatedCount as number) > 0,
    text: "Add story points to unestimated items \u2192 `issues update`",
  },

  // bugs triage
  {
    tool: "bugs",
    action: "triage",
    condition: (ctx) => (ctx.triageCount as number) > 0,
    text: "Apply recommended changes \u2192 `issues update` or move to sprint \u2192 `sprints move-issues`",
  },

  // issues create (confirmed)
  {
    tool: "issues",
    action: "create",
    condition: (ctx) => ctx.confirmed === true,
    text: "Add to sprint \u2192 `sprints move-issues` or rank in backlog \u2192 `backlog rank`",
  },

  // issues get
  {
    tool: "issues",
    action: "get",
    condition: (ctx) => ctx.hasMissingFields === true,
    text: "Fill in missing fields \u2192 `issues update`",
  },
  {
    tool: "issues",
    action: "get",
    condition: (ctx) => ctx.hasAttachments === true && ctx.downloaded !== true,
    text: "Download attachments locally \u2192 `issues get` with `download=true`",
  },

  // issues create (with attachments)
  {
    tool: "issues",
    action: "create",
    condition: (ctx) => ctx.confirmed === true && ctx.hasAttachments === true,
    text: "Verify uploaded attachments \u2192 `issues get` for the new ticket",
  },

  // issues create (spec-grounded \u2014 Stage D)
  {
    tool: "issues",
    action: "create",
    condition: (ctx) => ctx.confirmed === true && ctx.hasSourceSpec === true,
    text: "Publish implementation status back to the source spec \u2192 `insights epic-progress` then `confluence publish`",
  },

  // issues search
  {
    tool: "issues",
    action: "search",
    condition: (ctx) => (ctx.resultCount as number) > 0,
    text: "View full details \u2192 `issues get`",
  },

  // sprints get
  {
    tool: "sprints",
    action: "get",
    condition: (ctx) => (ctx.blockerCount as number) > 0,
    text: "Triage blocked items \u2192 `bugs triage` or view details \u2192 `issues get`",
  },
  {
    tool: "sprints",
    action: "get",
    condition: (ctx) => (ctx.healthScore as number) < 70,
    text: "Run retrospective for deeper analysis \u2192 `insights retro`",
  },
  {
    tool: "sprints",
    action: "get",
    condition: (ctx) => (ctx.carryoverCount as number) > 0,
    text: "Review carry-over items and re-prioritize \u2192 `backlog list`",
  },
  {
    tool: "sprints",
    action: "get",
    condition: (ctx) => ctx.isClosedSprint === true,
    text: "Run retrospective on this sprint \u2192 `insights retro`",
  },

  // insights retro
  {
    tool: "insights",
    action: "retro",
    condition: () => true,
    text: "Review backlog priorities \u2192 `backlog list`",
  },

  // insights epic-progress
  {
    tool: "insights",
    action: "epic-progress",
    condition: (ctx) => ctx.behindSchedule === true,
    text: "Review backlog priorities \u2192 `backlog list`",
  },

  // insights epic-progress (spec write-back \u2014 Stage D2)
  {
    tool: "insights",
    action: "epic-progress",
    condition: (ctx) => ctx.hasSpecLink === true,
    text: "Publish status back to the source spec \u2192 `confluence publish` with `pageId` from the spec link",
  },

  // insights epic-progress (freshness loop \u2014 Stage D3)
  {
    tool: "insights",
    action: "epic-progress",
    condition: (ctx) => ctx.epicComplete === true && ctx.hasSpecLink === true,
    text: "Epic complete \u2014 update the spec to match what shipped \u2192 `confluence publish`",
  },

  // knowledge stats
  {
    tool: "knowledge",
    action: "stats",
    condition: (ctx) => (ctx.staleCount as number) > 0,
    text: "Re-index stale content \u2192 `confluence spider`",
  },

  // knowledge get-page
  {
    tool: "knowledge",
    action: "get-page",
    condition: (ctx) => (ctx.attachmentCount as number) > 0 && ctx.downloaded !== true,
    text: "Download page attachments locally \u2192 `knowledge get-page` with `download=true`",
  },
  {
    tool: "knowledge",
    action: "get-page",
    condition: (ctx) => (ctx.totalPages as number) > 1 && (ctx.hasMore as boolean) === true,
    text: "Fetch the next chunk \u2192 `knowledge get-page` with `page=N+1`",
  },

  // configure setup
  {
    tool: "configure",
    action: "setup",
    condition: () => true,
    text: "View your backlog \u2192 `backlog list` or search docs \u2192 `knowledge search`",
  },

  // confluence publish (preview)
  {
    tool: "confluence",
    action: "publish",
    condition: (ctx) => ctx.confirmed === false,
    text: "Apply the publish \u2192 re-run `confluence publish` with `confirm: true`",
  },
  // confluence publish (confirmed create)
  {
    tool: "confluence",
    action: "publish",
    condition: (ctx) => ctx.confirmed === true && ctx.isUpdate === false,
    text: "Re-index the new page \u2192 `confluence spider` or browse it \u2192 `knowledge get-page`",
  },
  // confluence publish (confirmed update)
  {
    tool: "confluence",
    action: "publish",
    condition: (ctx) => ctx.confirmed === true && ctx.isUpdate === true,
    text: "Refresh the KB copy \u2192 `confluence spider` or view it \u2192 `knowledge get-page`",
  },
];

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Build contextual "next steps" suggestions based on what was found.
 * Returns a markdown block to append, or empty string if nothing applies.
 */
export function buildSuggestions(tool: string, action: string, context: Record<string, unknown>): string {
  const matching = RULES.filter((r) => r.tool === tool && r.action === action && r.condition(context));
  if (matching.length === 0) return "";

  const lines = matching.map((r) => `\u2022 ${r.text}`).join("\n");
  return `\n\n---\n**Next steps:**\n${lines}`;
}
