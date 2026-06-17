/**
 * Depth- and order-aware `<ul>`/`<ol>` → markdown converter.
 *
 * Extracted from `html-to-markdown.ts` to keep that file under the 400-line
 * cap. Preserves:
 *   - ordered vs unordered marker (`1.`/`2.` vs `-`) — fixes ADV-STORAGE-5.
 *   - nesting depth via `  ` per level — fixes ADV-STORAGE-6.
 *
 * Each item's inline content is HTML-decoded by re-running the rest of the
 * pipeline on the item body via the `renderItemBody` callback passed by the
 * caller — we deliberately don't recurse into the full html→markdown pipeline
 * here to avoid re-processing the same lists.
 */

const RE_LIST_OPEN = /<(ul|ol)\b[^>]*>/i;
const RE_LIST_CLOSE = /<\/(ul|ol)\s*>/i;
const RE_LI_OPEN_TAG = /<li\b[^>]*>/i;
const RE_LI_CLOSE_TAG = /<\/li\s*>/i;

/**
 * Walk every top-level `<ul>` or `<ol>` in `md` and render its full tree as
 * a properly-indented markdown list. Non-list spans pass through untouched.
 */
export function convertLists(md: string, renderItemBody: (html: string) => string): string {
  const out: string[] = [];
  let i = 0;
  const n = md.length;
  while (i < n) {
    const remaining = md.slice(i);
    const openMatch = RE_LIST_OPEN.exec(remaining);
    if (!openMatch) {
      out.push(remaining);
      break;
    }
    const openStart = i + openMatch.index;
    out.push(md.slice(i, openStart));
    const closeIdx = findMatchingListClose(md, openStart);
    if (closeIdx === -1) {
      // Malformed — leave verbatim, advance one char.
      out.push(md.slice(openStart, openStart + 1));
      i = openStart + 1;
      continue;
    }
    const closeMatch = RE_LIST_CLOSE.exec(md.slice(closeIdx));
    const closeLen = closeMatch ? closeMatch[0].length : 5;
    const block = md.slice(openStart, closeIdx + closeLen);
    out.push("\n");
    out.push(renderListBlock(block, 0, renderItemBody));
    out.push("\n");
    i = closeIdx + closeLen;
  }
  return out.join("");
}

/** Locate the `</ul>` or `</ol>` matching the list that opens at `start`. */
function findMatchingListClose(html: string, start: number): number {
  const openTag = RE_LIST_OPEN.exec(html.slice(start));
  if (!openTag) return -1;
  let depth = 1;
  const i = start + openTag[0].length;
  const RE_ANY = /<\/?(ul|ol)\b[^>]*>/gi;
  RE_ANY.lastIndex = i;
  let m: RegExpExecArray | null = RE_ANY.exec(html);
  while (m !== null) {
    if (m[0].startsWith("</")) {
      depth--;
      if (depth === 0) return m.index;
    } else {
      depth++;
    }
    m = RE_ANY.exec(html);
  }
  return -1;
}

/** Render a complete `<ul>…</ul>` or `<ol>…</ol>` block to markdown. */
function renderListBlock(block: string, depth: number, renderItemBody: (html: string) => string): string {
  const openMatch = RE_LIST_OPEN.exec(block);
  if (!openMatch) return "";
  const ordered = (openMatch[1] ?? "").toLowerCase() === "ol";
  const closeMatch = RE_LIST_CLOSE.exec(block);
  const innerStart = openMatch.index + openMatch[0].length;
  const innerEnd = closeMatch ? block.length - closeMatch[0].length : block.length;
  const inner = block.slice(innerStart, innerEnd);
  const items = splitTopLevelItems(inner);
  const indent = "  ".repeat(depth);
  const lines: string[] = [];
  items.forEach((item, idx) => {
    const marker = ordered ? `${idx + 1}.` : "-";
    const { head, nestedBlocks } = extractNested(item);
    const headMd = renderItemBody(head)
      .replace(/^\s+|\s+$/g, "")
      .replace(/\n+/g, " ");
    lines.push(`${indent}${marker} ${headMd}`);
    for (const nested of nestedBlocks) {
      lines.push(renderListBlock(nested, depth + 1, renderItemBody));
    }
  });
  return lines.join("\n");
}

/** Split `<li>…</li>` items at the *top* level of the given list inner HTML. */
function splitTopLevelItems(inner: string): string[] {
  const items: string[] = [];
  let i = 0;
  while (i < inner.length) {
    const openMatch = RE_LI_OPEN_TAG.exec(inner.slice(i));
    if (!openMatch) break;
    const start = i + openMatch.index + openMatch[0].length;
    const RE_LI_ANY = /<(\/?)li\b[^>]*>/gi;
    RE_LI_ANY.lastIndex = start;
    let depth = 1;
    let end = -1;
    let m: RegExpExecArray | null = RE_LI_ANY.exec(inner);
    while (m !== null) {
      if (m[1] === "/") {
        depth--;
        if (depth === 0) {
          end = m.index;
          break;
        }
      } else {
        depth++;
      }
      m = RE_LI_ANY.exec(inner);
    }
    if (end === -1) {
      items.push(inner.slice(start));
      break;
    }
    items.push(inner.slice(start, end));
    const closeMatch = RE_LI_CLOSE_TAG.exec(inner.slice(end));
    i = end + (closeMatch ? closeMatch[0].length : 5);
  }
  return items;
}

/**
 * For an `<li>` body, separate the textual head from any nested `<ul>`/`<ol>`
 * sub-blocks so the renderer can put them on indented lines below.
 */
function extractNested(itemBody: string): { head: string; nestedBlocks: string[] } {
  const nestedBlocks: string[] = [];
  let head = "";
  let i = 0;
  while (i < itemBody.length) {
    const openMatch = RE_LIST_OPEN.exec(itemBody.slice(i));
    if (!openMatch) {
      head += itemBody.slice(i);
      break;
    }
    head += itemBody.slice(i, i + openMatch.index);
    const blockStart = i + openMatch.index;
    const closeIdx = findMatchingListClose(itemBody, blockStart);
    if (closeIdx === -1) {
      head += itemBody.slice(blockStart);
      break;
    }
    const closeMatch = RE_LIST_CLOSE.exec(itemBody.slice(closeIdx));
    const closeLen = closeMatch ? closeMatch[0].length : 5;
    nestedBlocks.push(itemBody.slice(blockStart, closeIdx + closeLen));
    i = closeIdx + closeLen;
  }
  return { head, nestedBlocks };
}
