import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ATTACHMENT_UPLOAD_AGGREGATE_MAX_BYTES,
  ATTACHMENT_UPLOAD_MAX_BYTES,
  uploadAttachmentsFromPaths,
} from "../tools/issues-attachments.js";

describe("uploadAttachmentsFromPaths", () => {
  let tmpDir: string;
  let originalUploadRoot: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "lb-upload-"));
    // ATT-2: uploads are confined to the configured root. Point it at the
    // ephemeral test directory so the per-test fixtures can be uploaded.
    originalUploadRoot = process.env.LAZY_BACKLOG_UPLOAD_ROOT;
    process.env.LAZY_BACKLOG_UPLOAD_ROOT = tmpDir;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    if (originalUploadRoot === undefined) delete process.env.LAZY_BACKLOG_UPLOAD_ROOT;
    else process.env.LAZY_BACKLOG_UPLOAD_ROOT = originalUploadRoot;
  });

  function makeJiraStub(impl: (issueKey: string, files: unknown[]) => Promise<unknown[]>) {
    return { addAttachment: vi.fn(impl) };
  }

  it("reads files from disk and forwards them to addAttachment", async () => {
    const path = join(tmpDir, "report.pdf");
    writeFileSync(path, "pdf body");

    const stub = makeJiraStub(async (_key, files) => files.map((_f, i) => ({ id: String(i) })));
    const result = await uploadAttachmentsFromPaths(stub as never, "BP-1", [path]);
    expect(result.uploaded).toBe(1);
    expect(result.errors).toHaveLength(0);
    expect(stub.addAttachment).toHaveBeenCalledOnce();
    const [issueKey, files] = stub.addAttachment.mock.calls[0] ?? [];
    expect(issueKey).toBe("BP-1");
    expect(Array.isArray(files)).toBe(true);
    const filesArr = files as Array<{ filename: string; data: unknown; contentType: string }>;
    expect(filesArr[0]?.filename).toBe("report.pdf");
    expect(filesArr[0]?.contentType).toBe("application/pdf");
  });

  it("records an error for a missing file and still uploads the rest", async () => {
    const good = join(tmpDir, "good.txt");
    writeFileSync(good, "hi");
    const stub = makeJiraStub(async (_key, files) => files.map((_f, i) => ({ id: String(i) })));
    const result = await uploadAttachmentsFromPaths(stub as never, "BP-1", [good, join(tmpDir, "missing.bin")]);
    expect(result.uploaded).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("file not found");
  });

  it("rejects directories", async () => {
    const stub = makeJiraStub(async () => []);
    const result = await uploadAttachmentsFromPaths(stub as never, "BP-1", [tmpDir]);
    expect(result.uploaded).toBe(0);
    expect(result.errors[0]).toContain("not a regular file");
  });

  it("rejects files exceeding the size cap", async () => {
    // Create a sparse file just past the cap. `truncate` to a target size avoids
    // actually allocating 10 MB+ of bytes on disk while statSync still reports
    // the right size.
    const big = join(tmpDir, "big.bin");
    writeFileSync(big, "");
    const fs = await import("node:fs");
    fs.truncateSync(big, ATTACHMENT_UPLOAD_MAX_BYTES + 1);

    const stub = makeJiraStub(async () => []);
    const result = await uploadAttachmentsFromPaths(stub as never, "BP-1", [big]);
    expect(result.uploaded).toBe(0);
    expect(result.errors[0]).toContain("exceeds size cap");
    expect(stub.addAttachment).not.toHaveBeenCalled();
  });

  it("captures errors thrown by the underlying upload call", async () => {
    const good = join(tmpDir, "good.txt");
    writeFileSync(good, "hi");
    const stub = makeJiraStub(async () => {
      throw new Error("Network down");
    });
    const result = await uploadAttachmentsFromPaths(stub as never, "BP-1", [good]);
    expect(result.uploaded).toBe(0);
    expect(result.errors[0]).toContain("Network down");
  });

  it("returns empty outcome when no paths provided", async () => {
    const stub = makeJiraStub(async () => []);
    const result = await uploadAttachmentsFromPaths(stub as never, "BP-1", []);
    expect(result.uploaded).toBe(0);
    expect(result.errors).toHaveLength(0);
    expect(stub.addAttachment).not.toHaveBeenCalled();
  });

  // ── ATT-2: upload-root confinement ──────────────────────────────────────

  it("ATT-2: refuses to read a path outside the configured upload root", async () => {
    // Pull the upload root **down** to a child dir so /etc and /tmp are out of scope.
    const child = join(tmpDir, "sub");
    writeFileSync(join(tmpDir, "outside.txt"), "outside the new root");
    const fs = await import("node:fs");
    fs.mkdirSync(child, { recursive: true });
    process.env.LAZY_BACKLOG_UPLOAD_ROOT = child;

    const stub = makeJiraStub(async (_k, files) => files.map((_f, i) => ({ id: String(i) })));
    const result = await uploadAttachmentsFromPaths(stub as never, "BP-1", [join(tmpDir, "outside.txt")]);
    expect(result.uploaded).toBe(0);
    expect(result.errors[0]).toMatch(/refusing to read outside upload root/i);
    expect(stub.addAttachment).not.toHaveBeenCalled();
  });

  it("ATT-2: refuses to read a symlink even when the symlink resolves inside the root", async () => {
    // Set up a real file outside the root and a symlink to it inside.
    const outside = join(tmpdir(), `lb-evil-${Date.now()}.bin`);
    writeFileSync(outside, "secret");
    const link = join(tmpDir, "link.bin");
    try {
      symlinkSync(outside, link);
    } catch (err: unknown) {
      // Symlink creation might fail in some sandboxes; skip rather than false-fail.
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("EPERM") || msg.includes("EACCES")) {
        rmSync(outside, { force: true });
        return;
      }
      throw err;
    }

    const stub = makeJiraStub(async (_k, files) => files.map((_f, i) => ({ id: String(i) })));
    const result = await uploadAttachmentsFromPaths(stub as never, "BP-1", [link]);
    expect(result.uploaded).toBe(0);
    expect(result.errors[0]).toMatch(/symlink/i);
    expect(stub.addAttachment).not.toHaveBeenCalled();

    rmSync(outside, { force: true });
  });

  // ── ATT-6: aggregate cap ────────────────────────────────────────────────

  it("ATT-6: rejects a batch that exceeds the aggregate cap without buffering bytes", async () => {
    // Create N files at the per-file cap so the sum exceeds the aggregate
    // cap. Sparse `truncate` keeps actual disk allocation minimal.
    const fs = await import("node:fs");
    const fileCount = Math.ceil(ATTACHMENT_UPLOAD_AGGREGATE_MAX_BYTES / ATTACHMENT_UPLOAD_MAX_BYTES) + 1;
    const paths: string[] = [];
    for (let i = 0; i < fileCount; i++) {
      const path = join(tmpDir, `f${i}.bin`);
      writeFileSync(path, "");
      fs.truncateSync(path, ATTACHMENT_UPLOAD_MAX_BYTES);
      paths.push(path);
    }

    const stub = makeJiraStub(async () => []);
    const result = await uploadAttachmentsFromPaths(stub as never, "BP-1", paths);
    expect(result.uploaded).toBe(0);
    expect(result.errors.some((e) => /aggregate upload size/i.test(e))).toBe(true);
    expect(stub.addAttachment).not.toHaveBeenCalled();
  });
});
