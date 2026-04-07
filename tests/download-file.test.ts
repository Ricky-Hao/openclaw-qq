// ── qq_download_group_file tool tests ──────────────────────────────

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createQQDownloadFileTool } from "../src/download-file.js";
import * as gateway from "../src/gateway.js";
import { existsSync, readFileSync, rmSync } from "node:fs";

describe("qq_download_group_file tool", () => {
  // Factory context — simulates what openclaw core passes to the factory
  const factoryCtx = {
    config: { channels: { qq: { default: {} } } },
    agentAccountId: "default",
    workspaceDir: "/tmp/test-workspace-dl",
  };
  let tool: ReturnType<typeof createQQDownloadFileTool>;

  beforeEach(() => {
    tool = createQQDownloadFileTool(factoryCtx);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Clean up temp files
    try { rmSync("/tmp/test-workspace-dl/tmp/qq-files", { recursive: true, force: true }); } catch {}
  });

  it("should have correct metadata", () => {
    expect(tool.name).toBe("qq_download_group_file");
    expect(tool.description).toBeDefined();
    expect(tool.parameters).toBeDefined();
  });

  it("should return error when no active client", async () => {
    vi.spyOn(gateway, "getActiveClient").mockReturnValue(undefined);
    vi.spyOn(gateway, "getAnyActiveClient").mockReturnValue(undefined);

    const result = await tool.execute({}, { file_id: "test-file-id" });
    const data = JSON.parse(result.content[0].text);
    expect(data.error).toBe("No active QQ connection");
  });

  it("should return error when client exists but API returns no base64", async () => {
    const mockClient = { callApi: vi.fn().mockResolvedValue({}) };
    vi.spyOn(gateway, "getActiveClient").mockReturnValue(mockClient as any);

    const result = await tool.execute({}, { file_id: "missing-file" });
    expect(mockClient.callApi).toHaveBeenCalledWith("get_file", { file_id: "missing-file" });

    const data = JSON.parse(result.content[0].text);
    expect(data.error).toBe("File not found or no longer available");
  });

  it("should return error when API returns null", async () => {
    const mockClient = { callApi: vi.fn().mockResolvedValue(null) };
    vi.spyOn(gateway, "getActiveClient").mockReturnValue(mockClient as any);

    const result = await tool.execute({}, { file_id: "null-file" });
    const data = JSON.parse(result.content[0].text);
    expect(data.error).toBe("File not found or no longer available");
  });

  it("should write file to disk and return path when API succeeds", async () => {
    const fakeContent = Buffer.from("test file content for download").toString("base64");
    const mockClient = {
      callApi: vi.fn().mockResolvedValue({
        base64: fakeContent,
        file_size: 30,
        file_name: "report.pdf",
      }),
    };
    vi.spyOn(gateway, "getActiveClient").mockReturnValue(mockClient as any);

    const result = await tool.execute({}, { file_id: "file-123" });

    expect(mockClient.callApi).toHaveBeenCalledWith("get_file", { file_id: "file-123" });

    const data = JSON.parse(result.content[0].text);
    expect(data.path).toBe("/tmp/test-workspace-dl/tmp/qq-files/report.pdf");
    expect(data.file_name).toBe("report.pdf");
    expect(data.file_size).toBe(30);

    // Verify file was actually written
    expect(existsSync(data.path)).toBe(true);
    const written = readFileSync(data.path);
    expect(written.toString()).toBe("test file content for download");
  });

  it("should use file_id as filename when no filename provided and API returns no file_name", async () => {
    const fakeContent = Buffer.from("data").toString("base64");
    const mockClient = {
      callApi: vi.fn().mockResolvedValue({
        base64: fakeContent,
      }),
    };
    vi.spyOn(gateway, "getActiveClient").mockReturnValue(mockClient as any);

    const result = await tool.execute({}, { file_id: "abc-def-123" });
    const data = JSON.parse(result.content[0].text);
    expect(data.file_name).toBe("abc-def-123");
    expect(data.path).toBe("/tmp/test-workspace-dl/tmp/qq-files/abc-def-123");
  });

  it("should use provided filename parameter over API file_name", async () => {
    const fakeContent = Buffer.from("data").toString("base64");
    const mockClient = {
      callApi: vi.fn().mockResolvedValue({
        base64: fakeContent,
        file_name: "api-name.txt",
      }),
    };
    vi.spyOn(gateway, "getActiveClient").mockReturnValue(mockClient as any);

    const result = await tool.execute({}, { file_id: "file-123", filename: "my-report.pdf" });
    const data = JSON.parse(result.content[0].text);
    expect(data.file_name).toBe("my-report.pdf");
    expect(data.path).toBe("/tmp/test-workspace-dl/tmp/qq-files/my-report.pdf");
  });

  it("should return error when file exceeds 100MB limit", async () => {
    // Create a base64 string that decodes to > 100MB
    // We can't actually allocate 100MB in a test, so we mock the Buffer
    const mockClient = {
      callApi: vi.fn().mockResolvedValue({
        base64: "dGVzdA==", // just a small base64 for the API call
        file_name: "huge.bin",
      }),
    };
    vi.spyOn(gateway, "getActiveClient").mockReturnValue(mockClient as any);

    // Mock Buffer.from to return a buffer reporting > 100MB length
    const originalFrom = Buffer.from;
    const hugeBuffer = Object.create(Buffer.prototype);
    Object.defineProperty(hugeBuffer, "length", { value: 105 * 1024 * 1024 });
    vi.spyOn(Buffer, "from").mockImplementation((...args: any[]) => {
      // Only intercept the base64 decode call
      if (args[1] === "base64") return hugeBuffer;
      return originalFrom(...args);
    });

    const result = await tool.execute({}, { file_id: "huge-file" });
    const data = JSON.parse(result.content[0].text);
    expect(data.error).toContain("File too large");
    expect(data.error).toContain("max");
  });

  it("should return error when API throws exception", async () => {
    const mockClient = {
      callApi: vi.fn().mockRejectedValue(new Error("Network timeout")),
    };
    vi.spyOn(gateway, "getActiveClient").mockReturnValue(mockClient as any);

    const result = await tool.execute({}, { file_id: "timeout-file" });
    const data = JSON.parse(result.content[0].text);
    expect(data.error).toBe("Failed to download file: Network timeout");
  });

  it("should sanitize filename with path separators to prevent path traversal", async () => {
    const fakeContent = Buffer.from("traversal test").toString("base64");
    const mockClient = {
      callApi: vi.fn().mockResolvedValue({
        base64: fakeContent,
        file_name: "safe.txt",
      }),
    };
    vi.spyOn(gateway, "getActiveClient").mockReturnValue(mockClient as any);

    // Filename with path traversal attempt
    const result = await tool.execute({}, {
      file_id: "file-123",
      filename: "../../etc/passwd",
    });
    const data = JSON.parse(result.content[0].text);

    // Should strip directory components — only basename remains
    expect(data.file_name).toBe("passwd");
    expect(data.path).toBe("/tmp/test-workspace-dl/tmp/qq-files/passwd");

    // Verify file was written to the safe location, not outside
    expect(existsSync("/tmp/test-workspace-dl/tmp/qq-files/passwd")).toBe(true);
    expect(existsSync("/etc/passwd_test_traversal")).toBe(false); // sanity check
  });

  it("should sanitize API-returned file_name with path separators", async () => {
    const fakeContent = Buffer.from("traversal test 2").toString("base64");
    const mockClient = {
      callApi: vi.fn().mockResolvedValue({
        base64: fakeContent,
        file_name: "../../../tmp/evil.sh",
      }),
    };
    vi.spyOn(gateway, "getActiveClient").mockReturnValue(mockClient as any);

    const result = await tool.execute({}, { file_id: "file-456" });
    const data = JSON.parse(result.content[0].text);

    // Should strip directory components
    expect(data.file_name).toBe("evil.sh");
    expect(data.path).toBe("/tmp/test-workspace-dl/tmp/qq-files/evil.sh");
  });

  it("should fall back to file_id when basename results in empty string", async () => {
    const fakeContent = Buffer.from("edge case").toString("base64");
    const mockClient = {
      callApi: vi.fn().mockResolvedValue({
        base64: fakeContent,
        file_name: "",
      }),
    };
    vi.spyOn(gateway, "getActiveClient").mockReturnValue(mockClient as any);

    const result = await tool.execute({}, { file_id: "fallback-id" });
    const data = JSON.parse(result.content[0].text);
    expect(data.file_name).toBe("fallback-id");
  });

  it("should fall back to getAnyActiveClient when config has no qq channels", async () => {
    const noQQCtx = { config: {}, agentAccountId: "default" };
    const toolNoQQ = createQQDownloadFileTool(noQQCtx);

    const fakeContent = Buffer.from("fallback data").toString("base64");
    const mockClient = {
      callApi: vi.fn().mockResolvedValue({
        base64: fakeContent,
        file_size: 13,
        file_name: "fallback.txt",
      }),
    };
    vi.spyOn(gateway, "getActiveClient").mockReturnValue(undefined);
    vi.spyOn(gateway, "getAnyActiveClient").mockReturnValue(mockClient as any);

    const result = await toolNoQQ.execute({}, { file_id: "fallback-file" });
    const data = JSON.parse(result.content[0].text);
    // Should use FALLBACK_DIR when no workspaceDir
    expect(data.path).toBe("/tmp/openclaw/qq-files/fallback.txt");

    // Clean up
    try { rmSync("/tmp/openclaw/qq-files", { recursive: true, force: true }); } catch {}
  });

  it("should use workspace dir for output path when available", async () => {
    const fakeContent = Buffer.from("workspace test").toString("base64");
    const mockClient = {
      callApi: vi.fn().mockResolvedValue({
        base64: fakeContent,
        file_name: "workspace.txt",
      }),
    };
    vi.spyOn(gateway, "getActiveClient").mockReturnValue(mockClient as any);

    const result = await tool.execute({}, { file_id: "ws-file" });
    const data = JSON.parse(result.content[0].text);
    expect(data.path).toContain("/tmp/test-workspace-dl/tmp/qq-files/");
  });

  it("should handle non-Error thrown by API", async () => {
    const mockClient = {
      callApi: vi.fn().mockRejectedValue("string error"),
    };
    vi.spyOn(gateway, "getActiveClient").mockReturnValue(mockClient as any);

    const result = await tool.execute({}, { file_id: "string-err" });
    const data = JSON.parse(result.content[0].text);
    expect(data.error).toBe("Failed to download file: string error");
  });
});
