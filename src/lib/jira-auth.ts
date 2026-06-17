/**
 * Shared Jira authentication and URL validation helpers.
 * Extracted to avoid circular imports between jira.ts and jira-schema.ts.
 */

/** Check whether a dotted-quad IPv4 address is in a private/reserved range. */
function isPrivateIPv4(a: number, b: number): boolean {
  if (a === 127 || a === 10 || a === 0) return true; // loopback, class A private, zero
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 169 && b === 254) return true; // link-local / cloud metadata
  return false;
}

/**
 * Expand a textual IPv6 address (possibly with `::` shorthand) into 8 16-bit
 * groups. Returns `null` if the literal is malformed.
 */
function expandIPv6(literal: string): number[] | null {
  // Strip an optional IPv4-mapped tail (e.g. `::ffff:10.0.0.1`) and turn it
  // into two hex groups for uniform processing.
  const ipv4Tail = literal.match(/(?:^|:)((?:\d{1,3}\.){3}\d{1,3})$/);
  let normalised = literal;
  if (ipv4Tail) {
    const parts = ipv4Tail[1]?.split(".").map(Number);
    if (!parts || parts.length !== 4 || parts.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return null;
    const hi = ((parts[0] ?? 0) << 8) | (parts[1] ?? 0);
    const lo = ((parts[2] ?? 0) << 8) | (parts[3] ?? 0);
    normalised = `${literal.slice(0, literal.length - (ipv4Tail[1]?.length ?? 0))}${hi.toString(16)}:${lo.toString(16)}`;
  }
  if (normalised === "" || normalised === ":" || normalised.includes(":::")) return null;

  // Split on the `::` shorthand (at most once allowed).
  const doubleColonIdx = normalised.indexOf("::");
  let head: string[];
  let tail: string[];
  if (doubleColonIdx === -1) {
    head = normalised.split(":");
    tail = [];
  } else {
    if (normalised.indexOf("::", doubleColonIdx + 2) !== -1) return null;
    const left = normalised.slice(0, doubleColonIdx);
    const right = normalised.slice(doubleColonIdx + 2);
    head = left === "" ? [] : left.split(":");
    tail = right === "" ? [] : right.split(":");
  }
  const explicit = head.length + tail.length;
  if (explicit > 8) return null;
  const groups: number[] = [];
  for (const g of head) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    groups.push(Number.parseInt(g, 16));
  }
  for (let i = explicit; i < 8; i++) groups.push(0);
  for (const g of tail) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    groups.push(Number.parseInt(g, 16));
  }
  if (groups.length !== 8) return null;
  return groups;
}

/**
 * Detect whether an IPv6 literal (already unbracketed, lowercased) sits in
 * a non-routable / loopback / link-local / metadata range. Covers the
 * defect-list ranges in TEST-5: `::1` (loopback), `fc00::/7` (ULA),
 * `fe80::/10` (link-local), `::ffff:0:0/96` IPv4-mapped (re-check against
 * IPv4 private ranges), unspecified `::`.
 */
function isPrivateIPv6Literal(literal: string): boolean {
  const groups = expandIPv6(literal);
  if (!groups) return false;
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;

  // ::1 loopback
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && g7 === 1) return true;
  // :: unspecified
  if (groups.every((g) => g === 0)) return true;
  // fc00::/7  (ULA — first 7 bits = 1111110)
  if ((g0 & 0xfe00) === 0xfc00) return true;
  // fe80::/10 (link-local — first 10 bits = 1111111010)
  if ((g0 & 0xffc0) === 0xfe80) return true;
  // ::ffff:0:0/96 IPv4-mapped — first 80 bits zero, next 16 bits 0xffff
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    const a = (g6 >> 8) & 0xff;
    const b = g6 & 0xff;
    return isPrivateIPv4(a, b);
  }
  return false;
}

/** Check whether a hostname (from `new URL().hostname`) is private/internal. */
function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase();

  if (h === "localhost") return true;

  // IPv6 literal — URL `hostname` strips brackets, but allow either form.
  const ipv6Literal = h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h;
  if (ipv6Literal.includes(":")) {
    return isPrivateIPv6Literal(ipv6Literal);
  }

  const parts = h.split(".");
  if (parts.length === 4 && parts.every((p) => /^\d+$/.test(p))) {
    const [a, b] = parts.map(Number) as [number, number, number, number];
    return isPrivateIPv4(a, b);
  }

  return false;
}

export const PRIVATE_HOST_RE = {
  test: (url: string) => {
    try {
      return isPrivateHost(new URL(url).hostname);
    } catch {
      return true; // malformed URLs are rejected
    }
  },
};

export function validateSiteUrl(url: string): void {
  if (!url.startsWith("https://")) throw new Error(`siteUrl must start with https:// — got "${url}"`);
  if (PRIVATE_HOST_RE.test(url)) throw new Error(`siteUrl must not point to a private/internal address — got "${url}"`);
}

export function authHeaders(email: string, apiToken: string): Record<string, string> {
  const credentials = Buffer.from(`${email}:${apiToken}`).toString("base64");
  return {
    Authorization: `Basic ${credentials}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}
