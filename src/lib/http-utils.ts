/**
 * Shared HTTP retry/backoff utilities used by Jira and Confluence clients.
 */

// The TS config lib is `ESNext` only (no DOM). Node 18+ provides `RequestInit`
// as a global (via @types/node + undici-types), but `BodyInit` is not re-exported
// as a global. Derive it from `RequestInit["body"]` to stay aligned with the
// runtime's actual fetch signature.
type BodyInit = NonNullable<RequestInit["body"]>;

export const MAX_RETRIES = 3;
export const INITIAL_BACKOFF_MS = 1_000;
export const RETRYABLE_STATUSES = new Set([429, 500, 502, 503]);

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** @internal Exposed for test mocking — do not use directly. */
export const _internals = { sleep };

export interface FetchWithRetryOptions {
  /** HTTP method (GET, POST, PUT, etc.). Defaults to "GET". */
  method?: string;
  /** Request headers. */
  headers?: Record<string, string>;
  /** Request body — will be serialized to JSON if provided. */
  body?: unknown;
  /** Abort timeout in milliseconds. */
  timeoutMs?: number;
  /** Label for error messages (e.g. "Jira", "Confluence"). Defaults to "HTTP". */
  label?: string;
}

/** Compute the backoff delay for a given attempt (exponential). */
function backoffMs(attempt: number): number {
  return INITIAL_BACKOFF_MS * (1 << attempt);
}

/**
 * Serialize a request body for `fetch`.
 *
 * Plain objects/arrays become JSON. FormData / Blob / ArrayBuffer / Uint8Array
 * are passed through untouched so multipart uploads work. Strings are sent as-is.
 */
function serializeBody(body: unknown): BodyInit | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return body;
  if (body instanceof FormData) return body;
  if (body instanceof URLSearchParams) return body;
  if (body instanceof Blob) return body;
  if (body instanceof ArrayBuffer) return body;
  if (ArrayBuffer.isView(body)) {
    // Use the underlying ArrayBuffer slice to avoid passing a SharedArrayBuffer-backed view.
    const view = body as ArrayBufferView;
    return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
  }
  return JSON.stringify(body);
}

/** Determine whether a response should be retried and the delay to wait. */
function parseRetryAfter(header: string): number {
  const seconds = Number(header);
  if (!Number.isNaN(seconds)) return seconds * 1000;
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return 0;
}

function retryDelay(res: Response, attempt: number): number | null {
  if (attempt >= MAX_RETRIES) return null;
  if (res.status === 429) {
    const retryAfter = res.headers.get("Retry-After");
    return retryAfter ? parseRetryAfter(retryAfter) || backoffMs(attempt) : backoffMs(attempt);
  }
  if (RETRYABLE_STATUSES.has(res.status)) {
    return backoffMs(attempt);
  }
  return null;
}

/**
 * Fetch with exponential backoff retry for 429 and 5xx responses.
 *
 * Returns the raw Response on success (including non-retryable error statuses
 * like 4xx). Callers are responsible for checking `res.ok` and parsing.
 *
 * Throws only after all retries are exhausted for retryable statuses, or on
 * network/timeout errors that persist across retries.
 */
export async function fetchWithRetry(url: string, options: FetchWithRetryOptions = {}): Promise<Response> {
  const { method = "GET", headers, body, timeoutMs = 15_000, label = "HTTP" } = options;

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: serializeBody(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err: unknown) {
      // Network or timeout error — retry if attempts remain
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < MAX_RETRIES) {
        await _internals.sleep(backoffMs(attempt));
        continue;
      }
      throw lastError;
    }

    const delay = retryDelay(res, attempt);
    if (delay != null) {
      lastError = new Error(`${label} ${res.status} ${method} ${url}`);
      await _internals.sleep(delay);
      continue;
    }

    return res;
  }

  throw lastError ?? new Error(`${label} request failed after retries: ${method} ${url}`);
}
