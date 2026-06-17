/**
 * Markdown → Confluence storage-format XHTML converter.
 *
 * Inverse of `html-to-markdown.ts`. Used by `confluence publish` to write
 * pages from markdown produced elsewhere in the system (or written by a
 * human/LLM).
 *
 * The output is hand-crafted XHTML targeting the subset Confluence's
 * storage format understands:
 *   - Headings:        <h1>..<h6>
 *   - Inline marks:    <strong>, <em>, <code>
 *   - Links:           <a href="...">
 *   - Lists:           <ul>/<ol>/<li> (nested)
 *   - Fenced code:     <ac:structured-macro ac:name="code"> with language param
 *   - Tables:          <table><tbody>… header row inside <tbody>
 *   - Blockquotes:     <blockquote>
 *   - Admonitions:     <ac:structured-macro ac:name="info|note|warning|tip">
 *   - Images:          <ac:image><ri:url|ri:attachment .../></ac:image>
 *
 * **Security invariant:** `<script>`, `<style>`, and `on*=` event handlers
 * embedded in the source markdown are stripped during inline rendering.
 * Inline-code spans and fenced code blocks are exempt from sanitisation —
 * their content is meant to display literally, and CDATA / `<code>` keep it
 * inert. `javascript:`, `vbscript:`, `data:`, `file:` (etc.) URLs in links
 * are replaced with `#` by the allow-list `safeHref`.
 *
 * Inline parsing and sanitisation live in `markdown-to-storage-inline.ts`;
 * this file owns block-level parsing only.
 */

import { escapeXml, renderInline } from "./markdown-to-storage-inline.js";
import { parsePipeTable } from "./pipe-table.js";

// ── Re-exports (barrel) ───────────────────────────────────────────────────

export { escapeAttr, escapeXml, renderInline, safeHref, stripDangerous } from "./markdown-to-storage-inline.js";

// ── Block-level helpers ───────────────────────────────────────────────────

/**
 * Look up an admonition macro name from a blockquote prefix.
 *
 * Supports both:
 *   - GFM: `> [!NOTE]`, `> [!WARNING]`, `> [!TIP]`, `> [!INFO]`, etc.
 *   - Prose: `> **Note:** …`, `> **Warning:** …` (mirrors the ADF parser —
 *     ADV-STORAGE-2 / consistency with `src/lib/adf.ts`).
 */
function admonitionFromPrefix(line: string): { name: "info" | "note" | "warning" | "tip"; rest: string } | null {
  const gfm = line.match(/^\s*\[!(INFO|NOTE|WARNING|TIP|CAUTION|IMPORTANT)\]\s*(.*)$/i);
  if (gfm) {
    const tag = (gfm[1] ?? "").toUpperCase();
    const rest = gfm[2] ?? "";
    if (tag === "INFO" || tag === "IMPORTANT") return { name: "info", rest };
    if (tag === "TIP") return { name: "tip", rest };
    if (tag === "WARNING" || tag === "CAUTION") return { name: "warning", rest };
    return { name: "note", rest };
  }
  const prose = line.match(/^\s*\*\*(Note|Warning|Info|Tip|Caution|Important|Success|Error):\*\*\s*(.*)$/i);
  if (prose) {
    const tag = (prose[1] ?? "").toLowerCase();
    const rest = prose[2] ?? "";
    if (tag === "info" || tag === "important" || tag === "success") return { name: "info", rest };
    if (tag === "tip") return { name: "tip", rest };
    if (tag === "warning" || tag === "caution" || tag === "error") return { name: "warning", rest };
    return { name: "note", rest };
  }
  return null;
}

/** Render a fenced code block as a Confluence `code` macro. */
function renderCodeBlock(language: string, body: string): string {
  const lang = language.trim();
  const langParam = lang ? `<ac:parameter ac:name="language">${escapeXml(lang)}</ac:parameter>` : "";
  // Trim a single leading and trailing newline so blank lines aren't appended
  // by the renderer (ADV-STORAGE-11). Internal blank lines are kept verbatim.
  let trimmed = body;
  if (trimmed.startsWith("\n")) trimmed = trimmed.slice(1);
  if (trimmed.endsWith("\n")) trimmed = trimmed.slice(0, -1);
  // CDATA payload — escape "]]>" sequences just in case.
  const safe = trimmed.replace(/]]>/g, "]]]]><![CDATA[>");
  return (
    `<ac:structured-macro ac:name="code">` +
    `${langParam}` +
    `<ac:plain-text-body><![CDATA[${safe}]]></ac:plain-text-body>` +
    `</ac:structured-macro>`
  );
}

/** Render a heading line (`#…` `##…` etc.). */
function renderHeading(line: string): string | null {
  const m = line.match(/^(#{1,6})\s+(.*)$/);
  if (!m) return null;
  const level = (m[1] ?? "").length;
  return `<h${level}>${renderInline(m[2] ?? "")}</h${level}>`;
}

/**
 * Detect a table header + separator pair and emit a Confluence storage table.
 *
 * Delegates to the shared `parsePipeTable` so the two converters
 * (markdown→storage and html→markdown) agree on edge cases like single-column
 * tables, ragged rows, and varying separator widths (ADV-STORAGE-1/3/7, GEN-2,
 * PUB-10).
 *
 * Canonical Confluence storage puts the header row *inside* `<tbody>` (no
 * separate `<thead>`), so we emit that shape (ADV-STORAGE-3 / PUB-10).
 */
function tryParseTable(lines: string[], start: number): { html: string; consumed: number } | null {
  const parsed = parsePipeTable(lines, start);
  if (!parsed) return null;
  const { headers, rows, next } = parsed;
  if (headers.length === 0 && rows.length === 0) return null;

  const headerHtml = headers.length > 0 ? `<tr>${headers.map((c) => `<th>${renderInline(c)}</th>`).join("")}</tr>` : "";

  const bodyHtml = rows
    .map((r) => `<tr>${headers.map((_, idx) => `<td>${renderInline(r[idx] ?? "")}</td>`).join("")}</tr>`)
    .join("");

  return {
    html: `<table><tbody>${headerHtml}${bodyHtml}</tbody></table>`,
    consumed: next - start,
  };
}

interface ListItem {
  indent: number;
  ordered: boolean;
  content: string;
  children: ListItem[];
}

function parseListLine(line: string): { indent: number; ordered: boolean; content: string } | null {
  const m = line.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
  if (!m) return null;
  const indentRaw = m[1] ?? "";
  // Normalise tabs to 4 spaces so nested lists indented with tabs are detected.
  let indent = 0;
  for (const ch of indentRaw) indent += ch === "\t" ? 4 : 1;
  const marker = m[2] ?? "";
  const content = m[3] ?? "";
  return { indent, ordered: /\d+\./.test(marker), content };
}

function renderListItems(nodes: ListItem[]): string {
  const first = nodes[0];
  if (!first) return "";
  const tag = first.ordered ? "ol" : "ul";
  const inner = nodes
    .map((n) => {
      const child = n.children.length > 0 ? renderListItems(n.children) : "";
      return `<li>${renderInline(n.content)}${child}</li>`;
    })
    .join("");
  return `<${tag}>${inner}</${tag}>`;
}

/** Parse a list (ordered or unordered), supporting nesting via indentation. */
function tryParseList(lines: string[], start: number): { html: string; consumed: number } | null {
  const first = lines[start];
  if (!first || !parseListLine(first)) return null;

  const items: ListItem[] = [];
  const stack: ListItem[] = [];
  let i = start;

  while (i < lines.length) {
    const current = lines[i] ?? "";
    const parsed = parseListLine(current);
    if (!parsed) {
      if (current.trim() === "") {
        const next = lines[i + 1];
        if (next && parseListLine(next)) {
          i++;
          continue;
        }
      }
      break;
    }
    const item: ListItem = { ...parsed, children: [] };
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (!top || top.indent < item.indent) break;
      stack.pop();
    }
    const top = stack[stack.length - 1];
    if (!top) items.push(item);
    else top.children.push(item);
    stack.push(item);
    i++;
  }

  if (items.length === 0) return null;
  return { html: renderListItems(items), consumed: i - start };
}

/** Render a contiguous blockquote run starting at `start`. */
function tryParseBlockquote(lines: string[], start: number): { html: string; consumed: number } | null {
  const head = lines[start];
  if (!head || !head.startsWith(">")) return null;
  const collected: string[] = [];
  let i = start;
  while (i < lines.length) {
    const row = lines[i];
    if (row === undefined || !row.startsWith(">")) break;
    collected.push(row.replace(/^>\s?/, ""));
    i++;
  }
  if (collected.length === 0) return null;

  const first = collected[0] ?? "";
  const adm = admonitionFromPrefix(first);
  if (adm) {
    const remainder = adm.rest;
    const restLines = collected.slice(1);
    // Drop the prefix line entirely if it was just the tag (no content); else
    // keep its remainder as the first inner line.
    const innerLines = remainder ? [remainder, ...restLines] : restLines;
    // Trim leading blank lines after the tag so we don't emit a stray <p></p>.
    while (innerLines.length > 0 && innerLines[0]?.trim() === "") innerLines.shift();
    const innerHtml = renderBlocks(innerLines);
    return {
      html:
        `<ac:structured-macro ac:name="${adm.name}">` +
        `<ac:rich-text-body>${innerHtml}</ac:rich-text-body>` +
        `</ac:structured-macro>`,
      consumed: i - start,
    };
  }

  const innerHtml = renderBlocks(collected);
  return { html: `<blockquote>${innerHtml}</blockquote>`, consumed: i - start };
}

/** Top-level block walker. Splits the document into blocks and renders each. */
function renderBlocks(lines: string[]): string {
  const out: string[] = [];
  let i = 0;
  const n = lines.length;

  while (i < n) {
    const line = lines[i] ?? "";

    if (line.trim() === "") {
      i++;
      continue;
    }

    // Fenced code block — must be parsed BEFORE any sanitisation runs so that
    // `<script>`/`<style>` examples inside a code block survive verbatim
    // (GEN-1). The block walker never calls `stripDangerous` over code bodies;
    // `renderInline` shields inline backtick spans the same way.
    const fenceMatch = line.match(/^```(.*)$/);
    if (fenceMatch) {
      const lang = fenceMatch[1] ?? "";
      const body: string[] = [];
      i++;
      while (i < n) {
        const inner = lines[i] ?? "";
        if (inner.match(/^```\s*$/)) break;
        body.push(inner);
        i++;
      }
      if (i < n) i++; // skip closing fence
      out.push(renderCodeBlock(lang, body.join("\n")));
      continue;
    }

    // Heading
    const heading = renderHeading(line);
    if (heading) {
      out.push(heading);
      i++;
      continue;
    }

    // Horizontal rule
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push("<hr/>");
      i++;
      continue;
    }

    // Table — delegate to the shared parser (ADV-STORAGE-1/7, GEN-2).
    const table = tryParseTable(lines, i);
    if (table) {
      out.push(table.html);
      i += table.consumed;
      continue;
    }

    // List
    const list = tryParseList(lines, i);
    if (list) {
      out.push(list.html);
      i += list.consumed;
      continue;
    }

    // Blockquote / admonition
    const bq = tryParseBlockquote(lines, i);
    if (bq) {
      out.push(bq.html);
      i += bq.consumed;
      continue;
    }

    // Paragraph: collect contiguous non-blank, non-block-trigger lines.
    const paraLines: string[] = [line];
    i++;
    while (i < n) {
      const next = lines[i];
      if (next === undefined || next.trim() === "") break;
      if (/^#{1,6}\s+/.test(next)) break;
      if (/^```/.test(next)) break;
      if (/^>/.test(next)) break;
      if (/^\s*([-*+]|\d+\.)\s+/.test(next)) break;
      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(next)) break;
      paraLines.push(next);
      i++;
    }
    const paragraph = paraLines.join("\n");
    out.push(`<p>${renderInline(paragraph)}</p>`);
  }

  return out.join("");
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Convert a markdown document into Confluence storage-format XHTML.
 *
 * Returns a well-formed XHTML fragment suitable for the `body.storage.value`
 * field of a Confluence v2 page create/update request.
 *
 * Sanitisation strategy:
 *   - Fenced code bodies → CDATA (inert; never sanitised).
 *   - Inline code spans → shielded via PUA placeholders inside `renderInline`.
 *   - All other text   → `stripDangerous` (script/style/event handlers) inside
 *                        `renderInline` before XML escaping.
 *   - Link/image hrefs → `safeHref` allow-list (http/https/mailto/tel/#/rel).
 *
 * The XSS guard remains intact: `<script>`, `<style>`, and `on*=` event
 * handlers outside code regions never reach the output, and dangerous URL
 * schemes are collapsed to `#`.
 */
export function markdownToStorage(md: string): string {
  if (!md) return "";
  const normalised = md.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  return renderBlocks(normalised.split("\n"));
}
