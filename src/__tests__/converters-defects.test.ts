/**
 * Regression tests for the v4 converter defects.
 *
 * Each block names the defect ID (ADF-1 … ADV-STORAGE-11 / GEN-* / PUB-10)
 * it covers. Every assertion should FAIL against the pre-fix code and PASS
 * against the patched converters.
 */

import { describe, expect, it } from "vitest";
import { type AdfNode, adfToText, markdownToAdf } from "../lib/adf.js";
import { htmlToMarkdown } from "../lib/html-to-markdown.js";
import { markdownToStorage, renderInline } from "../lib/markdown-to-storage.js";

// ── ADF-1: orderedList must not collapse to bulletList ─────────────────────

describe("ADF-1: orderedList preserved through markdown → ADF → markdown", () => {
  it("renders an ADF orderedList with 1. 2. 3. markers", () => {
    const md = "1. one\n2. two\n3. three";
    const doc = markdownToAdf(md);
    const list = doc.content[0];
    expect(list?.type).toBe("orderedList");
    const back = adfToText(doc);
    expect(back).toContain("1. one");
    expect(back).toContain("2. two");
    expect(back).toContain("3. three");
    expect(back).not.toMatch(/^-\s/m); // no bullet markers
  });

  it("honours orderedList.attrs.order when present", () => {
    const adf: AdfNode = {
      type: "doc",
      version: 1,
      content: [
        {
          type: "orderedList",
          // attrs.order is optional in the local AdfNode union; cast through unknown.
          ...({ attrs: { order: 5 } } as unknown as { attrs: { order: number } }),
          content: [
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "a" }] }] },
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "b" }] }] },
          ],
        },
      ] as AdfNode[],
    } as AdfNode;
    const back = adfToText(adf);
    expect(back).toContain("5. a");
    expect(back).toContain("6. b");
  });
});

// ── ADF-2 / GEN-4: link URL with balanced parens ───────────────────────────

describe("ADF-2 / GEN-4: links with parenthesised URLs", () => {
  it("ADF parser captures the whole Wikipedia disambiguation URL", () => {
    const md = "[Foo (bar)](https://en.wikipedia.org/wiki/Foo_(bar))";
    const doc = markdownToAdf(md);
    const para = doc.content[0] as Extract<AdfNode, { type: "paragraph" }>;
    const textNode = para.content[0] as Extract<AdfNode, { type: "text" }>;
    const link = textNode.marks?.[0];
    expect(link?.type).toBe("link");
    expect(link?.attrs?.href).toBe("https://en.wikipedia.org/wiki/Foo_(bar)");
  });

  it("storage converter captures the whole parenthesised URL", () => {
    const out = markdownToStorage("[wikipedia](https://en.wikipedia.org/wiki/Foo_(disambiguation))");
    expect(out).toContain('href="https://en.wikipedia.org/wiki/Foo_(disambiguation)"');
    // No stray ')' must leak past the closing </a>.
    expect(out).not.toMatch(/<\/a>\s*\)/);
  });
});

// ── ADF-3: multi-line blockquote preserves line boundaries ─────────────────

describe("ADF-3: blockquote multi-line preservation", () => {
  it("does not merge two adjacent quoted lines into a single space-joined paragraph", () => {
    const doc = markdownToAdf("> hello\n> world");
    const bq = doc.content[0] as Extract<AdfNode, { type: "blockquote" }>;
    const para = bq.content[0] as Extract<AdfNode, { type: "paragraph" }>;
    // Either a hardBreak between the two segments, OR two paragraphs — but
    // never the joined "hello world" text from the pre-fix behaviour.
    const joined = para.content
      .filter((n) => n.type === "text")
      .map((n) => (n as Extract<AdfNode, { type: "text" }>).text)
      .join("");
    expect(joined).not.toBe("hello world");
    const hasBreak = para.content.some((n) => n.type === "hardBreak");
    expect(hasBreak).toBe(true);
  });
});

// ── ADF-4 / ADV-ADF-9: mediaSingle layout attr ─────────────────────────────

describe("ADF-4: mediaSingle carries layout attr", () => {
  it("sets layout='center' on external image mediaSingle", () => {
    const doc = markdownToAdf("![pic](https://example.com/a.png)");
    const ms = doc.content[0] as Extract<AdfNode, { type: "mediaSingle" }>;
    expect(ms.type).toBe("mediaSingle");
    expect(ms.attrs?.layout).toBe("center");
  });
});

// ── ADF-5: underscore italic / bold and strikethrough ──────────────────────

describe("ADF-5: underscore emphasis and strikethrough", () => {
  it("parses _italic_ into a text node with em mark", () => {
    const doc = markdownToAdf("_italic_ text");
    const para = doc.content[0] as Extract<AdfNode, { type: "paragraph" }>;
    const first = para.content[0] as Extract<AdfNode, { type: "text" }>;
    expect(first.text).toBe("italic");
    expect(first.marks?.[0]?.type).toBe("em");
  });

  it("parses __bold__ into a text node with strong mark", () => {
    const doc = markdownToAdf("__bold__ text");
    const para = doc.content[0] as Extract<AdfNode, { type: "paragraph" }>;
    const first = para.content[0] as Extract<AdfNode, { type: "text" }>;
    expect(first.text).toBe("bold");
    expect(first.marks?.[0]?.type).toBe("strong");
  });

  it("parses ~~struck~~ into a text node with strike mark", () => {
    const doc = markdownToAdf("~~struck~~ text");
    const para = doc.content[0] as Extract<AdfNode, { type: "paragraph" }>;
    const first = para.content[0] as Extract<AdfNode, { type: "text" }>;
    expect(first.text).toBe("struck");
    expect(first.marks?.[0]?.type).toBe("strike");
  });

  it("renders a strike mark as ~~text~~ in adfToText", () => {
    const adf: AdfNode = {
      type: "doc",
      version: 1,
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "gone", marks: [{ type: "strike" }] }],
        },
      ],
    };
    expect(adfToText(adf)).toContain("~~gone~~");
  });
});

// ── ADF-6: tab-indented nested lists ───────────────────────────────────────

describe("ADF-6: tab indentation for nested lists", () => {
  it("produces a nested bulletList when a child is indented with a tab", () => {
    const doc = markdownToAdf("- a\n\t- b");
    const outer = doc.content[0] as Extract<AdfNode, { type: "bulletList" }>;
    expect(outer.type).toBe("bulletList");
    expect(outer.content).toHaveLength(1);
    const item = outer.content[0] as Extract<AdfNode, { type: "listItem" }>;
    const nested = item.content.find((n) => n.type === "bulletList");
    expect(nested).toBeDefined();
  });
});

// ── ADF-7: panel keeps blank-line separator between paragraphs ─────────────

describe("ADF-7: panel paragraphs separated by `>` blank line on render", () => {
  it("round-trips a two-paragraph note panel without merging the bodies", () => {
    const md = "> **Note:** first\n>\n> second";
    const doc = markdownToAdf(md);
    const panel = doc.content[0] as Extract<AdfNode, { type: "panel" }>;
    expect(panel.type).toBe("panel");
    expect(panel.content.length).toBeGreaterThanOrEqual(2);
    const back = adfToText(doc);
    // The render must contain a blank `>` line between the two paragraphs.
    expect(back).toMatch(/> \*\*Note:\*\* first\n>\n> second/);
    // Re-parse — second paragraph must remain a distinct paragraph.
    const reDoc = markdownToAdf(back);
    const rePanel = reDoc.content[0] as Extract<AdfNode, { type: "panel" }>;
    expect(rePanel.content.length).toBe(2);
  });
});

// ── ADF-8: list rendering — no trailing-newline explosion, nesting kept ────

describe("ADF-8: list rendering nesting + trailing newlines", () => {
  it("emits one item per line with one trailing newline for a flat 3-item list", () => {
    const adf: AdfNode = {
      type: "doc",
      version: 1,
      content: [
        {
          type: "bulletList",
          content: [
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "one" }] }] },
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "two" }] }] },
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "three" }] }] },
          ],
        },
      ],
    };
    const out = adfToText(adf);
    expect(out).toBe("- one\n- two\n- three\n");
  });

  it("preserves nesting depth in adfToText", () => {
    const adf: AdfNode = {
      type: "doc",
      version: 1,
      content: [
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "a" }] },
                {
                  type: "bulletList",
                  content: [
                    {
                      type: "listItem",
                      content: [
                        { type: "paragraph", content: [{ type: "text", text: "b" }] },
                        {
                          type: "bulletList",
                          content: [
                            {
                              type: "listItem",
                              content: [{ type: "paragraph", content: [{ type: "text", text: "c" }] }],
                            },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const out = adfToText(adf);
    expect(out).toContain("- a");
    expect(out).toContain("  - b");
    expect(out).toContain("    - c");
  });
});

// ── ADF-9: empty admonition has no whitespace-only text child ──────────────

describe("ADF-9: empty admonition body is a clean empty paragraph", () => {
  it("does not emit a whitespace-only text node for `> **Warning:**`", () => {
    const doc = markdownToAdf("> **Warning:**");
    const panel = doc.content[0] as Extract<AdfNode, { type: "panel" }>;
    expect(panel.type).toBe("panel");
    const para = panel.content[0] as Extract<AdfNode, { type: "paragraph" }>;
    // Either zero children or no whitespace-only text node.
    const hasJunk = para.content.some(
      (n) =>
        n.type === "text" &&
        (n as Extract<AdfNode, { type: "text" }>).text.trim() === "" &&
        (n as Extract<AdfNode, { type: "text" }>).text.length > 0,
    );
    expect(hasJunk).toBe(false);
  });
});

// ── ADF-10: combined ***em-strong*** ───────────────────────────────────────

describe("ADF-10: combined emphasis ***strong-em*** parses correctly", () => {
  it("emits a text node with both strong and em marks", () => {
    const doc = markdownToAdf("***strong-em***");
    const para = doc.content[0] as Extract<AdfNode, { type: "paragraph" }>;
    const text = para.content[0] as Extract<AdfNode, { type: "text" }>;
    expect(text.text).toBe("strong-em");
    const types = (text.marks ?? []).map((m) => m.type).sort();
    expect(types).toContain("strong");
    expect(types).toContain("em");
  });
});

// ── ADF-11: link with inline bold preserves marks ──────────────────────────

describe("ADF-11: link label retains inline marks", () => {
  it("emits a strong-marked text node nested inside the link", () => {
    const doc = markdownToAdf("[**bold** text](https://x.com)");
    const para = doc.content[0] as Extract<AdfNode, { type: "paragraph" }>;
    const first = para.content[0] as Extract<AdfNode, { type: "text" }>;
    expect(first.text).toBe("bold");
    const markTypes = (first.marks ?? []).map((m) => m.type).sort();
    // Must have BOTH the link mark and the strong mark.
    expect(markTypes).toContain("link");
    expect(markTypes).toContain("strong");
    // Subsequent text " text" carries only the link mark.
    const second = para.content[1] as Extract<AdfNode, { type: "text" }>;
    expect(second.text.trim()).toBe("text");
    expect((second.marks ?? []).some((m) => m.type === "link")).toBe(true);
  });
});

// ── adf: per-document task counter ─────────────────────────────────────────

describe("adf: taskItem.localId is scoped per markdownToAdf call", () => {
  it("starts the counter at task-1 for every document", () => {
    const first = markdownToAdf("- [ ] one\n- [ ] two");
    const second = markdownToAdf("- [ ] alpha");
    const firstList = first.content[0] as Extract<AdfNode, { type: "taskList" }>;
    const secondList = second.content[0] as Extract<AdfNode, { type: "taskList" }>;
    const firstIds = firstList.content
      .filter((n) => n.type === "taskItem")
      .map((n) => (n as Extract<AdfNode, { type: "taskItem" }>).attrs.localId);
    const secondIds = secondList.content
      .filter((n) => n.type === "taskItem")
      .map((n) => (n as Extract<AdfNode, { type: "taskItem" }>).attrs.localId);
    expect(firstIds).toEqual(["task-1", "task-2"]);
    expect(secondIds).toEqual(["task-1"]);
  });
});

// ── ADV-STORAGE-1 / GEN-2: ragged-row + 3-col with spaces ──────────────────

describe("ADV-STORAGE-1: ragged tables, 3-col-with-spaces, single-col", () => {
  it("recognises a 3-column table whose separator has spaces between dashes", () => {
    const out = markdownToStorage("| A | B | C |\n| --- | --- | --- |\n| 1 | 2 | 3 |");
    expect(out).toContain("<table><tbody>");
    expect(out).toContain("<th>A</th>");
    expect(out).toContain("<th>C</th>");
    expect(out).toContain("<td>1</td>");
    expect(out).toContain("<td>3</td>");
    // Must not fall through to a literal <p> dump.
    expect(out).not.toMatch(/<p>\|/);
  });

  it("pads ragged body rows with empty cells", () => {
    const out = markdownToStorage("| A | B | C |\n| --- | --- | --- |\n| 1 | 2 |");
    expect(out).toContain("<td>1</td>");
    expect(out).toContain("<td>2</td>");
    // Missing third column should render as an empty <td>.
    expect(out).toContain("<td></td>");
  });

  it("ADV-STORAGE-7: parses a single-column table", () => {
    const out = markdownToStorage("| A |\n| --- |\n| 1 |");
    expect(out).toContain("<table><tbody>");
    expect(out).toContain("<th>A</th>");
    expect(out).toContain("<td>1</td>");
    expect(out).not.toMatch(/<p>\|/);
  });
});

// ── ADV-STORAGE-2: prose `> **Note:**` admonitions ──────────────────────────

describe("ADV-STORAGE-2: prose admonitions in blockquote convert to macros", () => {
  it.each([
    ["Note", "note"],
    ["Warning", "warning"],
    ["Tip", "tip"],
    ["Info", "info"],
  ])("converts `> **%s:** body` to a %s macro", (label, macro) => {
    const out = markdownToStorage(`> **${label}:** hello`);
    expect(out).toContain(`<ac:structured-macro ac:name="${macro}">`);
    // The bold prefix should be stripped — body is just the remainder.
    expect(out).not.toContain(`<strong>${label}:</strong>`);
    expect(out).toContain("hello");
  });
});

// ── ADV-STORAGE-3 / PUB-10: header inside <tbody> ───────────────────────────

describe("ADV-STORAGE-3 / PUB-10: canonical Confluence storage shape", () => {
  it("emits header <tr><th> inside <tbody>, no <thead>", () => {
    const out = markdownToStorage("| A | B |\n| --- | --- |\n| 1 | 2 |");
    expect(out).toContain("<table><tbody>");
    expect(out).not.toContain("<thead>");
    expect(out).toContain("<tr><th>A</th><th>B</th></tr>");
    expect(out).toContain("<tr><td>1</td><td>2</td></tr>");
  });
});

// ── ADV-STORAGE-4: relative images emit ri:attachment ──────────────────────

describe("ADV-STORAGE-4: relative image refs become <ri:attachment>", () => {
  it("emits <ri:attachment ri:filename=…> for a bare filename", () => {
    const out = markdownToStorage("![diagram](diagram.png)");
    expect(out).toContain('<ri:attachment ri:filename="diagram.png"/>');
    expect(out).not.toContain('<ri:url ri:value="diagram.png"');
  });

  it("emits <ri:url ri:value=…> for an absolute URL", () => {
    const out = markdownToStorage("![pic](https://example.com/x.png)");
    expect(out).toContain('<ri:url ri:value="https://example.com/x.png"/>');
    expect(out).not.toContain("<ri:attachment");
  });

  it("strips directory prefixes when normalising to attachment filename", () => {
    const out = markdownToStorage("![d](./images/d.png)");
    expect(out).toContain('<ri:attachment ri:filename="d.png"/>');
  });

  it("round-trips a relative image back to the same filename", () => {
    const storage = markdownToStorage("![diagram](diagram.png)");
    const back = htmlToMarkdown(storage);
    expect(back).toContain("![diagram](diagram.png)");
  });
});

// ── ADV-STORAGE-5: ordered lists preserved on round-trip ───────────────────

describe("ADV-STORAGE-5: <ol> not downgraded to <ul>", () => {
  it("htmlToMarkdown renders <ol>/<li> with 1./2./3. markers", () => {
    const html = "<ol><li>one</li><li>two</li><li>three</li></ol>";
    const md = htmlToMarkdown(html);
    expect(md).toContain("1. one");
    expect(md).toContain("2. two");
    expect(md).toContain("3. three");
    expect(md).not.toMatch(/^-\s/m);
  });

  it("round-trips markdown ordered lists through storage and back", () => {
    const storage = markdownToStorage("1. one\n2. two\n3. three");
    const back = htmlToMarkdown(storage);
    expect(back).toContain("1. one");
    expect(back).toContain("2. two");
    expect(back).toContain("3. three");
  });
});

// ── ADV-STORAGE-6: nested lists keep indentation ───────────────────────────

describe("ADV-STORAGE-6: nested <ul> preserved on round-trip", () => {
  it("htmlToMarkdown emits indented child items", () => {
    const html = "<ul><li>a<ul><li>b</li></ul></li><li>c</li></ul>";
    const md = htmlToMarkdown(html);
    expect(md).toContain("- a");
    expect(md).toContain("  - b");
    expect(md).toContain("- c");
    // Critical: 'a' and 'b' must NOT be glued together.
    expect(md).not.toContain("a- b");
    expect(md).not.toContain("a  - b\n- c"); // shape requires \n between siblings
  });

  it("preserves the unordered marker for mixed nested lists", () => {
    const html = "<ol><li>top<ul><li>nested</li></ul></li></ol>";
    const md = htmlToMarkdown(html);
    expect(md).toContain("1. top");
    expect(md).toContain("  - nested");
  });
});

// ── ADV-STORAGE-10 / GEN-3: safeHref allow-list ─────────────────────────────

describe("ADV-STORAGE-10 / GEN-3: safeHref blocks dangerous schemes", () => {
  it.each([
    "javascript:alert(1)",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
    "data:text/html,<script>",
    "mhtml:http://example.com",
  ])("blocks %s", (href) => {
    const out = renderInline(`[click](${href})`);
    expect(out).toContain('href="#"');
    expect(out).not.toContain(href);
  });

  it.each([
    "https://example.com",
    "http://example.com",
    "mailto:user@example.com",
    "tel:+1234567890",
    "#anchor",
    "/relative/path",
    "./relative",
    "filename.png",
  ])("allows %s", (href) => {
    const out = renderInline(`[click](${href})`);
    expect(out).toContain(`href="${href}"`);
  });
});

// ── ADV-STORAGE-11: code-macro trailing newline trimmed ────────────────────

describe("ADV-STORAGE-11: code macro trims wrapping newlines", () => {
  it("does not emit leading or trailing newlines inside CDATA", () => {
    const out = markdownToStorage("```\nline\n```");
    expect(out).toContain("<![CDATA[line]]>");
    expect(out).not.toContain("[CDATA[\nline");
    expect(out).not.toContain("line\n]]>");
  });

  it("preserves INTERNAL blank lines in the code body", () => {
    const out = markdownToStorage("```\na\n\nb\n```");
    expect(out).toContain("<![CDATA[a\n\nb]]>");
  });
});

// ── GEN-1: <script>/<style> survives inside code spans/blocks ──────────────

describe("GEN-1: code spans/blocks are not sanitised", () => {
  it("preserves <script>…</script> inside a fenced code block", () => {
    const out = markdownToStorage("```html\n<script>alert(1)</script>\n```");
    expect(out).toContain('<ac:structured-macro ac:name="code">');
    expect(out).toContain("<script>alert(1)</script>");
    expect(out).not.toContain("<![CDATA[]]>"); // body must not be empty
  });

  it("preserves <style>…</style> inside an inline code span", () => {
    const out = markdownToStorage("`<style>body{}</style>`");
    expect(out).toContain("<code>&lt;style&gt;body{}&lt;/style&gt;</code>");
  });

  it("still strips <script> outside a code region", () => {
    const out = markdownToStorage("hello <script>alert(1)</script> world");
    expect(out).not.toMatch(/<script/i);
    expect(out).not.toContain("alert(1)");
  });
});

// ── GEN-5: tip macro round-trips with the Tip label ─────────────────────────

describe("GEN-5: tip macro is not collapsed to Info", () => {
  it("htmlToMarkdown labels the tip macro as `> **Tip:**`", () => {
    const html =
      '<ac:structured-macro ac:name="tip"><ac:rich-text-body><p>pro move</p></ac:rich-text-body></ac:structured-macro>';
    const md = htmlToMarkdown(html);
    expect(md).toContain("> **Tip:** pro move");
    expect(md).not.toContain("> **Info:** pro move");
  });

  it("round-trips a tip through markdownToStorage → htmlToMarkdown", () => {
    const md = "> **Tip:** pro move";
    const storage = markdownToStorage(md);
    expect(storage).toContain('<ac:structured-macro ac:name="tip">');
    const back = htmlToMarkdown(storage);
    expect(back).toContain("> **Tip:** pro move");
  });
});

// ── XSS guard still intact ─────────────────────────────────────────────────

describe("XSS guard regression: script/style/onclick stripped outside code", () => {
  it("strips <script> blocks in paragraph context", () => {
    const out = markdownToStorage("hi <script>bad()</script> there");
    expect(out).not.toMatch(/<script/i);
    expect(out).not.toContain("bad()");
  });

  it("strips on*= attributes", () => {
    const out = markdownToStorage('text [x](https://example.com) onclick="bad()" tail');
    expect(out).not.toMatch(/\son\w+\s*=/i);
  });

  it("strips <style> blocks in paragraph context", () => {
    const out = markdownToStorage("intro <style>body{}</style> end");
    expect(out).not.toMatch(/<style/i);
  });
});
