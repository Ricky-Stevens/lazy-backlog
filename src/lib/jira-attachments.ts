/**
 * Jira attachment upload + manifest helpers.
 *
 * Kept separate from the main JiraClient module so the file size stays under
 * the 400-line cap and so unit tests can exercise the helpers directly.
 */

import { fetchWithRetry } from "./http-utils.js";
import type { JiraAttachment, RawAttachment } from "./jira-types.js";

/** Input shape for uploading an attachment to an issue. */
export interface AttachmentUpload {
  filename: string;
  data: Uint8Array | ArrayBuffer | Buffer;
  /** Optional MIME type. Defaults to `application/octet-stream`. */
  contentType?: string;
}

export function toUint8Array(data: Uint8Array | ArrayBuffer | Buffer): Uint8Array<ArrayBuffer> {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  // Both Buffer and Uint8Array hit this branch. If the underlying buffer is already
  // a non-shared ArrayBuffer we can re-use it (zero copy); otherwise (e.g.
  // SharedArrayBuffer-backed) copy into a fresh ArrayBuffer so the result narrows
  // to Uint8Array<ArrayBuffer>, which Blob's BlobPart signature on TS 5.7+ requires.
  if (data.buffer instanceof ArrayBuffer) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  return copy;
}

export function mapAttachment(raw: RawAttachment): JiraAttachment {
  const mimeType = raw.mimeType ?? "application/octet-stream";
  return {
    id: raw.id,
    filename: raw.filename,
    mimeType,
    size: raw.size,
    author: raw.author?.displayName,
    created: raw.created,
    url: raw.content,
    thumbnail: raw.thumbnail,
    // TEST-11: Atlassian Server occasionally returns capitalised media types
    // ("Image/PNG"); normalise before the prefix check so we don't lose the
    // image preview path for legitimate images.
    isImage: mimeType.toLowerCase().startsWith("image/"),
  };
}

/**
 * Upload one or more attachments to an issue.
 *
 * Uses `POST /rest/api/3/issue/{key}/attachments` with multipart form data
 * and the `X-Atlassian-Token: no-check` header required by Jira for file
 * uploads. The API token is never logged.
 */
export async function uploadAttachments(args: {
  baseUrl: string;
  headers: Record<string, string>;
  issueKey: string;
  files: AttachmentUpload[];
  timeoutMs: number;
}): Promise<JiraAttachment[]> {
  if (args.files.length === 0) throw new Error("addAttachment requires at least one file");

  const form = new FormData();
  for (const file of args.files) {
    const blob = new Blob([toUint8Array(file.data)], { type: file.contentType || "application/octet-stream" });
    form.append("file", blob, file.filename);
  }

  // Strip the JSON Content-Type — fetch will set the multipart boundary itself.
  const { "Content-Type": _omit, ...rest } = args.headers;
  const headers: Record<string, string> = { ...rest, "X-Atlassian-Token": "no-check" };

  const url = `${args.baseUrl}/rest/api/3/issue/${encodeURIComponent(args.issueKey)}/attachments`;
  const res = await fetchWithRetry(url, {
    method: "POST",
    headers,
    body: form,
    timeoutMs: args.timeoutMs,
    label: "Jira",
  });
  if (!res.ok) {
    throw new Error(`Jira ${res.status} POST attachments: ${await parseJiraErrorBody(res)}`);
  }
  const raw = (await res.json()) as RawAttachment[];
  return raw.map(mapAttachment);
}

/**
 * Parse the structured JiraErrorResponse out of a non-2xx body (ATT-7).
 *
 * Jira returns `{ errorMessages: string[], errors: Record<string,string> }`
 * for most API errors. We must NOT echo the raw body — it can contain
 * stack traces, request ids, or HTML that leaks server internals. This
 * helper extracts the structured fields and falls back to a generic
 * `Jira returned <status>` message when the body isn't parseable JSON.
 */
async function parseJiraErrorBody(res: Response): Promise<string> {
  let raw = "";
  try {
    raw = await res.text();
  } catch {
    // Body already drained / network blip — fall through to generic.
  }
  if (!raw) return `Jira returned ${res.status}`;

  try {
    const json = JSON.parse(raw) as {
      errorMessages?: unknown;
      errors?: unknown;
    };
    const messages: string[] = [];
    if (Array.isArray(json.errorMessages)) {
      for (const m of json.errorMessages) if (typeof m === "string" && m) messages.push(m);
    }
    if (json.errors && typeof json.errors === "object") {
      for (const [k, v] of Object.entries(json.errors as Record<string, unknown>)) {
        if (typeof v === "string" && v) messages.push(`${k}: ${v}`);
      }
    }
    if (messages.length > 0) return messages.join("; ");
    return `Jira returned ${res.status}`;
  } catch {
    return `Jira returned ${res.status}`;
  }
}
