/**
 * Atlassian Document Format (ADF) builder — converts markdown to ADF and back.
 *
 * Splits:
 *  - `adf-types.ts`  — discriminated union of node types
 *  - `adf-inline.ts` — inline parsing (text, marks, links, images, code)
 *  - `adf-render.ts` — ADF → markdown via `adfToText`
 *  - `pipe-table.ts` — GFM pipe-table helpers (shared with html-to-markdown)
 *
 * This file owns the block-level markdown → ADF parser and barrel-re-exports
 * the surface so existing imports (`from "./adf.js"`) keep working.
 */

import {
  findBalancedBracket,
  imageNode,
  type ParseCtx,
  paragraphNode as paragraph,
  parseInline,
  textNode,
} from "./adf-inline.js";
import type { AdfNode, AdfPanelType } from "./adf-types.js";
import { findBalancedUrlEnd } from "./markdown-to-storage-inline.js";
import { parsePipeTable } from "./pipe-table.js";

export { adfToText } from "./adf-render.js";
export type { AdfMark, AdfNode, AdfPanelType } from "./adf-types.js";

// ── Block-level parsing ──────────────────────────────────────────────────────

/** Try to parse a heading line into an ADF heading node. */
function parseHeading(line: string, ctx: ParseCtx): AdfNode | null {
  const headingRe = /^(#{1,6})\s+(.+)/;
  const hm = headingRe.exec(line);
  if (!hm) return null;
  return { type: "heading", attrs: { level: hm[1]?.length ?? 1 }, content: parseInline(hm[2] ?? "", ctx) };
}

/** Parse a fenced code block starting at index `i`. Returns the node and the new index. */
function parseCodeBlock(lines: string[], i: number): { node: AdfNode; next: number } {
  const lang = lines[i]?.slice(3).trim() || undefined;
  const codeLines: string[] = [];
  i++;
  while (i < lines.length && !lines[i]?.startsWith("```")) {
    codeLines.push(lines[i] ?? "");
    i++;
  }
  i++;
  const node = {
    type: "codeBlock",
    ...(lang ? { attrs: { language: lang } } : {}),
    content: [textNode(codeLines.join("\n"))],
  } as AdfNode;
  return { node, next: i };
}

const taskItemRe = /^[-*]\s\[([ xX])]\s/;

function parseTaskList(lines: string[], i: number, ctx: ParseCtx): { node: AdfNode; next: number } {
  const items: AdfNode[] = [];
  while (i < lines.length && taskItemRe.test(lines[i] ?? "")) {
    const line = lines[i] ?? "";
    const m = taskItemRe.exec(line);
    const state = m?.[1] === " " ? "TODO" : "DONE";
    const text = line.replace(taskItemRe, "");
    items.push({
      type: "taskItem",
      attrs: { localId: ctx.nextTaskId(), state },
      content: parseInline(text, ctx),
    });
    i++;
  }
  const listId = ctx.nextTaskId();
  return { node: { type: "taskList", attrs: { localId: listId }, content: items }, next: i };
}

function indentLevel(line: string): number {
  // Normalise tabs to 4 spaces before counting indent depth (ADF-6).
  const m = /^([ \t]*)/.exec(line);
  const indent = m?.[1] ?? "";
  let n = 0;
  for (const ch of indent) n += ch === "\t" ? 4 : 1;
  return n;
}

function detectListItem(line: string): { listType: "bulletList" | "orderedList"; text: string } | null {
  const stripped = line.replace(/^[ \t]+/, "");
  const bullet = /^[-*]\s(.*)/.exec(stripped);
  if (bullet) return { listType: "bulletList", text: bullet[1] ?? "" };
  const ordered = /^\d+\.\s(.*)/.exec(stripped);
  if (ordered) return { listType: "orderedList", text: ordered[1] ?? "" };
  return null;
}

function parseList(lines: string[], i: number, baseIndent: number, ctx: ParseCtx): { node: AdfNode; next: number } {
  const firstItem = detectListItem(lines[i] ?? "");
  const listType = firstItem?.listType ?? "bulletList";
  const items: AdfNode[] = [];

  while (i < lines.length) {
    const line = lines[i] ?? "";
    const indent = indentLevel(line);

    if (indent < baseIndent) break;
    if (indent === baseIndent) {
      const item = detectListItem(line);
      if (!item) break;

      const itemContent: AdfNode[] = [paragraph(item.text, ctx)];

      i++;
      if (i < lines.length && detectListItem(lines[i] ?? "") && indentLevel(lines[i] ?? "") > baseIndent) {
        const nested = parseList(lines, i, indentLevel(lines[i] ?? ""), ctx);
        itemContent.push(nested.node);
        i = nested.next;
      }

      items.push({ type: "listItem", content: itemContent });
      continue;
    }

    i++;
  }

  return { node: { type: listType, content: items }, next: i };
}

// ── Blockquote + panel parsing ───────────────────────────────────────────────

const ADMONITION_RE = /^\*\*(Info|Note|Warning|Success|Error|Tip):\*\*\s*(.*)$/i;

const ADMONITION_TYPE: Record<string, AdfPanelType> = {
  info: "info",
  note: "note",
  warning: "warning",
  success: "success",
  error: "error",
  // Tip has no ADF panelType; closest distinct analogue is "success".
  // adf-render maps it back to a `> **Tip:**` label so the round-trip is
  // preserved on the ADF side.
  tip: "success",
};

/**
 * Parse a contiguous run of `>`-prefixed lines into either an ADF
 * `panel` (if it starts with a `**Note:**`-style admonition) or a
 * plain `blockquote`. Strips one leading `> ` per line.
 */
function parseBlockquote(lines: string[], i: number, ctx: ParseCtx): { node: AdfNode; next: number } {
  const body: string[] = [];
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (!/^>\s?/.test(line)) break;
    body.push(line.replace(/^>\s?/, ""));
    i++;
  }

  // Trim trailing blank lines inside the quote
  while (body.length > 0 && body[body.length - 1]?.trim() === "") body.pop();

  if (body.length === 0) {
    // Empty-body admonition emits an empty paragraph rather than a
    // whitespace-only text node (ADF-9).
    return { node: { type: "blockquote", content: [{ type: "paragraph", content: [] }] }, next: i };
  }

  const firstLine = body[0] ?? "";
  const admon = ADMONITION_RE.exec(firstLine);
  if (admon) {
    const panelType = ADMONITION_TYPE[admon[1]?.toLowerCase() ?? "info"] ?? "info";
    const remainder = (admon[2] ?? "").trim();
    const rest = body.slice(1);
    const paragraphs = packParagraphs(remainder ? [remainder, ...rest] : rest, ctx);
    return {
      node: { type: "panel", attrs: { panelType }, content: paragraphs },
      next: i,
    };
  }

  return { node: { type: "blockquote", content: packParagraphs(body, ctx) }, next: i };
}

/**
 * Pack a list of text lines into ADF paragraphs, breaking on blank lines.
 *
 * Adjacent non-blank lines are joined with a hardBreak so multi-line content
 * survives the round-trip (was joined with a space — ADF-3).
 *
 * Always returns at least one paragraph so the node is well-formed (empty
 * paragraph has `content: []` rather than a whitespace text node — ADF-9).
 */
function packParagraphs(lines: string[], ctx: ParseCtx): AdfNode[] {
  const out: AdfNode[] = [];
  let buf: string[] = [];
  const flush = () => {
    if (buf.length === 0) return;
    const content: AdfNode[] = [];
    for (let j = 0; j < buf.length; j++) {
      if (j > 0) content.push({ type: "hardBreak" });
      content.push(...parseInline(buf[j] ?? "", ctx));
    }
    out.push({ type: "paragraph", content });
    buf = [];
  };
  for (const line of lines) {
    if (line.trim() === "") {
      flush();
      continue;
    }
    buf.push(line);
  }
  flush();
  if (out.length === 0) out.push({ type: "paragraph", content: [] });
  return out;
}

// ── Pipe tables → ADF table ──────────────────────────────────────────────────

function buildTableCell(rawCell: string, isHeader: boolean, ctx: ParseCtx): AdfNode {
  // Cell content is treated as a single paragraph of inline content.
  // Unescape `\|` (already handled by splitPipeRow). Honour `<br>` as a soft break.
  const segments = rawCell.split(/<br\s*\/?>/i);
  const paragraphs: AdfNode[] = segments.map((s) => paragraph(s.trim(), ctx));
  return isHeader ? { type: "tableHeader", content: paragraphs } : { type: "tableCell", content: paragraphs };
}

function parseTable(lines: string[], i: number, ctx: ParseCtx): { node: AdfNode; next: number } | null {
  const parsed = parsePipeTable(lines, i);
  if (!parsed) return null;
  const { headers, rows, next } = parsed;

  const tableRows: AdfNode[] = [];
  if (headers.length > 0) {
    tableRows.push({
      type: "tableRow",
      content: headers.map((c) => buildTableCell(c, true, ctx)),
    });
  }
  for (const row of rows) {
    tableRows.push({
      type: "tableRow",
      content: row.map((c) => buildTableCell(c, false, ctx)),
    });
  }

  return { node: { type: "table", content: tableRows }, next };
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Convert markdown-ish text to an ADF document node. */
export function markdownToAdf(md: string): Extract<AdfNode, { type: "doc" }> {
  // Per-document task counter (was module-global — `adf` finding).
  let taskCounter = 0;
  const ctx: ParseCtx = {
    nextTaskId: () => `task-${++taskCounter}`,
  };

  // Normalise literal \n sequences (common from AI clients double-escaping newlines)
  const normalised = md.replaceAll(String.raw`\n`, "\n");
  const lines = normalised.split("\n");
  const content: AdfNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";

    // Headings
    const heading = parseHeading(line, ctx);
    if (heading) {
      content.push(heading);
      i++;
      continue;
    }

    // Horizontal rule
    if (/^---+$/.test(line.trim())) {
      content.push({ type: "rule" });
      i++;
      continue;
    }

    // Code block
    if (line.startsWith("```")) {
      const result = parseCodeBlock(lines, i);
      content.push(result.node);
      i = result.next;
      continue;
    }

    // Blockquote / panel (must precede generic paragraph handling)
    if (/^>\s?/.test(line)) {
      const result = parseBlockquote(lines, i, ctx);
      content.push(result.node);
      i = result.next;
      continue;
    }

    // Pipe table — needs lookahead at the separator line
    const tableResult = parseTable(lines, i, ctx);
    if (tableResult) {
      content.push(tableResult.node);
      i = tableResult.next;
      continue;
    }

    // Task list (must check before bullet list since `- [ ]` also matches `[-*]\s`)
    if (taskItemRe.test(line)) {
      const result = parseTaskList(lines, i, ctx);
      content.push(result.node);
      i = result.next;
      continue;
    }

    // Bullet or ordered list
    if (detectListItem(line)) {
      const result = parseList(lines, i, 0, ctx);
      content.push(result.node);
      i = result.next;
      continue;
    }

    // Empty line — skip
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Standalone image on its own line → wrap in a mediaSingle for fidelity.
    // mediaSingle requires attrs.layout per the ADF schema (ADF-4 / ADV-ADF-9).
    const standaloneImage = matchStandaloneImage(line.trim());
    if (standaloneImage) {
      const media = imageNode(standaloneImage.alt, standaloneImage.url);
      if (media.type === "media") {
        content.push({ type: "mediaSingle", attrs: { layout: "center" }, content: [media] });
      } else {
        content.push(paragraph(line, ctx));
      }
      i++;
      continue;
    }

    // Regular paragraph
    content.push(paragraph(line, ctx));
    i++;
  }

  return { type: "doc", version: 1, content };
}

/** Match a whole-line `![alt](url)` where `url` may contain balanced parens. */
function matchStandaloneImage(line: string): { alt: string; url: string } | null {
  if (!line.startsWith("![")) return null;
  const labelEnd = findBalancedBracket(line, 1);
  if (labelEnd === -1 || line[labelEnd + 1] !== "(") return null;
  const urlEnd = findBalancedUrlEnd(line, labelEnd + 2);
  if (urlEnd === -1) return null;
  // Must be the *entire* line.
  if (urlEnd !== line.length - 1) return null;
  return {
    alt: line.slice(2, labelEnd),
    url: line.slice(labelEnd + 2, urlEnd).trim(),
  };
}
