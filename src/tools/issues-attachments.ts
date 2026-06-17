/**
 * Shared helpers for uploading local files as Jira attachments.
 *
 * Validates each path (must exist, must be a regular file, must respect the
 * per-attachment size cap) before invoking JiraClient.addAttachment().
 * Errors per file are collected instead of aborting the batch.
 *
 * Confinement (ATT-2): we reject paths that resolve outside the configured
 * upload root. This stops prompt-injected ticket bodies from instructing the
 * LLM to upload arbitrary files visible to the server process (e.g.
 * `/etc/passwd`, ssh keys). Symlinks are rejected explicitly via `lstatSync`
 * so a symlink inside the upload root cannot exfiltrate files outside it.
 *
 * Aggregate cap (ATT-6): the total bytes across all uploads in a single
 * call are capped — N×10 MB per-file limits add up fast and we'd rather
 * fail fast than buffer hundreds of MB into RAM and then into FormData.
 */

import { lstatSync, readFileSync, statSync } from "node:fs";
import { basename, resolve as resolvePath, sep } from "node:path";
import { DEFAULT_MAX_DOWNLOAD_BYTES } from "../lib/attachments.js";
import type { AttachmentUpload, JiraClient } from "../lib/jira.js";

export interface AttachmentUploadOutcome {
  uploaded: number;
  errors: string[];
}

/** Per-file size cap shared with downloads. */
export const ATTACHMENT_UPLOAD_MAX_BYTES = DEFAULT_MAX_DOWNLOAD_BYTES;

/** Aggregate cap for a single upload batch (ATT-6). 50 MB matches Jira's defaults. */
export const ATTACHMENT_UPLOAD_AGGREGATE_MAX_BYTES = 50 * 1024 * 1024;

/** Env-var override for the upload root. Empty means use cwd. */
const UPLOAD_ROOT_ENV = "LAZY_BACKLOG_UPLOAD_ROOT";

/**
 * The directory under which attachment paths must resolve. Sourced from
 * `LAZY_BACKLOG_UPLOAD_ROOT` env var, falling back to `process.cwd()`.
 * Exported so tests can spy on it via env manipulation; callers should
 * call this each upload (it's cheap) rather than caching the result.
 */
export function resolveUploadRoot(): string {
  const env = process.env[UPLOAD_ROOT_ENV];
  return resolvePath(env && env.trim() !== "" ? env : process.cwd());
}

/**
 * True when `candidate` is `root` itself or a descendant of `root`.
 * Both inputs must already be absolute (use `path.resolve` first).
 */
function isInsideRoot(candidate: string, root: string): boolean {
  const r = root.endsWith(sep) ? root : root + sep;
  return candidate === root || candidate.startsWith(r);
}

const COMMON_MIME_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  html: "text/html",
  zip: "application/zip",
  log: "text/plain",
};

function guessContentType(filename: string): string {
  const idx = filename.lastIndexOf(".");
  if (idx < 0) return "application/octet-stream";
  const ext = filename.slice(idx + 1).toLowerCase();
  return COMMON_MIME_TYPES[ext] ?? "application/octet-stream";
}

interface JiraAttachmentApi {
  addAttachment: InstanceType<typeof JiraClient>["addAttachment"];
}

interface ValidatedFile {
  path: string;
  size: number;
}

/**
 * Validate a single path: must resolve inside the upload root, must not be
 * a symlink, must be a regular file, must fit the per-file cap. Returns an
 * error string on failure or `null` on success, mutating `out` with the
 * validated record.
 */
function validatePath(path: string, root: string, out: ValidatedFile[]): string | null {
  const resolved = resolvePath(path);
  if (!isInsideRoot(resolved, root)) {
    return `${path}: refusing to read outside upload root (${root}). Set ${UPLOAD_ROOT_ENV} to broaden.`;
  }

  let lstat: ReturnType<typeof lstatSync>;
  try {
    lstat = lstatSync(resolved);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("ENOENT")) return `${path}: file not found`;
    return `${path}: ${message}`;
  }
  if (lstat.isSymbolicLink()) {
    return `${path}: refusing to upload symlinks (ATT-2 guard)`;
  }

  const stat = statSync(resolved);
  if (!stat.isFile()) return `${path}: not a regular file`;
  if (stat.size > ATTACHMENT_UPLOAD_MAX_BYTES) {
    return `${path}: exceeds size cap (${stat.size} > ${ATTACHMENT_UPLOAD_MAX_BYTES} bytes)`;
  }

  out.push({ path: resolved, size: stat.size });
  return null;
}

/**
 * Read each local file path, validate it, and upload as a Jira attachment.
 *
 * Errors are accumulated per-file — a single bad path does not abort the
 * remaining uploads. Returns the count of successfully uploaded files plus
 * a list of human-readable error strings.
 */
export async function uploadAttachmentsFromPaths(
  jira: JiraAttachmentApi,
  issueKey: string,
  paths: string[],
): Promise<AttachmentUploadOutcome> {
  const errors: string[] = [];
  const root = resolveUploadRoot();
  const validated: ValidatedFile[] = [];

  // Stage 1: validate every path before we read anything into memory.
  for (const path of paths) {
    const err = validatePath(path, root, validated);
    if (err) errors.push(err);
  }

  if (validated.length === 0) return { uploaded: 0, errors };

  // Stage 2: enforce aggregate cap before buffering (ATT-6). We sum the
  // sizes from stat — much cheaper than reading the files first.
  const aggregate = validated.reduce((acc, v) => acc + v.size, 0);
  if (aggregate > ATTACHMENT_UPLOAD_AGGREGATE_MAX_BYTES) {
    errors.push(
      `Aggregate upload size ${aggregate} bytes exceeds cap ${ATTACHMENT_UPLOAD_AGGREGATE_MAX_BYTES}. ` +
        `Split into smaller batches.`,
    );
    return { uploaded: 0, errors };
  }

  // Stage 3: read + upload. Reads are sync; we keep the staged failure
  // semantics from before so a transient read error doesn't drop the batch.
  const uploads: AttachmentUpload[] = [];
  for (const v of validated) {
    try {
      const data = readFileSync(v.path);
      const filename = basename(v.path);
      uploads.push({ filename, data, contentType: guessContentType(filename) });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`${v.path}: ${message}`);
    }
  }

  if (uploads.length === 0) return { uploaded: 0, errors };

  try {
    const result = await jira.addAttachment(issueKey, uploads);
    return { uploaded: result.length, errors };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    errors.push(`Upload failed for ${uploads.length} file(s): ${message}`);
    return { uploaded: 0, errors };
  }
}
