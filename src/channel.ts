// ChannelPlugin definition — all adapters for QQ

import type {
  ChannelPlugin,
  ChannelAccountSnapshot,
  ChannelMessageActionContext,
  ChannelOutboundContext,
  ChannelResolveResult,
  ChannelStatusIssue,
  OpenClawConfig,
  PluginRuntime,
  ReplyPayload,
} from "openclaw/plugin-sdk";
import { buildChannelConfigSchema } from "openclaw/plugin-sdk";
import type { QQResolvedAccount } from "./config.js";
import {
  listAccountIds,
  resolveAccount,
  defaultAccountId,
  isEnabled,
  isConfigured,
  qqAccountSchema,
} from "./config.js";
import {
  startAccount,
  stopAccount,
  getActiveClient,
} from "./gateway.js";
import {
  buildTextSegments,
  buildImageSegment,
  buildMediaSegment,
} from "./onebot/message.js";
import { existsSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";
import {
  emojiToQQEmojiId,
  getSupportedEmojiList,
} from "./emoji.js";
import { handlePollAction } from "./poll.js";

/**
 * Resolve a potentially relative media path against mediaLocalRoots.
 * If the path is already absolute or a URL, return as-is.
 * For relative paths, try each root until we find a file that exists.
 */
function resolveMediaPath(
  pathOrUrl: string,
  mediaLocalRoots?: readonly string[],
): string {
  // URLs — pass through
  if (/^https?:\/\//i.test(pathOrUrl) || pathOrUrl.startsWith("base64://") || pathOrUrl.startsWith("file://")) {
    return pathOrUrl;
  }
  // Absolute path — pass through
  if (isAbsolute(pathOrUrl)) {
    return pathOrUrl;
  }
  // Relative path — try mediaLocalRoots
  if (mediaLocalRoots && mediaLocalRoots.length > 0) {
    for (const root of mediaLocalRoots) {
      const candidate = resolve(root, pathOrUrl);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }
  // Fallback: resolve against CWD (original behavior)
  return pathOrUrl;
}

let _pluginRuntime: PluginRuntime | undefined;

export function setPluginRuntime(runtime: PluginRuntime): void {
  _pluginRuntime = runtime;
}

function getPluginRuntime(): PluginRuntime {
  if (!_pluginRuntime) {
    throw new Error("PluginRuntime not initialized. Was register() called?");
  }
  return _pluginRuntime;
}

// ── Channel Plugin ──────────────────────────────────────────────────

export const qqChannelPlugin: ChannelPlugin<QQResolvedAccount> = {
  id: "qq",

  meta: {
    id: "qq",
    label: "QQ",
    selectionLabel: "QQ (OneBot v11)",
    docsPath: "https://github.com/user/openclaw-qq",
    blurb: "QQ messaging via OneBot v11 protocol (NapCat)",
    order: 90,
  },

  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
    nativeCommands: false,
    polls: false, // Disabled: use poll_create tool directly for correct agentId propagation
    reactions: true,
    edit: false,
    unsend: false,
    reply: true,
    effects: false,
    groupManagement: false,
    threads: false,
  },

  // ── Config Schema ───────────────────────────────────────────────
  configSchema: buildChannelConfigSchema(qqAccountSchema),

  // ── Config Adapter ──────────────────────────────────────────────
  config: {
    listAccountIds: (cfg) => listAccountIds(cfg),

    resolveAccount: (cfg, accountId) => resolveAccount(cfg, accountId),

    defaultAccountId: (cfg) => defaultAccountId(cfg),

    isEnabled: (account) => isEnabled(account),

    isConfigured: (account) => isConfigured(account),

    describeAccount: (account): ChannelAccountSnapshot => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: Boolean(account.wsUrl && account.botQQ),
      dmPolicy: account.dmPolicy,
      allowFrom: account.allowFrom,
    }),

    resolveAllowFrom: (params) => {
      const account = resolveAccount(params.cfg, params.accountId);
      return account.allowFrom;
    },
  },

  // ── Setup Adapter ───────────────────────────────────────────────
  setup: {
    applyAccountConfig: (params) => {
      const { cfg, accountId, input } = params;
      const raw = cfg as Record<string, unknown>;
      const channels = (raw.channels ?? {}) as Record<string, unknown>;
      const qq = (channels.qq ?? {}) as Record<string, unknown>;
      const acct = (qq[accountId] ?? {}) as Record<string, unknown>;

      if (input.token) acct.token = input.token;
      if (input.url) acct.wsUrl = input.url;

      qq[accountId] = acct;
      channels.qq = qq;
      raw.channels = channels;
      return raw as OpenClawConfig;
    },
  },

  // ── Gateway Adapter ─────────────────────────────────────────────
  gateway: {
    startAccount: (ctx) => startAccount(ctx, getPluginRuntime()),
    stopAccount: (ctx) => stopAccount(ctx),
  },

  // ── Outbound Adapter ───────────────────────────────────────────
  outbound: {
    deliveryMode: "gateway",
    textChunkLimit: 4500, // QQ has fairly generous message limits

    resolveTarget: (params) => {
      const { to } = params;
      if (!to) return { ok: false, error: new Error("No target specified") };

      // Already in correct format
      if (to.startsWith("qq:group:") || to.startsWith("qq:")) {
        return { ok: true, to };
      }

      // OpenClaw core stores targets as "channel:<id>" — extract the id
      if (to.startsWith("channel:")) {
        const id = to.slice("channel:".length);
        const num = parseInt(id, 10);
        if (!isNaN(num)) {
          // Check if this is a known group
          const accountId = params.accountId || defaultAccountId(params.cfg!);
          try {
            const account = resolveAccount(params.cfg!, accountId);
            if (account.groupAllowFrom.includes(id)) {
              return { ok: true, to: `qq:group:${id}` };
            }
          } catch {
            // ignore resolve errors
          }
          return { ok: true, to: `qq:${id}` };
        }
      }

      // Bare number — check if it's a known group from allowedGroups config
      const num = parseInt(to, 10);
      if (!isNaN(num)) {
        // Check if this number matches a known group
        const accountId = params.accountId || defaultAccountId(params.cfg!);
        try {
          const account = resolveAccount(params.cfg!, accountId);
          if (account.groupAllowFrom.includes(to)) {
            return { ok: true, to: `qq:group:${to}` };
          }
        } catch {
          // ignore resolve errors
        }
        // Default: treat as private user
        return { ok: true, to: `qq:${to}` };
      }

      return { ok: false, error: new Error(`Unknown QQ target: ${to}`) };
    },

    sendText: async (ctx) => {
      const accountId = ctx.accountId || defaultAccountId(ctx.cfg);
      const client = getActiveClient(accountId);
      if (!client?.connected) {
        throw new Error("QQ client not connected");
      }

      const target = resolveOutboundTarget(ctx.to);
      if (!target) {
        throw new Error(`Cannot resolve target: ${ctx.to}`);
      }

      const msgId = await client.sendMessage(
        target,
        buildTextSegments(ctx.text),
      );
      return { channel: "qq", messageId: String(msgId) };
    },

    sendMedia: async (ctx) => {
      const accountId = ctx.accountId || defaultAccountId(ctx.cfg);
      const client = getActiveClient(accountId);
      if (!client?.connected) {
        throw new Error("QQ client not connected");
      }

      const target = resolveOutboundTarget(ctx.to);
      if (!target) {
        throw new Error(`Cannot resolve target: ${ctx.to}`);
      }

      const segments = [];
      if (ctx.text) {
        segments.push(...buildTextSegments(ctx.text));
      }
      if (ctx.mediaUrl) {
        const resolved = resolveMediaPath(ctx.mediaUrl, ctx.mediaLocalRoots);
        segments.push(buildMediaSegment(resolved));
      }
      const msgId = await client.sendMessage(target, segments);
      return { channel: "qq", messageId: String(msgId) };
    },

    sendPayload: async (ctx) => {
      const accountId = ctx.accountId || defaultAccountId(ctx.cfg);
      const client = getActiveClient(accountId);
      if (!client?.connected) {
        throw new Error("QQ client not connected");
      }

      const target = resolveOutboundTarget(ctx.to);
      if (!target) {
        throw new Error(`Cannot resolve target: ${ctx.to}`);
      }

      const payload = ctx.payload;
      let lastMsgId = "0";
      // Send text
      if (payload.text) {
        const id = await client.sendMessage(target, buildTextSegments(payload.text));
        lastMsgId = String(id);
      }
      // Send media
      if (payload.mediaUrl) {
        const id = await client.sendMessage(target, [
          buildMediaSegment(payload.mediaUrl),
        ]);
        lastMsgId = String(id);
      }
      if (payload.mediaUrls) {
        for (const url of payload.mediaUrls) {
          if (url === payload.mediaUrl) continue;
          const id = await client.sendMessage(target, [buildMediaSegment(url)]);
          lastMsgId = String(id);
        }
      }
      return { channel: "qq", messageId: lastMsgId };
    },
  },

  // ── Security Adapter ────────────────────────────────────────────
  security: {
    resolveDmPolicy: (ctx) => {
      const account = ctx.account;
      return {
        policy: account.dmPolicy,
        allowFrom: account.allowFrom,
        allowFromPath: `channels.qq.${account.accountId}.allowFrom`,
        approveHint: `Add their QQ number to channels.qq.${account.accountId}.allowFrom`,
      };
    },
  },

  // ── Messaging Adapter ────────────────────────────────────────────
  messaging: {
    normalizeTarget: (raw: string) => {
      const trimmed = raw.trim();
      // Already prefixed
      if (trimmed.startsWith("qq:")) return trimmed;
      // Bare number — return as-is, resolveTarget will handle group vs private
      if (/^\d+$/.test(trimmed)) return trimmed;
      return undefined;
    },
    targetResolver: {
      looksLikeId: (raw: string) => {
        const trimmed = raw.trim();
        // qq:group:xxx or qq:xxx
        if (trimmed.startsWith("qq:")) return true;
        // Bare number (QQ number or group ID)
        if (/^\d{5,}$/.test(trimmed)) return true;
        return false;
      },
      hint: "Use a QQ number, group ID, or qq:group:<id> / qq:<id> format",
    },
  },

  // ── Actions Adapter ─────────────────────────────────────────────
  actions: {
    supportsAction: ({ action }) => action === "send" || action === "react" || action === "poll",

    handleAction: async (ctx: ChannelMessageActionContext) => {
      const params = ctx.params;

      if (ctx.action === "poll") {
        return {
          content: [{ type: "text", text: "❌ 请使用 poll_create 工具创建投票，不要通过 message 工具创建。poll_create 能正确设置定时结算和 agent 身份。" }],
          isError: true,
          details: {},
        };
      }

      if (ctx.action === "send") {
        // Block message(action="send", pollQuestion=...) — must use poll_create tool
        if (params.pollQuestion || params.pollOption) {
          return {
            content: [{ type: "text", text: "❌ 请使用 poll_create 工具创建投票，不要通过 message(pollQuestion=...) 创建。poll_create 能正确设置定时结算和 agent 身份。" }],
            isError: true,
            details: {},
          };
        }

        const toRaw = (params.to ?? params.target) as string | undefined;
        if (!toRaw) {
          return {
            content: [{ type: "text", text: "target/to is required for send action." }],
            isError: true,
            details: {},
          };
        }

        const accountId = ctx.accountId || defaultAccountId(ctx.cfg);
        const client = getActiveClient(accountId);
        if (!client?.connected) {
          return {
            content: [{ type: "text", text: "QQ client not connected." }],
            isError: true,
            details: {},
          };
        }

        const target = resolveOutboundTarget(toRaw);
        if (!target) {
          return {
            content: [{ type: "text", text: `Cannot resolve target: ${toRaw}` }],
            isError: true,
            details: {},
          };
        }

        const text = typeof params.message === "string" ? params.message : "";
        const mediaUrl = typeof params.media === "string" ? params.media : undefined;
        const mediaUrls = Array.isArray(params.mediaUrls)
          ? params.mediaUrls.filter((u): u is string => typeof u === "string")
          : [];

        if (!text.trim() && !mediaUrl && mediaUrls.length === 0) {
          return {
            content: [{ type: "text", text: "send requires message or media." }],
            isError: true,
            details: {},
          };
        }

        let lastMsgId = "0";

        // Send combined text + first media when available (matches outbound.sendMedia behavior)
        if (text || mediaUrl) {
          const segments = [];
          if (text) segments.push(...buildTextSegments(text));
          if (mediaUrl) segments.push(buildMediaSegment(mediaUrl));
          const id = await client.sendMessage(target, segments);
          lastMsgId = String(id);
        }

        // Send remaining media URLs (if any)
        for (const url of mediaUrls) {
          if (url === mediaUrl) continue;
          const id = await client.sendMessage(target, [buildMediaSegment(url)]);
          lastMsgId = String(id);
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              channel: "qq",
              to: toRaw,
              via: "plugin-action",
              result: {
                messageId: lastMsgId,
                channel: "qq",
              },
            }),
          }],
          details: {},
        };
      }

      if (ctx.action !== "react") {
        return {
          content: [{ type: "text", text: `Action "${ctx.action}" not supported for QQ.` }],
          isError: true,
          details: {},
        };
      }

      const messageId = params.message_id ?? params.messageId;
      const emoji = params.emoji as string | undefined;
      const remove = params.remove === true;

      if (!messageId) {
        return {
          content: [{ type: "text", text: "message_id is required for react action." }],
          isError: true,
          details: {},
        };
      }

      if (!emoji) {
        return {
          content: [{ type: "text", text: "emoji is required for react action." }],
          isError: true,
          details: {},
        };
      }

      // Resolve emoji to QQ emoji_id
      const emojiId = emojiToQQEmojiId(emoji);
      if (!emojiId) {
        const supported = getSupportedEmojiList();
        return {
          content: [{
            type: "text",
            text: `Emoji "${emoji}" is not supported by QQ reactions.\nSupported: ${supported}`,
          }],
          isError: true,
          details: {},
        };
      }

      const accountId = ctx.accountId || defaultAccountId(ctx.cfg);
      const client = getActiveClient(accountId);
      if (!client?.connected) {
        return {
          content: [{ type: "text", text: "QQ client not connected." }],
          isError: true,
          details: {},
        };
      }

      try {
        await client.callApi("set_msg_emoji_like", {
          message_id: Number(messageId),
          emoji_id: emojiId,
          set: !remove,
        });

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              ok: true,
              action: remove ? "removed" : "added",
              emoji,
              emojiId,
              messageId: String(messageId),
            }),
          }],
          details: {},
        };
      } catch (err) {
        return {
          content: [{
            type: "text",
            text: `Failed to ${remove ? "remove" : "add"} reaction: ${err instanceof Error ? err.message : String(err)}`,
          }],
          isError: true,
          details: {},
        };
      }
    },
  },

  // ── Groups Adapter ──────────────────────────────────────────────
  groups: {
    resolveRequireMention: (ctx) => {
      return (ctx as Record<string, unknown>).account
        ? ((ctx as Record<string, unknown>).account as QQResolvedAccount).requireMention ?? true
        : true;
    },
  },

  // ── Mentions Adapter ────────────────────────────────────────────
  mentions: {
    stripMentions: (params) => {
      let text = params.text;
      // Strip @bot QQ number patterns
      const account = resolveAccount(params.cfg!, undefined);
      if (account.botQQ) {
        text = text.replace(
          new RegExp(`@${account.botQQ}\\s*`, "g"),
          "",
        );
        text = text.replace(
          new RegExp(`\\[CQ:at,qq=${account.botQQ}\\]\\s*`, "g"),
          "",
        );
      }
      return text.trim();
    },
  },

  // ── Status Adapter ──────────────────────────────────────────────
  status: {
    buildChannelSummary: (params) => {
      const { account, snapshot } = params;
      return {
        botQQ: account.botQQ,
        wsUrl: account.wsUrl,
        dmPolicy: account.dmPolicy,
        groupPolicy: account.groupPolicy,
        connected: snapshot.connected ?? false,
        running: snapshot.running ?? false,
      };
    },

    resolveAccountState: (params) => {
      if (!params.configured) return "not configured";
      if (!params.enabled) return "disabled";
      return "enabled";
    },

    probeAccount: async (params) => {
      const { account } = params;
      const client = getActiveClient(account.accountId);
      if (!client) {
        return { ok: false, error: "No active WebSocket connection" };
      }
      try {
        const info = await client.callApi("get_login_info", {}, {
          maxRetries: 0,
          retryDelayMs: 0,
        }) as { user_id?: number; nickname?: string };
        return {
          ok: true,
          botQQ: String(info.user_id ?? ""),
          nickname: info.nickname ?? "",
        };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },

    collectStatusIssues: (accounts) => {
      const issues: ChannelStatusIssue[] = [];
      for (const snap of accounts) {
        if (!snap.connected) {
          issues.push({
            channel: "qq",
            accountId: snap.accountId ?? "unknown",
            kind: "runtime",
            message: "WebSocket not connected to NapCat",
            fix: "Check NapCat container is running and wsUrl is correct",
          });
        }
        if (snap.connected && !snap.running) {
          issues.push({
            channel: "qq",
            accountId: snap.accountId ?? "unknown",
            kind: "runtime",
            message: "Connected but not running (gateway may be initializing)",
          });
        }
      }
      return issues;
    },
  },

  // ── Directory Adapter ───────────────────────────────────────────
  directory: {
    self: async (params) => {
      const client = getActiveClient(params.accountId ?? "default");
      if (!client) return null;
      try {
        const info = await client.callApi("get_login_info") as {
          user_id?: number;
          nickname?: string;
        };
        return {
          kind: "user" as const,
          id: String(info.user_id ?? ""),
          name: info.nickname ?? undefined,
        };
      } catch {
        return null;
      }
    },

    listPeers: async (params) => {
      const client = getActiveClient(params.accountId ?? "default");
      if (!client) return [];
      try {
        const friends = await client.callApi("get_friend_list") as Array<{
          user_id: number;
          nickname: string;
          remark?: string;
        }>;
        let results = friends.map((f) => ({
          kind: "user" as const,
          id: String(f.user_id),
          name: f.remark || f.nickname,
          handle: f.nickname,
        }));
        if (params.query) {
          const q = params.query.toLowerCase();
          results = results.filter(
            (r) =>
              r.id.includes(q) ||
              r.name?.toLowerCase().includes(q) ||
              r.handle?.toLowerCase().includes(q),
          );
        }
        if (params.limit) results = results.slice(0, params.limit);
        return results;
      } catch {
        return [];
      }
    },

    listGroups: async (params) => {
      const client = getActiveClient(params.accountId ?? "default");
      if (!client) return [];
      try {
        const groups = await client.callApi("get_group_list") as Array<{
          group_id: number;
          group_name: string;
          member_count?: number;
        }>;
        let results = groups.map((g) => ({
          kind: "group" as const,
          id: String(g.group_id),
          name: g.group_name,
        }));
        if (params.query) {
          const q = params.query.toLowerCase();
          results = results.filter(
            (r) =>
              r.id.includes(q) || r.name?.toLowerCase().includes(q),
          );
        }
        if (params.limit) results = results.slice(0, params.limit);
        return results;
      } catch {
        return [];
      }
    },

    listGroupMembers: async (params) => {
      const client = getActiveClient(params.accountId ?? "default");
      if (!client) return [];
      try {
        const members = await client.callApi("get_group_member_list", {
          group_id: Number(params.groupId),
        }) as Array<{
          user_id: number;
          nickname: string;
          card?: string;
          role?: string;
        }>;
        let results = members.map((m) => ({
          kind: "user" as const,
          id: String(m.user_id),
          name: m.card || m.nickname,
          handle: m.nickname,
          raw: { role: m.role },
        }));
        if (params.limit) results = results.slice(0, params.limit);
        return results;
      } catch {
        return [];
      }
    },
  },

  // ── Resolver Adapter ────────────────────────────────────────────
  resolver: {
    resolveTargets: async (params) => {
      const { inputs, kind } = params;
      const client = getActiveClient(params.accountId ?? "default");
      if (!client) {
        return inputs.map((input) => ({ input, resolved: false, note: "No active client" }));
      }

      const results: ChannelResolveResult[] = [];

      if (kind === "group") {
        let groups: Array<{ group_id: number; group_name: string }> = [];
        try {
          groups = await client.callApi("get_group_list") as typeof groups;
        } catch { /* empty */ }

        for (const input of inputs) {
          // Try exact ID match first
          const byId = groups.find((g) => String(g.group_id) === input);
          if (byId) {
            results.push({ input, resolved: true, id: String(byId.group_id), name: byId.group_name });
            continue;
          }
          // Try name match
          const byName = groups.find((g) => g.group_name.toLowerCase().includes(input.toLowerCase()));
          if (byName) {
            results.push({ input, resolved: true, id: String(byName.group_id), name: byName.group_name });
            continue;
          }
          results.push({ input, resolved: false });
        }
      } else {
        // kind === "user" — search friends
        let friends: Array<{ user_id: number; nickname: string; remark?: string }> = [];
        try {
          friends = await client.callApi("get_friend_list") as typeof friends;
        } catch { /* empty */ }

        for (const input of inputs) {
          const byId = friends.find((f) => String(f.user_id) === input);
          if (byId) {
            results.push({ input, resolved: true, id: String(byId.user_id), name: byId.remark || byId.nickname });
            continue;
          }
          const byName = friends.find((f) =>
            f.nickname.toLowerCase().includes(input.toLowerCase()) ||
            (f.remark && f.remark.toLowerCase().includes(input.toLowerCase())),
          );
          if (byName) {
            results.push({ input, resolved: true, id: String(byName.user_id), name: byName.remark || byName.nickname });
            continue;
          }
          results.push({ input, resolved: false });
        }
      }

      return results;
    },
  },

  // ── Streaming Adapter ───────────────────────────────────────────
  streaming: {
    blockStreamingCoalesceDefaults: {
      minChars: 100,
      idleMs: 2000,
    },
  },

  // ── Agent Prompt Adapter ────────────────────────────────────────
  agentPrompt: {
    messageToolHints: () => [
      "QQ does not support Markdown formatting. Use plain text, 【brackets】 for emphasis, and numbered lists.",
      "QQ messages cannot be edited after sending.",
      "QQ image URLs expire within ~2 hours.",
    ],
  },
};

// ── Helpers ──────────────────────────────────────────────────────────

type OutboundTarget =
  | { type: "private"; userId: number }
  | { type: "group"; groupId: number };

function resolveOutboundTarget(to: string): OutboundTarget | null {
  // Format: qq:<userId> or qq:group:<groupId>
  if (to.startsWith("qq:group:")) {
    const groupId = parseInt(to.slice("qq:group:".length), 10);
    if (isNaN(groupId)) return null;
    return { type: "group", groupId };
  }
  if (to.startsWith("qq:")) {
    const userId = parseInt(to.slice("qq:".length), 10);
    if (isNaN(userId)) return null;
    return { type: "private", userId };
  }
  // Bare number — treat as private
  const num = parseInt(to, 10);
  if (!isNaN(num)) return { type: "private", userId: num };
  return null;
}
