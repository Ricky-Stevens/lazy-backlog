import type { KnowledgeBase, PageSummary } from "../lib/db.js";
import type { JiraSchema } from "../lib/jira.js";
import type {
  EstimationInsight,
  OwnershipInsight,
  PatternInsight,
  TemplateInsight,
} from "../lib/team-insights-types.js";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Stop words filtered from description when extracting search keywords. */
export const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "shall",
  "should",
  "may",
  "might",
  "can",
  "could",
  "must",
  "to",
  "of",
  "in",
  "for",
  "on",
  "with",
  "at",
  "by",
  "from",
  "as",
  "into",
  "through",
  "during",
  "before",
  "after",
  "above",
  "below",
  "between",
  "out",
  "off",
  "over",
  "under",
  "again",
  "further",
  "then",
  "once",
  "all",
  "each",
  "every",
  "both",
  "few",
  "more",
  "most",
  "other",
  "some",
  "such",
  "no",
  "not",
  "only",
  "same",
  "so",
  "than",
  "too",
  "very",
  "just",
  "because",
  "but",
  "and",
  "or",
  "if",
  "while",
  "that",
  "this",
  "these",
  "those",
  "it",
  "its",
  "set",
  "up",
  "using",
  "via",
  "any",
  "new",
  "create",
  "add",
  "implement",
  "provision",
  "configure",
  "setup",
  "ensure",
  "including",
  "required",
  "necessary",
]);

export const FIELD_RULES = `
## Field Rules

### Summary
- Action-oriented: start with a verb (Add, Fix, Implement, Investigate, Migrate)
- Concise: 5–15 words. No trailing period.
- Include scope: "Add retry logic to ingestion pipeline" not "Add retry logic"

### Description (Markdown → ADF)
Structure every description as:
1. **Context** — Why this work matters (1–2 sentences)
2. **Requirements** — Bullet list of what must be done
3. **Acceptance Criteria** — Checkboxes: \`- [ ] Criterion\`
4. **Technical Notes** — Implementation hints, links to ADRs/designs (optional)

### Issue Types
- **Epic** — Large body of work spanning multiple sprints. Summary = theme, not task.
- **Feature** — User-facing capability. Describe the user value.
- **Task** — Technical work. Be specific about the deliverable.
- **Bug** — Include: steps to reproduce, expected vs actual, environment.
- **Spike** — Time-boxed investigation. State the question and exit criteria.
- **Sub-task** — Must have parentKey. Atomic unit of work (< 1 day).

### Story Points (Fibonacci)
- **1** — Trivial change, < 1 hour
- **2** — Small, well-understood task, < half day
- **3** — Standard task, ~1 day
- **5** — Multi-day, some complexity
- **8** — Large, cross-cutting, ~1 week
- **13** — Very large, consider breaking down

### Priority
- **Showstopper/Critical** — Production down, data loss, security
- **High** — Blocks sprint goal or other work
- **Medium** — Standard sprint work (default)
- **Low/Lowest** — Nice-to-have, backlog grooming
- **Trivial** — Cosmetic, typos

### Labels
- Use kebab-case: \`tech-debt\`, \`customer-facing\`, \`auth0\`, \`infra\`
- Max 3 labels per ticket
`;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Zod preprocess: parse JSON strings into native types (handles buggy LLM clients). */
export const jsonPreprocess = <T>(val: unknown): T => (typeof val === "string" ? JSON.parse(val) : val) as T;

export const boolPreprocess = (val: unknown): boolean => (typeof val === "string" ? val === "true" : val) as boolean;

/** Extract search keywords from a description string. */
export function extractKeywords(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\s,.:;()\-/]+/)
        .map((w) => w.toLowerCase().replaceAll(/[^a-z0-9]/g, ""))
        .filter((w) => w.length > 2 && !STOP_WORDS.has(w)),
    ),
  ];
}

/** Retrieve deep KB context for ticket planning. */
export function retrieveKbContext(kb: KnowledgeBase, description: string, spaceKey?: string) {
  const opts = { spaceKey };

  const adrs = kb.getPageSummaries("adr", spaceKey);
  const designs = kb.getPageSummaries("design", spaceKey);
  const specs = kb.getPageSummaries("spec", spaceKey);

  const keywords = extractKeywords(description);
  const seen = new Set<string>();
  const chunks: Array<{ page_title: string; page_type: string; breadcrumb: string; snippet: string }> = [];

  const addChunks = (
    results: Array<{ page_title: string; page_type: string; breadcrumb?: string; heading?: string; snippet: string }>,
  ) => {
    for (const c of results) {
      const key = `${c.page_title}::${c.breadcrumb || c.heading || ""}`;
      if (!seen.has(key)) {
        seen.add(key);
        chunks.push({
          page_title: c.page_title,
          page_type: c.page_type,
          breadcrumb: c.breadcrumb || c.heading || "",
          snippet: c.snippet,
        });
      }
    }
  };

  for (const kw of keywords) addChunks(kb.searchChunks(kw, { ...opts, limit: 5 }));
  for (let i = 0; i < keywords.length - 1; i++) {
    addChunks(kb.searchChunks(`${keywords[i]} ${keywords[i + 1]}`, { ...opts, limit: 3 }));
  }
  addChunks(kb.searchChunks(description.split(/\s+/).slice(0, 12).join(" "), { ...opts, limit: 10 }));

  return { adrs, designs, specs, chunks };
}

/** Format page summaries as markdown list items. */
export function formatSummaries(pages: PageSummary[], heading: string): string {
  if (pages.length === 0) return "";
  const items = pages.map((p) => `- **${p.title}**: ${p.content_preview.replaceAll("\n", " ").trim()}`).join("\n");
  return `### ${heading} (${pages.length} total)\n${items}\n\n`;
}

/** Format board and general schema info. */
export function formatBoardInfo(schema: JiraSchema): string {
  let out = "";
  if (schema.board) {
    const estimationSuffix = schema.board.estimationField ? ` — estimates in ${schema.board.estimationField}` : "";
    out += `**Board:** ${schema.board.name} (${schema.board.type})${estimationSuffix}\n`;
    if (schema.board.columns) out += `**Workflow:** ${schema.board.columns.map((c) => c.name).join(" → ")}\n`;
  }
  out += `**Priorities:** ${schema.priorities.map((p) => p.name).join(", ")}\n`;
  const typeLabels = schema.issueTypes.map((t) => t.name + (t.subtask ? " [subtask]" : "")).join(", ");
  out += `**Issue Types:** ${typeLabels}\n\n`;
  return out;
}

/** Format the fields list for a specific issue type. */
export function formatFieldsList(ts: JiraSchema["issueTypes"][number], issueType: string): string {
  let out = `## Fields for ${issueType}\n\n`;
  for (const f of ts.fields) {
    const valuesLabel = f.allowedValues?.length ? f.allowedValues.map((v) => `\`${v.name}\``).join(", ") : "";
    const valuesSuffix = valuesLabel ? ` — values: ${valuesLabel}` : "";
    out += `- **${f.name}** [${f.required ? "REQUIRED" : "optional"}]${valuesSuffix}\n`;
  }
  out += `\nPass custom fields via \`namedFields\`: \`{"Field Name": "Value Name"}\`\n`;
  out += `Required fields with allowed values are auto-filled if not provided.\n\n`;
  return out;
}

/** Format sample tickets as conventions. */
export function formatSampleTickets(sampleTickets: NonNullable<JiraSchema["sampleTickets"]>): string {
  let out = `## Conventions (from recent tickets)\n`;
  for (const t of sampleTickets.slice(0, 3)) {
    out += `- ${t.key}: "${t.summary}" [${t.type}, ${t.priority}]\n`;
  }
  out += `\n`;
  return out;
}

/** Build the schema guidance section for the ticket plan. */
export function buildSchemaGuidance(schema: JiraSchema | null, issueType: string): string {
  if (!schema) return `> No Jira schema found. Run \`setup\` or \`discover-jira\` first.\n\n`;

  let plan = formatBoardInfo(schema);

  const ts = schema.issueTypes.find((t) => t.name === issueType);
  if (ts) plan += formatFieldsList(ts, issueType);

  if (schema.sampleTickets?.length) plan += formatSampleTickets(schema.sampleTickets);

  return plan;
}

/** Load parsed team insights from the knowledge base. */
export function loadTeamInsights(kb: KnowledgeBase) {
  const estimation = kb.getInsights("estimation").map((r) => JSON.parse(r.data) as EstimationInsight);
  const ownership = kb.getInsights("ownership").map((r) => JSON.parse(r.data) as OwnershipInsight);
  const templates = kb.getInsights("templates").map((r) => JSON.parse(r.data) as TemplateInsight);
  const patternsRaw = kb.getInsights("patterns");
  const patterns: PatternInsight =
    patternsRaw.length > 0
      ? (JSON.parse(patternsRaw[0]?.data ?? "{}") as PatternInsight)
      : { priorityDistribution: {}, labelCooccurrence: [], reworkRates: [] };
  return { estimation, ownership, templates, patterns };
}

/** Build the KB context section for the ticket plan. */
export function buildKbContextSection(ctx: ReturnType<typeof retrieveKbContext>): string {
  let plan = `## Confluence Context\n\n`;
  plan += `> **IMPORTANT:** You MUST reference relevant ADRs, design docs, and specs in ticket descriptions. Cite specific ADR numbers and technical constraints.\n\n`;
  plan += formatSummaries(ctx.adrs, "ADRs");
  plan += formatSummaries(ctx.designs, "Design Docs");
  plan += formatSummaries(ctx.specs, "Specs");

  if (ctx.chunks.length > 0) {
    plan += `### Targeted Matches (${ctx.chunks.length} relevant sections)\n`;
    for (const c of ctx.chunks.slice(0, 25)) {
      plan += `- **${c.page_title}** > ${c.breadcrumb} [${c.page_type}]: ${c.snippet}\n`;
    }
    plan += `\n`;
  }

  if (!ctx.adrs.length && !ctx.designs.length && !ctx.chunks.length) {
    plan += `> No Confluence context found. Spider a space first.\n\n`;
  }

  return plan;
}
