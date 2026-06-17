/**
 * Pure pagination helper for `knowledge get-page`. Split out of `knowledge.ts`
 * to keep that file under the 400-line cap. Barrel-re-exported from
 * `knowledge.ts` so existing imports keep working.
 */

/** Default size of a single `get-page` response window. */
export const MAX_PAGE_CHARS = 15_000;

/** Minimum page size we allow callers to request. */
export const MIN_PAGE_SIZE = 1_000;

/** Hard upper bound on page size. */
export const MAX_PAGE_SIZE = 100_000;

export interface PaginationWindow {
  /** 1-based current page. */
  page: number;
  /** Total number of pages (>= 1). */
  totalPages: number;
  /** Slice of content for the requested page. */
  body: string;
  /** Whether more pages follow this one. */
  hasMore: boolean;
  /** Total character count of the underlying content (unsliced). */
  totalChars: number;
  /** Effective page size after clamping. */
  effectiveSize: number;
}

/**
 * Slice page content into a stable, byte-budgeted window. Pure — no I/O.
 *
 * Defensive coercion (PAG-2, PAG-3): non-finite or non-integer `page` and
 * non-finite `pageSize` are coerced to safe defaults BEFORE clamping, so
 * direct callers of this exported helper get the same "stable window"
 * contract as the MCP tool entry-point (where Zod rejects NaN/Infinity).
 *
 * Surrogate-pair safety (PAG-1): when a chosen boundary lands inside a
 * UTF-16 surrogate pair (non-BMP codepoints like emoji), the boundary is
 * walked back by one code unit so the WHOLE pair falls on the next page.
 * JSON.stringify on a lone surrogate emits invalid UTF-8 per RFC 8259 §8.2,
 * which strict re-decoders replace with U+FFFD. Concatenating the windows
 * still reassembles the original content because the split moves but never
 * duplicates or drops code units.
 */
export function paginateContent(content: string, page: number, pageSize: number): PaginationWindow {
  // PAG-2 / PAG-3: coerce non-finite / fractional inputs.
  //  - NaN page → 1 (defensive; matches the JSDoc "default 1" contract).
  //  - +Infinity page → very large number that clamps to the last page below.
  //  - -Infinity page → very small number that clamps to 1 below.
  //  - Non-integer page → floor (so page=1.7 == page=1, not an overlapping slice).
  //  - Non-finite pageSize → MAX_PAGE_CHARS default.
  let safePage: number;
  if (Number.isNaN(page)) safePage = 1;
  else if (page === Number.POSITIVE_INFINITY) safePage = Number.MAX_SAFE_INTEGER;
  else if (page === Number.NEGATIVE_INFINITY) safePage = 1;
  else safePage = Math.floor(page);
  const safeSize = Number.isFinite(pageSize) ? Math.floor(pageSize) : MAX_PAGE_CHARS;

  const totalChars = content.length;
  const effectiveSize = Math.max(MIN_PAGE_SIZE, Math.min(MAX_PAGE_SIZE, safeSize));
  const totalPages = Math.max(1, Math.ceil(totalChars / effectiveSize));
  const clampedPage = Math.max(1, Math.min(safePage, totalPages));

  let start = (clampedPage - 1) * effectiveSize;
  let end = Math.min(totalChars, start + effectiveSize);

  // PAG-1: avoid splitting a surrogate pair.
  // - end-1 is a HIGH surrogate (D800-DBFF) and end < totalChars: pull `end`
  //   back so the whole pair rolls into the next page.
  // - `start` is a LOW surrogate (DC00-DFFF): pull `start` back so this page
  //   picks up the high surrogate that the previous page walked back from.
  if (end > start && end < totalChars && isHighSurrogate(content.charCodeAt(end - 1))) end -= 1;
  if (start > 0 && isLowSurrogate(content.charCodeAt(start))) start -= 1;

  return {
    page: clampedPage,
    totalPages,
    body: content.slice(start, end),
    hasMore: clampedPage < totalPages,
    totalChars,
    effectiveSize,
  };
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}
