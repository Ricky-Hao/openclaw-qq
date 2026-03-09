// Gateway adapter — startAccount / stopAccount
// This is the core of the plugin: manages WS connections and routes inbound messages.

import type {
  ChannelGatewayContext,
  ChannelAccountSnapshot,
  PluginRuntime,
  ReplyPayload,
  OpenClawConfig,
} from "openclaw/plugin-sdk";
import { OneBotClient } from "./onebot/client.js";
import type { OneBotMessageEvent } from "./onebot/types.js";
import type { QQResolvedAccount } from "./config.js";
import {
  extractPlainText,
  wasBotMentioned,
  stripBotMention,
  extractImageUrls,
  buildTextSegments,
  buildMediaSegment,
  buildTarget,
} from "./onebot/message.js";



/**
 * Parse a history message's segments into a text summary.
 * Returns a string with per-image resolve hints and [文件: name] markers for non-text content.
 */
export function parseHistoryMessageSegments(
  segs: Array<{ type: string; data: Record<string, string> }> | undefined | null,
): string {
  const textParts: string[] = [];
  const imageParts: string[] = [];
  const fileNames: string[] = [];

  for (const seg of (segs || [])) {
    if (seg.type === "text") {
      textParts.push(seg.data.text);
    } else if (seg.type === "face") {
      textParts.push(`[表情${seg.data.id}]`);
    } else if (seg.type === "image") {
      const file = seg.data.file;
      if (file) {
        imageParts.push(`[图片 - 使用 qq_resolve_image(file: "${file}") 获取]`);
      } else {
        // Fallback for images without file hash (shouldn't happen in history, but defensive)
        imageParts.push(`[图片]`);
      }
    } else if (seg.type === "file") {
      const name = seg.data.name || seg.data.file || "未知文件";
      fileNames.push(name);
    }
  }

  let line = textParts.join("").trim();
  for (const imgPart of imageParts) {
    line = line ? `${line} ${imgPart}` : imgPart;
  }
  for (const fn of fileNames) {
    line = line ? `${line} [文件: ${fn}]` : `[文件: ${fn}]`;
  }
  if (!line) line = "[非文本消息]";

  return line;
}

/**
 * Download inbound images using the SDK media pipeline.
 * Processes URLs sequentially (SDK's saveMediaBuffer is sync I/O).
 */
async function downloadInboundImages(
  urls: string[],
  runtime: PluginRuntime,
  log?: { warn: (msg: string) => void },
): Promise<Array<{ url: string; path: string; contentType?: string }>> {
  const results: Array<{ url: string; path: string; contentType?: string }> = [];
  for (const url of urls) {
    try {
      const fetched = await runtime.channel.media.fetchRemoteMedia({
        url,
        filePathHint: url,
        maxBytes: 20 * 1024 * 1024, // 20MB limit
      });
      const saved = await runtime.channel.media.saveMediaBuffer(
        fetched.buffer,
        fetched.contentType,
        "inbound",
      );
      results.push({ url, path: saved.path, contentType: saved.contentType });
    } catch (err) {
      log?.warn(`Failed to download QQ image: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return results;
}

/** Active client map keyed by accountId (for outbound adapter access). */
const activeClients = new Map<string, OneBotClient>();

export function getActiveClient(accountId: string): OneBotClient | undefined {
  return activeClients.get(accountId);
}

/** Return any active client (for tools that don't know the account ID). */
export function getAnyActiveClient(): OneBotClient | undefined {
  for (const client of activeClients.values()) return client;
  return undefined;
}

// ── Start Account ───────────────────────────────────────────────────

export async function startAccount(
  ctx: ChannelGatewayContext<QQResolvedAccount>,
  pluginRuntime: PluginRuntime,
): Promise<void> {
  const { account, cfg, abortSignal, log, setStatus, getStatus, accountId } =
    ctx;

  const client = new OneBotClient({
    wsUrl: account.wsUrl,
    token: account.token,
  });

  activeClients.set(accountId, client);

  let connectCount = 0;
  client.on("connected", () => {
    connectCount++;
    setStatus({
      ...getStatus(),
      connected: true,
      running: true,
      lastConnectedAt: Date.now(),
      lastError: null,
    });
    if (connectCount === 1) {
      log?.info(`QQ bot ${account.botQQ} connected to ${account.wsUrl}`);
    } else {
      log?.info(`QQ bot ${account.botQQ} reconnected to ${account.wsUrl} (attempt #${connectCount})`);
    }
  });

  client.on("disconnected", (reason) => {
    setStatus({
      ...getStatus(),
      connected: false,
      lastDisconnect: { at: Date.now(), error: reason },
    });
    log?.warn(`QQ bot ${account.botQQ} disconnected: ${reason}`);
  });

  client.on("error", (err) => {
    setStatus({
      ...getStatus(),
      lastError: err.message,
    });
    log?.error(`QQ bot ${account.botQQ} error: ${err.message}`);
  });

  // ── Inbound message handler ─────────────────────────────────────
  client.on("message", (event) => {
    handleInboundMessage(event, account, cfg, pluginRuntime, client, log).catch(
      (err) => {
        log?.error(
          `Error handling inbound message: ${err instanceof Error ? err.message : String(err)}`,
        );
      },
    );
  });

  // ── Abort signal ────────────────────────────────────────────────
  abortSignal.addEventListener(
    "abort",
    () => {
      client.disconnect();
      activeClients.delete(accountId);
    },
    { once: true },
  );

  // Connect (will auto-reconnect on failure)
  try {
    await client.connect();
  } catch (err) {
    log?.warn(
      `Initial connect failed, will retry: ${err instanceof Error ? err.message : String(err)}`,
    );
    // OneBotClient auto-reconnects, so we don't throw here
  }

  // Keep the startAccount promise pending until abort.
  // If this resolves, the gateway treats the account as "stopped" and auto-restarts.
  await new Promise<void>((resolve) => {
    abortSignal.addEventListener("abort", () => resolve(), { once: true });
  });
}

// ── Stop Account ────────────────────────────────────────────────────

export async function stopAccount(
  ctx: ChannelGatewayContext<QQResolvedAccount>,
): Promise<void> {
  const client = activeClients.get(ctx.accountId);
  if (client) {
    client.disconnect();
    activeClients.delete(ctx.accountId);
  }
  ctx.setStatus({
    ...ctx.getStatus(),
    running: false,
    connected: false,
    lastStopAt: Date.now(),
  });
  ctx.log?.info(`QQ bot ${ctx.account.botQQ} stopped`);
}

// ── Inbound Message Routing ─────────────────────────────────────────

/** @internal Exported for testing. */
export async function handleInboundMessage(
  event: OneBotMessageEvent,
  account: QQResolvedAccount,
  cfg: OpenClawConfig,
  runtime: PluginRuntime,
  client: OneBotClient,
  log?: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void },
): Promise<void> {
  const isGroup = event.message_type === "group";
  const senderId = String(event.user_id);
  const groupId = event.group_id ? String(event.group_id) : undefined;

  // ── Self-message filter ─────────────────────────────────────────
  if (senderId === account.botQQ) return;

  // ── Security: DM policy ─────────────────────────────────────────
  if (!isGroup) {
    if (account.dmPolicy === "allowlist") {
      if (!account.allowFrom.includes(senderId)) {
        log?.info(`DM from ${senderId} rejected (not in allowFrom)`);
        return;
      }
    }
  }

  // ── Security: Group policy ──────────────────────────────────────
  if (isGroup && groupId) {
    if (account.groupPolicy === "allowlist") {
      if (!account.groupAllowFrom.includes(groupId)) {
        log?.info(`Group ${groupId} rejected (not in groupAllowFrom)`);
        return;
      }
    }

    // Group messages require @bot mention
    const mentioned = wasBotMentioned(event.message, account.botQQ);
    if (!mentioned) return;
  }

  // ── Extract message content ─────────────────────────────────────
  let rawText = extractPlainText(event.message);
  const imageUrls = extractImageUrls(event.message);

  // Strip bot mention from the text for group messages
  if (isGroup) {
    rawText = stripBotMention(rawText, account.botQQ);
  }

  // Skip empty messages (after stripping) — but allow empty @bot in groups
  if (!rawText && imageUrls.length === 0) {
    if (!isGroup) return; // DM with no content → skip
    // Group empty @bot → treat as a greeting/summon
    rawText = "[用户@了你但没有附带任何文字]";
  }

  // ── Processing indicator (emoji reaction) ────────────────────────
  // React with 🔥 to show the message is being processed
  client.callApi("set_msg_emoji_like", {
    message_id: event.message_id,
    emoji_id: "128293",  // 🔥 processing
  }).catch((err) => { log?.warn(`Failed to set processing emoji: ${err instanceof Error ? err.message : String(err)}`); });

  // ── Fetch group context (recent messages before this one) ───────
  let inboundHistory: Array<{ sender: string; body: string; timestamp: number }> | undefined;
  if (isGroup && account.groupContextMessages > 0) {
    try {
      const histResult = await client.callApi("get_group_msg_history", {
        group_id: event.group_id,
        count: account.groupContextMessages + 5, // fetch a few extra to filter
      }) as { messages?: Array<Record<string, unknown>> } | undefined;

      const messages = histResult?.messages;
      if (messages && messages.length > 0) {
        // Filter out only the current message itself; keep bot's own messages for full context
        const contextMsgs = messages
          .filter((m) => (m.message_id as number) !== event.message_id)
          .slice(-(account.groupContextMessages)); // take last N

        if (contextMsgs.length > 0) {
          inboundHistory = contextMsgs.map((m) => {
            const senderObj = m.sender as Record<string, string> | undefined | null;
            const sender = senderObj?.card
              || senderObj?.nickname
              || String(m.user_id);
            const segs = m.message as Array<{ type: string; data: Record<string, string> }>;
            const body = parseHistoryMessageSegments(segs);
            const timestamp = typeof m.time === "number"
              ? (m.time as number) * 1000
              : (event.time ? event.time * 1000 : Date.now());
            return { sender, body, timestamp };
          });
        }
      }
    } catch (err) {
      log?.warn(`Failed to fetch group history: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const senderName =
    event.sender.card || event.sender.nickname || senderId;
  const chatType = isGroup ? "group" : "direct";
  const from = isGroup ? `qq:group:${groupId}` : `qq:${senderId}`;
  const to = isGroup ? `qq:group:${groupId}` : `qq:${senderId}`;
  const messageSid = `qq_${event.message_id}`;

  // ── Resolve agent route ─────────────────────────────────────────
  const route = runtime.channel.routing.resolveAgentRoute({
    cfg,
    channel: "qq",
    accountId: account.accountId,
    peer: {
      kind: chatType,
      id: isGroup ? groupId! : senderId,
    },
  });

  // ── Check command authorization ─────────────────────────────────
  const commandAuthorized = runtime.channel.commands.resolveCommandAuthorizedFromAuthorizers({
    useAccessGroups: false,
    authorizers: [
      {
        configured: account.allowFrom.length > 0,
        allowed: account.allowFrom.includes(senderId),
      },
    ],
  });

  // ── Build MsgContext ────────────────────────────────────────────
  const msgCtx: Record<string, unknown> = {
    Body: rawText,
    BodyForAgent: rawText,
    RawBody: rawText,
    CommandBody: rawText,
    From: from,
    To: to,
    SessionKey: route.sessionKey,
    AccountId: account.accountId,
    ChatType: chatType,
    ConversationLabel: isGroup
      ? `QQ Group ${groupId}`
      : `QQ DM ${senderName}`,
    SenderName: senderName,
    SenderId: senderId,
    SenderUsername: event.sender.nickname || senderId,
    Provider: "qq",
    Surface: "qq",
    MessageSid: messageSid,
    Timestamp: event.time * 1000, // OneBot uses seconds
    WasMentioned: isGroup ? wasBotMentioned(event.message, account.botQQ) : undefined,
    CommandAuthorized: commandAuthorized,
    OriginatingChannel: "qq",
    OriginatingTo: to,
  };

  // Conditionally add InboundHistory only when available
  if (inboundHistory) msgCtx.InboundHistory = inboundHistory;

  // Attach media if present (current message images only)
  const allImageUrls = imageUrls;
  if (allImageUrls.length > 0) {
    msgCtx.MediaUrl = allImageUrls[0];
    msgCtx.MediaUrls = allImageUrls;
    msgCtx.MediaType = "image";
    msgCtx.MediaTypes = allImageUrls.map(() => "image");

    // Download images to local files so OpenClaw core can inject them
    // into the LLM context as image blocks (core requires MediaPaths)
    const downloaded = await downloadInboundImages(
      allImageUrls,
      runtime,
      log as { warn: (msg: string) => void } | undefined,
    );
    if (downloaded.length > 0) {
      const downloadedPaths = downloaded.map((d) => d.path);
      msgCtx.MediaPath = downloadedPaths[0];
      msgCtx.MediaPaths = downloadedPaths;
      // Use actual content types from SDK
      msgCtx.MediaTypes = downloaded.map((d) => d.contentType || "image");
    }
  }

  // ── Finalize context ────────────────────────────────────────────
  const finalCtx = runtime.channel.reply.finalizeInboundContext(msgCtx);

  // ── Record session ──────────────────────────────────────────────
  const storePath = runtime.channel.session.resolveStorePath(
    cfg.session?.store,
    { agentId: route.agentId },
  );

  await runtime.channel.session.recordInboundSession({
    storePath,
    sessionKey: route.sessionKey,
    ctx: finalCtx,
    updateLastRoute: {
      sessionKey: route.sessionKey,
      channel: "qq",
      to,
      accountId: account.accountId,
    },
    onRecordError: (err) => {
      log?.error(
        `Session record error: ${err instanceof Error ? err.message : String(err)}`,
      );
    },
  });

  // ── Dispatch to agent pipeline ──────────────────────────────────
  const deliver = async (payload: ReplyPayload): Promise<void> => {
    await deliverReply(payload, event, account, client, runtime, log);
  };

  await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: finalCtx,
    cfg,
    dispatcherOptions: {
      deliver,
      onError: (err) => {
        log?.error(
          `Reply dispatch error: ${err instanceof Error ? (err as Error).message : String(err)}`,
        );
      },
    },
  });

  // ── Done indicator (swap emoji reactions) ───────────────────────
  // Remove 🔥 processing indicator, then add ✨ done indicator
  try {
    await client.callApi("set_msg_emoji_like", {
      message_id: event.message_id,
      emoji_id: "128293",
      set: false,  // remove 🔥
    });
  } catch (err) {
    log?.warn(`Failed to remove processing emoji: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    await client.callApi("set_msg_emoji_like", {
      message_id: event.message_id,
      emoji_id: "10024",  // ✨ done
    });
  } catch (err) {
    log?.warn(`Failed to set done emoji: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── Deliver Reply ───────────────────────────────────────────────────

async function deliverReply(
  payload: ReplyPayload,
  event: OneBotMessageEvent,
  account: QQResolvedAccount,
  client: OneBotClient,
  runtime: PluginRuntime,
  log?: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void },
): Promise<void> {
  const isGroup = event.message_type === "group";
  const target = buildTarget(
    isGroup ? "group" : "private",
    event.user_id,
    event.group_id,
  );

  // Send text (possibly chunked)
  if (payload.text) {
    const textChunkLimit = runtime.channel.text.resolveTextChunkLimit(
      undefined,
      "qq",
    );
    const chunks = runtime.channel.text.chunkText(
      payload.text,
      textChunkLimit,
    );

    for (const chunk of chunks) {
      try {
        await client.sendMessage(target, buildTextSegments(chunk));
      } catch (err) {
        log?.error(
          `Failed to send text chunk: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  // Send media (images)
  if (payload.mediaUrl) {
    try {
      await client.sendMessage(target, [buildMediaSegment(payload.mediaUrl!)]);
    } catch (err) {
      log?.error(
        `Failed to send media: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (payload.mediaUrls) {
    for (const url of payload.mediaUrls) {
      if (url === payload.mediaUrl) continue; // already sent
      try {
        await client.sendMessage(target, [buildMediaSegment(url)]);
      } catch (err) {
        log?.error(
          `Failed to send media: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}
