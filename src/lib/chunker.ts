/**
 * Markdown-aware section chunker using remark AST.
 *
 * Splits markdown on heading boundaries, preserving heading breadcrumbs
 * (e.g. "Architecture > Authentication > OAuth2") for each chunk.
 * Designed for Confluence content that's already been converted to markdown.
 */

import type { Content, Heading, Root } from "mdast";
import { toString as nodeToString } from "mdast-util-to-string";
import remarkParse from "remark-parse";
import { unified } from "unified";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Chunk {
  /** Heading breadcrumb path, e.g. "Architecture > Auth > OAuth2" */
  breadcrumb: string;
  /** The heading that starts this section (empty for preamble) */
  heading: string;
  /** Heading depth (1-6), 0 for preamble content before first heading */
  depth: number;
  /** Plain text content of this section (no child headings) */
  content: string;
  /** Character offset in the original markdown */
  startOffset: number;
  /** Order index within the document */
  index: number;
}

export interface ChunkOptions {
  /** Minimum chunk size in chars — sections smaller than this merge into parent (default: 50) */
  minChunkSize?: number;
  /** Maximum chunk size in chars — sections larger than this get split at paragraph boundaries (default: 2000) */
  maxChunkSize?: number;
  /** Overlap chars to prepend from previous chunk for context continuity (default: 100) */
  overlapChars?: number;
}

const DEFAULT_OPTIONS: Required<ChunkOptions> = {
  minChunkSize: 50,
  maxChunkSize: 2000,
  overlapChars: 100,
};

// ── Parser ────────────────────────────────────────────────────────────────────

const parser = unified().use(remarkParse);

/** Parse markdown into remark AST. */
function parse(md: string): Root {
  return parser.parse(md);
}

// ── Chunking ──────────────────────────────────────────────────────────────────

interface RawSection {
  heading: string;
  depth: number;
  nodes: Content[];
  startOffset: number;
}

/**
 * Walk the AST and collect sections split on heading boundaries.
 * Each section contains all nodes between two headings of equal or higher level.
 */
function collectSections(tree: Root): RawSection[] {
  const sections: RawSection[] = [];
  let current: RawSection = {
    heading: "",
    depth: 0,
    nodes: [],
    startOffset: 0,
  };

  for (const node of tree.children) {
    if (node.type === "heading") {
      const h = node as Heading;
      // Flush current section if it has content
      if (current.nodes.length > 0) {
        sections.push(current);
      }
      current = {
        heading: nodeToString(h),
        depth: h.depth,
        nodes: [],
        startOffset: h.position?.start.offset ?? 0,
      };
    } else {
      current.nodes.push(node);
    }
  }

  // Flush final section
  if (current.nodes.length > 0 || current.heading) {
    sections.push(current);
  }

  return sections;
}

/** Build breadcrumb from heading stack. */
function buildBreadcrumb(stack: { heading: string; depth: number }[]): string {
  return stack.map((s) => s.heading).join(" > ");
}

/** Extract plain text from a list of AST nodes. */
function nodesToText(nodes: Content[]): string {
  return nodes
    .map((n) => nodeToString(n))
    .join("\n\n")
    .trim();
}

/**
 * Split oversized text at paragraph boundaries.
 * Returns chunks of at most maxSize chars, splitting at double-newline boundaries.
 */
function splitAtParagraphs(text: string, maxSize: number): string[] {
  if (text.length <= maxSize) return [text];

  const parts: string[] = [];
  const paragraphs = text.split(/\n\n+/);
  let current = "";

  for (const para of paragraphs) {
    if (current.length > 0 && current.length + para.length + 2 > maxSize) {
      parts.push(current.trim());
      current = para;
    } else {
      current += (current ? "\n\n" : "") + para;
    }
  }
  if (current.trim()) parts.push(current.trim());

  return parts;
}

/** Update heading stack by popping entries at same or deeper level, then pushing the new heading. */
function updateHeadingStack(stack: { heading: string; depth: number }[], section: RawSection): void {
  while (stack.length > 0 && (stack.at(-1)?.depth ?? 0) >= section.depth) {
    stack.pop();
  }
  if (section.heading) {
    stack.push({ heading: section.heading, depth: section.depth });
  }
}

/** Try to merge a tiny section into the previous chunk. Returns true if merged. */
function tryMergeTinySection(text: string, section: RawSection, chunks: Chunk[], minChunkSize: number): boolean {
  if (text.length < minChunkSize && text.length > 0 && chunks.length > 0) {
    const prev = chunks.at(-1);
    if (!prev) return false;
    prev.content += `\n\n## ${section.heading}\n${text}`;
    return true;
  }
  return false;
}

/** Emit one or more chunks from a section's text parts, applying overlap from previous chunk. */
function emitSectionChunks(
  textParts: string[],
  section: RawSection,
  breadcrumb: string,
  chunks: Chunk[],
  prevChunkEnd: string,
  overlapChars: number,
): void {
  for (let i = 0; i < textParts.length; i++) {
    const part = textParts[i];
    if (!part) continue;
    let content = part;

    if (overlapChars > 0 && prevChunkEnd && chunks.length > 0) {
      const overlap = prevChunkEnd.slice(-overlapChars);
      content = `…${overlap}\n\n---\n\n${content}`;
    }

    chunks.push({
      breadcrumb,
      heading: section.heading + (textParts.length > 1 ? ` (${i + 1}/${textParts.length})` : ""),
      depth: section.depth,
      content,
      startOffset: section.startOffset,
      index: chunks.length,
    });
  }
}

/**
 * Chunk a markdown document into heading-aware sections with breadcrumbs.
 *
 * - Splits on heading boundaries
 * - Merges tiny sections into parent
 * - Splits oversized sections at paragraph boundaries
 * - Adds overlap for context continuity
 */
export function chunkMarkdown(markdown: string, options?: ChunkOptions): Chunk[] {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const tree = parse(markdown);
  const sections = collectSections(tree);

  if (sections.length === 0) {
    const text = markdown.trim();
    if (!text) return [];
    return [{ breadcrumb: "", heading: "", depth: 0, content: text, startOffset: 0, index: 0 }];
  }

  const headingStack: { heading: string; depth: number }[] = [];
  const chunks: Chunk[] = [];
  let prevChunkEnd = "";

  for (const section of sections) {
    const text = nodesToText(section.nodes);

    updateHeadingStack(headingStack, section);
    const breadcrumb = buildBreadcrumb(headingStack);

    if (!text && !section.heading) continue;
    if (tryMergeTinySection(text, section, chunks, opts.minChunkSize)) continue;

    const textParts = splitAtParagraphs(text || section.heading, opts.maxChunkSize);
    emitSectionChunks(textParts, section, breadcrumb, chunks, prevChunkEnd, opts.overlapChars);
    prevChunkEnd = text;
  }

  return chunks;
}

/** Strip common Confluence boilerplate patterns from markdown before chunking. */
export function stripBoilerplate(md: string): string {
  return (
    md
      // Page properties macro remnants (bounded to single line, no backtracking)
      .replaceAll(/\|?[ \t]*Created by[^|\n]*\d{4}[ \t]*\|?/gi, "")
      // "Last updated" lines
      .replaceAll(/Last (updated|modified|edited)[^\n]*\n/gi, "")
      // Empty table rows
      .replaceAll(/\|\s*\|\s*\|\s*\n/g, "")
      // Confluence status macros
      .replaceAll(/\{status[^}]*\}/gi, "")
      // TOC macros
      .replaceAll(/\{toc[^}]*\}/gi, "")
      // Panel/info/warning macro wrappers (keep content)
      .replaceAll(/\{(panel|info|warning|note|tip|expand)[^}]*\}/gi, "")
      // Jira issue macro
      .replaceAll(/\{jira[^}]*\}/gi, "")
      // Multiple blank lines → max 2
      .replaceAll(/\n{3,}/g, "\n\n")
      .trim()
  );
}
