/**
 * Atlassian Document Format (ADF) node types.
 *
 * Kept in its own file so converters (`adf-render.ts`) and parsers
 * (`adf.ts`) can share the discriminated union without circular imports.
 */

/** A text mark (strong / em / code / link). */
export type AdfMark = { type: string; attrs?: Record<string, string> };

/** Panel admonition kinds supported by Confluence/Jira ADF. */
export type AdfPanelType = "info" | "note" | "warning" | "success" | "error";

/** Minimal ADF node types covering Jira description fidelity needs. */
export type AdfNode =
  | { type: "doc"; version: 1; content: AdfNode[] }
  | { type: "paragraph"; content: AdfNode[] }
  | { type: "heading"; attrs: { level: number }; content: AdfNode[] }
  | { type: "text"; text: string; marks?: AdfMark[] }
  | { type: "bulletList"; content: AdfNode[] }
  | { type: "orderedList"; content: AdfNode[] }
  | { type: "listItem"; content: AdfNode[] }
  | { type: "taskList"; attrs: { localId: string }; content: AdfNode[] }
  | { type: "taskItem"; attrs: { localId: string; state: "TODO" | "DONE" }; content: AdfNode[] }
  | { type: "codeBlock"; attrs?: { language?: string }; content: AdfNode[] }
  | { type: "blockquote"; content: AdfNode[] }
  | { type: "panel"; attrs: { panelType: AdfPanelType }; content: AdfNode[] }
  | { type: "table"; attrs?: { isNumberColumnEnabled?: boolean; layout?: string }; content: AdfNode[] }
  | { type: "tableRow"; content: AdfNode[] }
  | { type: "tableHeader"; attrs?: Record<string, unknown>; content: AdfNode[] }
  | { type: "tableCell"; attrs?: Record<string, unknown>; content: AdfNode[] }
  | {
      type: "mediaSingle";
      attrs?: { layout?: string };
      content: AdfNode[];
    }
  | { type: "mediaGroup"; content: AdfNode[] }
  | {
      type: "media";
      attrs: {
        type?: "file" | "external" | "link";
        id?: string;
        collection?: string;
        url?: string;
        alt?: string;
        width?: number;
        height?: number;
      };
    }
  | { type: "rule" }
  | { type: "hardBreak" };
