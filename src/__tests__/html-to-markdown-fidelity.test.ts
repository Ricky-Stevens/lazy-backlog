/**
 * Stage A — Rich Content Fidelity for Confluence storage HTML.
 *
 * Covers acceptance criteria A1 (shared pipe-table formatter),
 * A3 (Confluence macro rendering), A4 (image preservation).
 */

import { describe, expect, it } from "vitest";
import { MACRO_NESTING_CAP, processMacros } from "../lib/confluence-macros.js";
import { htmlToMarkdown } from "../lib/html-to-markdown.js";

// ── A1: Shared pipe-table formatter ────────────────────────────────────────

describe("htmlToMarkdown — tables (A1)", () => {
  it("emits a single header + separator + body row pipe table for <table>", () => {
    const html = "<table><tr><th>Name</th><th>Value</th></tr><tr><td>Foo</td><td>Bar</td></tr></table>";
    const md = htmlToMarkdown(html);
    expect(md).toContain("| Name | Value |");
    expect(md).toContain("| --- | --- |");
    expect(md).toContain("| Foo | Bar |");
    // Header separator must appear exactly once (not duplicated by row replacer)
    expect(md.match(/\| --- \| --- \|/g)?.length).toBe(1);
  });

  it("escapes literal pipes inside cells", () => {
    const html = "<table><tr><th>Cmd</th></tr><tr><td>a | b</td></tr></table>";
    const md = htmlToMarkdown(html);
    expect(md).toContain("a \\| b");
  });
});

// ── A3: Confluence macros ──────────────────────────────────────────────────

describe("htmlToMarkdown — Confluence macros (A3)", () => {
  it.each([
    ["info", "Info"],
    ["note", "Note"],
    ["warning", "Warning"],
    ["tip", "Tip"],
  ])("renders <ac:structured-macro ac:name='%s'> as a `> **%s:**` admonition", (name, label) => {
    const html = `<ac:structured-macro ac:name="${name}"><ac:rich-text-body><p>Heads up</p></ac:rich-text-body></ac:structured-macro>`;
    const md = htmlToMarkdown(html);
    expect(md).toContain(`> **${label}:** Heads up`);
  });

  it("renders the code macro as a fenced block with the declared language", () => {
    const html =
      '<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">typescript</ac:parameter><ac:plain-text-body><![CDATA[const x: number = 1;]]></ac:plain-text-body></ac:structured-macro>';
    const md = htmlToMarkdown(html);
    expect(md).toContain("```typescript");
    expect(md).toContain("const x: number = 1;");
    expect(md).toContain("```");
  });

  it("renders the expand macro as a bolded title + body", () => {
    const html =
      '<ac:structured-macro ac:name="expand"><ac:parameter ac:name="title">Show details</ac:parameter><ac:rich-text-body><p>Hidden content</p></ac:rich-text-body></ac:structured-macro>';
    const md = htmlToMarkdown(html);
    expect(md).toContain("**Show details**");
    expect(md).toContain("Hidden content");
  });

  it("renders the status macro as inline code with optional colour", () => {
    const html =
      '<ac:structured-macro ac:name="status"><ac:parameter ac:name="title">In Progress</ac:parameter><ac:parameter ac:name="colour">Yellow</ac:parameter></ac:structured-macro>';
    expect(htmlToMarkdown(html)).toContain("`In Progress` (Yellow)");
  });

  it("skips the toc macro cleanly with no error", () => {
    const html =
      '<p>Above</p><ac:structured-macro ac:name="toc"><ac:parameter ac:name="maxLevel">3</ac:parameter></ac:structured-macro><p>Below</p>';
    const md = htmlToMarkdown(html);
    expect(md).toContain("Above");
    expect(md).toContain("Below");
    expect(md).not.toContain("toc");
  });

  it("renders a jira issue macro as an issue key, linkable when serverId is a URL", () => {
    const html =
      '<ac:structured-macro ac:name="jira"><ac:parameter ac:name="key">ABC-123</ac:parameter><ac:parameter ac:name="server">https://example.atlassian.net</ac:parameter></ac:structured-macro>';
    expect(htmlToMarkdown(html)).toContain("[ABC-123](https://example.atlassian.net/browse/ABC-123)");
  });

  it("renders an unknown macro by falling back to its inner text (never throws)", () => {
    const html =
      '<ac:structured-macro ac:name="some-unknown-macro"><ac:rich-text-body><p>fallback content</p></ac:rich-text-body></ac:structured-macro>';
    expect(htmlToMarkdown(html)).toContain("fallback content");
  });

  // GEN-6: when the macro processor's outer unpeeling loop hits its safety
  // cap before reaching the fixed point, it MUST surface a visible marker
  // — silently returning half-converted HTML hides the failure from callers.
  // We test processMacros directly with an identity convertInner so the
  // cap is exercised by raw nested macros (htmlToMarkdown's recursive
  // pipeline collapses them in one pass).
  it("emits a partial-conversion marker when macro nesting exceeds the cap (GEN-6)", () => {
    let html = "<p>inner</p>";
    for (let i = 0; i < MACRO_NESTING_CAP + 10; i++) {
      html = `<ac:structured-macro ac:name="info"><ac:rich-text-body>${html}</ac:rich-text-body></ac:structured-macro>`;
    }
    const out = processMacros(html, (x) => x);
    expect(out).toMatch(/macro nesting cap/i);
  });

  it("keeps stripping <script> and <style> (security invariant)", () => {
    const html =
      '<style>.bad{}</style><script>alert(1)</script><ac:structured-macro ac:name="info"><ac:rich-text-body><p>Body</p></ac:rich-text-body></ac:structured-macro>';
    const md = htmlToMarkdown(html);
    expect(md).not.toContain("alert(1)");
    expect(md).not.toContain(".bad");
    expect(md).toContain("Body");
  });
});

// ── A4: Image preservation ─────────────────────────────────────────────────

describe("htmlToMarkdown — images (A4)", () => {
  it("converts <img> to markdown image syntax with alt + src", () => {
    const html = '<p>Hi <img src="https://example.com/x.png" alt="x"/></p>';
    expect(htmlToMarkdown(html)).toContain("![x](https://example.com/x.png)");
  });

  it("converts <ac:image><ri:url> to markdown image syntax", () => {
    const html = '<ac:image ac:alt="diagram"><ri:url ri:value="https://example.com/img.png"/></ac:image>';
    expect(htmlToMarkdown(html)).toContain("![diagram](https://example.com/img.png)");
  });

  it("converts <ac:image><ri:attachment> using baseUrl to build a download URL", () => {
    const html = '<ac:image ac:alt="diagram"><ri:attachment ri:filename="diagram.png"/></ac:image>';
    const md = htmlToMarkdown(html, { baseUrl: "https://example.atlassian.net/wiki" });
    expect(md).toContain("![diagram](https://example.atlassian.net/wiki/download/attachments/diagram.png)");
  });

  it("falls back to filename as alt when ac:alt missing", () => {
    const html = '<ac:image><ri:attachment ri:filename="screenshot.png"/></ac:image>';
    const md = htmlToMarkdown(html);
    expect(md).toContain("![screenshot.png](screenshot.png)");
  });

  it("applies an attachment manifest to rewrite filename refs to absolute URLs", () => {
    const html = '<ac:image><ri:attachment ri:filename="diagram.png"/></ac:image>';
    const md = htmlToMarkdown(html, {
      attachmentUrls: { "diagram.png": "https://cdn.example.com/diagram.png" },
    });
    expect(md).toContain("![diagram.png](https://cdn.example.com/diagram.png)");
  });
});
