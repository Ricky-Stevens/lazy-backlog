/**
 * Shared attachment download helpers.
 *
 * Used by Jira and Confluence flows to safely save remote attachments to disk:
 *  - sanitises server-supplied filenames against path traversal
 *  - validates download hosts so we never blindly follow off-host redirects
 *  - validates the final URL after manual redirect resolution (ATT-3)
 *  - enforces a size cap before writing to disk
 *  - never overwrites an existing file (auto-suffixes on collision — ATT-4)
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { extname, resolve as resolvePath, sep } from "node:path";
import { PRIVATE_HOST_RE } from "./jira-auth.js";

/** Default per-attachment cap (10 MB). Override via {@link DownloadOptions.maxBytes}. */
export const DEFAULT_MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024;

/** Config key used by `kb.getConfig` to store the user's configured download directory. */
export const DOWNLOAD_DIR_CONFIG_KEY = "downloadDir";

/** Default download directory used when none is configured. */
export const DEFAULT_DOWNLOAD_DIR_NAME = "lazy-backlog-downloads";

/**
 * Atlassian content/CDN hosts shared between Jira and Confluence download
 * flows (GEN-7). Each connector layers its own additions on top — Jira adds
 * `jira-dev.com`, Confluence keeps a subset. Keeping this list in `attachments.ts`
 * means a future Atlassian host change has one place to update.
 */
export const ATLASSIAN_HOSTS = [
  "atlassian.net",
  "atl-paas.net",
  "media.atlassian.com",
  "wac-cdn.atlassian.com",
  "secure-media.atlassian.com",
];

/**
 * Default per-tool download directory. Honours `$HOME`/`$USERPROFILE`, falling
 * back to `process.cwd()`. Centralised here so Jira and Confluence agree on
 * the location (GEN-7).
 */
export function defaultDownloadDir(): string {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (home) return `${home}/${DEFAULT_DOWNLOAD_DIR_NAME}`;
  return `${process.cwd()}/${DEFAULT_DOWNLOAD_DIR_NAME}`;
}

/**
 * Format a byte count as a short human-readable string (e.g. "4.2 KB",
 * "12 MB"). Returns "?" for non-finite/negative inputs. Centralised here
 * (GEN-7) so Jira and Confluence renderers can't drift in formatting.
 */
export function humanReadableSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "?";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

/** Maximum hops while following redirects (ATT-3). */
export const MAX_REDIRECT_HOPS = 5;

export interface DownloadOptions {
  /** Maximum bytes allowed for the download. Default {@link DEFAULT_MAX_DOWNLOAD_BYTES}. */
  maxBytes?: number;
  /** Extra hostnames considered valid download targets in addition to the Atlassian site host. */
  allowedHosts?: string[];
  /** Authorisation headers to send with the request. */
  headers?: Record<string, string>;
  /** Fetch timeout in milliseconds. Default 30s. */
  timeoutMs?: number;
}

export interface DownloadedFile {
  /** Absolute path on disk where the file was saved. */
  path: string;
  /** Bytes actually written. */
  bytes: number;
  /** Content-Type returned by the remote, or undefined when not present. */
  contentType?: string;
  /** Sanitised filename used on disk (may differ from the server-supplied filename
   *  AND may be suffixed if the original name collided with an existing file). */
  filename: string;
}

/**
 * Strip directory traversal and absolute-path components from a server-supplied
 * filename. Returns a safe base name with no path separators.
 *
 * Examples:
 *  - "report.pdf" → "report.pdf"
 *  - "../etc/passwd" → "etc_passwd"
 *  - "/abs/secret.bin" → "abs_secret.bin"
 *  - "" → "download.bin"
 */
export function sanitizeFilename(raw: string): string {
  if (!raw) return "download.bin";
  // Drop any null bytes (defensive — some filesystems treat them oddly).
  let name = raw.replaceAll("\0", "");
  // Normalise both kinds of slash, then strip leading separators.
  name = name.replaceAll("\\", "/");
  name = name.replace(/^\/+/, "");
  // Collapse any `..` segments — replace whole segments to avoid sneaky `..foo`.
  name = name
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== ".." && segment !== ".")
    .join("_");
  // After traversal stripping, also drop residual separators / null chars.
  name = name.replaceAll(/[\\/]/g, "_");
  // Trim trailing dots/spaces that Windows treats specially.
  name = name.replace(/[. ]+$/u, "");
  if (!name) return "download.bin";
  return name;
}

/**
 * Validate that a URL is a fetchable Atlassian/CDN host.
 *
 * Throws if the URL is private/internal (SSRF guard) or — when allowedHosts is
 * provided — if the URL's hostname is not in the allow-list. Atlassian
 * occasionally serves attachments from a different content host (e.g.
 * `*.atlassian.net` content URLs), so callers must list those hosts.
 */
export function validateDownloadUrl(url: string, allowedHosts?: string[]): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Refusing to download from malformed URL: ${url}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`Refusing to download from non-https URL: ${url}`);
  }
  if (PRIVATE_HOST_RE.test(url)) {
    throw new Error(`Refusing to download from private/internal host: ${parsed.hostname}`);
  }
  if (allowedHosts && allowedHosts.length > 0) {
    const host = parsed.hostname.toLowerCase();
    const allowed = allowedHosts.some((h) => host === h.toLowerCase() || host.endsWith(`.${h.toLowerCase()}`));
    if (!allowed) {
      throw new Error(`Refusing to download — host '${host}' not in allowed list (${allowedHosts.join(", ")})`);
    }
  }
  return parsed;
}

/**
 * Resolve a download path inside the configured directory, sanitising the
 * filename to guard against path traversal.
 *
 * PAG-6 hardening: the directory itself is also validated. We refuse any
 * `dir` that resolves to a known system path (e.g. /etc, /usr, /bin) so that
 * a malicious or prompt-injected MCP client setting `downloadDir` cannot
 * cause us to write into a location the OS will execute from on boot/login.
 * The primary check lives in `configure set` (see `validateDownloadDir`);
 * this is defence-in-depth for any code path that pulls the dir directly
 * from `kb.getConfig`.
 */
const FORBIDDEN_DOWNLOAD_PREFIXES = [
  "/etc",
  "/usr",
  "/bin",
  "/sbin",
  "/boot",
  "/proc",
  "/sys",
  "/dev",
  "/var/spool",
  "/var/run",
  "/root",
];

export function safeJoinDownloadPath(dir: string, filename: string): string {
  const cleanName = sanitizeFilename(filename);
  const resolvedDir = resolvePath(dir);
  for (const forbidden of FORBIDDEN_DOWNLOAD_PREFIXES) {
    if (resolvedDir === forbidden || resolvedDir.startsWith(`${forbidden}/`)) {
      throw new Error(
        `Refusing to write under forbidden system path '${forbidden}': ${dir}. Use 'configure set downloadDir' to pick a safe location.`,
      );
    }
  }
  const candidate = resolvePath(resolvedDir, cleanName);
  // Belt-and-braces: ensure the resolved path still sits under the resolved dir.
  if (!candidate.startsWith(resolvedDir + sep) && candidate !== resolvedDir) {
    throw new Error(`Refusing to write outside of download directory: ${filename}`);
  }
  return candidate;
}

/**
 * Pick a non-clobbering destination path (ATT-4). Tries the sanitised filename
 * first; on collision, appends "(1)", "(2)", … before the extension and tries
 * again. Bounded by `maxAttempts` to prevent unbounded search.
 *
 * Pure path computation — does NOT touch the filesystem. The caller still uses
 * `flag: "wx"` when writing so two concurrent downloads can never silently
 * clobber even when they pre-compute the same suffix.
 */
export function pickAvailableDownloadPath(
  dir: string,
  filename: string,
  exists: (path: string) => boolean,
  maxAttempts = 1024,
): { path: string; filename: string } {
  const base = sanitizeFilename(filename);
  const ext = extname(base);
  const stem = ext ? base.slice(0, base.length - ext.length) : base;

  for (let i = 0; i < maxAttempts; i++) {
    const candidateName = i === 0 ? base : `${stem} (${i})${ext}`;
    const candidatePath = safeJoinDownloadPath(dir, candidateName);
    if (!exists(candidatePath)) return { path: candidatePath, filename: candidateName };
  }
  // Last resort: random-ish suffix so we never throw away the bytes
  const fallback = `${stem}-${Date.now()}${ext}`;
  return { path: safeJoinDownloadPath(dir, fallback), filename: fallback };
}

/**
 * Manually follow up to `MAX_REDIRECT_HOPS` redirects, validating every hop's
 * Location header against the allow-list and SSRF guard before issuing the
 * next request (ATT-3). Returns the final non-redirect response.
 *
 * Undici/Node strip the Authorization header on cross-origin redirects already,
 * but a redirect to an attacker-controlled (or private/internal) host could
 * still pull bytes we'd then write to disk — this loop prevents that.
 */
async function fetchFollowingRedirects(url: string, options: DownloadOptions, timeoutMs: number): Promise<Response> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
    validateDownloadUrl(current, options.allowedHosts);
    const res = await fetch(current, {
      headers: options.headers,
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "manual",
    });

    // 3xx with Location header → continue manually.
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("Location") ?? res.headers.get("location");
      if (!location) {
        // 3xx without Location: treat as non-redirect — let the caller see it.
        return res;
      }
      // Drain body to free the socket; we won't use these bytes.
      try {
        await res.body?.cancel();
      } catch {
        // best-effort cleanup
      }
      try {
        current = new URL(location, current).toString();
      } catch {
        throw new Error(`Download failed: malformed redirect Location header (${location})`);
      }
      continue;
    }
    return res;
  }
  throw new Error(`Download failed: exceeded ${MAX_REDIRECT_HOPS} redirect hops for ${url}`);
}

/**
 * Download a remote file to disk.
 *
 * - URL is validated for protocol, SSRF, and (optionally) host allow-list at
 *   every redirect hop (ATT-3).
 * - Filename is sanitised; the file lands inside `dir`.
 * - Response body is buffered with a hard size cap before writing.
 * - Writes use `flag: "wx"` and auto-suffix on collision so we never silently
 *   clobber an existing file (ATT-4).
 */
export async function downloadToDir(
  url: string,
  dir: string,
  filename: string,
  options: DownloadOptions = {},
): Promise<DownloadedFile> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES;
  const timeoutMs = options.timeoutMs ?? 30_000;

  const res = await fetchFollowingRedirects(url, options, timeoutMs);
  if (!res.ok) {
    throw new Error(`Download failed: ${res.status} ${res.statusText} for ${url}`);
  }

  const contentLengthHeader = res.headers.get("Content-Length");
  if (contentLengthHeader) {
    const declared = Number.parseInt(contentLengthHeader, 10);
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new Error(`Attachment exceeds size cap: ${declared} > ${maxBytes} bytes`);
    }
  }
  const contentType = res.headers.get("Content-Type") ?? undefined;

  // Stream into memory but enforce the cap as we go.
  const reader = res.body?.getReader();
  if (!reader) throw new Error("Download failed: response had no body");
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        // best-effort
      }
      throw new Error(`Attachment exceeds size cap: ${total} > ${maxBytes} bytes`);
    }
    chunks.push(value);
  }

  mkdirSync(dir, { recursive: true });

  const buffer = Buffer.concat(
    chunks.map((c) => Buffer.from(c)),
    total,
  );

  // Pre-resolve a non-existing path, then re-try with the `wx` flag in a
  // bounded loop. The `wx` flag is what guarantees no clobber under
  // concurrency — pickAvailableDownloadPath only deduplicates on first try.
  return writeWithoutClobber(dir, filename, buffer, total, contentType);
}

/**
 * Write bytes to disk under `dir` using a non-clobbering filename, retrying
 * on EEXIST so concurrent downloads never overwrite each other.
 */
function writeWithoutClobber(
  dir: string,
  filename: string,
  buffer: Buffer,
  total: number,
  contentType: string | undefined,
): DownloadedFile {
  const maxAttempts = 1024;
  let lastErr: unknown;
  for (let i = 0; i < maxAttempts; i++) {
    const { path: candidatePath, filename: candidateName } = pickAvailableDownloadPath(
      dir,
      filename,
      existsSync,
      maxAttempts,
    );
    try {
      // `wx`: create only — fail with EEXIST if it already exists. Belt-and-braces
      // alongside the existsSync probe above, in case another writer raced us.
      writeFileSync(candidatePath, buffer, { flag: "wx" });
      return { path: candidatePath, bytes: total, contentType, filename: candidateName };
    } catch (err: unknown) {
      lastErr = err;
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code !== "EEXIST") throw err;
      // EEXIST — bump the counter implicitly by re-running pickAvailableDownloadPath,
      // which will skip this path on the next iteration via existsSync.
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`Failed to write attachment after ${maxAttempts} attempts`);
}
