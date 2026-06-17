/**
 * Tests for the Confluence webui URL normaliser (PUB-7).
 *
 * The defect: read paths concatenated `${baseUrl}/wiki${webui}` even when
 * `webui` already started with `/wiki/`, producing `/wiki/wiki/...` URLs
 * surfaced back to the LLM and user.
 */

import { describe, expect, it } from "vitest";
import { buildConfluenceWebUrl } from "../lib/confluence-write.js";

describe("buildConfluenceWebUrl (PUB-7)", () => {
  it("does not double-prepend /wiki when webui already starts with /wiki/", () => {
    const url = buildConfluenceWebUrl("https://test.atlassian.net", "/wiki/spaces/ENG/pages/999");
    expect(url).toBe("https://test.atlassian.net/wiki/spaces/ENG/pages/999");
  });

  it("prepends /wiki when webui is the tail only", () => {
    const url = buildConfluenceWebUrl("https://test.atlassian.net", "/spaces/ENG/pages/999");
    expect(url).toBe("https://test.atlassian.net/wiki/spaces/ENG/pages/999");
  });

  it("handles webui without a leading slash", () => {
    const url = buildConfluenceWebUrl("https://test.atlassian.net", "spaces/ENG/pages/999");
    expect(url).toBe("https://test.atlassian.net/wiki/spaces/ENG/pages/999");
  });

  it("returns absolute URLs untouched", () => {
    expect(buildConfluenceWebUrl("https://test.atlassian.net", "https://other.example.com/x")).toBe(
      "https://other.example.com/x",
    );
  });

  it("returns undefined for undefined input", () => {
    expect(buildConfluenceWebUrl("https://test.atlassian.net", undefined)).toBeUndefined();
  });

  it("trims trailing slashes from baseUrl before joining", () => {
    const url = buildConfluenceWebUrl("https://test.atlassian.net/", "/wiki/spaces/ENG/pages/999");
    expect(url).toBe("https://test.atlassian.net/wiki/spaces/ENG/pages/999");
    expect(url).not.toContain("//wiki/");
  });
});
