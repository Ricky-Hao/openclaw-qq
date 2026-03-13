/**
 * QQ Resolve Member Tool — look up group members by nickname.
 *
 * Provides: qq_resolve_member(group_id, name)
 * Returns: { found, qq, card, nickname, match_type } or { found, candidates, message }
 *
 * Uses get_group_member_list API with a 5-minute module-level cache.
 */

import { Type, type Static } from "@sinclair/typebox";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { AnyAgentTool } from "openclaw/plugin-sdk";
import type { OneBotClient } from "./onebot/client.js";
import { getActiveClient, getAnyActiveClient } from "./gateway.js";
import { defaultAccountId } from "./config.js";

// ── Types ────────────────────────────────────────────────────────

/** Minimal group member info from OneBot API. */
export interface GroupMember {
  user_id: number;
  nickname: string;
  card: string;
  [key: string]: unknown;
}

// ── Cache ────────────────────────────────────────────────────────

const memberListCache = new Map<string, { data: GroupMember[]; ts: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/** @internal Exported for testing — clear the module-level cache. */
export function _clearMemberCache(): void {
  memberListCache.clear();
}

async function getMembers(client: OneBotClient, groupId: string): Promise<GroupMember[]> {
  const now = Date.now();
  const cached = memberListCache.get(groupId);
  if (cached && now - cached.ts < CACHE_TTL) {
    return cached.data;
  }

  const result = await client.callApi("get_group_member_list", {
    group_id: Number(groupId),
  }) as GroupMember[];

  const members = Array.isArray(result) ? result : [];
  memberListCache.set(groupId, { data: members, ts: now });
  return members;
}

// ── Matching logic ───────────────────────────────────────────────

interface MatchResult {
  found: true;
  qq: string;
  card: string;
  nickname: string;
  match_type: "card" | "nickname" | "card_ci" | "nickname_ci";
}

interface NoMatchResult {
  found: false;
  candidates: Array<{ qq: string; card: string; nickname: string }>;
  message: string;
}

type ResolveResult = MatchResult | NoMatchResult;

/** @internal Exported for testing. */
export function matchMember(members: GroupMember[], name: string): ResolveResult {
  const nameLower = name.toLowerCase();

  // 1. Exact match on card
  for (const m of members) {
    if (m.card && m.card === name) {
      return { found: true, qq: String(m.user_id), card: m.card, nickname: m.nickname, match_type: "card" };
    }
  }

  // 2. Exact match on nickname
  for (const m of members) {
    if (m.nickname === name) {
      return { found: true, qq: String(m.user_id), card: m.card || "", nickname: m.nickname, match_type: "nickname" };
    }
  }

  // 3. Case-insensitive exact match on card
  for (const m of members) {
    if (m.card && m.card.toLowerCase() === nameLower) {
      return { found: true, qq: String(m.user_id), card: m.card, nickname: m.nickname, match_type: "card_ci" };
    }
  }

  // 4. Case-insensitive exact match on nickname
  for (const m of members) {
    if (m.nickname.toLowerCase() === nameLower) {
      return { found: true, qq: String(m.user_id), card: m.card || "", nickname: m.nickname, match_type: "nickname_ci" };
    }
  }

  // 5. Prefix match (name length >= 2)
  const candidates: Array<{ qq: string; card: string; nickname: string }> = [];
  if (name.length >= 2) {
    for (const m of members) {
      const cardLower = (m.card || "").toLowerCase();
      const nickLower = m.nickname.toLowerCase();
      if (cardLower.startsWith(nameLower) || nickLower.startsWith(nameLower)) {
        candidates.push({ qq: String(m.user_id), card: m.card || "", nickname: m.nickname });
      }
    }
    if (candidates.length > 0) {
      return { found: false, candidates: candidates.slice(0, 5), message: "未精确匹配，以下是相似成员" };
    }
  }

  // 6. Contains match
  for (const m of members) {
    const cardLower = (m.card || "").toLowerCase();
    const nickLower = m.nickname.toLowerCase();
    if (cardLower.includes(nameLower) || nickLower.includes(nameLower)) {
      candidates.push({ qq: String(m.user_id), card: m.card || "", nickname: m.nickname });
    }
  }
  if (candidates.length > 0) {
    return { found: false, candidates: candidates.slice(0, 5), message: "未精确匹配，以下是相似成员" };
  }

  // 7. No match
  return { found: false, candidates: [], message: "群内没有匹配的成员" };
}

// ── Schema ───────────────────────────────────────────────────────

const ResolveMemberParams = Type.Object(
  {
    group_id: Type.String({ description: "群号" }),
    name: Type.String({ description: "要查找的昵称（群昵称或QQ昵称）" }),
  },
  { additionalProperties: false },
);

type ResolveMemberInput = Static<typeof ResolveMemberParams>;

// ── Helpers ──────────────────────────────────────────────────────

function ok(data: unknown): AgentToolResult<unknown> {
  return { content: [{ type: "text", text: JSON.stringify(data) }], details: {} };
}

function err(message: string): AgentToolResult<unknown> {
  return { content: [{ type: "text", text: JSON.stringify({ error: message }) }], details: {}, isError: true } as AgentToolResult<unknown>;
}

// ── Tool context ─────────────────────────────────────────────────

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
export function createQQResolveMemberTool(ctx: ToolContext): AnyAgentTool {
  return {
    name: "qq_resolve_member",
    label: "QQ群成员查询",
    description:
      "通过群昵称或QQ昵称查找群成员的QQ号。用于需要 @某人但只知道昵称的场景。",
    parameters: ResolveMemberParams,

    async execute(_execCtx, params): Promise<AgentToolResult<unknown>> {
      const input = params as ResolveMemberInput;
      const groupId = input.group_id;
      const name = input.name.trim();

      if (!name) {
        return err("name 不能为空");
      }

      // Resolve client (same pattern as resolve-image)
      const cfg = ctx.config as any;
      let client: OneBotClient | undefined;

      if (cfg?.channels?.qq) {
        const accountId = ctx.agentAccountId || defaultAccountId(cfg);
        client = getActiveClient(accountId);
      }

      if (!client) {
        client = getAnyActiveClient();
      }

      if (!client) {
        return err("No active QQ connection");
      }

      try {
        const members = await getMembers(client, groupId);
        const result = matchMember(members, name);
        return ok(result);
      } catch (error) {
        return err(`Failed to resolve member: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
}
