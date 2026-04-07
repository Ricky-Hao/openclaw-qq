/**
 * QQ Download Group File Tool — download QQ group files on demand.
 *
 * Provides: qq_download_group_file(file_id, filename?)
 * Returns: { path: "<workspace>/tmp/qq-files/<filename>", file_name: "...", file_size: N }
 *
 * Files are saved to the agent's workspace directory so both host-side plugin tools
 * and sandbox tools can access them via the same path.
 * The sandbox bridge translates host workspace paths to container paths automatically.
 */

import { Type, type Static } from "@sinclair/typebox";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { AnyAgentTool } from "openclaw/plugin-sdk";
import type { OneBotClient } from "./onebot/client.js";
import { getActiveClient, getAnyActiveClient } from "./gateway.js";
import { defaultAccountId } from "./config.js";
import { mkdirSync, writeFileSync, existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join, basename } from "node:path";

// ── Constants ────────────────────────────────────────────────────

/** Subdirectory within workspace for downloaded QQ files. */
const QQ_FILES_SUBDIR = "tmp/qq-files";

/** Fallback directory if workspace is not available. */
const FALLBACK_DIR = "/tmp/openclaw/qq-files";

/** TTL for temp files: 10 minutes. */
const TTL_MS = 10 * 60 * 1000;

/** Maximum file size: 100 MB. */
const MAX_FILE_BYTES = 100 * 1024 * 1024;

/** Maximum concurrent downloads. */
const MAX_CONCURRENT_DOWNLOADS = 3;

/** Active download counter. */
let activeDownloads = 0;

// ── Schema ───────────────────────────────────────────────────────

const DownloadFileParams = Type.Object(
  {
    file_id: Type.String({
      description: "文件ID，从群文件通知中获取",
    }),
    filename: Type.Optional(
      Type.String({
        description: "保存的文件名",
      }),
    ),
  },
  { additionalProperties: false },
);

type DownloadFileInput = Static<typeof DownloadFileParams>;

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
export function createQQDownloadFileTool(ctx: ToolContext): AnyAgentTool {
  // Determine output directory: prefer workspace (sandbox-accessible), fallback to /tmp
  const outputDir = ctx.workspaceDir
    ? join(ctx.workspaceDir, QQ_FILES_SUBDIR)
    : FALLBACK_DIR;

  return {
    name: "qq_download_group_file",
    label: "QQ群文件下载",
    description:
      "下载QQ群文件。从上下文中的群文件通知获取 file_id。",
    parameters: DownloadFileParams,

    async execute(_execCtx, params): Promise<AgentToolResult<unknown>> {
      const input = params as DownloadFileInput;
      const fileId = input.file_id;

      // Concurrency limit
      if (activeDownloads >= MAX_CONCURRENT_DOWNLOADS) {
        return err("Too many concurrent downloads, please try again later");
      }
      activeDownloads++;
      try {
        return await executeDownload(input, fileId, outputDir, ctx);
      } finally {
        activeDownloads--;
      }
    },
  };

  async function executeDownload(
    input: DownloadFileInput,
    fileId: string,
    outputDir: string,
    ctx: ToolContext,
  ): Promise<AgentToolResult<unknown>> {
      // Cleanup expired temp files
      cleanupExpired(outputDir);

      // Use context from factory closure (same pattern as resolve-image tool)
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
        // Call NapCat get_file API
        const result = (await client.callApi("get_file", { file_id: fileId })) as {
          file?: string;
          url?: string;
          base64?: string;
          file_size?: number;
          file_name?: string;
        };

        if (!result || !result.base64) {
          return err("File not found or no longer available");
        }

        // Decode base64 to buffer
        const buffer = Buffer.from(result.base64, "base64");

        // Size check
        if (buffer.length > MAX_FILE_BYTES) {
          return err(`File too large: ${buffer.length} bytes (max ${MAX_FILE_BYTES})`);
        }

        // Determine filename (sanitize to prevent path traversal)
        const rawName = input.filename || result.file_name || fileId;
        let fileName = basename(rawName.replace(/[\\\x00]/g, "/")) || fileId;
        if (fileName === "." || fileName === "..") fileName = fileId;

        // Ensure output directory exists
        mkdirSync(outputDir, { recursive: true });

        // Write to temp file
        const outPath = join(outputDir, fileName);
        writeFileSync(outPath, buffer);

        return ok({
          path: outPath,
          file_name: fileName,
          file_size: buffer.length,
        });
      } catch (error) {
        const msg = `Failed to download file: ${error instanceof Error ? error.message : String(error)}`;
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: msg, file_id: fileId }) }],
          details: {},
          isError: true,
        } as AgentToolResult<unknown>;
      }
  }
}
