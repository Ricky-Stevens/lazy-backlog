/**
 * Knowledge base dashboard / stats handler.
 *
 * Split out of knowledge.ts to keep both files under the 400-line cap. Pure
 * presentation logic — no side effects other than KB reads.
 */

import { textResponse } from "../lib/config.js";
import type { KnowledgeBase, PageSummary } from "../lib/db.js";
import { loadSchemaFromDb } from "../lib/jira-schema.js";
import { buildSuggestions } from "./suggestions.js";

export const MAX_CONTEXT_CHARS = 20_000;
const STALE_CUTOFF_DAYS = 90;
const RECENT_DAYS = 7;

type ToolResponse = { content: { type: "text"; text: string }[]; isError?: boolean };

export function appendSection(
  pages: PageSummary[],
  heading: string,
  maxItems: number,
  budget: number,
  emit: (s: string) => void,
): number {
  if (pages.length === 0 || budget <= 0) return budget;

  const header = `## ${heading} (${pages.length})\n\n`;
  emit(header);
  budget -= header.length;

  const items = pages.slice(0, maxItems);
  for (let i = 0; i < items.length; i++) {
    if (budget <= 100) {
      emit(`…and ${pages.length - i} more\n\n`);
      break;
    }
    const p = items[i];
    if (!p) continue;
    const entry = `### ${p.title}\n${p.content_preview.trim()}\n\n`;
    emit(entry);
    budget -= entry.length;
  }
  return budget;
}

function buildCoverageGaps(kb: KnowledgeBase, byType: Record<string, number>): string[] {
  const gaps: string[] = [];
  if (!byType.adr) gaps.push("No ADRs indexed — consider documenting architectural decisions.");
  if (!byType.runbook) gaps.push("No runbooks indexed — consider documenting operational procedures.");

  const schema = loadSchemaFromDb(kb);
  if (schema) {
    const components = new Set<string>();
    for (const issueType of schema.issueTypes) {
      const compField = issueType.fields.find((f) => f.id === "components");
      for (const v of compField?.allowedValues ?? []) components.add(v.name);
    }
    if (components.size > 0) {
      const undocumented: string[] = [];
      for (const comp of components) {
        const results = kb.search(comp, { limit: 1 });
        if (results.length === 0) undocumented.push(comp);
      }
      if (undocumented.length > 0) {
        gaps.push(`No documentation found for components: ${undocumented.join(", ")}.`);
      }
    }
  }
  return gaps;
}

function appendContextSummary(out: string, adrs: PageSummary[], designs: PageSummary[], specs: PageSummary[]): string {
  if (adrs.length === 0 && designs.length === 0 && specs.length === 0) return out;
  let result = `${out}\n\n---\n\n# Context Summary\n\n`;
  let budget = MAX_CONTEXT_CHARS - result.length;

  budget = appendSection(adrs, "ADRs", 20, budget, (s) => {
    result += s;
  });
  budget = appendSection(designs, "Design Docs", 10, budget, (s) => {
    result += s;
  });
  appendSection(specs, "Specs", 10, budget, (s) => {
    result += s;
  });
  return result;
}

export function handleStats(
  params: { source?: string; spaceKey?: string; pageType?: string },
  kb: KnowledgeBase,
): ToolResponse {
  const stats = kb.getStats();
  if (stats.total === 0) return textResponse("Knowledge base is empty.");

  const types = Object.entries(stats.byType)
    .map(([k, v]) => `  ${k}: ${v}`)
    .join("\n");
  const spaces = Object.entries(stats.bySpace)
    .map(([k, v]) => `  ${k}: ${v}`)
    .join("\n");

  let out = `# Knowledge Base Dashboard\n\n`;
  out += `**Total pages:** ${stats.total}\n\n`;
  out += `By type:\n${types}\n\nBy space:\n${spaces}`;

  if (stats.bySource) {
    const sources = Object.entries(stats.bySource)
      .map(([k, v]) => `  ${k}: ${v}`)
      .join("\n");
    out += `\n\nBy source:\n${sources}`;
  }

  try {
    const gaps = buildCoverageGaps(kb, stats.byType);
    if (gaps.length > 0) {
      out += `\n\n**Coverage Gaps:**\n${gaps.map((g) => `- ${g}`).join("\n")}`;
    }
  } catch {
    /* graceful: skip coverage gap detection */
  }

  const adrs = kb.getPageSummaries("adr", params.spaceKey, params.source);
  const designs = kb.getPageSummaries("design", params.spaceKey, params.source);
  const specs = kb.getPageSummaries("spec", params.spaceKey, params.source);
  out = appendContextSummary(out, adrs, designs, specs);

  const recentCutoff = new Date();
  recentCutoff.setDate(recentCutoff.getDate() - RECENT_DAYS);
  const recentPages = kb.getRecentlyIndexed(recentCutoff.toISOString(), params.source);

  if (recentPages.length > 0) {
    out += `\n\n---\n\n## Recent Changes (last ${RECENT_DAYS} days): ${recentPages.length}\n\n`;
    const shown = recentPages.slice(0, 10);
    for (const p of shown) {
      out += `- **${p.title}** (${p.space_key}) [${p.page_type}] indexed ${p.indexed_at.slice(0, 10)}\n`;
    }
    if (recentPages.length > 10) {
      out += `…and ${recentPages.length - 10} more\n`;
    }
  } else {
    out += `\n\n---\n\n## Recent Changes (last ${RECENT_DAYS} days): none\n`;
  }

  const staleCutoff = new Date();
  staleCutoff.setDate(staleCutoff.getDate() - STALE_CUTOFF_DAYS);
  const stalePages = kb.getStalePages(staleCutoff.toISOString(), {
    spaceKey: params.spaceKey,
    pageType: params.pageType,
    source: params.source,
  });

  if (stalePages.length > 0) {
    out += `\n## Stale Docs (>${STALE_CUTOFF_DAYS} days): ${stalePages.length}\n\n`;
    const top5 = stalePages.slice(0, 5);
    for (const p of top5) {
      const daysAgo = Math.floor(
        (Date.now() - new Date(p.updated_at ?? p.indexed_at).getTime()) / (1000 * 60 * 60 * 24),
      );
      out += `- **${p.title}** (${p.space_key}) [${p.page_type}] — ${daysAgo}d ago\n`;
    }
    if (stalePages.length > 5) {
      out += `…and ${stalePages.length - 5} more\n`;
    }
  }

  const freshCount = stats.total - stalePages.length;
  const freshPct = Math.round((freshCount / stats.total) * 100);
  let health: string;
  if (freshPct > 80) health = "healthy";
  else if (freshPct >= 50) health = "needs-attention";
  else health = "stale";
  out += `\n## KB Health: **${health}** (${freshPct}% of pages updated within ${STALE_CUTOFF_DAYS} days)\n`;

  const suggestions = buildSuggestions("knowledge", "stats", { staleCount: stalePages.length });
  return textResponse(out + suggestions);
}
