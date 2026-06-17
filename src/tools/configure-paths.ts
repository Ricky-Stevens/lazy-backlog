/**
 * Download-directory validation helpers — split out of `configure.ts` to
 * keep that file under the 400-line cap (and so other tools can reuse the
 * same rules without circular imports).
 *
 * The `downloadDir` config key is the only user-controlled disk-write
 * location in the system. A prompt-injected MCP client setting it to
 * `/etc/cron.d` would otherwise gain code execution on the next
 * `download:true` call. These rules are the primary defence (see PAG-6).
 */

import { isAbsolute, normalize, resolve as resolvePath } from "node:path";

/**
 * Block-list of directories we refuse to use as the download root, even when
 * the caller is an authenticated MCP client. The list intentionally covers
 * UNIX system roots that an attacker (or prompt-injected client) could use
 * to drop executable bytes (cron jobs, init scripts, profile files, etc.).
 * It's not exhaustive — the absolute-path + no-`..` checks below carry the
 * bulk of the guarantee — but the obvious cases get an explicit refusal so
 * we surface the misconfiguration loudly.
 */
export const FORBIDDEN_DOWNLOAD_DIR_PREFIXES = [
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

/**
 * Validate a user-supplied download directory (PAG-6). Returns an error
 * message string when invalid, or `null` when the path is acceptable.
 *
 * Constraints:
 *  - must be a non-empty string;
 *  - must be an absolute path (relative paths anchor to the server's cwd —
 *    unpredictable across MCP clients);
 *  - must not contain `..` segments (no traversal, even if the absolute
 *    prefix looks safe);
 *  - must not sit under a known system root (see FORBIDDEN_DOWNLOAD_DIR_PREFIXES).
 *
 * The downstream `safeJoinDownloadPath()` enforces no-escape of the resolved
 * dir at write time — this validation is defence-in-depth on top of that.
 */
export function validateDownloadDir(raw: string): string | null {
  if (typeof raw !== "string" || raw.length === 0) {
    return "downloadDir must be a non-empty string.";
  }
  if (!isAbsolute(raw)) {
    return `downloadDir must be an absolute path (got '${raw}').`;
  }
  // Check `..` BEFORE normalising, so `/tmp/a/../etc` is rejected even
  // though `normalize` would silently resolve it to `/tmp/etc`. We don't want
  // any traversal segment in the literal user-supplied string — it's a sign
  // of either a typo or an attempted bypass.
  const rawSegments = raw.split(/[\\/]/);
  if (rawSegments.includes("..")) {
    return `downloadDir must not contain '..' segments (got '${raw}').`;
  }
  const resolved = resolvePath(normalize(raw));
  for (const forbidden of FORBIDDEN_DOWNLOAD_DIR_PREFIXES) {
    if (resolved === forbidden || resolved.startsWith(`${forbidden}/`)) {
      return `downloadDir '${raw}' resolves under a forbidden system path ('${forbidden}'). Pick a location under your home directory or a dedicated downloads folder.`;
    }
  }
  return null;
}
