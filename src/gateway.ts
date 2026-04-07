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
  buildReplySegment,
  buildTarget,
} from "./onebot/message.js";
import type { MessageSegment, MessageTarget } from "./onebot/types.js";
import { RateLimiter } from "./rate-limiter.js";

// ── Module-level rate limiter ───────────────────────────────────────

const rateLimiter = new RateLimiter();

/** @internal Exposed for testing only. */
export function _getRateLimiter(): RateLimiter {
  return rateLimiter;
}

// ── Send with Retry ─────────────────────────────────────────────────

/** @internal Exported for testing. */
export async function sendWithRetry(
  client: OneBotClient,
  target: MessageTarget,
  segments: MessageSegment[],
  log?: { warn: (msg: string) => void; error: (msg: string) => void },
  maxAttempts = 3,
  targetKey?: string,
): Promise<number> {
  // Rate-limit if a targetKey was provided
  if (targetKey) {
    await rateLimiter.acquire(targetKey);
  }

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await client.sendMessage(target, segments);
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) {
        const delayMs = 1000 * Math.pow(2, attempt - 1); // 1s, 2s, 4s
        log?.warn(
          `Send attempt ${attempt}/${maxAttempts} failed, retrying in ${delayMs}ms: ${err instanceof Error ? err.message : String(err)}`,
        );
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }
  throw lastErr;
}


/**
 * Resolve reply context from message segments.
 * If the message contains a reply segment, fetches the referenced message via get_msg
 * and returns a formatted context string like `[引用 张三 的消息: 你好]\n`.
 *
 * @param segments  The message segments to search for a reply segment.
 * @param client    Optional OneBot client for calling get_msg.
 *                  When omitted, returns empty string (no resolution).
 * @returns         A formatted reply context string, or empty string if no reply.
 */
export async function resolveReplyContext(
  segments: Array<{ type: string; data: Record<string, string> }>,
  client?: { callApi: (action: string, params: Record<string, unknown>) => Promise<unknown> },
): Promise<string> {
  const replySegment = segments.find(seg => seg.type === "reply");
  if (!replySegment?.data?.id || !client) return "";

  try {
    const repliedMsg = await client.callApi("get_msg", {
      message_id: Number(replySegment.data.id),
    }) as {
      sender?: { card?: string; nickname?: string };
      message?: Array<{ type: string; data: Record<string, string> }>;
    } | undefined;

    if (repliedMsg?.message) {
      const repliedSender = repliedMsg.sender?.card || repliedMsg.sender?.nickname || "?";
      // Start at depth 1 since resolveReplyContext itself is the first layer of expansion
      const repliedContent = await parseHistoryMessageSegments(repliedMsg.message, client, 1, 3);
      return `[引用 ${repliedSender} 的消息: ${repliedContent}]\n`;
    }
  } catch {
    // get_msg failed, skip reply context
  }
  return "";
}

/**
 * Parse a history message's segments into a text summary.
 * Returns a string with per-image resolve hints and [文件: name] markers for non-text content.
 *
 * @param client    Optional OneBot client for resolving reply/forward segments via API.
 *                  When omitted, reply segments degrade to `[回复消息]` and forward to `[合并转发消息]`.
 * @param depth     Current recursion depth (default 0).
 * @param maxDepth  Maximum recursion depth (default 3). When depth >= maxDepth,
 *                  reply and forward segments degrade to plain text markers.
 */
export async function parseHistoryMessageSegments(
  segs: Array<{ type: string; data: Record<string, string> }> | undefined | null,
  client?: { callApi: (action: string, params: Record<string, unknown>) => Promise<unknown> },
  depth?: number,
  maxDepth?: number,
): Promise<string> {
  const d = depth ?? 0;
  const md = maxDepth ?? 3;
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
      const fileId = seg.data.file_id;
      if (fileId) {
        fileNames.push(`${name} - 使用 qq_download_group_file(file_id: "${fileId}") 下载`);
      } else {
        fileNames.push(name);
      }
    } else if (seg.type === "reply") {
      const replyId = seg.data.id;
      if (replyId && client && d < md) {
        try {
          const repliedMsg = await client.callApi("get_msg", { message_id: Number(replyId) }) as {
            sender?: { card?: string; nickname?: string };
            message?: Array<{ type: string; data: Record<string, string> }>;
          } | undefined;

          if (repliedMsg?.message) {
            const repliedSender = repliedMsg.sender?.card || repliedMsg.sender?.nickname || "?";
            const repliedContent = await parseHistoryMessageSegments(repliedMsg.message, client, d + 1, md);
            textParts.push(`[回复 ${repliedSender}: ${repliedContent}]`);
          } else {
            textParts.push("[回复消息]");
          }
        } catch {
          textParts.push("[回复消息]");
        }
      } else {
        textParts.push("[回复消息]");
      }
    } else if (seg.type === "at") {
      const qq = seg.data.qq;
      if (qq === "all") {
        textParts.push("@全体成员");
      } else {
        textParts.push(`@${qq}`);
      }
    } else if (seg.type === "record") {
      textParts.push("[语音消息]");
    } else if (seg.type === "forward") {
      const forwardId = seg.data.id;
      if (forwardId && client && d < md) {
        try {
          const forwardResult = await client.callApi("get_forward_msg", {
            message_id: forwardId,
          }) as {
            messages?: Array<{
              sender?: { nickname?: string; card?: string; user_id?: number };
              content?: Array<{ type: string; data: Record<string, string> }>;
              // NapCat may use "message" instead of "content"
              message?: Array<{ type: string; data: Record<string, string> }>;
            }>;
          } | undefined;

          const msgs = forwardResult?.messages;
          if (msgs && msgs.length > 0) {
            const parts: string[] = [];
            for (const msg of msgs) {
              const sender = msg.sender?.card || msg.sender?.nickname || "?";
              const msgSegs = msg.content || msg.message;
              const content = await parseHistoryMessageSegments(msgSegs, client, d + 1, md);
              parts.push(`${sender}: ${content}`);
            }
            textParts.push(`[合并转发消息:\n${parts.join("\n")}]`);
          } else {
            textParts.push("[合并转发消息]");
          }
        } catch {
          textParts.push("[合并转发消息]");
        }
      } else {
        textParts.push("[合并转发消息]");
      }
    } else if (seg.type === "video") {
      textParts.push("[视频]");
    } else if (seg.type === "json") {
      textParts.push("[卡片消息]");
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

    // Group messages require @bot mention (unless requireMention is disabled)
    const mentioned = wasBotMentioned(event.message, account.botQQ);
    const requireMention = account.requireMention ?? true;
    if (requireMention && !mentioned) return;
  }

  // ── Extract message content ─────────────────────────────────────
  const rawText = extractPlainText(event.message);
  const imageUrls = extractImageUrls(event.message);

  // Strip bot mention from the text for group messages (used for BodyForAgent)
  let bodyForAgent = rawText;
  if (isGroup) {
    bodyForAgent = stripBotMention(rawText, account.botQQ);
  }

  // Skip empty messages (after stripping) — but allow empty @bot in groups
  if (!bodyForAgent && imageUrls.length === 0) {
    if (!isGroup) return; // DM with no content → skip
    // Group empty @bot → treat as a greeting/summon
    bodyForAgent = "[用户@了你但没有附带任何文字]";
  }

  // ── Resolve reply context (quoted message) ───────────────────
  const replyContext = await resolveReplyContext(event.message as Array<{ type: string; data: Record<string, string> }>, client);
  if (replyContext) {
    bodyForAgent = replyContext + bodyForAgent;
  }

  // ── Processing indicator (emoji reaction) ────────────────────────
  // React with 🔥 to show the message is being processed
  let processingEmojiSet = false;
  try {
    await client.callApi("set_msg_emoji_like", {
      message_id: event.message_id,
      emoji_id: "128293",  // 🔥 processing
    });
    processingEmojiSet = true;
  } catch (err) {
    log?.warn(`Failed to set processing emoji: ${err instanceof Error ? err.message : String(err)}`);
  }

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
          inboundHistory = await Promise.all(contextMsgs.map(async (m) => {
            const senderObj = m.sender as Record<string, string> | undefined | null;
            const sender = senderObj?.card
              || senderObj?.nickname
              || String(m.user_id);
            const segs = m.message as Array<{ type: string; data: Record<string, string> }>;
            const body = await parseHistoryMessageSegments(segs, client);
            const timestamp = typeof m.time === "number"
              ? (m.time as number) * 1000
              : (event.time ? event.time * 1000 : Date.now());
            const messageId = typeof m.message_id === "number" ? String(m.message_id) : undefined;
            const bodyWithId = messageId ? `[msg_id:${messageId}] ${body}` : body;
            return { sender, body: bodyWithId, timestamp };
          }));
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
    Body: bodyForAgent,
    BodyForAgent: bodyForAgent,
    RawBody: rawText,
    CommandBody: bodyForAgent,
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
  // Remove 🔥 processing indicator only if it was set successfully
  if (processingEmojiSet) {
    try {
      await client.callApi("set_msg_emoji_like", {
        message_id: event.message_id,
        emoji_id: "128293",
        set: false,  // remove 🔥
      });
    } catch (err) {
      log?.warn(`Failed to remove processing emoji: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // ✨ done emoji always attempted (regardless of 🔥 success)
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
  const targetKey = isGroup
    ? `group:${event.group_id}`
    : `user:${event.user_id}`;

  // Track whether we've prepended a reply (quote) segment to the first message.
  // Only used for group chats.
  let repliedToOriginal = false;

  // Track whether the first media URL has already been sent (merged with text).
  let firstMediaSent = false;

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

    for (let i = 0; i < chunks.length; i++) {
      const isLastChunk = i === chunks.length - 1;
      const segments: MessageSegment[] = buildTextSegments(chunks[i]);

      // Quote-reply: prepend reply segment to the first message (group only)
      if (isGroup && !repliedToOriginal) {
        segments.unshift(buildReplySegment(event.message_id));
        repliedToOriginal = true;
      }

      // Merge: append first media to the last text chunk
      if (isLastChunk && payload.mediaUrl) {
        const mediaSegment = buildMediaSegment(payload.mediaUrl);
        segments.push(mediaSegment);
        try {
          await sendWithRetry(client, target, segments, log, 3, targetKey);
          firstMediaSent = true;
        } catch {
          // Merge failed — fallback: send text and media separately
          // Remove the media segment from the end
          segments.pop();
          try {
            await sendWithRetry(client, target, segments, log, 3, targetKey);
          } catch (err) {
            log?.error(
              `Failed to send text chunk: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          // Media will be sent below in the media section
        }
      } else {
        try {
          await sendWithRetry(client, target, segments, log, 3, targetKey);
        } catch (err) {
          log?.error(
            `Failed to send text chunk: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
  }

  // Send media (images)
  if (payload.mediaUrl && !firstMediaSent) {
    const segments: MessageSegment[] = [buildMediaSegment(payload.mediaUrl)];
    // If no text was sent yet, and it's a group, prepend reply segment
    if (isGroup && !repliedToOriginal) {
      segments.unshift(buildReplySegment(event.message_id));
      repliedToOriginal = true;
    }
    try {
      await sendWithRetry(client, target, segments, log, 3, targetKey);
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
        await sendWithRetry(client, target, [buildMediaSegment(url)], log, 3, targetKey);
      } catch (err) {
        log?.error(
          `Failed to send media: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}


