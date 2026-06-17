/**
 * Shared utility functions used across the codebase.
 */

/** Group items by a key function. */
export function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const arr = map.get(k);
    if (arr) arr.push(item);
    else map.set(k, [item]);
  }
  return map;
}

/**
 * Stringify a caught value safely for error reporting.
 *
 * `${err}` on an `unknown` produces `[object Object]` for non-Error throws
 * (e.g. plain objects rejected from a Promise). This helper extracts
 * `Error.message`, falls back to `String(err)`, and never throws.
 */
export function toErrMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err === null || err === undefined) return String(err);
  if (typeof err === "string") return err;
  // For non-Error objects, prefer a `message` field if it looks like one.
  if (typeof err === "object" && "message" in (err as Record<string, unknown>)) {
    const m = (err as Record<string, unknown>).message;
    if (typeof m === "string") return m;
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
