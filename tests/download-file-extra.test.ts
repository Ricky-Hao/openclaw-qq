// ── Supplementary download-file tests (round 3 fixes) ──────────────

import { describe, it, expect, vi, afterEach } from "vitest";
import { createQQDownloadFileTool } from "../src/download-file.js";
import * as gateway from "../src/gateway.js";
import { rmSync } from "node:fs";

describe("qq_download_group_file — path traversal hardening", () => {
  const factoryCtx = {
    config: { channels: { qq: { default: {} } } },
    agentAccountId: "default",
    workspaceDir: "/tmp/test-workspace-dl-extra",
  };

  afterEach(() => {
    vi.restoreAllMocks();
    try { rmSync("/tmp/test-workspace-dl-extra/tmp/qq-files", { recursive: true, force: true }); } catch {}
  });

  function mockClientWithFile(fileName?: string) {
    const fakeContent = Buffer.from("test data").toString("base64");
    const mockClient = {
      callApi: vi.fn().mockResolvedValue({
        base64: fakeContent,
        file_name: fileName,
      }),
    };
    vi.spyOn(gateway, "getActiveClient").mockReturnValue(mockClient as any);
    return mockClient;
  }

  it('should fallback to file_id when filename is "."', async () => {
    mockClientWithFile("safe.txt");
    const tool = createQQDownloadFileTool(factoryCtx);

    const result = await tool.execute({}, { file_id: "dot-file-id", filename: "." });
    const data = JSON.parse(result.content[0].text);
    expect(data.file_name).toBe("dot-file-id");
    expect(data.path).toBe("/tmp/test-workspace-dl-extra/tmp/qq-files/dot-file-id");
  });

  it('should fallback to file_id when filename is ".."', async () => {
    mockClientWithFile("safe.txt");
    const tool = createQQDownloadFileTool(factoryCtx);

    const result = await tool.execute({}, { file_id: "dotdot-file-id", filename: ".." });
    const data = JSON.parse(result.content[0].text);
    expect(data.file_name).toBe("dotdot-file-id");
    expect(data.path).toBe("/tmp/test-workspace-dl-extra/tmp/qq-files/dotdot-file-id");
  });

  it('should fallback to file_id when API returns file_name "."', async () => {
    mockClientWithFile(".");
    const tool = createQQDownloadFileTool(factoryCtx);

    const result = await tool.execute({}, { file_id: "dot-api-id" });
    const data = JSON.parse(result.content[0].text);
    expect(data.file_name).toBe("dot-api-id");
  });

  it('should fallback to file_id when API returns file_name ".."', async () => {
    mockClientWithFile("..");
    const tool = createQQDownloadFileTool(factoryCtx);

    const result = await tool.execute({}, { file_id: "dotdot-api-id" });
    const data = JSON.parse(result.content[0].text);
    expect(data.file_name).toBe("dotdot-api-id");
  });

  it('should handle Windows-style backslash path traversal (..\\..\\etc\\passwd)', async () => {
    mockClientWithFile("safe.txt");
    const tool = createQQDownloadFileTool(factoryCtx);

    const result = await tool.execute({}, {
      file_id: "backslash-id",
      filename: "..\\..\\etc\\passwd",
    });
    const data = JSON.parse(result.content[0].text);
    expect(data.file_name).toBe("passwd");
    expect(data.path).toBe("/tmp/test-workspace-dl-extra/tmp/qq-files/passwd");
  });

  it("should handle null bytes in filename", async () => {
    mockClientWithFile("safe.txt");
    const tool = createQQDownloadFileTool(factoryCtx);

    const result = await tool.execute({}, {
      file_id: "nullbyte-id",
      filename: "evil\x00.txt",
    });
    const data = JSON.parse(result.content[0].text);
    // null byte replaced with /, basename strips directory part → ".txt"
    // If basename produces empty or unexpected result, fileId is used as fallback
    expect(data.file_name).not.toContain("\x00");
    expect(data.path).not.toContain("\x00");
  });

  it("should handle null bytes in API-returned file_name", async () => {
    mockClientWithFile("test\x00evil.sh");
    const tool = createQQDownloadFileTool(factoryCtx);

    const result = await tool.execute({}, { file_id: "nullbyte-api-id" });
    const data = JSON.parse(result.content[0].text);
    expect(data.file_name).not.toContain("\x00");
  });

  it("should include file_id in catch error JSON", async () => {
    const mockClient = {
      callApi: vi.fn().mockRejectedValue(new Error("Network timeout")),
    };
    vi.spyOn(gateway, "getActiveClient").mockReturnValue(mockClient as any);
    const tool = createQQDownloadFileTool(factoryCtx);

    const result = await tool.execute({}, { file_id: "err-file-123" });
    const data = JSON.parse(result.content[0].text);
    expect(data.error).toContain("Failed to download file");
    expect(data.file_id).toBe("err-file-123");
  });
});

describe("qq_download_group_file — concurrency limit", () => {
  const factoryCtx = {
    config: { channels: { qq: { default: {} } } },
    agentAccountId: "default",
    workspaceDir: "/tmp/test-workspace-dl-concurrent",
  };

  afterEach(() => {
    vi.restoreAllMocks();
    try { rmSync("/tmp/test-workspace-dl-concurrent/tmp/qq-files", { recursive: true, force: true }); } catch {}
  });

  it("should reject the 4th concurrent download", async () => {
    // Create a mock client that delays its response to keep downloads active
    let resolvers: Array<(value: unknown) => void> = [];
    const fakeContent = Buffer.from("concurrent test").toString("base64");

    const mockClient = {
      callApi: vi.fn().mockImplementation(() => {
        return new Promise((resolve) => {
          resolvers.push(() => resolve({
            base64: fakeContent,
            file_name: "concurrent.txt",
          }));
        });
      }),
    };
    vi.spyOn(gateway, "getActiveClient").mockReturnValue(mockClient as any);

    const tool = createQQDownloadFileTool(factoryCtx);

    // Start 3 downloads (they will block on the API call)
    const p1 = tool.execute({}, { file_id: "concurrent-1" });
    const p2 = tool.execute({}, { file_id: "concurrent-2" });
    const p3 = tool.execute({}, { file_id: "concurrent-3" });

    // Give the event loop a tick for the promises to start executing
    await new Promise((r) => setTimeout(r, 10));

    // 4th download should be rejected immediately
    const result4 = await tool.execute({}, { file_id: "concurrent-4" });
    const data4 = JSON.parse(result4.content[0].text);
    expect(data4.error).toBe("Too many concurrent downloads, please try again later");

    // Resolve the pending downloads so they complete
    for (const resolve of resolvers) resolve(undefined);

    // Wait for all pending downloads to settle (they'll fail gracefully since resolvers
    // resolved with undefined, which means no base64)
    await Promise.allSettled([p1, p2, p3]);
  });

  it("should allow new downloads after previous ones complete", async () => {
    const fakeContent = Buffer.from("sequential test").toString("base64");
    const mockClient = {
      callApi: vi.fn().mockResolvedValue({
        base64: fakeContent,
        file_name: "seq.txt",
      }),
    };
    vi.spyOn(gateway, "getActiveClient").mockReturnValue(mockClient as any);

    const tool = createQQDownloadFileTool(factoryCtx);

    // Run 3 downloads sequentially — each should succeed
    for (let i = 0; i < 3; i++) {
      const result = await tool.execute({}, { file_id: `seq-${i}` });
      const data = JSON.parse(result.content[0].text);
      expect(data.error).toBeUndefined();
      expect(data.file_name).toBe("seq.txt");
    }

    // 4th sequential download should also succeed (previous 3 completed)
    const result = await tool.execute({}, { file_id: "seq-3" });
    const data = JSON.parse(result.content[0].text);
    expect(data.error).toBeUndefined();
    expect(data.file_name).toBe("seq.txt");
  });
});
