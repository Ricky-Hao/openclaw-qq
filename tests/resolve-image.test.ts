// ── qq_resolve_image tool tests ────────────────────────────────────

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createQQResolveImageTool } from "../src/resolve-image.js";
import * as gateway from "../src/gateway.js";
import { existsSync, readFileSync, mkdirSync, rmSync } from "node:fs";

describe("qq_resolve_image tool", () => {
  // Factory context — simulates what openclaw core passes to the factory
  const factoryCtx = {
    config: { channels: { qq: { default: {} } } },
    agentAccountId: "default",
    workspaceDir: "/tmp/test-workspace",
  };
  let tool: ReturnType<typeof createQQResolveImageTool>;

  beforeEach(() => {
    tool = createQQResolveImageTool(factoryCtx);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Clean up temp files
    try { rmSync("/tmp/test-workspace/tmp/qq-images", { recursive: true, force: true }); } catch {}
  });

  it("should have correct metadata", () => {
    expect(tool.name).toBe("qq_resolve_image");
    expect(tool.description).toContain("获取QQ聊天历史中的图片");
    expect(tool.description).toContain("本地文件路径");
    expect(tool.parameters).toBeDefined();
  });

  it("should return error when no active client", async () => {
    vi.spyOn(gateway, "getActiveClient").mockReturnValue(undefined);
    vi.spyOn(gateway, "getAnyActiveClient").mockReturnValue(undefined);

    const result = await tool.execute({}, { file: "TEST.jpg" });
    const data = JSON.parse(result.content[0].text);
    expect(data.error).toBe("No active QQ connection");
  });

  it("should return error when client exists but API returns no base64", async () => {
    const mockClient = { callApi: vi.fn().mockResolvedValue({}) };
    vi.spyOn(gateway, "getActiveClient").mockReturnValue(mockClient as any);

    const result = await tool.execute({}, { file: "MISSING.jpg" });
    expect(mockClient.callApi).toHaveBeenCalledWith("get_image", { file: "MISSING.jpg" });

    const data = JSON.parse(result.content[0].text);
    expect(data.error).toBe("Image not found or expired from cache");
  });

  it("should write file to disk and return path when API succeeds (jpeg)", async () => {
    // Create a small valid JPEG-like base64
    const fakeImageData = Buffer.from("fake jpeg content for testing").toString("base64");
    const mockClient = {
      callApi: vi.fn().mockResolvedValue({
        base64: fakeImageData,
        file_size: 29,
        file_name: "5E28D43A2FE346F995BC1D0F5D82829F.jpg",
      }),
    };
    vi.spyOn(gateway, "getActiveClient").mockReturnValue(mockClient as any);

    const result = await tool.execute({}, { file: "5E28D43A2FE346F995BC1D0F5D82829F.jpg" });

    expect(mockClient.callApi).toHaveBeenCalledWith("get_image", {
      file: "5E28D43A2FE346F995BC1D0F5D82829F.jpg",
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.path).toBe("/tmp/test-workspace/tmp/qq-images/5E28D43A2FE346F995BC1D0F5D82829F.jpg");
    expect(data.file_name).toBe("5E28D43A2FE346F995BC1D0F5D82829F.jpg");
    expect(data.file_size).toBe(29);

    // Verify file was actually written
    expect(existsSync(data.path)).toBe(true);
    const written = readFileSync(data.path);
    expect(written.toString()).toBe("fake jpeg content for testing");
  });

  it("should handle png extension", async () => {
    const fakeData = Buffer.from("png content").toString("base64");
    const mockClient = {
      callApi: vi.fn().mockResolvedValue({ base64: fakeData, file_size: 11 }),
    };
    vi.spyOn(gateway, "getActiveClient").mockReturnValue(mockClient as any);

    const result = await tool.execute({}, { file: "ABCDEF.png" });
    const data = JSON.parse(result.content[0].text);
    expect(data.path).toBe("/tmp/test-workspace/tmp/qq-images/ABCDEF.png");
  });

  it("should handle gif extension", async () => {
    const fakeData = Buffer.from("gif content").toString("base64");
    const mockClient = {
      callApi: vi.fn().mockResolvedValue({ base64: fakeData, file_size: 11 }),
    };
    vi.spyOn(gateway, "getActiveClient").mockReturnValue(mockClient as any);

    const result = await tool.execute({}, { file: "ANIMATED.gif" });
    const data = JSON.parse(result.content[0].text);
    expect(data.path).toBe("/tmp/test-workspace/tmp/qq-images/ANIMATED.gif");
  });

  it("should handle webp extension", async () => {
    const fakeData = Buffer.from("webp content").toString("base64");
    const mockClient = {
      callApi: vi.fn().mockResolvedValue({ base64: fakeData, file_size: 12 }),
    };
    vi.spyOn(gateway, "getActiveClient").mockReturnValue(mockClient as any);

    const result = await tool.execute({}, { file: "MODERN.webp" });
    const data = JSON.parse(result.content[0].text);
    expect(data.path).toBe("/tmp/test-workspace/tmp/qq-images/MODERN.webp");
  });

  it("should default to .jpg for unknown extensions", async () => {
    const fakeData = Buffer.from("unknown content").toString("base64");
    const mockClient = {
      callApi: vi.fn().mockResolvedValue({ base64: fakeData, file_size: 15 }),
    };
    vi.spyOn(gateway, "getActiveClient").mockReturnValue(mockClient as any);

    const result = await tool.execute({}, { file: "NOEXT" });
    const data = JSON.parse(result.content[0].text);
    expect(data.path).toBe("/tmp/test-workspace/tmp/qq-images/NOEXT.jpg");
  });

  it("should return error when API throws exception", async () => {
    const mockClient = {
      callApi: vi.fn().mockRejectedValue(new Error("Network timeout")),
    };
    vi.spyOn(gateway, "getActiveClient").mockReturnValue(mockClient as any);

    const result = await tool.execute({}, { file: "FAIL.jpg" });
    const data = JSON.parse(result.content[0].text);
    expect(data.error).toBe("Failed to resolve image: Network timeout");
  });

  it("should handle file_size=0 when not provided by API", async () => {
    const fakeData = Buffer.from("some data").toString("base64");
    const mockClient = {
      callApi: vi.fn().mockResolvedValue({ base64: fakeData }),
    };
    vi.spyOn(gateway, "getActiveClient").mockReturnValue(mockClient as any);

    const result = await tool.execute({}, { file: "NOSIZE.jpg" });
    const data = JSON.parse(result.content[0].text);
    expect(data.file_size).toBe(9); // actual buffer length
  });

  it("should fall back to getAnyActiveClient when config has no qq channels", async () => {
    const noQQCtx = { config: {}, agentAccountId: "default" };
    const toolNoQQ = createQQResolveImageTool(noQQCtx);

    const fakeData = Buffer.from("fallback data").toString("base64");
    const mockClient = {
      callApi: vi.fn().mockResolvedValue({ base64: fakeData, file_size: 13 }),
    };
    vi.spyOn(gateway, "getActiveClient").mockReturnValue(undefined);
    vi.spyOn(gateway, "getAnyActiveClient").mockReturnValue(mockClient as any);

    const result = await toolNoQQ.execute({}, { file: "FALLBACK.jpg" });
    const data = JSON.parse(result.content[0].text);
    expect(data.path).toBe("/tmp/openclaw/qq-images/FALLBACK.jpg");
  });
});
