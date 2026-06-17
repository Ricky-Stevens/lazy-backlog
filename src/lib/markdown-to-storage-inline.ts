/**
 * Inline-level rendering and sanitisation for markdown → storage conversion.
 *
 * Extracted from `markdown-to-storage.ts` to keep that file under the 400-line
 * cap. The block-level walker imports these helpers to render paragraph
 * content, list items, table cells, and blockquote inner text.
 */

// ── Sanitisation ──────────────────────────────────────────────────────────

const RE_SCRIPT = /<script\b[^>]*>[\s\S]*?<\/script\s*>/gi;
const RE_STYLE = /<style\b[^>]*>[\s\S]*?<\/style\s*>/gi;
const RE_SELF_CLOSING_DANGEROUS = /<(script|style|iframe|object|embed|link|meta)\b[^>]*\/?>/gi;
const RE_EVENT_HANDLER = /\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;

/**
 * Strip script/style blocks, dangerous tags, and event handlers.
 *
 * NOTE: Callers must not apply this to fenced or inline code bodies — code
 * spans hold literal text and need to survive verbatim (GEN-1). The block
 * walker excises code regions before passing the rest through here, and
 * `renderInline` pulls inline backtick spans out via Private-Use-Area
 * placeholders before sanitisation.
 */
export function stripDangerous(input: string): string {
  return input
    .replace(RE_SCRIPT, "")
    .replace(RE_STYLE, "")
    .replace(RE_SELF_CLOSING_DANGEROUS, "")
    .replace(RE_EVENT_HANDLER, "");
}

/** Escape XML/HTML special characters for use inside element text. */
export function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Escape only for use inside a double-quoted attribute value. */
export function escapeAttr(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/**
 * Filter href to a safe scheme.
 *
 * Uses an *allow-list* (ADV-STORAGE-10 / GEN-3): http, https, mailto, tel,
 * fragment anchors, and relative paths pass through. Anything with a different
 * scheme (`javascript:`, `data:`, `vbscript:`, `file:`, `mhtml:`, …) is
 * collapsed to `#`. This is the XSS guard the file's docstring promises.
 */
export function safeHref(href: string): string {
  const trimmed = href.trim();
  if (trimmed === "") return "#";
  // Fragment, root-relative, or relative path — all safe.
  if (trimmed.startsWith("#") || trimmed.startsWith("/") || trimmed.startsWith("./") || trimmed.startsWith("../")) {
    return trimmed;
  }
  const schemeMatch = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed);
  if (!schemeMatch) {
    // No scheme — treat as a relative URL (filenames, query strings, etc.)
    return trimmed;
  }
  const scheme = (schemeMatch[1] ?? "").toLowerCase();
  if (scheme === "http" || scheme === "https" || scheme === "mailto" || scheme === "tel") return trimmed;
  return "#";
}

/** True if `href` is an absolute URL (has a scheme or is protocol-relative). */
function isAbsoluteUrl(href: string): boolean {
  const trimmed = href.trim();
  return /^([a-z][a-z0-9+.-]*:|\/\/)/i.test(trimmed);
}

/**
 * Render a markdown image inline as either `<ri:url>` (absolute) or
 * `<ri:attachment>` (relative / bare filename). Confluence storage format
 * round-trips correctly only when relative refs are emitted as attachments
 * (ADV-STORAGE-4).
 */
function renderImageInline(alt: string, url: string): string {
  if (isAbsoluteUrl(url)) {
    const safe = safeHref(url);
    return `<ac:image ac:alt="${escapeAttr(alt)}"><ri:url ri:value="${escapeAttr(safe)}"/></ac:image>`;
  }
  // Relative path / bare filename → attachment reference. Strip any leading
  // ./ or directory components so the filename matches Confluence's
  // expectations for attached files.
  const filename = url.replace(/^.*[/\\]/, "");
  return `<ac:image ac:alt="${escapeAttr(alt)}"><ri:attachment ri:filename="${escapeAttr(filename)}"/></ac:image>`;
}

// ── URL parens balancer ──────────────────────────────────────────────────

/**
 * Find the closing `)` for a markdown link/image URL starting at `start`,
 * accounting for balanced parentheses inside the URL itself (Wikipedia
 * disambiguation links are the canonical case — GEN-4 / ADF-2).
 *
 * Returns the index of the closing `)`, or -1 if none.
 */
export function findBalancedUrlEnd(src: string, start: number): number {
  let depth = 1;
  let i = start;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\" && i + 1 < src.length) {
      // CommonMark: backslash escapes the following character inside URLs too.
      i += 2;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

// ── Inline parser ─────────────────────────────────────────────────────────

interface LinkMatch {
  text: string;
  url: string;
  end: number;
}

/** Match `[text](url)` starting at position `start` (`[`). Balances parens in the URL. */
function matchLinkLike(src: string, start: number): LinkMatch | null {
  if (src[start] !== "[") return null;
  let depth = 1;
  let i = start + 1;
  while (i < src.length && depth > 0) {
    const c = src[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "[") depth++;
    else if (c === "]") depth--;
    if (depth === 0) break;
    i++;
  }
  if (depth !== 0) return null;
  const textEnd = i;
  if (src[textEnd + 1] !== "(") return null;
  const urlStart = textEnd + 2;
  const urlEnd = findBalancedUrlEnd(src, urlStart);
  if (urlEnd === -1) return null;
  return {
    text: src.slice(start + 1, textEnd),
    url: src.slice(urlStart, urlEnd).trim(),
    end: urlEnd + 1,
  };
}

// Sentinels in the Unicode Private Use Area — guaranteed not to appear in
// real markdown. Used to shield inline-code spans from stripDangerous (GEN-1).
const PH_OPEN = "";
const PH_CLOSE = "";

/**
 * Parse inline markdown (within a paragraph / list item / table cell).
 *
 * Supported in order of precedence:
 *   1. Inline code (`…`)
 *   2. Images (![alt](url))
 *   3. Links ([text](url))
 *   4. Strikethrough (~~…~~)
 *   5. Bold (**…**, __…__)
 *   6. Italic (*…*, _…_)
 *
 * All other text is XML-escaped.
 */
export function renderInline(md: string): string {
  // Pull out inline-code spans FIRST so their bodies survive stripDangerous
  // untouched (GEN-1: <script>/<style> tags inside `code` must round-trip).
  const codeBodies: string[] = [];
  const withPlaceholders = extractInlineCode(md, (body) => {
    const id = codeBodies.push(body) - 1;
    return `${PH_OPEN}${id}${PH_CLOSE}`;
  });
  const cleaned = stripDangerous(withPlaceholders);

  const out: string[] = [];
  let i = 0;
  const n = cleaned.length;

  while (i < n) {
    const ch = cleaned[i] ?? "";

    // Restore inline-code placeholder
    if (ch === PH_OPEN) {
      const closeAt = cleaned.indexOf(PH_CLOSE, i + 1);
      if (closeAt !== -1) {
        const id = Number.parseInt(cleaned.slice(i + 1, closeAt), 10);
        const body = codeBodies[id] ?? "";
        out.push(`<code>${escapeXml(body)}</code>`);
        i = closeAt + 1;
        continue;
      }
    }

    // Image: ![alt](url)
    if (ch === "!" && cleaned[i + 1] === "[") {
      const match = matchLinkLike(cleaned, i + 1);
      if (match) {
        out.push(renderImageInline(match.text, match.url));
        i = match.end;
        continue;
      }
    }

    // Link: [text](url)
    if (ch === "[") {
      const match = matchLinkLike(cleaned, i);
      if (match) {
        const url = safeHref(match.url);
        const inner = renderInline(match.text);
        out.push(`<a href="${escapeAttr(url)}">${inner}</a>`);
        i = match.end;
        continue;
      }
    }

    // Strikethrough: ~~…~~
    if (ch === "~" && cleaned[i + 1] === "~") {
      const close = cleaned.indexOf("~~", i + 2);
      if (close > i + 2) {
        const inner = renderInline(cleaned.slice(i + 2, close));
        out.push(`<span style="text-decoration: line-through;">${inner}</span>`);
        i = close + 2;
        continue;
      }
    }

    // Bold: **…** or __…__
    if ((ch === "*" || ch === "_") && cleaned[i + 1] === ch) {
      const marker = ch + ch;
      const close = cleaned.indexOf(marker, i + 2);
      if (close > i + 2) {
        const inner = renderInline(cleaned.slice(i + 2, close));
        out.push(`<strong>${inner}</strong>`);
        i = close + 2;
        continue;
      }
    }

    // Italic: *…* or _…_ (single delimiter)
    if (ch === "*" || ch === "_") {
      const close = cleaned.indexOf(ch, i + 1);
      if (close > i + 1 && cleaned[close + 1] !== ch && cleaned[i + 1] !== ch) {
        const inner = renderInline(cleaned.slice(i + 1, close));
        out.push(`<em>${inner}</em>`);
        i = close + 1;
        continue;
      }
    }

    out.push(escapeXml(ch));
    i++;
  }

  return out.join("");
}

/**
 * Walk `src` and pull out every inline-code span (`…`), calling `onCode` with
 * each body and substituting the returned placeholder. Backtick-pairs are
 * matched greedily left-to-right; an unmatched opening backtick is left as
 * literal text.
 */
function extractInlineCode(src: string, onCode: (body: string) => string): string {
  const out: string[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\" && i + 1 < src.length) {
      out.push(src.slice(i, i + 2));
      i += 2;
      continue;
    }
    if (c === "`") {
      const close = src.indexOf("`", i + 1);
      if (close > i) {
        out.push(onCode(src.slice(i + 1, close)));
        i = close + 1;
        continue;
      }
    }
    out.push(c ?? "");
    i++;
  }
  return out.join("");
}

/**
 * Strikethrough rendering helper exposed for shared use by tests / block
 * builders. Confluence storage has no first-class strike element; we emit
 * the `<span style="text-decoration: line-through;">` form that the
 * Confluence editor itself produces.
 */
export const STRIKE_OPEN = '<span style="text-decoration: line-through;">';
export const STRIKE_CLOSE = "</span>";
