/**
 * Confluence storage-format HTML → markdown.
 *
 * Preserves rich content: tables (via shared pipe-table helper), images
 * (`<img>` + `<ac:image>` with `<ri:attachment>`/`<ri:url>`), and
 * Confluence structured macros (info/note/warning/tip/code/expand/status/toc/jira).
 *
 * Security invariant: `<script>` and `<style>` are always stripped.
 */

import { processMacros } from "./confluence-macros.js";
import { convertLists } from "./html-list.js";
import { formatPipeTable } from "./pipe-table.js";

// ── Semaphore for bounded concurrency ──────────────────────────────────────

export class Semaphore {
  private readonly queue: (() => void)[] = [];
  private active = 0;

  constructor(private readonly limit: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) {
      this.active++;
      next();
    }
  }
}

// ── Pre-compiled regex ─────────────────────────────────────────────────────

const RE_STYLE = /<style[^>]*>[\s\S]*?<\/style>/gi;
const RE_SCRIPT = /<script[^>]*>[\s\S]*?<\/script>/gi;
const RE_HEADING = /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi;
const RE_BOLD = /<(?:strong|b)>([\s\S]*?)<\/(?:strong|b)>/gi;
const RE_ITALIC = /<(?:em|i)>([\s\S]*?)<\/(?:em|i)>/gi;
const RE_CODE = /<code>([\s\S]*?)<\/code>/gi;
const RE_PRE = /<pre[^>]*>([\s\S]*?)<\/pre>/gi;
const RE_BLOCKQUOTE = /<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi;
const RE_BR = /<br\s*\/?>/gi;
const RE_P_CLOSE = /<\/p>/gi;
const RE_LI_OPEN = /<li[^>]*>/gi;
const RE_LI_CLOSE = /<\/li>/gi;
const RE_TABLE = /<table[^>]*>([\s\S]*?)<\/table>/gi;
const RE_TABLE_ROW = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
const RE_TABLE_HEADER = /<th[^>]*>([\s\S]*?)<\/th>/gi;
const RE_TABLE_CELL = /<td[^>]*>([\s\S]*?)<\/td>/gi;
const RE_LINK = /<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
const RE_IMG = /<img\b[^>]*>/gi;
const RE_AC_IMAGE = /<ac:image\b([^>]*)>([\s\S]*?)<\/ac:image>/gi;
const RE_AC_IMAGE_SELF = /<ac:image\b([^>]*)\/>/gi;
const RE_RI_ATTACHMENT = /<ri:attachment\b[^>]*\bri:filename="([^"]*)"[^>]*\/?>(?:<\/ri:attachment>)?/i;
const RE_RI_URL = /<ri:url\b[^>]*\bri:value="([^"]*)"[^>]*\/?>(?:<\/ri:url>)?/i;
const RE_ATTR = (name: string): RegExp => new RegExp(`\\b${name}="([^"]*)"`, "i");
const RE_AC_LINK = /<ac:link\b[^>]*>([\s\S]*?)<\/ac:link>/gi;
const RE_ALL_TAGS = /<[^>]+>/g;
const RE_MULTI_NEWLINE = /\n{3,}/g;

const ENTITY_MAP: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&nbsp;": " ",
  "&#x2F;": "/",
  "&#x27;": "'",
};
const RE_ENTITY = /&(?:amp|lt|gt|quot|nbsp|#39|#x2F|#x27);/g;

// ── HTML→Markdown helpers ──────────────────────────────────────────────────

function stripTags(text: string): string {
  return text.replaceAll(RE_ALL_TAGS, "");
}

/**
 * Security invariant: remove `<script>` and `<style>` blocks BEFORE any
 * downstream processing. Their content must never appear in the output.
 */
function stripUnsafe(md: string): string {
  return md.replaceAll(RE_STYLE, "").replaceAll(RE_SCRIPT, "");
}

function convertCodeBlocks(md: string): string {
  md = md.replaceAll(RE_PRE, (_, content: string) => `\n\`\`\`\n${content}\n\`\`\`\n`);
  md = md.replaceAll(RE_CODE, "`$1`");
  return md;
}

function convertHeadings(md: string): string {
  return md.replaceAll(RE_HEADING, (_, level: string, content: string) => {
    const prefix = "#".repeat(Number.parseInt(level, 10));
    return `\n${prefix} ${stripTags(content).trim()}\n`;
  });
}

function decodeEntities(md: string): string {
  return md.replaceAll(RE_ENTITY, (match) => ENTITY_MAP[match] || match);
}

function attr(tagFragment: string, name: string): string {
  return RE_ATTR(name).exec(tagFragment)?.[1] ?? "";
}

/** Convert a single `<table>…</table>` to a pipe table using the shared formatter. */
function convertSingleTable(_full: string, body: string): string {
  const headers: string[] = [];
  const rows: string[][] = [];

  let m: RegExpExecArray | null;
  RE_TABLE_ROW.lastIndex = 0;
  m = RE_TABLE_ROW.exec(body);
  while (m !== null) {
    const rowContent = m[1] ?? "";
    const rowHeaders: string[] = [];
    const rowCells: string[] = [];
    rowContent.replaceAll(RE_TABLE_HEADER, (__, cell: string) => {
      rowHeaders.push(stripTags(cell).trim());
      return "";
    });
    rowContent.replaceAll(RE_TABLE_CELL, (__, cell: string) => {
      rowCells.push(stripTags(cell).trim());
      return "";
    });
    if (rowHeaders.length > 0 && headers.length === 0) {
      headers.push(...rowHeaders);
    } else if (rowCells.length > 0) {
      rows.push(rowCells);
    }
    m = RE_TABLE_ROW.exec(body);
  }

  const out = formatPipeTable(headers, rows);
  return out ? `\n${out}\n` : "";
}

/** Fallback: a stray `<tr>…</tr>` outside a `<table>`. Keep prior behaviour. */
function convertStrayTableRow(_match: string, rowContent: string): string {
  const headers: string[] = [];
  const cells: string[] = [];
  rowContent.replaceAll(RE_TABLE_HEADER, (__, c: string) => {
    headers.push(stripTags(c).trim());
    return "";
  });
  rowContent.replaceAll(RE_TABLE_CELL, (__, c: string) => {
    cells.push(stripTags(c).trim());
    return "";
  });
  if (headers.length > 0) {
    return formatPipeTable(headers, []);
  }
  if (cells.length > 0) {
    return formatPipeTable([], [cells]);
  }
  return "";
}

function convertLinks(md: string): string {
  return md.replaceAll(RE_LINK, (_, href: string, text: string) => {
    const clean = stripTags(text).trim();
    return clean === href ? clean : `[${clean}](${href})`;
  });
}

function convertInlineFormatting(md: string): string {
  md = md.replaceAll(RE_BOLD, "**$1**");
  md = md.replaceAll(RE_ITALIC, "*$1*");
  return md;
}

function convertBlockquotes(md: string): string {
  return md.replaceAll(RE_BLOCKQUOTE, (_, content: string) => {
    const inner = content.trim();
    if (!inner) return "\n";
    const lines = inner.split(/\n+/).map((l) => l.trim());
    return `\n${lines.map((l) => (l ? `> ${l}` : ">")).join("\n")}\n`;
  });
}

function convertBlockElements(md: string): string {
  md = md.replaceAll(RE_BR, "\n");
  md = md.replaceAll(RE_P_CLOSE, "\n\n");
  // Lists are pre-converted by `convertLists`; any stray <li> outside a list
  // gets a default unordered marker.
  md = md.replaceAll(RE_LI_OPEN, "- ");
  md = md.replaceAll(RE_LI_CLOSE, "\n");
  return md;
}

/**
 * Convert plain `<img>` tags to markdown image syntax. Preserves alt text.
 */
function convertImgTags(md: string): string {
  return md.replaceAll(RE_IMG, (full) => {
    const src = attr(full, "src");
    const alt = attr(full, "alt");
    if (!src) return "";
    return `![${alt}](${src})`;
  });
}

/**
 * Convert Confluence `<ac:image>` (with `<ri:attachment>` / `<ri:url>` ref)
 * into markdown image syntax. Alt comes from `ac:alt`, falls back to filename.
 *
 * Attachment URLs are resolved against `attachmentUrls` (manifest, preferred)
 * or `baseUrl` (fallback heuristic) when available.
 */
function convertAcImage(md: string, baseUrl?: string, attachmentUrls?: Record<string, string>): string {
  const handle = (fragment: string, body: string): string => {
    const alt = attr(fragment, "ac:alt") || attr(fragment, "alt") || "";

    // External URL takes precedence
    const urlMatch = RE_RI_URL.exec(body);
    if (urlMatch) {
      const url = urlMatch[1] ?? "";
      return url ? `![${alt}](${url})` : "";
    }

    // Attachment reference — resolve against manifest first, then base URL heuristic.
    const attMatch = RE_RI_ATTACHMENT.exec(body);
    if (attMatch) {
      const filename = attMatch[1] ?? "";
      const altText = alt || filename;
      let url: string;
      if (attachmentUrls?.[filename]) {
        url = attachmentUrls[filename];
      } else if (baseUrl) {
        url = `${baseUrl.replace(/\/$/, "")}/download/attachments/${filename}`;
      } else {
        url = filename;
      }
      return filename ? `![${altText}](${url})` : "";
    }

    // No recognised inner ref — fall back to alt text only, so nothing vanishes
    return alt ? `![${alt}]()` : "";
  };

  let out = md.replaceAll(RE_AC_IMAGE, (_full, fragment: string, body: string) => handle(fragment, body));
  out = out.replaceAll(RE_AC_IMAGE_SELF, (_full, fragment: string) => handle(fragment, ""));
  return out;
}

/**
 * Confluence `<ac:link>` wrappers — keep their visible body. The page
 * reference itself is opaque without API resolution, so we degrade to text.
 */
function convertAcLinks(md: string): string {
  return md.replaceAll(RE_AC_LINK, (_full, inner: string) => stripTags(inner).trim());
}

// ── Public API ─────────────────────────────────────────────────────────────

export interface HtmlToMarkdownOptions {
  /** Confluence base URL used to resolve `<ri:attachment>` filenames into download URLs. */
  baseUrl?: string;
  /** Optional attachment manifest (filename → absolute URL) for richer resolution. */
  attachmentUrls?: Record<string, string>;
}

function applyAttachmentManifest(md: string, manifest: Record<string, string>): string {
  // Rewrite any `![alt](filename)` whose target appears in the manifest.
  return md.replaceAll(/!\[([^\]]*)]\(([^)\s]+)\)/g, (full, alt: string, url: string) => {
    if (manifest[url]) return `![${alt}](${manifest[url]})`;
    return full;
  });
}

/**
 * Convert Confluence storage-format HTML to markdown.
 *
 * Pipeline:
 *  1. Strip `<script>`/`<style>` (security invariant).
 *  2. Convert images (`<img>` + `<ac:image>`) — done early so macros don't swallow them.
 *  3. Process structured macros (info/note/warning/tip/code/expand/status/toc/jira).
 *  4. Convert code/headings/tables/links/inline/blockquotes/block elements.
 *  5. Strip residual tags, decode entities, compact blank lines.
 */
export function htmlToMarkdown(html: string, options: HtmlToMarkdownOptions = {}): string {
  let md = stripUnsafe(html);
  md = convertAcImage(md, options.baseUrl, options.attachmentUrls);
  md = convertImgTags(md);
  md = convertAcLinks(md);

  // Macro processing recurses through the full converter for nested content
  md = processMacros(md, (inner) => htmlToMarkdown(inner, options));

  md = convertCodeBlocks(md);
  md = convertHeadings(md);
  md = md.replaceAll(RE_TABLE, convertSingleTable);
  md = md.replaceAll(RE_TABLE_ROW, convertStrayTableRow);
  // Render <ul>/<ol> properly (ADV-STORAGE-5 / ADV-STORAGE-6). The item body
  // needs the remaining inline/block conversions, but we must NOT recurse
  // back into convertLists or the same list would be re-rendered. The body
  // renderer below runs the rest of the pipeline directly.
  const renderItemBody = (itemHtml: string): string => {
    let s = itemHtml;
    s = convertLinks(s);
    s = convertInlineFormatting(s);
    s = s.replaceAll(RE_P_CLOSE, " ");
    s = s.replaceAll(RE_BR, " ");
    s = stripTags(s);
    s = decodeEntities(s);
    return s.trim();
  };
  md = convertLists(md, renderItemBody);
  md = convertLinks(md);
  md = convertInlineFormatting(md);
  md = convertBlockquotes(md);
  md = convertBlockElements(md);
  md = stripTags(md);
  md = decodeEntities(md);

  if (options.attachmentUrls && Object.keys(options.attachmentUrls).length > 0) {
    md = applyAttachmentManifest(md, options.attachmentUrls);
  }

  md = md.replaceAll(RE_MULTI_NEWLINE, "\n\n");
  return md.trim();
}
