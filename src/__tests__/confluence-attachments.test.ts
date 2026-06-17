import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { ConfluenceClient } from "../lib/confluence.js";
import { KnowledgeBase } from "../lib/db.js";
import { _internals as httpInternals } from "../lib/http-utils.js";
import { loadPageAttachments, Spider, storePageAttachments } from "../lib/indexer.js";

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

const testConfig = {
  siteUrl: "https://test.atlassian.net",
  email: "test@example.com",
  apiToken: "tok_123",
  confluenceSpaces: [],
  rootPageIds: [],
};

describe("ConfluenceClient.getPageAttachments", () => {
  it("returns mapped attachments with resolved download URLs", async () => {
    const client = new ConfluenceClient(testConfig);
    mockFetchResponse({
      results: [
        {
          id: "att-1",
          title: "diagram.png",
          fileSize: 5000,
          mediaType: "image/png",
          downloadLink: "/download/attachments/123/diagram.png",
          version: { createdAt: "2026-01-01" },
        },
        {
          id: "att-2",
          title: "spec.pdf",
          fileSize: 2048,
          mediaType: "application/pdf",
          _links: { download: "/download/attachments/123/spec.pdf" },
        },
      ],
      _links: {},
    });

    const list = await client.getPageAttachments("123");
    expect(list).toHaveLength(2);
    expect(list[0]?.filename).toBe("diagram.png");
    expect(list[0]?.isImage).toBe(true);
    expect(list[0]?.url).toContain("https://test.atlassian.net/wiki/download/attachments/123/diagram.png");
    expect(list[1]?.isImage).toBe(false);
    expect(list[1]?.url).toContain("/spec.pdf");
  });

  // TEST-8: Atlassian Cloud responses sometimes prefix download links with
  // `/wiki/...` already; the read path must not double-prepend the prefix.
  it("does not double-prepend /wiki/ when downloadLink already starts with /wiki/", async () => {
    const client = new ConfluenceClient(testConfig);
    mockFetchResponse({
      results: [
        {
          id: "att-1",
          title: "diagram.png",
          fileSize: 100,
          mediaType: "image/png",
          downloadLink: "/wiki/download/attachments/123/diagram.png",
        },
      ],
      _links: {},
    });

    const list = await client.getPageAttachments("123");
    expect(list).toHaveLength(1);
    // Must contain `/wiki/` exactly once — `/wiki/wiki/` would indicate a regression.
    expect(list[0]?.url).toBe("https://test.atlassian.net/wiki/download/attachments/123/diagram.png");
    expect((list[0]?.url ?? "").match(/\/wiki\//g)?.length).toBe(1);
  });

  // TEST-9: pagination — the single-page test cannot detect a regression
  // where `paginate` drops the second page, caps at one page, or fails
  // mid-stream. Two real pages with a `_links.next` cursor catches all three.
  it("follows _links.next across pages and merges results", async () => {
    const client = new ConfluenceClient(testConfig);
    const firstPageResults = Array.from({ length: 5 }, (_, i) => ({
      id: `att-${i + 1}`,
      title: `file-${i + 1}.bin`,
      fileSize: 10,
      mediaType: "application/octet-stream",
      downloadLink: `/download/attachments/123/file-${i + 1}.bin`,
    }));
    const secondPageResults = Array.from({ length: 3 }, (_, i) => ({
      id: `att-${i + 6}`,
      title: `file-${i + 6}.bin`,
      fileSize: 10,
      mediaType: "application/octet-stream",
      downloadLink: `/download/attachments/123/file-${i + 6}.bin`,
    }));
    mockFetchResponse({
      results: firstPageResults,
      _links: { next: "/wiki/api/v2/pages/123/attachments?cursor=abc" },
    });
    mockFetchResponse({ results: secondPageResults, _links: {} });

    const list = await client.getPageAttachments("123");
    expect(list).toHaveLength(8);
    expect(list[0]?.filename).toBe("file-1.bin");
    expect(list[7]?.filename).toBe("file-8.bin");
  });

  it("surfaces an error when an intermediate page returns 5xx", async () => {
    // Stub the retry sleep so the test doesn't actually wait 7+ seconds.
    const sleepSpy = vi.spyOn(httpInternals, "sleep").mockResolvedValue();
    try {
      const client = new ConfluenceClient(testConfig);
      mockFetchResponse({
        results: [{ id: "att-1", title: "a.bin", fileSize: 0, mediaType: "application/octet-stream" }],
        _links: { next: "/wiki/api/v2/pages/123/attachments?cursor=zzz" },
      });
      // Mid-stream failure on the second page — pagination must NOT silently
      // return a truncated list. Mock retry exhaustion so the error surfaces.
      for (let i = 0; i < 4; i++) {
        fetchMock.mockResolvedValueOnce(new Response("boom", { status: 500 }));
      }

      await expect(client.getPageAttachments("123")).rejects.toThrow();
    } finally {
      sleepSpy.mockRestore();
    }
  });
});

describe("ConfluenceClient.getPageFull image-reference resolution", () => {
  it("rewrites <ri:attachment> filenames to real download URLs via the manifest", async () => {
    const client = new ConfluenceClient(testConfig);

    // First Promise.allSettled fetch — page
    mockFetchResponse({
      id: "p1",
      title: "Design",
      status: "current",
      spaceId: "s1",
      body: {
        storage: {
          value: `<p>Intro</p><ac:image ac:alt="diagram"><ri:attachment ri:filename="diagram.png"/></ac:image>`,
        },
      },
      _links: { webui: "/spaces/ENG/pages/p1" },
    });
    // Labels
    mockFetchResponse({ results: [{ name: "design" }], _links: {} });
    // Attachments
    mockFetchResponse({
      results: [
        {
          id: "att-1",
          title: "diagram.png",
          mediaType: "image/png",
          fileSize: 1024,
          downloadLink: "/download/attachments/p1/diagram.png",
        },
      ],
      _links: {},
    });

    const page = await client.getPageFull("p1");
    expect(page.attachments).toHaveLength(1);
    expect(page.body).toContain("![diagram](https://test.atlassian.net/wiki/download/attachments/p1/diagram.png)");
  });

  it("still returns the page even when attachment fetch fails", async () => {
    const client = new ConfluenceClient(testConfig);
    mockFetchResponse({
      id: "p1",
      title: "No-attach page",
      status: "current",
      spaceId: "s1",
      body: { storage: { value: "<p>Hello</p>" } },
      _links: { webui: "/x" },
    });
    mockFetchResponse({ results: [], _links: {} });
    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 500 }));

    const page = await client.getPageFull("p1");
    expect(page.body).toContain("Hello");
    expect(page.attachments).toEqual([]);
  });
});

describe("Spider attachment persistence", () => {
  let tmpDir: string;
  let kb: KnowledgeBase;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "lb-spider-att-"));
    kb = new KnowledgeBase(join(tmpDir, "test.db"));
  });

  afterEach(() => {
    kb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("stores and reloads the attachment manifest for a page", () => {
    storePageAttachments(kb, "p1", [
      {
        id: "att-1",
        filename: "diagram.png",
        mediaType: "image/png",
        size: 1234,
        url: "https://test.atlassian.net/x",
        isImage: true,
      },
    ]);
    const loaded = loadPageAttachments(kb, "p1");
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.filename).toBe("diagram.png");
  });

  it("returns [] when nothing is stored", () => {
    expect(loadPageAttachments(kb, "unknown")).toEqual([]);
  });

  it("persists attachments through a crawlTree run", async () => {
    const client = {
      getPageFull: vi.fn(async (id: string) => ({
        id,
        title: `Page ${id}`,
        spaceId: "s1",
        status: "current",
        body: "hello world",
        labels: [],
        updatedAt: "2026-01-01T00:00:00Z",
        attachments: [
          {
            id: "att-1",
            filename: "design.png",
            mediaType: "image/png",
            size: 100,
            url: "https://test.atlassian.net/x",
            isImage: true,
          },
        ],
      })),
      getPageChildren: vi.fn(async () => []),
      getSpace: vi.fn(),
      listPagesInSpace: vi.fn(),
    } as unknown as ConfluenceClient;

    const spider = new Spider(client, kb);
    const result = await spider.crawl({
      rootPageId: "p1",
      maxDepth: 1,
      maxConcurrency: 1,
      includeLabels: [],
      excludeLabels: [],
    });
    expect(result.indexed).toBe(1);
    const persisted = loadPageAttachments(kb, "p1");
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.filename).toBe("design.png");
  });
});
