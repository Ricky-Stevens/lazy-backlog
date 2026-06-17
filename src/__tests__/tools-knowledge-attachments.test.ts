import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { DOWNLOAD_DIR_CONFIG_KEY } from "../lib/attachments.js";
import { KnowledgeBase } from "../lib/db.js";
import { storePageAttachments } from "../lib/indexer.js";
import { registerKnowledgeTool } from "../tools/knowledge.js";
import { createMockServer } from "./helpers/mock-server.js";

// ── Fetch mock ───────────────────────────────────────────────────────────────

const originalFetch = globalThis.fetch;
let fetchMock: Mock;

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

const envSnapshot: Record<string, string | undefined> = {};
const ENV_KEYS = ["ATLASSIAN_SITE_URL", "ATLASSIAN_EMAIL", "ATLASSIAN_API_TOKEN", "JIRA_PROJECT_KEY"];

function setTestEnv() {
  for (const key of ENV_KEYS) envSnapshot[key] = process.env[key];
  process.env.ATLASSIAN_SITE_URL = "https://test.atlassian.net";
  process.env.ATLASSIAN_EMAIL = "test@example.com";
  process.env.ATLASSIAN_API_TOKEN = "tok_123";
  process.env.JIRA_PROJECT_KEY = "BP";
}

function restoreEnv() {
  for (const key of ENV_KEYS) {
    if (envSnapshot[key] === undefined) delete process.env[key];
    else process.env[key] = envSnapshot[key];
  }
}

const defaults = {
  pageType: undefined,
  spaceKey: undefined,
  source: undefined,
  limit: 5,
};

function makePage(overrides: Partial<{ id: string; title: string; content: string; url: string }>) {
  return {
    id: overrides.id ?? "p1",
    space_key: "ENG",
    title: overrides.title ?? "Sample",
    url: overrides.url ?? null,
    content: overrides.content ?? "Body content",
    page_type: "design" as const,
    labels: JSON.stringify([]),
    parent_id: null,
    author_id: null,
    created_at: "2026-01-01",
    updated_at: "2026-01-01",
    indexed_at: "2026-01-01",
    source: "confluence",
    content_hash: null,
  };
}

describe("knowledge get-page — attachment surfacing", () => {
  let kb: KnowledgeBase;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "lb-knowledge-att-"));
    kb = new KnowledgeBase(join(tmpDir, "test.db"));
    setTestEnv();
  });

  afterEach(() => {
    kb.close();
    rmSync(tmpDir, { recursive: true, force: true });
    restoreEnv();
  });

  it("renders the page attachment table when manifest is stored", async () => {
    const { server, getTool } = createMockServer();
    registerKnowledgeTool(server, () => kb);
    kb.upsertPage(makePage({ id: "p1", title: "Design", content: "body" }));
    storePageAttachments(kb, "p1", [
      {
        id: "a1",
        filename: "diagram.png",
        mediaType: "image/png",
        size: 4096,
        url: "https://test.atlassian.net/wiki/download/attachments/p1/diagram.png",
        isImage: true,
      },
    ]);

    const knowledge = getTool("knowledge");
    const result = await knowledge({ action: "get-page", pageId: "p1", ...defaults });
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("Attachments (1)");
    expect(text).toContain("diagram.png");
  });

  it("omits attachment section when no manifest stored", async () => {
    const { server, getTool } = createMockServer();
    registerKnowledgeTool(server, () => kb);
    kb.upsertPage(makePage({ id: "p2", title: "No-att", content: "body" }));
    const knowledge = getTool("knowledge");
    const result = await knowledge({ action: "get-page", pageId: "p2", ...defaults });
    expect(result.content[0]?.text).not.toContain("Attachments (");
  });
});

describe("knowledge get-page — download flow", () => {
  let kb: KnowledgeBase;
  let tmpDir: string;
  let downloadDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "lb-kdl-"));
    downloadDir = mkdtempSync(join(tmpdir(), "lb-kdl-target-"));
    kb = new KnowledgeBase(join(tmpDir, "test.db"));
    setTestEnv();
  });

  afterEach(() => {
    kb.close();
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(downloadDir, { recursive: true, force: true });
    restoreEnv();
  });

  it("downloads page attachments into the configured directory", async () => {
    const { server, getTool } = createMockServer();
    registerKnowledgeTool(server, () => kb);
    kb.upsertPage(makePage({ id: "p1", title: "Design", content: "body" }));
    kb.setConfig(DOWNLOAD_DIR_CONFIG_KEY, downloadDir);
    storePageAttachments(kb, "p1", [
      {
        id: "a1",
        filename: "diagram.png",
        mediaType: "image/png",
        size: 4,
        url: "https://test.atlassian.net/wiki/download/attachments/p1/diagram.png",
        isImage: true,
      },
    ]);

    const payload = new TextEncoder().encode("PNG!");
    fetchMock.mockResolvedValueOnce(new Response(payload, { status: 200, headers: { "Content-Type": "image/png" } }));

    const knowledge = getTool("knowledge");
    const result = await knowledge({ action: "get-page", pageId: "p1", download: true, ...defaults });
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("Downloads (1)");
    expect(existsSync(join(downloadDir, "diagram.png"))).toBe(true);
    expect(readFileSync(join(downloadDir, "diagram.png")).toString()).toBe("PNG!");
  });

  it("includes a suggestion to enable download when attachments exist", async () => {
    const { server, getTool } = createMockServer();
    registerKnowledgeTool(server, () => kb);
    kb.upsertPage(makePage({ id: "p1", title: "Design", content: "body" }));
    storePageAttachments(kb, "p1", [
      {
        id: "a1",
        filename: "x.png",
        mediaType: "image/png",
        size: 1,
        url: "https://test.atlassian.net/x.png",
        isImage: true,
      },
    ]);

    const knowledge = getTool("knowledge");
    const result = await knowledge({ action: "get-page", pageId: "p1", ...defaults });
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("Download page attachments locally");
  });
});
