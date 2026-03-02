/**
 * QQ Poll Tool — create emoji-reaction-based polls in QQ groups.
 *
 * Two tools:
 *   - poll_create: Send a poll message + auto-react with option emojis
 *   - poll_result: Query who voted for what, return summary
 *
 * Polls are persisted as JSON in <workspaceDir>/polls/<messageId>.json
 * so that poll_result can map emoji → option labels.
 *
 * Timed polls auto-create a one-shot cron job via Gateway HTTP API.
 */

import { Type, type Static } from "@sinclair/typebox";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { AnyAgentTool, ChannelMessageActionContext } from "openclaw/plugin-sdk";
import type { OneBotClient } from "./onebot/client.js";
import { getActiveClient } from "./gateway.js";
import { defaultAccountId, resolveAccount } from "./config.js";
import { buildTextSegments } from "./onebot/message.js";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// OpenClaw plugin tool context — used by the factory function
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

// ── Schemas ──────────────────────────────────────────────────────

const PollCreateParams = Type.Object(
  {
    question: Type.String({
      description: '投票问题，如"今晚吃什么？"',
    }),
    options: Type.Array(Type.String(), {
      description: "选项列表，最多6个",
      minItems: 2,
      maxItems: 6,
    }),
    duration: Type.Optional(
      Type.String({
        description:
          '投票持续时间，如 "10m"、"30m"、"1h"、"2h"。不填则不自动结算。',
      }),
    ),
    channel: Type.Optional(
      Type.String({
        description: '频道，默认 "qq"',
        default: "qq",
      }),
    ),
    target: Type.String({
      description: '目标群，如 "qq:group:111222333"',
    }),
  },
  { additionalProperties: false },
);

const PollResultParams = Type.Object(
  {
    message_id: Type.String({
      description: "投票消息的 message_id",
    }),
    channel: Type.Optional(
      Type.String({
        description: '频道，默认 "qq"',
        default: "qq",
      }),
    ),
  },
  { additionalProperties: false },
);

type PollCreateInput = Static<typeof PollCreateParams>;
type PollResultInput = Static<typeof PollResultParams>;

// ── Types ────────────────────────────────────────────────────────

interface PollOption {
  label: string;
  emoji: string;
  emojiId: string;
}

interface PollData {
  messageId: string;
  question: string;
  options: PollOption[];
  target: string;
  channel: string;
  createdAt: string;
  expiresAt?: string;
  botQQ: string;
  creatorQQ?: string; // who initiated the poll
  cronJobId?: string; // agent-cron job ID for auto-settlement
}

// ── Default emoji sequence ───────────────────────────────────────

// Verified emoji pool — all confirmed working on QQ PC client as reactions
// Includes both QQ face IDs (type 1, [表情XXX]) and Unicode emoji (type 2)
const VERIFIED_EMOJI_POOL = [
  { emoji: "[表情326]", emojiId: "326" },   // 生气
  { emoji: "[表情424]", emojiId: "424" },   // 
  { emoji: "🔥",        emojiId: "128293" }, // 火
  { emoji: "[表情76]",  emojiId: "76" },     // 赞
  { emoji: "[表情333]", emojiId: "333" },   // 烟花
  { emoji: "[表情137]", emojiId: "137" },   // 鞭炮
  { emoji: "[表情53]",  emojiId: "53" },     // 蛋糕
  { emoji: "[表情114]", emojiId: "114" },   // 篮球
  { emoji: "[表情89]",  emojiId: "89" },     // 西瓜
  { emoji: "[表情419]", emojiId: "419" },   //
  { emoji: "[表情307]", emojiId: "307" },   // 喵喵
  { emoji: "[表情277]", emojiId: "277" },   // 汪汪
  { emoji: "[表情201]", emojiId: "201" },   // 点赞
  { emoji: "[表情171]", emojiId: "171" },   // 茶
];

/**
 * Pick N unique random emoji from the verified pool.
 */
export function pickRandomEmoji(count: number): Array<{ emoji: string; emojiId: string }> {
  const pool = [...VERIFIED_EMOJI_POOL];
  const picked: Array<{ emoji: string; emojiId: string }> = [];
  for (let i = 0; i < count && pool.length > 0; i++) {
    const idx = Math.floor(Math.random() * pool.length);
    picked.push(pool.splice(idx, 1)[0]);
  }
  return picked;
}

// ── Duration parsing ─────────────────────────────────────────────

export function parseDuration(dur: string): number | null {
  const m = dur.match(/^(\d+)\s*(m|min|h|hr|hour)s?$/i);
  if (!m) return null;
  const val = parseInt(m[1]);
  const unit = m[2].toLowerCase();
  if (unit === "m" || unit === "min") return val * 60 * 1000;
  if (unit === "h" || unit === "hr" || unit === "hour") return val * 60 * 60 * 1000;
  return null;
}

// ── Helpers ──────────────────────────────────────────────────────

// Fixed global poll data directory — shared across all agents/sessions
const POLL_DATA_DIR = join(
  process.env.HOME || "/tmp",
  ".openclaw",
  "data",
  "polls",
);

function getPollDir(_ctx: ToolContext): string {
  mkdirSync(POLL_DATA_DIR, { recursive: true });
  return POLL_DATA_DIR;
}

function savePoll(ctx: ToolContext, poll: PollData): void {
  const dir = getPollDir(ctx);
  writeFileSync(join(dir, `${poll.messageId}.json`), JSON.stringify(poll, null, 2));
}

function loadPoll(ctx: ToolContext, messageId: string): PollData | null {
  const dir = getPollDir(ctx);
  const path = join(dir, `${messageId}.json`);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

export function resolveTarget(target: string): { type: "group" | "private"; id: string } | null {
  const m = target.match(/^(?:qq:)?(?:(group|private):)?(\d+)$/);
  if (!m) return null;
  return { type: (m[1] as "group" | "private") || "group", id: m[2] };
}

function getClientAndBotQQ(ctx: ToolContext): { client: OneBotClient; botQQ: string } {
  const cfg = ctx.config as any;
  const accountId = ctx.agentAccountId || defaultAccountId(cfg);
  const client = getActiveClient(accountId);
  if (!client?.connected) {
    throw new Error("QQ client not connected");
  }
  const account = resolveAccount(cfg, accountId);
  return { client, botQQ: account.botQQ || "" };
}

function ok(data: unknown): AgentToolResult<unknown> {
  return { content: [{ type: "text", text: JSON.stringify(data) }], details: {} };
}

function err(msg: string): AgentToolResult<unknown> {
  return { content: [{ type: "text", text: msg }], details: {}, isError: true } as AgentToolResult<unknown>;
}

export function makeBar(count: number, maxCount: number, width: number = 10): string {
  if (maxCount === 0) return "";
  const filled = Math.round((count / maxCount) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

/**
 * Resolve a group member's display name (card > nickname > userId).
 */
async function resolveGroupMemberName(
  client: OneBotClient,
  groupId: string,
  userId: string,
): Promise<string> {
  try {
    const resp = (await client.callApi("get_group_member_info", {
      group_id: Number(groupId),
      user_id: Number(userId),
    })) as { card?: string; nickname?: string };
    return resp.card || resp.nickname || userId;
  } catch {
    return userId;
  }
}

// ── Shared poll creation logic ───────────────────────────────────

/** Parameters for the core poll creation logic. */
interface CreatePollParams {
  question: string;
  options: string[];
  target: string;          // already resolved to qq:group:XXX format
  channel: string;
  durationMs?: number;     // duration in milliseconds (undefined = no auto-settle)
  durationLabel?: string;  // original duration string for result display (e.g. "10m")
  client: OneBotClient;
  botQQ: string;
  creatorQQ?: string;
  agentId?: string;        // owner agent ID for cron job registration
  saveCtx: ToolContext;    // context used for savePoll
}

/**
 * Core poll creation logic shared by poll_create tool and handlePollAction.
 * Sends the poll message, reacts with emoji, saves metadata, and returns the result.
 */
async function executePollCreate(params: CreatePollParams): Promise<AgentToolResult<unknown>> {
  const {
    question, options: optionLabels, target, channel,
    durationMs, durationLabel, client, botQQ, creatorQQ, agentId, saveCtx,
  } = params;

  // Validate target
  const tgt = resolveTarget(target);
  if (!tgt || tgt.type !== "group") {
    return err("投票仅支持群聊。target 格式: qq:group:群号");
  }

  // Validate options count
  if (optionLabels.length < 2 || optionLabels.length > 6) {
    return err("选项数量需要 2-6 个");
  }

  // Assign emojis to options (random from verified pool)
  const pickedEmoji = pickRandomEmoji(optionLabels.length);
  const pollOptions: PollOption[] = optionLabels.map((label, i) => {
    const picked = pickedEmoji[i];
    return { label, emoji: picked.emoji, emojiId: picked.emojiId };
  });

  // Build poll message text
  const lines = [`📊 投票：${question}`, ""];
  for (const opt of pollOptions) {
    lines.push(`${opt.emoji} ${opt.label}`);
  }
  lines.push("");

  // Handle duration / expiry
  let expiresAt: string | undefined;
  if (durationMs && durationMs > 0) {
    const expDate = new Date(Date.now() + durationMs);
    expiresAt = expDate.toISOString();
    const mins = Math.round(durationMs / 60000);
    lines.push(`⏰ ${mins}分钟后自动结算`);
  }

  // Send poll message
  const msgTarget = { type: "group" as const, groupId: Number(tgt.id) };
  const segments = buildTextSegments(lines.join("\n"));
  const messageId = await client.sendMessage(msgTarget, segments);
  const messageIdStr = String(messageId);

  // Auto-react with each option's emoji
  const reactResults: string[] = [];
  for (const opt of pollOptions) {
    if (!opt.emojiId) {
      reactResults.push(`${opt.emoji}: skipped (no emojiId)`);
      continue;
    }
    try {
      await client.callApi("set_msg_emoji_like", {
        message_id: Number(messageIdStr),
        emoji_id: opt.emojiId,
        set: true,
      });
      reactResults.push(`${opt.emoji}: ok`);
    } catch (e) {
      reactResults.push(`${opt.emoji}: failed — ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Save poll metadata
  const poll: PollData = {
    messageId: messageIdStr,
    question,
    options: pollOptions,
    target,
    channel,
    createdAt: new Date().toISOString(),
    expiresAt,
    botQQ,
    creatorQQ,
  };

  savePoll(saveCtx, poll);

  // Build result
  const result: Record<string, unknown> = {
    success: true,
    channel,
    to: target,
    messageId: messageIdStr,
    question,
    options: pollOptions.map((o) => ({ label: o.label, emoji: o.emoji })),
    reactions: reactResults,
  };

  if (expiresAt) {
    result.expiresAt = expiresAt;
    if (durationLabel) {
      result.duration = durationLabel;
    }

    // Try to auto-schedule settlement via agent-cron programmatic API
    let settlementScheduled = false;
    if (durationMs && durationMs > 0) {
      try {
        // Access agent-cron's addJob via globalThis Symbol (cross-plugin communication)
        // Same pattern as openclaw core's Symbol.for("openclaw.pluginRegistryState")
        type AddJobFn = (params: {
          name: string;
          ownerAgentId: string;
          schedule: { kind: "at"; at: string };
          payload: { kind: "agentTurn"; message: string; timeoutSeconds?: number };
          delivery: { mode: "announce"; channel: string; to: string };
        }) => Promise<{ ok: boolean; jobId?: string; error?: string }>;

        const addJob = (globalThis as Record<symbol, unknown>)[
          Symbol.for("openclaw.agentCron.addJob")
        ] as AddJobFn | undefined;
        if (typeof addJob !== "function") throw new Error("agent-cron addJob not available on globalThis");

        const cronResult = await addJob({
          name: `poll-settle-${messageIdStr}`,
          ownerAgentId: agentId || "main",
          schedule: {
            kind: "at",
            at: expiresAt,
          },
          payload: {
            kind: "agentTurn",
            message: `投票「${question}」时间到了！请调用 poll_result(message_id="${messageIdStr}") 查询结果，然后把 formattedText 发到群 ${target}。`,
            timeoutSeconds: 120,
          },
          delivery: {
            mode: "announce",
            channel,
            to: target,
          },
        });
        if (cronResult.ok && cronResult.jobId) {
          settlementScheduled = true;
          poll.cronJobId = cronResult.jobId;
          savePoll(saveCtx, poll);
        }
      } catch {
        // agent-cron plugin not available — fall back to settleAction hint
      }
    }

    if (settlementScheduled) {
      result.settlementScheduled = true;
      result.cronJobId = poll.cronJobId;
    } else {
      // Fallback: return settleAction hint for bot to handle manually
      result.settleAction = {
        instruction: "请立即调用 agent_cron_add 创建定时结算任务",
        agent_cron_add_params: {
          name: `poll-settle-${messageIdStr}`,
          schedule: { kind: "at", at: expiresAt },
          payload: {
            kind: "agentTurn",
            message: `投票「${question}」时间到了！请调用 poll_result(message_id="${messageIdStr}") 查询结果，然后把 formattedText 发到群 ${target}。`,
          },
          delivery: {
            mode: "announce",
            channel,
            to: target,
          },
        },
      };
    }
  }

  return ok(result);
}

// ── poll_create ──────────────────────────────────────────────────

export function createPollCreateTool(
  ctx: ToolContext,
): AnyAgentTool {
  return {
    name: "poll_create",
    label: "QQ Poll Create",
    description:
      "在QQ群创建投票。发送投票消息并自动贴上选项表情，群友点表情即可投票。支持定时自动结算。",
    parameters: PollCreateParams,

    async execute(
      _toolCallId: string,
      input: PollCreateInput,
      _signal?: AbortSignal,
    ): Promise<AgentToolResult<unknown>> {
      try {
        const { client, botQQ } = getClientAndBotQQ(ctx);

        // Parse duration string
        let durationMs: number | undefined;
        if (input.duration) {
          durationMs = parseDuration(input.duration) ?? undefined;
          if (!durationMs) {
            return err(`无效的持续时间格式: "${input.duration}"。支持: 10m, 30m, 1h, 2h`);
          }
        }

        return await executePollCreate({
          question: input.question,
          options: input.options,
          target: input.target,
          channel: input.channel || "qq",
          durationMs,
          durationLabel: input.duration,
          client,
          botQQ,
          creatorQQ: ctx.requesterSenderId || undefined,
          agentId: ctx.agentId,
          saveCtx: ctx,
        });
      } catch (e) {
        return err(`创建投票失败: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  } as unknown as AnyAgentTool;
}

// ── poll_result ──────────────────────────────────────────────────

export function createPollResultTool(
  ctx: ToolContext,
): AnyAgentTool {
  return {
    name: "poll_result",
    label: "QQ Poll Result",
    description:
      "查询QQ群投票结果。返回每个选项的投票人数和百分比。",
    parameters: PollResultParams,

    async execute(
      _toolCallId: string,
      input: PollResultInput,
      _signal?: AbortSignal,
    ): Promise<AgentToolResult<unknown>> {
      try {
        const { client, botQQ } = getClientAndBotQQ(ctx);
        const messageId = input.message_id;

        // Load poll metadata
        const poll = loadPoll(ctx, messageId);
        if (!poll) {
          return err(
            `未找到投票数据 (messageId=${messageId})。确认 messageId 正确。`,
          );
        }

        // Extract groupId from target
        const tgt = resolveTarget(poll.target);
        const groupId = tgt?.id || "";

        // Query each emoji's voter list
        const results: Array<{
          label: string;
          emoji: string;
          emojiId: string;
          count: number;
        }> = [];

        for (const opt of poll.options) {
          if (!opt.emojiId) {
            results.push({
              label: opt.label,
              emoji: opt.emoji,
              emojiId: opt.emojiId,
              count: 0,
            });
            continue;
          }

          try {
            const resp = (await client.callApi("get_emoji_likes", {
              message_id: messageId,
              emoji_id: opt.emojiId,
              count: 0,
            })) as {
              emoji_like_list: Array<{ user_id: string; nick_name: string }>;
            };

            const botIds = new Set([poll.botQQ, botQQ, ctx.agentAccountId].filter(Boolean));
            const voterCount = (resp.emoji_like_list || []).filter(
              (v) => !botIds.has(v.user_id),
            ).length;

            results.push({
              label: opt.label,
              emoji: opt.emoji,
              emojiId: opt.emojiId,
              count: voterCount,
            });
          } catch (e) {
            results.push({
              label: opt.label,
              emoji: opt.emoji,
              emojiId: opt.emojiId,
              count: -1,
            });
          }
        }

        const totalVotes = results.reduce((sum, r) => sum + Math.max(r.count, 0), 0);
        const maxCount = Math.max(...results.map((r) => r.count), 1);

        // Build formatted result text
        const lines = [`📊 投票结果：${poll.question}`, ""];
        for (const r of results) {
          const bar = makeBar(r.count, maxCount);
          const pct = totalVotes > 0 ? Math.round((Math.max(r.count, 0) / totalVotes) * 100) : 0;
          lines.push(`${r.emoji} ${r.label} — ${r.count}票 (${pct}%) ${bar}`);
        }
        lines.push("");
        lines.push(`共 ${totalVotes} 票`);

        if (poll.creatorQQ && groupId) {
          const creatorName = await resolveGroupMemberName(client, groupId, poll.creatorQQ);
          lines.push(`发起人: ${creatorName}`);
        }

        return ok({
          question: poll.question,
          results: results.map((r) => ({
            label: r.label,
            emoji: r.emoji,
            count: r.count,
          })),
          totalVotes,
          formattedText: lines.join("\n"),
          creatorQQ: poll.creatorQQ,
        });
      } catch (e) {
        return err(`查询投票结果失败: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  } as unknown as AnyAgentTool;
}

// ── handlePollAction (for message tool's poll action) ────────────

/**
 * Handle `message(action="send", pollQuestion=..., pollOption=[...])` by
 * intercepting the "poll" action dispatched by OpenClaw's message tool.
 *
 * This bridges the built-in `message` tool's poll parameters to our
 * emoji-reaction based poll system, so bots can use either `poll_create`
 * or `message(pollQuestion=...)` and get the same result.
 */
export async function handlePollAction(
  ctx: ChannelMessageActionContext,
): Promise<AgentToolResult<unknown>> {
  try {
    const params = ctx.params as Record<string, unknown>;

    // Extract poll parameters from message tool params
    const question = (params.pollQuestion ?? params.question) as string | undefined;
    const options = (params.pollOption ?? params.options) as string[] | undefined;
    const to = (params.to ?? params.target) as string | undefined;
    const durationHours = params.pollDurationHours as number | undefined;

    if (!question) {
      return err("pollQuestion is required.");
    }
    if (!options || options.length < 2) {
      return err("pollOption requires at least 2 options.");
    }
    if (options.length > 6) {
      return err("最多支持6个选项。");
    }
    if (!to) {
      return err("target/to is required.");
    }

    // Resolve target — handle both "qq:group:XXX" and bare "XXX" formats
    let resolvedTarget = to;
    if (/^\d+$/.test(to)) {
      resolvedTarget = `qq:group:${to}`;
    }

    // Get QQ client
    const cfg = ctx.cfg as Record<string, unknown>;
    const accountId = ctx.accountId || defaultAccountId(cfg);
    const client = getActiveClient(accountId);
    if (!client?.connected) {
      return err("QQ client not connected.");
    }
    const account = resolveAccount(cfg, accountId);
    const botQQ = account.botQQ || "";

    // Compute duration in ms
    const durationMs = (durationHours && durationHours > 0)
      ? durationHours * 60 * 60 * 1000
      : undefined;

    const saveCtx: ToolContext = {
      config: cfg,
      requesterSenderId: ctx.requesterSenderId || undefined,
    };

    return await executePollCreate({
      question,
      options,
      target: resolvedTarget,
      channel: "qq",
      durationMs,
      client,
      botQQ,
      creatorQQ: ctx.requesterSenderId || undefined,
      agentId: undefined,
      saveCtx,
    });
  } catch (e) {
    return err(`创建投票失败: ${e instanceof Error ? e.message : String(e)}`);
  }
}
