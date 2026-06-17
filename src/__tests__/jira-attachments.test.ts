import { afterAll, afterEach, beforeAll, describe, expect, it, type Mock, vi } from "vitest";
import { JiraClient, type JiraSchema } from "../lib/jira.js";
import { mapAttachment } from "../lib/jira-attachments.js";
import type { RawAttachment } from "../lib/jira-types.js";

// ── Fetch mock ───────────────────────────────────────────────────────────────

const originalFetch = globalThis.fetch;
let fetchMock: Mock;

function mockFetchResponse(body: unknown, status = 200) {
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }),
  );
}

beforeAll(() => {
  fetchMock = vi.fn(() => Promise.resolve(new Response("{}")));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  fetchMock.mockClear();
});

// ── Test schema ──────────────────────────────────────────────────────────────

const testSchema: JiraSchema = {
  projectKey: "BP",
  projectName: "Backlog",
  boardId: "266",
  issueTypes: [{ id: "1", name: "Task", subtask: false, fields: [], requiredFields: [] }],
  priorities: [{ id: "1", name: "Medium" }],
  statuses: [],
};

const testConfig = {
  siteUrl: "https://test.atlassian.net",
  email: "test@example.com",
  apiToken: "tok_123",
  jiraProjectKey: "BP",
  confluenceSpaces: [],
  rootPageIds: [],
};

// ── mapAttachment ────────────────────────────────────────────────────────────

describe("mapAttachment", () => {
  it("translates raw API shape to domain shape", () => {
    const raw: RawAttachment = {
      id: "10001",
      filename: "diagram.png",
      mimeType: "image/png",
      size: 1024,
      author: { displayName: "Alice" },
      created: "2026-06-01T00:00:00Z",
      content: "https://test.atlassian.net/secure/attachment/10001/diagram.png",
      thumbnail: "https://test.atlassian.net/secure/thumbnail/10001/diagram.png",
    };
    const mapped = mapAttachment(raw);
    expect(mapped).toEqual({
      id: "10001",
      filename: "diagram.png",
      mimeType: "image/png",
      size: 1024,
      author: "Alice",
      created: "2026-06-01T00:00:00Z",
      url: raw.content,
      thumbnail: raw.thumbnail,
      isImage: true,
    });
  });

  it("flags non-image mime types", () => {
    const mapped = mapAttachment({
      id: "1",
      filename: "report.pdf",
      mimeType: "application/pdf",
      size: 200,
      created: "2026-01-01T00:00:00Z",
      content: "https://test.atlassian.net/secure/attachment/1/report.pdf",
    });
    expect(mapped.isImage).toBe(false);
  });

  it("defaults missing mime type to octet-stream", () => {
    const mapped = mapAttachment({
      id: "1",
      filename: "blob.bin",
      size: 1,
      created: "2026-01-01T00:00:00Z",
      content: "https://test.atlassian.net/x",
    });
    expect(mapped.mimeType).toBe("application/octet-stream");
    expect(mapped.isImage).toBe(false);
  });

  // TEST-11: Jira Server occasionally returns capitalised media types
  // ("Image/PNG"). Without case-folding, isImage returns false and the
  // markdown preview path is skipped for a legitimate image. Use a table
  // so a regression on any common variant fails the suite.
  it.each<[string | undefined, boolean]>([
    ["image/png", true],
    ["Image/PNG", true],
    ["IMAGE/jpeg", true],
    ["Image/Svg+Xml", true],
    ["application/pdf", false],
    ["image", false], // no slash — not a real media type, treat as non-image
    ["", false], // empty string falls through to octet-stream default
    [undefined, false],
  ])("isImage handles mimeType=%j as %j", (mimeType, expected) => {
    const mapped = mapAttachment({
      id: "1",
      filename: "x.bin",
      ...(mimeType === undefined ? {} : { mimeType }),
      size: 1,
      created: "2026-01-01T00:00:00Z",
      content: "https://test.atlassian.net/x",
    });
    expect(mapped.isImage).toBe(expected);
  });
});

// ── JiraClient.getIssue attachment surfacing ─────────────────────────────────

describe("JiraClient.getIssue attachments", () => {
  function issueResponse(attachment: RawAttachment[] | undefined) {
    return {
      key: "BP-1",
      id: "10001",
      fields: {
        summary: "Test ticket",
        issuetype: { name: "Task" },
        priority: { name: "Medium" },
        status: { name: "To Do" },
        labels: [],
        components: [],
        created: "2026-01-01T00:00:00Z",
        updated: "2026-01-02T00:00:00Z",
        attachment,
      },
    };
  }

  it("returns parsed attachments when present", async () => {
    const client = new JiraClient(testConfig, testSchema);
    mockFetchResponse(
      issueResponse([
        {
          id: "1",
          filename: "design.png",
          mimeType: "image/png",
          size: 5000,
          author: { displayName: "Ricky" },
          created: "2026-01-02T00:00:00Z",
          content: "https://test.atlassian.net/secure/attachment/1/design.png",
        },
      ]),
    );

    const issue = await client.getIssue("BP-1");
    expect(issue.attachments).toHaveLength(1);
    expect(issue.attachments[0]?.filename).toBe("design.png");
    expect(issue.attachments[0]?.isImage).toBe(true);
  });

  it("returns an empty array when no attachments", async () => {
    const client = new JiraClient(testConfig, testSchema);
    mockFetchResponse(issueResponse([]));
    const issue = await client.getIssue("BP-1");
    expect(issue.attachments).toEqual([]);
  });

  it("requests the attachment field projection", async () => {
    const client = new JiraClient(testConfig, testSchema);
    mockFetchResponse(issueResponse([]));
    await client.getIssue("BP-1");
    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).toContain("attachment");
  });
});

// ── JiraClient.addAttachment ─────────────────────────────────────────────────

describe("JiraClient.addAttachment", () => {
  it("uploads via multipart and parses the response", async () => {
    const client = new JiraClient(testConfig, testSchema);
    mockFetchResponse([
      {
        id: "20001",
        filename: "report.pdf",
        mimeType: "application/pdf",
        size: 2048,
        created: "2026-01-01T00:00:00Z",
        content: "https://test.atlassian.net/secure/attachment/20001/report.pdf",
      },
    ]);

    const result = await client.addAttachment("BP-1", [
      { filename: "report.pdf", data: new TextEncoder().encode("PDF body"), contentType: "application/pdf" },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]?.filename).toBe("report.pdf");

    const call = fetchMock.mock.calls[0];
    const url = call?.[0] as string;
    const init = call?.[1] as RequestInit;

    expect(url).toContain("/rest/api/3/issue/BP-1/attachments");
    expect(init.method).toBe("POST");
    expect(init.body).toBeInstanceOf(FormData);
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Atlassian-Token"]).toBe("no-check");
    // Multipart Content-Type is set by fetch — must NOT be the JSON header.
    expect(headers["Content-Type"]).toBeUndefined();
  });

  it("throws on empty file list", async () => {
    const client = new JiraClient(testConfig, testSchema);
    await expect(client.addAttachment("BP-1", [])).rejects.toThrow(/at least one file/);
  });

  it("propagates HTTP errors with status detail (and never logs the token)", async () => {
    const client = new JiraClient(testConfig, testSchema);
    fetchMock.mockResolvedValueOnce(new Response("forbidden", { status: 403 }));
    await expect(client.addAttachment("BP-1", [{ filename: "x.bin", data: new Uint8Array(1) }])).rejects.toThrow(
      /Jira 403/,
    );
  });

  it("rejects invalid issue keys", async () => {
    const client = new JiraClient(testConfig, testSchema);
    await expect(client.addAttachment("bad", [{ filename: "x.bin", data: new Uint8Array(1) }])).rejects.toThrow(
      /Invalid issue key/,
    );
  });

  it("does not include the API token in the error message", async () => {
    const client = new JiraClient(testConfig, testSchema);
    fetchMock.mockResolvedValueOnce(new Response("permission denied", { status: 401 }));
    try {
      await client.addAttachment("BP-1", [{ filename: "x.bin", data: new Uint8Array(1) }]);
      expect.fail("expected throw");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).not.toContain("tok_123");
    }
  });

  // ── ATT-7: structured error body parsing ───────────────────────────────────

  it("ATT-7: surfaces parsed errorMessages/errors from the Jira response", async () => {
    const client = new JiraClient(testConfig, testSchema);
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          errorMessages: ["Attachment too large"],
          errors: { file: "exceeds 10 MB" },
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      ),
    );
    try {
      await client.addAttachment("BP-1", [{ filename: "x.bin", data: new Uint8Array(1) }]);
      expect.fail("expected throw");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).toContain("Attachment too large");
      expect(msg).toContain("file: exceeds 10 MB");
    }
  });

  it("ATT-7: does NOT leak the raw response body (no stack traces, no HTML)", async () => {
    const client = new JiraClient(testConfig, testSchema);
    // 400 is non-retryable so the mock is consumed once and the error surface
    // is deterministic. An HTML/stack-trace body must NOT make it into the
    // thrown message — only the structured fields (or a generic fallback).
    const rawHtmlBody = "<html><body>Stack: at com.atlassian.foo(Bar.java:42)…secret-internal-id-987</body></html>";
    fetchMock.mockResolvedValueOnce(new Response(rawHtmlBody, { status: 400 }));
    try {
      await client.addAttachment("BP-1", [{ filename: "x.bin", data: new Uint8Array(1) }]);
      expect.fail("expected throw");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).not.toContain("Stack:");
      expect(msg).not.toContain("secret-internal-id-987");
      expect(msg).toMatch(/Jira returned 400/);
    }
  });
});
