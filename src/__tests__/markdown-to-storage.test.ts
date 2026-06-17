import { describe, expect, it } from "vitest";
import { htmlToMarkdown } from "../lib/html-to-markdown.js";
import { markdownToStorage, renderInline } from "../lib/markdown-to-storage.js";

describe("markdownToStorage", () => {
  // ── Headings ──────────────────────────────────────────────────────────

  describe("headings", () => {
    it("emits <h1>..<h6> for # through ######", () => {
      const out = markdownToStorage("# One\n## Two\n### Three\n#### Four\n##### Five\n###### Six");
      expect(out).toContain("<h1>One</h1>");
      expect(out).toContain("<h2>Two</h2>");
      expect(out).toContain("<h3>Three</h3>");
      expect(out).toContain("<h4>Four</h4>");
      expect(out).toContain("<h5>Five</h5>");
      expect(out).toContain("<h6>Six</h6>");
    });
  });

  // ── Inline marks ──────────────────────────────────────────────────────

  describe("inline marks", () => {
    it("emits <strong> for **bold** and __bold__", () => {
      expect(renderInline("**hi**")).toBe("<strong>hi</strong>");
      expect(renderInline("__hi__")).toBe("<strong>hi</strong>");
    });

    it("emits <em> for *italic* and _italic_", () => {
      expect(renderInline("*hi*")).toBe("<em>hi</em>");
      expect(renderInline("_hi_")).toBe("<em>hi</em>");
    });

    it("emits <code> for `inline code` and escapes contents", () => {
      expect(renderInline("`a<b>c`")).toBe("<code>a&lt;b&gt;c</code>");
    });

    it("escapes lone XML characters in plain text", () => {
      expect(renderInline("a & b < c")).toBe("a &amp; b &lt; c");
    });
  });

  // ── Links ─────────────────────────────────────────────────────────────

  describe("links", () => {
    it("emits <a href> for [text](url)", () => {
      expect(renderInline("[click](https://example.com)")).toBe('<a href="https://example.com">click</a>');
    });

    it("blocks javascript: URLs", () => {
      const out = renderInline("[x](javascript:alert(1))");
      expect(out).toContain('href="#"');
      expect(out).not.toContain("javascript:");
    });

    it("blocks data: URLs", () => {
      const out = renderInline("[x](data:text/html,<script>1</script>)");
      expect(out).toContain('href="#"');
    });
  });

  // ── Lists ─────────────────────────────────────────────────────────────

  describe("lists", () => {
    it("emits <ul>/<li> for - bullet items", () => {
      const out = markdownToStorage("- one\n- two\n- three");
      expect(out).toBe("<ul><li>one</li><li>two</li><li>three</li></ul>");
    });

    it("emits <ol>/<li> for 1. numbered items", () => {
      const out = markdownToStorage("1. one\n2. two");
      expect(out).toBe("<ol><li>one</li><li>two</li></ol>");
    });

    it("supports nested lists via indentation", () => {
      const out = markdownToStorage("- top\n  - nested\n- top2");
      expect(out).toContain("<ul><li>top<ul><li>nested</li></ul></li><li>top2</li></ul>");
    });
  });

  // ── Code blocks ───────────────────────────────────────────────────────

  describe("fenced code blocks", () => {
    it("wraps in a code macro with language parameter", () => {
      const out = markdownToStorage("```typescript\nconst x = 1;\n```");
      expect(out).toContain('<ac:structured-macro ac:name="code">');
      expect(out).toContain('<ac:parameter ac:name="language">typescript</ac:parameter>');
      expect(out).toContain("<![CDATA[const x = 1;]]>");
    });

    it("omits language parameter when not specified", () => {
      const out = markdownToStorage("```\nhi\n```");
      expect(out).toContain('<ac:structured-macro ac:name="code">');
      expect(out).not.toContain('ac:name="language"');
      expect(out).toContain("<![CDATA[hi]]>");
    });

    it("escapes ]]> sequences inside code body", () => {
      const out = markdownToStorage("```\nfoo]]>bar\n```");
      // Documents the canonical escape sequence is present.
      expect(out).toContain("]]]]><![CDATA[>");

      // TEST-10: positive round-trip — concatenate every CDATA payload and
      // assert it reconstructs the original body verbatim. A regression that
      // doubled or mis-positioned the escape would fail this even though the
      // substring above would still match.
      const cdataChunks = Array.from(out.matchAll(/<!\[CDATA\[([\s\S]*?)]]>/g), (m) => m[1] ?? "");
      expect(cdataChunks.join("")).toBe("foo]]>bar");
    });

    it("preserves <script> inside fenced code blocks (XSS guard scope — code is inert)", () => {
      // general finding: previously the whole-document sanitiser ran BEFORE
      // block parsing and ate `<script>` even inside fenced code. The fix
      // routes code bodies through CDATA without ever touching the sanitiser.
      const out = markdownToStorage("```html\n<script>x</script>\n```");
      expect(out).toContain("<![CDATA[<script>x</script>]]>");
      const cdataChunks = Array.from(out.matchAll(/<!\[CDATA\[([\s\S]*?)]]>/g), (m) => m[1] ?? "");
      expect(cdataChunks.join("")).toBe("<script>x</script>");
    });
  });

  // ── Tables ────────────────────────────────────────────────────────────

  describe("tables", () => {
    it("emits the canonical Confluence storage shape: header <tr><th> inside <tbody>", () => {
      const md = ["| A | B |", "|---|---|", "| 1 | 2 |", "| 3 | 4 |"].join("\n");
      const out = markdownToStorage(md);
      expect(out).toContain("<table><tbody>");
      // No separate <thead> wrapper (ADV-STORAGE-3 / PUB-10)
      expect(out).not.toContain("<thead>");
      expect(out).toContain("<tr><th>A</th><th>B</th></tr>");
      expect(out).toContain("<tr><td>1</td><td>2</td></tr>");
      expect(out).toContain("<tr><td>3</td><td>4</td></tr>");
    });

    it("renders inline marks inside table cells", () => {
      const md = ["| A | B |", "|---|---|", "| **bold** | `code` |"].join("\n");
      const out = markdownToStorage(md);
      expect(out).toContain("<td><strong>bold</strong></td>");
      expect(out).toContain("<td><code>code</code></td>");
    });

    // TEST-1: assert the *structure* (one tbody, header row contains <th>),
    // not the exact byte layout. Combined with the round-trip test below this
    // catches both shape regressions and renderer drift.
    it("emits exactly one <tbody> and header cells use <th>", () => {
      const out = markdownToStorage("| A | B |\n|---|---|\n| 1 | 2 |");
      const tbodyCount = (out.match(/<tbody>/g) ?? []).length;
      const tbodyCloseCount = (out.match(/<\/tbody>/g) ?? []).length;
      expect(tbodyCount).toBe(1);
      expect(tbodyCloseCount).toBe(1);
      // Header cells must be <th>, regardless of whether they sit in a
      // <thead> or directly in <tbody> — the test should not lock either choice.
      const headerRow = out.match(/<tr>[^<]*<th>[\s\S]*?<\/tr>/);
      expect(headerRow).not.toBeNull();
      expect(headerRow?.[0]).toContain("<th>A</th>");
      expect(headerRow?.[0]).toContain("<th>B</th>");
    });

    // Round-trip storage → markdown → storage preserves a table.
    it("storage → markdown → storage preserves a table", () => {
      const md = "| A | B |\n|---|---|\n| 1 | 2 |";
      const storage = markdownToStorage(md);
      const back = htmlToMarkdown(storage);
      const back2 = markdownToStorage(back);
      expect(back2).toContain("<table>");
      expect(back2).toContain("<th>A</th>");
      expect(back2).toContain("<th>B</th>");
      expect(back2).toContain("<td>1</td>");
      expect(back2).toContain("<td>2</td>");
    });
  });

  // ── Blockquotes & admonitions ─────────────────────────────────────────

  describe("blockquotes and admonitions", () => {
    it("emits <blockquote> for >-prefixed lines", () => {
      const out = markdownToStorage("> heads up\n> second line");
      expect(out).toContain("<blockquote>");
      expect(out).toContain("<p>heads up\nsecond line</p>");
    });

    it("emits info macro for [!INFO] prefix", () => {
      const out = markdownToStorage("> [!INFO]\n> something useful");
      expect(out).toContain('<ac:structured-macro ac:name="info">');
      expect(out).toContain("<ac:rich-text-body>");
    });

    it("emits note macro for [!NOTE] prefix", () => {
      const out = markdownToStorage("> [!NOTE]\n> see also");
      expect(out).toContain('<ac:structured-macro ac:name="note">');
    });

    it("emits warning macro for [!WARNING] prefix", () => {
      const out = markdownToStorage("> [!WARNING]\n> danger");
      expect(out).toContain('<ac:structured-macro ac:name="warning">');
    });

    it("emits tip macro for [!TIP] prefix", () => {
      const out = markdownToStorage("> [!TIP]\n> pro move");
      expect(out).toContain('<ac:structured-macro ac:name="tip">');
    });
  });

  // ── Images ────────────────────────────────────────────────────────────

  describe("images", () => {
    it("emits <ac:image><ri:url> for ![alt](url)", () => {
      const out = renderInline("![logo](https://example.com/a.png)");
      expect(out).toContain('<ac:image ac:alt="logo">');
      expect(out).toContain('<ri:url ri:value="https://example.com/a.png"/>');
      expect(out).toContain("</ac:image>");
    });
  });

  // ── XSS guard ─────────────────────────────────────────────────────────

  describe("XSS guard", () => {
    it("strips <script> tags from input", () => {
      const out = markdownToStorage("hello <script>alert(1)</script> world");
      expect(out).not.toMatch(/<script/i);
      expect(out).not.toContain("alert(1)");
    });

    it("strips <style> tags from input", () => {
      const out = markdownToStorage("intro <style>body{display:none}</style> end");
      expect(out).not.toMatch(/<style/i);
      expect(out).not.toContain("display:none");
    });

    it("strips on*= event-handler attributes", () => {
      const out = markdownToStorage('Click [me](https://example.com) onclick="bad()"');
      expect(out).not.toMatch(/\son\w+\s*=/i);
    });

    it("strips iframe / object / embed", () => {
      const out = markdownToStorage("<iframe src='x'></iframe><object data='x'></object>");
      expect(out).not.toMatch(/<iframe/i);
      expect(out).not.toMatch(/<object/i);
    });

    it("never emits a raw < or > from a sanitised payload outside known tags", () => {
      // Plain angle brackets in text are escaped.
      const out = markdownToStorage("a < b and b > c");
      expect(out).toContain("a &lt; b");
      expect(out).toContain("b &gt; c");

      // TEST-15: the toContain assertions alone don't enforce the spirit of
      // the test name (a leaked `<foo>` elsewhere would pass). Strip every
      // structural tag we know we emit, then assert no `<` or `>` survives.
      // ac: / ri: namespace tags (Confluence storage), self-closing variants,
      // and CDATA wrappers all count as expected.
      const stripped = out
        .replace(/<!\[CDATA\[[\s\S]*?]]>/g, "") // CDATA blocks
        .replace(/<\/?(p|strong|em|code|h[1-6]|ul|ol|li|table|thead|tbody|tr|th|td|blockquote|hr|a|br)\b[^>]*>/g, "")
        .replace(/<\/?(ac|ri):[a-z-]+\b[^>]*>/g, "");
      expect(stripped).not.toMatch(/[<>]/);
    });
  });

  // ── Round-trip sanity ──────────────────────────────────────────────────

  describe("round-trip storage → markdown → storage", () => {
    it("preserves core structure for a representative document", () => {
      const originalStorage =
        "<h1>Title</h1>" +
        "<p>Some <strong>bold</strong> and <em>italic</em> text with <code>code</code>.</p>" +
        "<ul><li>one</li><li>two</li></ul>" +
        '<ac:structured-macro ac:name="code">' +
        '<ac:parameter ac:name="language">javascript</ac:parameter>' +
        "<ac:plain-text-body><![CDATA[const x = 1;]]></ac:plain-text-body>" +
        "</ac:structured-macro>";

      const md = htmlToMarkdown(originalStorage);
      const back = markdownToStorage(md);

      // Round-trip should preserve the recognisable structures, even if the
      // exact byte layout differs.
      expect(back).toContain("<h1>Title</h1>");
      expect(back).toContain("<strong>bold</strong>");
      expect(back).toContain("<em>italic</em>");
      expect(back).toContain("<code>code</code>");
      expect(back).toContain("<ul>");
      expect(back).toContain("<li>one</li>");
      expect(back).toContain("<li>two</li>");
      expect(back).toContain('<ac:structured-macro ac:name="code">');
      expect(back).toContain("const x = 1;");
    });
  });

  // ── Edge cases ─────────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("returns empty string for empty input", () => {
      expect(markdownToStorage("")).toBe("");
    });

    it("normalises CRLF line endings", () => {
      const out = markdownToStorage("# A\r\n## B");
      expect(out).toContain("<h1>A</h1>");
      expect(out).toContain("<h2>B</h2>");
    });

    it("wraps plain text in <p>", () => {
      expect(markdownToStorage("just some text")).toBe("<p>just some text</p>");
    });

    it("emits <hr/> for horizontal rules", () => {
      expect(markdownToStorage("---")).toBe("<hr/>");
    });
  });

  // ── Defect regressions ────────────────────────────────────────────────

  describe("PUB-2: balanced parens in link URLs", () => {
    it("preserves parens in Wikipedia-style disambiguation URLs", () => {
      const out = markdownToStorage("[wiki](https://en.wikipedia.org/wiki/Foo_(bar))");
      // The URL must terminate at the OUTER closing paren — not the first one.
      expect(out).toContain('href="https://en.wikipedia.org/wiki/Foo_(bar)"');
      // No trailing literal `)` leaking into the paragraph text.
      expect(out).toBe('<p><a href="https://en.wikipedia.org/wiki/Foo_(bar)">wiki</a></p>');
    });

    it("preserves nested parens in image URLs", () => {
      const out = markdownToStorage("![logo](https://cdn.example.com/img/foo_(bar)_(baz).png)");
      expect(out).toContain('ri:value="https://cdn.example.com/img/foo_(bar)_(baz).png"');
    });

    it("still neutralises javascript: in a paren-containing URL", () => {
      const out = markdownToStorage("[evil](javascript:bad(1))");
      expect(out).toContain('href="#"');
      expect(out).not.toContain("javascript:");
    });
  });

  describe("GEN: single-column tables (general finding)", () => {
    it("emits a <table> for a single-column markdown table", () => {
      const out = markdownToStorage("| A |\n| --- |\n| 1 |");
      // The classic regression: parsePipeTable rejected single-column inputs
      // and the renderer fell back to <p>| A |\n…</p>.
      expect(out).toContain("<table>");
      expect(out).toContain("<th>A</th>");
      expect(out).toContain("<td>1</td>");
      expect(out).not.toMatch(/<p>\|/);
    });
  });

  describe("PUB-8: tables with ragged rows", () => {
    it("renders a 3-column table even when a body row has 2 cells", () => {
      const md = "| A | B | C |\n| --- | --- | --- |\n| 1 | 2 |";
      const out = markdownToStorage(md);
      // Critical: the input must be parsed as a TABLE, not demoted to <p>.
      expect(out).toContain("<table>");
      expect(out).toContain("<tr><th>A</th><th>B</th><th>C</th></tr>");
      // The short row pads to the header width with an empty cell.
      expect(out).toContain("<tr><td>1</td><td>2</td><td></td></tr>");
      // And there's no leaking <p>| A | B | … markdown text fallback.
      expect(out).not.toMatch(/<p>\| A \|/);
    });

    it("renders a 3-column table when a body row has 4 cells (over-wide)", () => {
      const md = "| A | B | C |\n| --- | --- | --- |\n| 1 | 2 | 3 | 4 |";
      const out = markdownToStorage(md);
      expect(out).toContain("<table>");
      // Only the first 3 cells become <td> — the 4th is dropped (header width wins).
      expect(out).toContain("<tr><td>1</td><td>2</td><td>3</td></tr>");
    });
  });

  describe("PUB-9: prose-style admonitions (`> **Note:**`)", () => {
    it("emits a note macro for `> **Note:** …`", () => {
      const out = markdownToStorage("> **Note:** be careful");
      expect(out).toContain('<ac:structured-macro ac:name="note">');
      expect(out).toContain("be careful");
      // Must NOT be a plain blockquote.
      expect(out).not.toMatch(/<blockquote>.*<strong>Note/i);
    });

    it("emits a warning macro for `> **Warning:** …`", () => {
      const out = markdownToStorage("> **Warning:** big change");
      expect(out).toContain('<ac:structured-macro ac:name="warning">');
    });

    it("emits a tip macro for `> **Tip:** …`", () => {
      const out = markdownToStorage("> **Tip:** pro move");
      expect(out).toContain('<ac:structured-macro ac:name="tip">');
    });

    it("emits an info macro for `> **Info:** …`", () => {
      const out = markdownToStorage("> **Info:** FYI");
      expect(out).toContain('<ac:structured-macro ac:name="info">');
    });
  });
});
