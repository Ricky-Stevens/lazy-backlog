/**
 * Spec ↔ Ticket loop helpers (Stage D).
 *
 * Pure, side-effect-free functions that:
 *   - format a Confluence spec page as grounding context for ticket creation
 *     (preview cards + `executeCreate`)
 *   - summarise an epic's progress as an "Implementation status" markdown
 *     section that can be written back into the source spec via the
 *     existing Stage C `confluence publish` action
 *   - decide when an epic is "complete" so the freshness loop can flag the
 *     source spec as stale
 *
 * These helpers are intentionally I/O-free so they can be unit-tested in
 * isolation. All Jira/KB/Confluence I/O lives in the calling tools.
 */
import type { IndexedPage } from "./db-types.js";
import { formatPipeTable } from "./pipe-table.js";

/** Maximum chars of a spec page body inlined into a ticket preview. */
export const SPEC_PREVIEW_CHAR_LIMIT = 4_000;

/** A minimal Jira issue shape used by `summariseEpicStatus`. */
export interface EpicChildIssue {
  key: string;
  summary: string;
  statusName: string;
  statusCategory: string;
  storyPoints: number;
}

/** Aggregate progress numbers for an epic. */
export interface EpicProgressSummary {
  total: number;
  done: number;
  inProgress: number;
  todo: number;
  totalPoints: number;
  completedPoints: number;
  remainingPoints: number;
  completionPct: number;
  /** True when 100% of issues are in the "done" status category. */
  isComplete: boolean;
  /** Issues not yet done, in status-then-key order. */
  remaining: Array<{ key: string; summary: string; status: string }>;
}

/**
 * Render the source spec page as a "Source Spec" markdown section to inline
 * into a create-preview. Returns an empty string when no page is provided so
 * the caller can concatenate unconditionally.
 */
export function formatSpecContextSection(page: IndexedPage | undefined): string {
  if (!page) return "";
  const body =
    page.content.length > SPEC_PREVIEW_CHAR_LIMIT
      ? `${page.content.slice(0, SPEC_PREVIEW_CHAR_LIMIT)}\n\n…(truncated — ${page.content.length} chars total)`
      : page.content;

  const meta = [
    `**Source spec:** ${page.title}`,
    `**Page ID:** ${page.id}`,
    page.url ? `**URL:** ${page.url}` : "",
    `**Source:** ${page.source}`,
    `**Type:** ${page.page_type}`,
  ]
    .filter(Boolean)
    .join("  \n");

  return [
    "",
    "## Source Spec",
    "",
    "> Tickets generated below are grounded in this Confluence page.",
    "",
    meta,
    "",
    "### Spec Content",
    "",
    body,
    "",
  ].join("\n");
}

/**
 * Compute aggregate progress numbers for an epic from its child issues.
 *
 * Pure function — no I/O. Callers fetch the issues and shape them into
 * `EpicChildIssue` before calling this.
 */
export function summariseEpicStatus(children: EpicChildIssue[]): EpicProgressSummary {
  let done = 0;
  let inProgress = 0;
  let todo = 0;
  let totalPoints = 0;
  let completedPoints = 0;
  const remaining: EpicProgressSummary["remaining"] = [];

  for (const child of children) {
    totalPoints += child.storyPoints;
    const cat = child.statusCategory.toLowerCase();
    if (cat === "done") {
      done++;
      completedPoints += child.storyPoints;
    } else if (cat === "indeterminate" || cat === "in progress") {
      inProgress++;
      remaining.push({ key: child.key, summary: child.summary, status: child.statusName });
    } else {
      todo++;
      remaining.push({ key: child.key, summary: child.summary, status: child.statusName });
    }
  }

  const total = children.length;
  const completionPct = total > 0 ? Math.round((done / total) * 100) : 0;

  return {
    total,
    done,
    inProgress,
    todo,
    totalPoints,
    completedPoints,
    remainingPoints: totalPoints - completedPoints,
    completionPct,
    isComplete: total > 0 && done === total,
    remaining,
  };
}

/**
 * Build the "Implementation status" markdown section to write back to the
 * source spec. Designed to be fed into `confluence publish` via
 * `markdownToStorage`. Idempotent — produces a stable heading so reruns can
 * be diffed by reviewers.
 */
export function buildSpecStatusSection(
  epicKey: string,
  siteUrl: string,
  summary: EpicProgressSummary,
  options?: { generatedAt?: Date; epicSummary?: string | null },
): string {
  const epicLink = `${siteUrl.replace(/\/$/, "")}/browse/${epicKey}`;
  const stamp = (options?.generatedAt ?? new Date()).toISOString();
  const lines = [
    "## Implementation Status",
    "",
    `> Auto-generated from Jira on ${stamp}. Source of truth: ${epicLink}.`,
    "",
    `- **Epic:** [${epicKey}](${epicLink})${options?.epicSummary ? ` — ${options.epicSummary}` : ""}`,
    `- **Completion:** ${summary.completionPct}% (${summary.done}/${summary.total} issues done)`,
    `- **Story points:** ${summary.completedPoints}/${summary.totalPoints} completed, ${summary.remainingPoints} remaining`,
    `- **In progress:** ${summary.inProgress} | **To do:** ${summary.todo}`,
    "",
  ];

  if (summary.remaining.length > 0) {
    // GEN-10: use the shared pipe-table helper so cells containing `|` or
    // newlines are escaped consistently with the other writers
    // (`adf.ts`, `html-to-markdown.ts`).
    const rows = summary.remaining.map((r) => {
      const link = `${siteUrl.replace(/\/$/, "")}/browse/${r.key}`;
      return [`[${r.key}](${link})`, r.summary, r.status];
    });
    lines.push("### Open Work", "", formatPipeTable(["Key", "Summary", "Status"], rows), "");
  }

  if (summary.isComplete) {
    lines.push("> **Epic complete.** The spec may need an update to reflect what shipped.", "");
  }

  return lines.join("\n");
}

/**
 * Compose the "Source Spec" line appended to a create-confirmation response,
 * showing the URL the new ticket was linked to. Returns "" when no spec was
 * supplied so callers can concatenate unconditionally.
 */
export function formatSpecLinkLine(page: IndexedPage | undefined): string {
  if (!page) return "";
  const target = page.url ? `[${page.title}](${page.url})` : page.title;
  return `\nSource spec: ${target} (page ${page.id})`;
}
