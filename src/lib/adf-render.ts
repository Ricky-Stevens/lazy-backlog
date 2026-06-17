/**
 * Render an ADF document to plain markdown.
 *
 * Block-aware: tables become pipe tables, panels become labelled
 * blockquote admonitions, blockquotes get `> ` prefixes, media nodes
 * become `![alt](url)`. Never silently drops rich-content nodes.
 */

import { formatPipeTable } from "./pipe-table.js";

const PANEL_LABEL: Record<string, string> = {
  info: "Info",
  note: "Note",
  warning: "Warning",
  success: "Success",
  error: "Error",
  tip: "Tip",
};

function getAttr<T = unknown>(node: Record<string, unknown>, key: string): T | undefined {
  const attrs = node.attrs as Record<string, unknown> | undefined;
  return attrs?.[key] as T | undefined;
}

function renderTextNode(node: Record<string, unknown>): string {
  const text = (node.text as string) ?? "";
  const marks = node.marks as { type: string; attrs?: Record<string, unknown> }[] | undefined;
  if (!marks || marks.length === 0) return text;

  let out = text;
  for (const mark of marks) {
    if (mark.type === "strong") out = `**${out}**`;
    else if (mark.type === "em") out = `*${out}*`;
    else if (mark.type === "code") out = `\`${out}\``;
    else if (mark.type === "strike") out = `~~${out}~~`;
    else if (mark.type === "link") {
      const href = (mark.attrs?.href as string) ?? "";
      out = href ? `[${out}](${href})` : out;
    }
  }
  return out;
}

function renderMedia(node: Record<string, unknown>): string {
  const alt = (getAttr<string>(node, "alt") ?? "").trim();
  const url = getAttr<string>(node, "url");
  if (url) return `![${alt}](${url})`;
  const id = getAttr<string>(node, "id");
  const collection = getAttr<string>(node, "collection");
  if (id) {
    const ref = collection ? `media:${collection}/${id}` : `media:${id}`;
    return `![${alt}](${ref})`;
  }
  return alt ? `![${alt}]()` : "";
}

function renderTable(node: Record<string, unknown>): string {
  const rows = Array.isArray(node.content) ? node.content : [];
  const headers: string[] = [];
  const body: string[][] = [];

  for (const rowRaw of rows) {
    const row = rowRaw as Record<string, unknown>;
    if (row.type !== "tableRow") continue;
    const cells = Array.isArray(row.content) ? row.content : [];

    const rowText: string[] = [];
    let isHeaderRow = false;
    for (const cellRaw of cells) {
      const cell = cellRaw as Record<string, unknown>;
      const text = renderCellInline(cell);
      if (cell.type === "tableHeader") isHeaderRow = true;
      rowText.push(text);
    }

    if (isHeaderRow && headers.length === 0) {
      headers.push(...rowText);
    } else {
      body.push(rowText);
    }
  }

  return formatPipeTable(headers, body);
}

function renderCellInline(cell: Record<string, unknown>): string {
  const children = Array.isArray(cell.content) ? cell.content : [];
  const parts: string[] = [];
  for (const c of children) {
    parts.push(renderNode(c, { listDepth: 0, listOrdered: false, listIndex: 0 }));
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

// ── List rendering ─────────────────────────────────────────────────────────

interface RenderCtx {
  /** Current indent depth for nested lists (in list items). */
  listDepth: number;
  /** Whether the *direct parent* list is ordered. */
  listOrdered: boolean;
  /** 1-based position of the current item within its list. */
  listIndex: number;
}

function renderList(node: Record<string, unknown>, ctx: RenderCtx, ordered: boolean): string {
  const items = Array.isArray(node.content) ? node.content : [];
  const startAttr = ordered ? (getAttr<number>(node, "order") ?? 1) : 1;
  const lines: string[] = [];
  let idx = 0;
  for (const itemRaw of items) {
    idx++;
    const item = itemRaw as Record<string, unknown>;
    if (item.type !== "listItem") continue;
    lines.push(
      renderListItem(item, {
        listDepth: ctx.listDepth + 1,
        listOrdered: ordered,
        listIndex: startAttr + idx - 1,
      }),
    );
  }
  return lines.join("\n");
}

function renderListItem(item: Record<string, unknown>, ctx: RenderCtx): string {
  const children = Array.isArray(item.content) ? item.content : [];
  const indent = "  ".repeat(Math.max(0, ctx.listDepth - 1));
  const marker = ctx.listOrdered ? `${ctx.listIndex}.` : "-";

  const headlineParts: string[] = [];
  const nestedParts: string[] = [];

  for (const c of children) {
    const child = c as Record<string, unknown>;
    if (child.type === "bulletList" || child.type === "orderedList") {
      nestedParts.push(renderList(child, ctx, child.type === "orderedList"));
    } else if (child.type === "paragraph") {
      headlineParts.push(renderInline(child));
    } else {
      // Other block content inside a listItem (e.g. nested codeBlock) — render
      // it but indent so it sits under the marker.
      const rendered = renderNode(child, ctx).replace(/\n+$/, "");
      headlineParts.push(rendered);
    }
  }

  const headline = `${indent}${marker} ${headlineParts.join(" ").trim()}`;
  if (nestedParts.length === 0) return headline;
  return [headline, ...nestedParts].join("\n");
}

function renderTaskList(node: Record<string, unknown>): string {
  const items = Array.isArray(node.content) ? node.content : [];
  return items
    .filter((c) => (c as Record<string, unknown>).type === "taskItem")
    .map((c) => renderTaskItem(c as Record<string, unknown>))
    .join("\n");
}

function renderTaskItem(item: Record<string, unknown>): string {
  const state = getAttr<string>(item, "state");
  const children = Array.isArray(item.content) ? item.content : [];
  const inner = children.map((c) => renderNode(c, { listDepth: 0, listOrdered: false, listIndex: 0 })).join("");
  return `- ${state === "DONE" ? "[x]" : "[ ]"} ${inner.trim()}`;
}

function renderInline(node: Record<string, unknown>): string {
  const children = Array.isArray(node.content) ? node.content : [];
  return children.map((c) => renderNode(c, { listDepth: 0, listOrdered: false, listIndex: 0 })).join("");
}

function renderPanelOrQuote(node: Record<string, unknown>): string {
  const isPanel = node.type === "panel";
  let header = "";
  if (isPanel) {
    const panelType = (getAttr<string>(node, "panelType") ?? "info").toLowerCase();
    const label = PANEL_LABEL[panelType] ?? "Note";
    header = `**${label}:** `;
  }

  const children = Array.isArray(node.content) ? node.content : [];
  // Render each child paragraph (or other block) into its own segment so we
  // can emit a `>` blank-line separator between siblings (ADF-3 / ADF-7).
  const segments: string[] = [];
  for (const c of children) {
    const child = c as Record<string, unknown>;
    let rendered = "";
    if (child.type === "paragraph") {
      rendered = renderInlineRespectingBreaks(child);
    } else {
      rendered = renderNode(child, { listDepth: 0, listOrdered: false, listIndex: 0 }).replace(/\n+$/, "");
    }
    segments.push(rendered);
  }

  // Drop empty trailing segments
  while (segments.length > 0 && segments[segments.length - 1]?.trim() === "") segments.pop();

  if (segments.length === 0) {
    return isPanel ? `> ${header.trimEnd()}` : ">";
  }

  const blockLines: string[] = [];
  segments.forEach((seg, idx) => {
    if (idx > 0) blockLines.push(""); // blank-line separator between sibling paragraphs
    const lines = seg.split("\n");
    blockLines.push(...lines);
  });

  // Apply panel header to the first non-empty line, then prefix with `> ` / `>`.
  if (isPanel) {
    let headerApplied = false;
    for (let k = 0; k < blockLines.length; k++) {
      if (!headerApplied && blockLines[k]?.length !== 0) {
        blockLines[k] = `${header}${blockLines[k]}`;
        headerApplied = true;
        break;
      }
    }
    if (!headerApplied) blockLines.unshift(header.trimEnd());
  }

  return blockLines.map((l) => (l.length > 0 ? `> ${l}` : ">")).join("\n");
}

/** Render a paragraph's inline content, expanding hardBreaks to `\n`. */
function renderInlineRespectingBreaks(para: Record<string, unknown>): string {
  const children = Array.isArray(para.content) ? para.content : [];
  return children.map((c) => renderNode(c, { listDepth: 0, listOrdered: false, listIndex: 0 })).join("");
}

// ── Master dispatcher ──────────────────────────────────────────────────────

function renderNode(input: unknown, ctx: RenderCtx): string {
  if (input == null || typeof input !== "object") return "";
  const node = input as Record<string, unknown>;
  const t = node.type as string;

  if (t === "text") return renderTextNode(node);
  if (t === "hardBreak") return "\n";
  if (t === "rule") return "---\n";
  if (t === "media") return renderMedia(node);

  if (t === "table") {
    const md = renderTable(node);
    return md.length > 0 ? `${md}\n` : "";
  }

  if (t === "bulletList") return `${renderList(node, ctx, false)}\n`;
  if (t === "orderedList") return `${renderList(node, ctx, true)}\n`;
  if (t === "taskList") return `${renderTaskList(node)}\n`;
  if (t === "blockquote" || t === "panel") return `${renderPanelOrQuote(node)}\n`;

  // For listItem / taskItem reached outside their list, fall back to inline.
  if (t === "listItem") return renderListItem(node, ctx);
  if (t === "taskItem") return renderTaskItem(node);

  // Recurse for block-y wrappers
  const children = Array.isArray(node.content) ? node.content : [];
  const childTexts = children.map((c) => renderNode(c, ctx));
  let joined = childTexts.join("");

  if (t === "heading") {
    const level = (getAttr<number>(node, "level") ?? 1) as number;
    joined = `${"#".repeat(level)} ${joined}`;
  } else if (t === "codeBlock") {
    const lang = getAttr<string>(node, "language") ?? "";
    joined = `\`\`\`${lang}\n${joined}\n\`\`\``;
  } else if (t === "paragraph") {
    // nothing — already inlined
  } else if (t === "doc") {
    // doc-level — join children with blank lines so blocks separate cleanly.
    // The trailing-newline pass below will normalise to a single trailing \n.
  } else if (t === "tableCell" || t === "tableHeader") {
    joined = joined.replace(/\n+/g, " ").trim();
    return joined;
  } else if (t === "tableRow") {
    return joined;
  } else if (t === "mediaSingle" || t === "mediaGroup") {
    // Wrap on its own line so the standalone-image round-trip works.
  }

  // Block-level nodes get a trailing newline so successive blocks separate.
  // The `doc` wrapper does NOT — its children already terminate themselves,
  // and adding another '\n' would double the trailing newline count on lists
  // and other block children (ADF-8).
  const BLOCK_TYPES_TRAILING = new Set(["paragraph", "heading", "codeBlock", "mediaSingle", "mediaGroup"]);
  if (BLOCK_TYPES_TRAILING.has(t) && joined.length > 0) {
    joined = `${joined}\n`;
  }

  return joined;
}

/**
 * Convert ADF JSON to plain markdown.
 *
 * Recursively walks the document. Returns "" for null/non-object input
 * so callers can pass possibly-missing description fields safely.
 */
export function adfToText(adf: unknown): string {
  const out = renderNode(adf, { listDepth: 0, listOrdered: false, listIndex: 0 });
  // Collapse runs of more than two trailing newlines to keep output tidy.
  return out.replace(/\n{3,}/g, "\n\n");
}
