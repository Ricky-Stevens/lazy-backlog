/**
 * Confluence storage-format macro handlers.
 *
 * Converts `<ac:structured-macro ac:name="...">…</ac:structured-macro>` blocks
 * into markdown equivalents. Handlers are pure string→string so they compose
 * cleanly inside the html-to-markdown pipeline.
 *
 * Macros covered (per Stage A3): info, note, warning, tip, code, expand,
 * status, toc, jira. Everything else degrades to its inner plain text —
 * never silently dropped, never thrown.
 */

const RE_MACRO_BLOCK = /<ac:structured-macro\b[^>]*\bac:name="([^"]+)"[^>]*>([\s\S]*?)<\/ac:structured-macro>/gi;
const RE_SELF_CLOSING_MACRO = /<ac:structured-macro\b[^>]*\bac:name="([^"]+)"[^>]*\/>/gi;
const RE_RICH_TEXT_BODY = /<ac:rich-text-body[^>]*>([\s\S]*?)<\/ac:rich-text-body>/i;
const RE_PLAIN_TEXT_BODY = /<ac:plain-text-body[^>]*>([\s\S]*?)<\/ac:plain-text-body>/i;
const RE_PARAMETER = /<ac:parameter\b[^>]*\bac:name="([^"]+)"[^>]*>([\s\S]*?)<\/ac:parameter>/gi;
const RE_CDATA = /<!\[CDATA\[([\s\S]*?)]]>/g;
const RE_STRIP_TAGS = /<[^>]+>/g;

const ADMONITION_LABEL: Record<string, string> = {
  info: "Info",
  note: "Note",
  warning: "Warning",
  tip: "Tip",
};

interface ParsedMacro {
  params: Record<string, string>;
  richBody: string;
  plainBody: string;
}

function parseMacro(inner: string): ParsedMacro {
  const params: Record<string, string> = {};
  inner.replaceAll(RE_PARAMETER, (_full, name: string, raw: string) => {
    params[name] = raw.replaceAll(RE_CDATA, "$1").replaceAll(RE_STRIP_TAGS, "").trim();
    return "";
  });

  const rich = RE_RICH_TEXT_BODY.exec(inner)?.[1] ?? "";
  const plainRaw = RE_PLAIN_TEXT_BODY.exec(inner)?.[1] ?? "";
  const plain = plainRaw.replaceAll(RE_CDATA, "$1");
  return { params, richBody: rich, plainBody: plain };
}

function admonitionMarkdown(label: string, bodyHtml: string, convert: (html: string) => string): string {
  const inner = convert(bodyHtml).trim();
  if (!inner) return `\n> **${label}:**\n`;
  const lines = inner.split("\n");
  const [first = "", ...rest] = lines;
  const head = `> **${label}:** ${first}`.trimEnd();
  const tail = rest.map((l) => (l.trim().length > 0 ? `> ${l}` : ">"));
  return `\n${[head, ...tail].join("\n")}\n`;
}

/**
 * Render a single macro by name. The `convertInner` callback runs the
 * full html→markdown pipeline on rich bodies so nested formatting works.
 */
function renderMacro(name: string, inner: string, convertInner: (html: string) => string): string {
  const { params, richBody, plainBody } = parseMacro(inner);
  const lowered = name.toLowerCase();

  if (lowered === "info" || lowered === "note" || lowered === "warning" || lowered === "tip") {
    return admonitionMarkdown(ADMONITION_LABEL[lowered] ?? "Note", richBody, convertInner);
  }

  if (lowered === "code") {
    const lang = (params.language ?? "").trim();
    const body = plainBody.replace(/\n+$/, "");
    return `\n\`\`\`${lang}\n${body}\n\`\`\`\n`;
  }

  if (lowered === "expand") {
    const title = (params.title ?? "Details").trim() || "Details";
    const body = convertInner(richBody).trim();
    return body ? `\n**${title}**\n\n${body}\n` : `\n**${title}**\n`;
  }

  if (lowered === "status") {
    const title = (params.title ?? "").trim();
    const colour = (params.colour ?? params.color ?? "").trim();
    if (!title) return "";
    return colour ? `\`${title}\` (${colour})` : `\`${title}\``;
  }

  if (lowered === "toc") {
    return "";
  }

  if (lowered === "jira") {
    const key = (params.key ?? "").trim();
    const server = (params.server ?? params.serverId ?? "").trim();
    if (key && /^https?:\/\//i.test(server)) {
      const base = server.replace(/\/$/, "");
      return `[${key}](${base}/browse/${key})`;
    }
    return key;
  }

  // Unknown macro: fall back to the inner content (rich body if present,
  // otherwise plain body, otherwise stripped raw). Never throws.
  if (richBody) return convertInner(richBody);
  if (plainBody) return plainBody;
  return inner.replaceAll(RE_STRIP_TAGS, "").trim();
}

/** Maximum macro-unpeeling iterations. Real Confluence content rarely nests
 * more than 3-4 deep; the cap stops a hostile/malformed payload from spinning. */
export const MACRO_NESTING_CAP = 20;

/**
 * Replace all Confluence structured macros in `html` with markdown.
 *
 * `convertInner` is the full html→markdown converter so admonitions and
 * expand panels render with their nested formatting intact.
 *
 * GEN-6: When the safety cap fires before the fixed point, we emit an
 * inline marker and log to stderr so callers and operators have a signal
 * instead of silently returning a half-converted body.
 */
export function processMacros(html: string, convertInner: (html: string) => string): string {
  // Self-closing macros first (no body to recurse into)
  let out = html.replaceAll(RE_SELF_CLOSING_MACRO, (_full, name: string) => renderMacro(name, "", convertInner));

  // Then macros with bodies. We iterate manually to avoid re-entrant lastIndex bugs.
  let prev = "";
  let safety = 0;
  while (prev !== out && safety < MACRO_NESTING_CAP) {
    prev = out;
    out = out.replaceAll(RE_MACRO_BLOCK, (_full, name: string, inner: string) =>
      renderMacro(name, inner, convertInner),
    );
    safety++;
  }

  // GEN-6: if we exited because of the cap rather than the fixed-point, surface
  // a visible marker and log to stderr. The caller still gets the best-effort
  // partial conversion — never silently dropped — but knows to investigate.
  if (prev !== out) {
    console.error(`processMacros: macro nesting cap (${MACRO_NESTING_CAP}) reached; output may be partially converted`);
    out = `${out}\n<!-- macro nesting cap (${MACRO_NESTING_CAP}) reached — output may be partially converted -->`;
  }

  return out;
}
