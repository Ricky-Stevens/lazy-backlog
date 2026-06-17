/**
 * Shared GitHub-flavoured markdown pipe-table helpers.
 *
 * Used by both `adf.ts` (ADF table ↔ markdown) and `html-to-markdown.ts`
 * (Confluence storage HTML → markdown). Keep a single source of truth so
 * the two converters render tables identically.
 */

/** Escape pipe characters inside a cell so the markdown stays well-formed. */
export function escapePipeCell(text: string): string {
  return text.replaceAll("|", "\\|");
}

/**
 * Render a header + body rows array as a GFM pipe table.
 *
 * - `headers` may be empty → no header row / separator emitted; rows still render.
 * - Each cell is trimmed and pipe-escaped.
 * - Newlines inside a cell are replaced with `<br>` so the table stays on one row.
 */
export function formatPipeTable(headers: string[], rows: string[][]): string {
  const sanitiseCell = (cell: string): string => escapePipeCell(cell.trim().replaceAll(/\r?\n+/g, "<br>"));

  const lines: string[] = [];

  if (headers.length > 0) {
    const headerCells = headers.map(sanitiseCell);
    lines.push(`| ${headerCells.join(" | ")} |`);
    lines.push(`| ${headerCells.map(() => "---").join(" | ")} |`);
  }

  for (const row of rows) {
    if (row.length === 0) continue;
    lines.push(`| ${row.map(sanitiseCell).join(" | ")} |`);
  }

  return lines.join("\n");
}

/**
 * Detect whether a slice of markdown lines starting at index `i` is a
 * GFM pipe table. Returns `{ headers, rows, next }` if so, else `null`.
 *
 * A table requires:
 *  - line[i]    contains at least one `|` (header row)
 *  - line[i+1]  is a separator: only `|`, `-`, `:`, spaces, with at least one `---`
 *  - line[i+2…] continues while lines contain `|`
 */
export function parsePipeTable(
  lines: string[],
  i: number,
): { headers: string[]; rows: string[][]; next: number } | null {
  const header = lines[i];
  const sep = lines[i + 1];
  if (!header || !sep) return null;
  if (!header.includes("|")) return null;

  // Separator: optional leading/trailing pipe + cells of `:?-+:?` separated by `|`
  const sepTrim = sep.trim();
  if (!/^[|\s:-]+$/.test(sepTrim)) return null;
  // Must contain at least one run of dashes to qualify as a table separator
  if (!/-{3,}/.test(sepTrim)) return null;

  const headers = splitPipeRow(header);
  const sepCells = splitPipeRow(sep);
  if (headers.length === 0 || sepCells.length === 0) return null;

  const rows: string[][] = [];
  let j = i + 2;
  while (j < lines.length) {
    const line = lines[j];
    if (line == null || !line.includes("|") || line.trim() === "") break;
    rows.push(splitPipeRow(line));
    j++;
  }

  return { headers, rows, next: j };
}

/**
 * Split a markdown pipe-table row into cells.
 * Strips a single leading/trailing pipe before splitting on unescaped `|`.
 * Honours `\|` escapes inside cells.
 */
export function splitPipeRow(line: string): string[] {
  let trimmed = line.trim();
  if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
  if (trimmed.endsWith("|") && !trimmed.endsWith("\\|")) trimmed = trimmed.slice(0, -1);

  const cells: string[] = [];
  let current = "";
  for (let k = 0; k < trimmed.length; k++) {
    const ch = trimmed[k];
    if (ch === "\\" && trimmed[k + 1] === "|") {
      current += "|";
      k++;
      continue;
    }
    if (ch === "|") {
      cells.push(current);
      current = "";
      continue;
    }
    current += ch ?? "";
  }
  cells.push(current);
  return cells.map((c) => c.trim());
}
