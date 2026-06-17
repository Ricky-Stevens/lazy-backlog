/**
 * Stage A — Rich Content Fidelity for ADF (markdown ↔ ADF).
 *
 * Covers acceptance criteria A1 (tables both ways), A2 (panels + blockquotes
 * both ways), and A4 (image/media preservation both ways).
 */

import { describe, expect, it } from "vitest";
import { type AdfNode, adfToText, markdownToAdf } from "../lib/adf.js";

// ── A1: Tables ─────────────────────────────────────────────────────────────

describe("markdownToAdf — pipe tables (A1)", () => {
  it("parses a header row + separator + body rows into an ADF table", () => {
    const md = ["| Name | Value |", "| --- | --- |", "| Foo | 1 |", "| Bar | 2 |"].join("\n");
    const doc = markdownToAdf(md);
    const table = doc.content.find((n) => n.type === "table") as Extract<AdfNode, { type: "table" }>;
    expect(table).toBeDefined();
    expect(table.content).toHaveLength(3); // header row + 2 body rows

    const headerRow = table.content[0] as Extract<AdfNode, { type: "tableRow" }>;
    expect(headerRow.content[0]?.type).toBe("tableHeader");
    const firstHeader = headerRow.content[0] as Extract<AdfNode, { type: "tableHeader" }>;
    const para = firstHeader.content[0] as Extract<AdfNode, { type: "paragraph" }>;
    expect(para.content[0]).toMatchObject({ type: "text", text: "Name" });

    const bodyRow = table.content[1] as Extract<AdfNode, { type: "tableRow" }>;
    expect(bodyRow.content[0]?.type).toBe("tableCell");
  });

  it("preserves inline marks inside table cells", () => {
    const md = ["| Field | Note |", "| --- | --- |", "| `id` | **required** |"].join("\n");
    const doc = markdownToAdf(md);
    const text = adfToText(doc);
    expect(text).toContain("`id`");
    expect(text).toContain("**required**");
  });

  it("ignores a non-table line containing pipes (no separator)", () => {
    const md = "Just a | bar | character";
    const doc = markdownToAdf(md);
    expect(doc.content.some((n) => n.type === "table")).toBe(false);
  });
});

describe("adfToText — pipe tables (A1)", () => {
  it("renders an ADF table as a markdown pipe table with header + separator", () => {
    const adf: AdfNode = {
      type: "doc",
      version: 1,
      content: [
        {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [
                { type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text: "A" }] }] },
                { type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text: "B" }] }] },
              ],
            },
            {
              type: "tableRow",
              content: [
                { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "1" }] }] },
                { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "2" }] }] },
              ],
            },
          ],
        },
      ],
    };
    const text = adfToText(adf);
    expect(text).toContain("| A | B |");
    expect(text).toContain("| --- | --- |");
    expect(text).toContain("| 1 | 2 |");
  });

  it("does not flatten table cells into a run of text", () => {
    const adf: AdfNode = {
      type: "doc",
      version: 1,
      content: [
        {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [
                { type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text: "X" }] }] },
              ],
            },
          ],
        },
      ],
    };
    expect(adfToText(adf)).toContain("|");
  });
});

describe("round-trip tables (A1)", () => {
  it("markdown → ADF → markdown produces an equivalent pipe table", () => {
    const md = ["| Col1 | Col2 |", "| --- | --- |", "| foo | bar |"].join("\n");
    const back = adfToText(markdownToAdf(md));
    expect(back).toContain("| Col1 | Col2 |");
    expect(back).toContain("| --- | --- |");
    expect(back).toContain("| foo | bar |");
  });
});

// ── A2: Panels and blockquotes ─────────────────────────────────────────────

describe("markdownToAdf — blockquotes & panels (A2)", () => {
  it("parses a plain blockquote into an ADF blockquote node", () => {
    const doc = markdownToAdf("> a quote\n> spanning lines");
    const q = doc.content[0] as Extract<AdfNode, { type: "blockquote" }>;
    expect(q.type).toBe("blockquote");
    expect(q.content[0]?.type).toBe("paragraph");
  });

  it.each([
    ["Info", "info"],
    ["Note", "note"],
    ["Warning", "warning"],
    ["Success", "success"],
    ["Error", "error"],
  ])("parses '> **%s:** …' as a panel with panelType %s", (label, expected) => {
    const doc = markdownToAdf(`> **${label}:** something important`);
    const panel = doc.content[0] as Extract<AdfNode, { type: "panel" }>;
    expect(panel.type).toBe("panel");
    expect(panel.attrs.panelType).toBe(expected);
  });
});

describe("adfToText — blockquotes & panels (A2)", () => {
  it("renders a blockquote with `> ` prefixes", () => {
    const adf: AdfNode = {
      type: "doc",
      version: 1,
      content: [
        {
          type: "blockquote",
          content: [{ type: "paragraph", content: [{ type: "text", text: "quoted line" }] }],
        },
      ],
    };
    expect(adfToText(adf)).toContain("> quoted line");
  });

  it.each([
    ["info", "Info"],
    ["note", "Note"],
    ["warning", "Warning"],
    ["success", "Success"],
    ["error", "Error"],
  ])("renders a %s panel with the %s label", (panelType, label) => {
    const adf: AdfNode = {
      type: "doc",
      version: 1,
      content: [
        {
          type: "panel",
          attrs: { panelType: panelType as "info" | "note" | "warning" | "success" | "error" },
          content: [{ type: "paragraph", content: [{ type: "text", text: "heads up" }] }],
        },
      ],
    };
    const text = adfToText(adf);
    expect(text).toContain(`> **${label}:** heads up`);
  });

  it("never silently drops a panel — empty content still produces a labelled marker", () => {
    const adf: AdfNode = {
      type: "doc",
      version: 1,
      content: [{ type: "panel", attrs: { panelType: "warning" }, content: [] }],
    };
    expect(adfToText(adf)).toContain("> **Warning:**");
  });
});

describe("round-trip blockquotes & panels (A2)", () => {
  it.each([
    "info",
    "note",
    "warning",
    "success",
    "error",
  ])("round-trips a %s panel without losing the panel type", (panelType) => {
    const label = panelType.charAt(0).toUpperCase() + panelType.slice(1);
    const md = `> **${label}:** caution`;
    const doc = markdownToAdf(md);
    const back = adfToText(doc);
    expect(back).toContain(`> **${label}:** caution`);
    const panel = doc.content[0] as Extract<AdfNode, { type: "panel" }>;
    expect(panel.type).toBe("panel");
    expect(panel.attrs.panelType).toBe(panelType);
  });

  it("round-trips a plain blockquote — single paragraph", () => {
    const md = "> first line";
    const back = adfToText(markdownToAdf(md));
    expect(back).toContain("> first line");
  });

  it("round-trips a multi-paragraph blockquote (blank line separator)", () => {
    const md = "> first\n>\n> second";
    const back = adfToText(markdownToAdf(md));
    expect(back).toContain("> first");
    expect(back).toContain("> second");
  });
});

// ── A4: Image / media preservation ─────────────────────────────────────────

describe("markdownToAdf — images (A4)", () => {
  it("parses ![alt](https://…) into an external media node", () => {
    const doc = markdownToAdf("![diagram](https://example.com/img.png)");
    // standalone images on their own line wrap in mediaSingle
    const ms = doc.content[0] as Extract<AdfNode, { type: "mediaSingle" }>;
    expect(ms.type).toBe("mediaSingle");
    const media = ms.content[0] as Extract<AdfNode, { type: "media" }>;
    expect(media.type).toBe("media");
    expect(media.attrs.type).toBe("external");
    expect(media.attrs.url).toBe("https://example.com/img.png");
    expect(media.attrs.alt).toBe("diagram");
  });

  it("parses an inline image inside a paragraph", () => {
    const doc = markdownToAdf("See ![logo](https://example.com/logo.png) here");
    const para = doc.content[0] as Extract<AdfNode, { type: "paragraph" }>;
    const media = para.content.find((n) => n.type === "media") as Extract<AdfNode, { type: "media" }>;
    expect(media).toBeDefined();
    expect(media.attrs.url).toBe("https://example.com/logo.png");
  });

  it("parses ![alt](media:collection/id) into a file media node", () => {
    const doc = markdownToAdf("![sketch](media:designs/abc-123)");
    const ms = doc.content[0] as Extract<AdfNode, { type: "mediaSingle" }>;
    const media = ms.content[0] as Extract<AdfNode, { type: "media" }>;
    expect(media.attrs.type).toBe("file");
    expect(media.attrs.id).toBe("abc-123");
    expect(media.attrs.collection).toBe("designs");
  });
});

describe("adfToText — media (A4)", () => {
  it("renders mediaSingle / media as markdown image syntax", () => {
    const adf: AdfNode = {
      type: "doc",
      version: 1,
      content: [
        {
          type: "mediaSingle",
          content: [
            {
              type: "media",
              attrs: { type: "external", url: "https://example.com/x.png", alt: "x" },
            },
          ],
        },
      ],
    };
    expect(adfToText(adf)).toContain("![x](https://example.com/x.png)");
  });

  it("renders a file media reference using collection/id when no url present", () => {
    const adf: AdfNode = {
      type: "doc",
      version: 1,
      content: [
        {
          type: "mediaSingle",
          content: [
            {
              type: "media",
              attrs: { type: "file", id: "abc-123", collection: "designs", alt: "diagram" },
            },
          ],
        },
      ],
    };
    expect(adfToText(adf)).toContain("![diagram](media:designs/abc-123)");
  });

  it("renders mediaGroup nodes without silencing them", () => {
    const adf: AdfNode = {
      type: "doc",
      version: 1,
      content: [
        {
          type: "mediaGroup",
          content: [
            { type: "media", attrs: { type: "external", url: "https://example.com/a.png", alt: "a" } },
            { type: "media", attrs: { type: "external", url: "https://example.com/b.png", alt: "b" } },
          ],
        },
      ],
    };
    const text = adfToText(adf);
    expect(text).toContain("![a](https://example.com/a.png)");
    expect(text).toContain("![b](https://example.com/b.png)");
  });
});

describe("round-trip images (A4)", () => {
  it("markdown → ADF → markdown preserves external images", () => {
    const md = "![diagram](https://example.com/img.png)";
    const back = adfToText(markdownToAdf(md));
    expect(back).toContain("![diagram](https://example.com/img.png)");
  });
});
