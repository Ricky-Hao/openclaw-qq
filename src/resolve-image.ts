/**
 * QQ Resolve Image Tool — retrieve historical QQ images via NapCat get_image API.
 *
 * Provides: qq_resolve_image(file: "HASH.jpg")
 * Returns: { path: "<workspace>/tmp/qq-images/HASH.jpg", file_name: "...", file_size: N }
 *
 * Images are saved to the agent's workspace directory so both host-side plugin tools
 * (photo_save) and sandbox tools (image) can access them via the same path.
 * The sandbox bridge translates host workspace paths to container paths automatically.
 */

import { Type, type Static } from "@sinclair/typebox";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { AnyAgentTool } from "openclaw/plugin-sdk";
import type { OneBotClient } from "./onebot/client.js";
import { getActiveClient, getAnyActiveClient } from "./gateway.js";
import { defaultAccountId } from "./config.js";
import { mkdirSync, writeFileSync, existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

// ── Constants ────────────────────────────────────────────────────

/** Subdirectory within workspace for resolved QQ images. */
const QQ_IMAGES_SUBDIR = "tmp/qq-images";

/** Fallback directory if workspace is not available. */
const FALLBACK_DIR = "/tmp/openclaw/qq-images";

/** TTL for temp files: 10 minutes. */
const TTL_MS = 10 * 60 * 1000;

// ── Schema ───────────────────────────────────────────────────────

const ResolveImageParams = Type.Object(
  {
    file: Type.String({
      description: '图片文件标识，如 5E28D43A2FE346F995BC1D0F5D82829F.jpg',
    }),
  },
  { additionalProperties: false },
);

type ResolveImageInput = Static<typeof ResolveImageParams>;

// ── Extension helper ────────────────────────────────────────────

function inferExtension(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "png":
    case "gif":
    case "webp":
    case "jpg":
    case "jpeg":
      return ext;
    default:
      return "jpg";
  }
}

// ── Cleanup ─────────────────────────────────────────────────────

function cleanupExpired(dir: string): void {
  try {
    if (!existsSync(dir)) return;
    const now = Date.now();
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      try {
        const st = statSync(p);
        if (now - st.mtimeMs > TTL_MS) unlinkSync(p);
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

// ── Helper functions ─────────────────────────────────────────────

function ok(data: unknown): AgentToolResult<unknown> {
  return { content: [{ type: "text", text: JSON.stringify(data) }], details: {} };
}

function err(message: string): AgentToolResult<unknown> {
  return { content: [{ type: "text", text: JSON.stringify({ error: message }) }], details: {}, isError: true } as AgentToolResult<unknown>;
}

// ── Tool context (passed by openclaw core to factory) ────────────

interface ToolContext {
  config?: Record<string, unknown>;
  workspaceDir?: string;
  agentId?: string;
  agentAccountId?: string;
  sessionKey?: string;
  sessionId?: string;
  messageChannel?: string;
  requesterSenderId?: string;
  senderIsOwner?: boolean;
}

// ── Tool factory ─────────────────────────────────────────────────

/**
 * Factory function called by openclaw core with agent context.
 * The context is captured via closure and used in execute().
 */
export function createQQResolveImageTool(ctx: ToolContext): AnyAgentTool {
  // Determine output directory: prefer workspace (sandbox-accessible), fallback to /tmp
  const outputDir = ctx.workspaceDir
    ? join(ctx.workspaceDir, QQ_IMAGES_SUBDIR)
    : FALLBACK_DIR;

  return {
    name: "qq_resolve_image",
    label: "QQ历史图片解析",
    description:
      '获取QQ聊天历史中的图片。传入历史消息中 [图片 - 使用 qq_resolve_image(file: "xxx") 获取] 标记里的 file 值。返回本地文件路径，可直接用于 photo_save 或 image 等工具。',
    parameters: ResolveImageParams,

    async execute(_execCtx, params): Promise<AgentToolResult<unknown>> {
      const input = params as ResolveImageInput;
      const file = input.file;

      // Cleanup expired temp files
      cleanupExpired(outputDir);

      // Use context from factory closure (same pattern as poll tools)
      const cfg = ctx.config as any;
      let client: OneBotClient | undefined;

      // Try specific account from context
      if (cfg?.channels?.qq) {
        const accountId = ctx.agentAccountId || defaultAccountId(cfg);
        client = getActiveClient(accountId);
      }

      // Fall back to any active client
      if (!client) {
        client = getAnyActiveClient();
      }

      if (!client) {
        return err("No active QQ connection");
      }

      try {
        // Call NapCat get_image API
        const result = (await client.callApi("get_image", { file })) as {
          file?: string;
          url?: string;
          base64?: string;
          file_size?: number;
          file_name?: string;
        };

        if (!result || !result.base64) {
          return err("Image not found or expired from cache");
        }

        // Decode base64 to buffer
        const buffer = Buffer.from(result.base64, "base64");

        // Ensure output directory exists
        mkdirSync(outputDir, { recursive: true });

        // Write to temp file (use original filename as-is)
        const ext = inferExtension(file);
        const basename = file.includes(".") ? file : `${file}.${ext}`;
        const outPath = join(outputDir, basename);
        writeFileSync(outPath, buffer);

        return ok({
          path: outPath,
          file_name: basename,
          file_size: buffer.length,
        });
      } catch (error) {
        return err(`Failed to resolve image: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
}
