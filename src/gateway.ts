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

/** Active client map keyed by accountId (for outbound adapter access). */
const activeClients = new Map<string, OneBotClient>();

export function getActiveClient(accountId: string): OneBotClient | undefined {
  return activeClients.get(accountId);
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

async function handleInboundMessage(
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
  let groupContext = "";
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
          .filter((m) => {
            const mid = m.message_id as number;
            return mid !== event.message_id;
          })
          .slice(-(account.groupContextMessages)); // take last N

        if (contextMsgs.length > 0) {
          const lines = contextMsgs.map((m) => {
            const sender = (m.sender as Record<string, string>)?.card
              || (m.sender as Record<string, string>)?.nickname
              || String(m.user_id);
            const segs = m.message as Array<{ type: string; data: Record<string, string> }>;
            const text = segs
              ?.filter((s) => s.type === "text")
              .map((s) => s.data.text)
              .join("") || "[非文本消息]";
            return `${sender}: ${text}`;
          });
          groupContext = `[以下是群聊中最近的${contextMsgs.length}条消息，供你了解上下文]\n${lines.join("\n")}\n[以上是历史消息，以下是用户@你的消息]`;
        }
      }
    } catch (err) {
      log?.warn?.(`Failed to fetch group history: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const senderName =
    event.sender.card || event.sender.nickname || senderId;
  const chatType = isGroup ? "group" : "direct";
  const from = isGroup ? `qq:group:${groupId}` : `qq:${senderId}`;
  const to = isGroup ? `qq:group:${groupId}` : `qq:${account.botQQ}`;
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
  const commandAuthorized = account.allowFrom.includes(senderId);

  // ── Build MsgContext ────────────────────────────────────────────
  const bodyForAgent = groupContext
    ? `${groupContext}\n\n${rawText}`
    : rawText;

  const msgCtx: Record<string, unknown> = {
    Body: rawText,
    BodyForAgent: bodyForAgent,
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

  // Attach media if present
  if (imageUrls.length > 0) {
    msgCtx.MediaUrl = imageUrls[0];
    msgCtx.MediaUrls = imageUrls;
    msgCtx.MediaType = "image";
    msgCtx.MediaTypes = imageUrls.map(() => "image");
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
      await client.sendMessage(target, [buildMediaSegment(payload.mediaUrl)]);
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
