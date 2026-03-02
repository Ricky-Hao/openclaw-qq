// Config adapter — resolves QQ channel accounts from OpenClaw config

import type { OpenClawConfig } from "openclaw/plugin-sdk";

// ── Resolved Account ────────────────────────────────────────────────

export type QQResolvedAccount = {
  accountId: string;
  enabled: boolean;
  wsUrl: string;
  token: string;
  botQQ: string;
  dmPolicy: "open" | "allowlist";
  allowFrom: string[];
  groupPolicy: "open" | "allowlist";
  groupAllowFrom: string[];
  /** Send a "🤔 思考中..." placeholder before agent processes. Default: false */
  thinkingIndicator: boolean;
  /** Number of recent group messages to fetch as context when @mentioned. Default: 20, 0 to disable. */
  groupContextMessages: number;
};

// ── Raw config shape (channels.qq.<accountId>) ──────────────────────

type QQAccountRaw = {
  enabled?: boolean;
  wsUrl?: string;
  token?: string;
  botQQ?: string;
  dmPolicy?: string;
  allowFrom?: (string | number)[];
  groupPolicy?: string;
  groupAllowFrom?: (string | number)[];
  thinkingIndicator?: boolean;
  groupContextMessages?: number;
};

// ── Helpers ─────────────────────────────────────────────────────────

function getQQSection(cfg: OpenClawConfig): Record<string, QQAccountRaw> {
  const channels = (cfg as Record<string, unknown>).channels as
    | Record<string, unknown>
    | undefined;
  if (!channels) return {};
  const qq = channels.qq as Record<string, QQAccountRaw> | undefined;
  return qq ?? {};
}

function toStringArray(arr: unknown): string[] {
  if (!Array.isArray(arr)) return [];
  return arr.map((v) => String(v));
}

// ── Config Adapter Functions ────────────────────────────────────────

export function listAccountIds(cfg: OpenClawConfig): string[] {
  return Object.keys(getQQSection(cfg));
}

export function resolveAccount(
  cfg: OpenClawConfig,
  accountId?: string | null,
): QQResolvedAccount {
  const section = getQQSection(cfg);
  const id = accountId || Object.keys(section)[0] || "default";
  const raw = section[id] ?? {};

  return {
    accountId: id,
    enabled: raw.enabled !== false,
    wsUrl: raw.wsUrl || "ws://localhost:3001",
    token: raw.token || "",
    botQQ: raw.botQQ || "",
    dmPolicy: raw.dmPolicy === "open" ? "open" : "allowlist",
    allowFrom: toStringArray(raw.allowFrom),
    groupPolicy: raw.groupPolicy === "open" ? "open" : "allowlist",
    groupAllowFrom: toStringArray(raw.groupAllowFrom),
    thinkingIndicator: raw.thinkingIndicator === true,
    groupContextMessages: typeof raw.groupContextMessages === "number"
      ? Math.max(0, Math.trunc(raw.groupContextMessages))
      : 20, // default: 20
  };
}

export function defaultAccountId(cfg: OpenClawConfig): string {
  const ids = listAccountIds(cfg);
  return ids[0] || "default";
}

export function isEnabled(account: QQResolvedAccount): boolean {
  return account.enabled;
}

export function isConfigured(account: QQResolvedAccount): boolean {
  return Boolean(account.wsUrl && account.botQQ);
}
