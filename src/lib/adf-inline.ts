/**
 * Inline-level markdown → ADF parser (text, marks, links, images, code).
 *
 * Extracted from `adf.ts` to keep that file under the 400-line cap.
 * Uses a small recursive parser (not one combined regex) so nested marks
 * (bold-inside-link, italic-inside-bold, strike-inside-bold) and
 * balanced-paren URLs all work. The single-regex approach was the root cause
 * of ADF-1/2/5/10/11.
 */

import type { AdfMark, AdfNode } from "./adf-types.js";
import { findBalancedUrlEnd } from "./markdown-to-storage-inline.js";

export interface ParseCtx {
  nextTaskId: () => string;
}

export function textNode(text: string, marks?: AdfMark[]): AdfNode {
  return marks?.length ? { type: "text", text, marks } : { type: "text", text };
}

export function paragraphNode(text: string, ctx: ParseCtx): AdfNode {
  return { type: "paragraph", content: parseInline(text, ctx) };
}

/** Build a media node from `![alt](url)` inline image syntax. */
export function imageNode(alt: string, url: string): AdfNode {
  const isExternal = /^https?:\/\//i.test(url);
  if (isExternal) {
    return { type: "media", attrs: { type: "external", url, alt } };
  }
  // Treat anything else (media:id, media:collection/id, or bare id) as a file ref
  const ref = url.startsWith("media:") ? url.slice("media:".length) : url;
  const [maybeCollection, maybeId] = ref.split("/");
  const id = maybeId ?? maybeCollection ?? "";
  const collection = maybeId ? maybeCollection : undefined;
  return {
    type: "media",
    attrs: {
      type: "file",
      id,
      ...(collection ? { collection } : {}),
      ...(alt ? { alt } : {}),
    },
  };
}

function applyMarks(nodes: AdfNode[], mark: AdfMark): AdfNode[] {
  // Attach `mark` to every text/media descendant. Media nodes do not carry
  // marks in ADF, so for those we just keep them un-marked.
  return nodes.map((n) => {
    if (n.type === "text") {
      const existing = n.marks ?? [];
      return { type: "text", text: n.text, marks: [...existing, mark] };
    }
    return n;
  });
}

function tryMatchPaired(text: string, i: number, marker: string): { inner: string; end: number } | null {
  // Look for a non-empty closing marker. Used by bold/italic/strike variants.
  const open = i + marker.length;
  if (open >= text.length) return null;
  // Refuse "opener" if the character right after is the same marker (prevents
  // `**` from matching as italic, `~` from matching as strike opener etc.)
  const nextChar = text[open];
  if (nextChar === marker[0] && marker.length === 1) return null;
  const close = text.indexOf(marker, open + 1);
  if (close === -1) return null;
  const inner = text.slice(open, close);
  if (inner.length === 0) return null;
  // For underscore-based emphasis, require word boundaries (skip mid-word).
  if (marker === "_" || marker === "__") {
    const before = text[i - 1];
    const after = text[close + marker.length];
    if (before && /\w/.test(before)) return null;
    if (after && /\w/.test(after)) return null;
  }
  return { inner, end: close + marker.length };
}

const BARE_URL_RE = /^(https?:\/\/[^\s)>\]]+)/;

/** Parse inline markdown into ADF nodes. Recursive (handles nested marks). */
export function parseInline(text: string, ctx: ParseCtx): AdfNode[] {
  const out: AdfNode[] = [];
  let buf = "";
  const flushText = () => {
    if (buf.length > 0) {
      out.push(textNode(buf));
      buf = "";
    }
  };

  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i] ?? "";
    const c2 = text.slice(i, i + 2);

    // Escaped character: `\` followed by anything
    if (c === "\\" && i + 1 < n) {
      buf += text[i + 1];
      i += 2;
      continue;
    }

    // Image: ![alt](url)
    if (c === "!" && text[i + 1] === "[") {
      const labelEnd = findBalancedBracket(text, i + 1);
      if (labelEnd !== -1 && text[labelEnd + 1] === "(") {
        const urlEnd = findBalancedUrlEnd(text, labelEnd + 2);
        if (urlEnd !== -1) {
          const alt = text.slice(i + 2, labelEnd);
          const url = text.slice(labelEnd + 2, urlEnd).trim();
          flushText();
          out.push(imageNode(alt, url));
          i = urlEnd + 1;
          continue;
        }
      }
    }

    // Link: [text](url) — recurse into the label so marks inside survive
    if (c === "[") {
      const labelEnd = findBalancedBracket(text, i);
      if (labelEnd !== -1 && text[labelEnd + 1] === "(") {
        const urlEnd = findBalancedUrlEnd(text, labelEnd + 2);
        if (urlEnd !== -1) {
          const label = text.slice(i + 1, labelEnd);
          const url = text.slice(labelEnd + 2, urlEnd).trim();
          flushText();
          const inner = parseInline(label, ctx);
          out.push(...applyMarks(inner, { type: "link", attrs: { href: url } }));
          i = urlEnd + 1;
          continue;
        }
      }
    }

    // Inline code: `…` (no recursion — code is literal)
    if (c === "`") {
      const close = text.indexOf("`", i + 1);
      if (close > i + 1) {
        flushText();
        out.push(textNode(text.slice(i + 1, close), [{ type: "code" }]));
        i = close + 1;
        continue;
      }
    }

    // Strikethrough: ~~…~~
    if (c2 === "~~") {
      const m = tryMatchPaired(text, i, "~~");
      if (m) {
        flushText();
        out.push(...applyMarks(parseInline(m.inner, ctx), { type: "strike" }));
        i = m.end;
        continue;
      }
    }

    // Combined bold + italic: ***…*** or ___…___ (must come BEFORE the
    // plain `**`/`__` check because the outer marker is a strict superset).
    const c3 = text.slice(i, i + 3);
    if (c3 === "***" || c3 === "___") {
      const m = tryMatchPaired(text, i, c3);
      if (m) {
        flushText();
        const inner = parseInline(m.inner, ctx);
        const withStrong = applyMarks(inner, { type: "strong" });
        const withBoth = applyMarks(withStrong, { type: "em" });
        out.push(...withBoth);
        i = m.end;
        continue;
      }
    }

    // Bold: **…** or __…__ — recurse into inner so combined emphasis works.
    if (c2 === "**" || c2 === "__") {
      const m = tryMatchPaired(text, i, c2);
      if (m) {
        flushText();
        out.push(...applyMarks(parseInline(m.inner, ctx), { type: "strong" }));
        i = m.end;
        continue;
      }
    }

    // Italic: *…* or _…_ (single delimiter)
    if (c === "*" || c === "_") {
      const m = tryMatchPaired(text, i, c);
      if (m) {
        flushText();
        out.push(...applyMarks(parseInline(m.inner, ctx), { type: "em" }));
        i = m.end;
        continue;
      }
    }

    // Bare URL (not preceded by `(` or `[`)
    if (c === "h" && (i === 0 || !/[([]/.test(text[i - 1] ?? ""))) {
      const slice = text.slice(i);
      const m = BARE_URL_RE.exec(slice);
      if (m) {
        flushText();
        const url = m[1] ?? "";
        out.push(textNode(url, [{ type: "link", attrs: { href: url } }]));
        i += url.length;
        continue;
      }
    }

    buf += c;
    i++;
  }

  flushText();
  if (out.length === 0) return [];
  return out;
}

/** Find the matching `]` for a `[` at position `start`. Returns -1 if not found. */
export function findBalancedBracket(text: string, start: number): number {
  if (text[start] !== "[") return -1;
  let depth = 1;
  let i = start + 1;
  while (i < text.length && depth > 0) {
    const c = text[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "[") depth++;
    else if (c === "]") {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}
