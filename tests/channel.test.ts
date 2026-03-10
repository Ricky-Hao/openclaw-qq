/**
 * Tests for channel.ts adapters:
 * - poll action → isError (use poll_create instead)
 * - send action with pollQuestion → isError (use poll_create instead)
 * - capabilities.polls = false
 * - configSchema, setup, resolver, streaming, agentPrompt
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getActiveClient } from '../src/gateway.js';
import { qqChannelPlugin } from '../src/channel.js';

// Mock dependencies needed by channel.ts
vi.mock('../src/gateway.js', () => ({
  getActiveClient: vi.fn(() => ({
    connected: true,
    sendMessage: vi.fn().mockResolvedValue(99999),
    callApi: vi.fn().mockResolvedValue({}),
  })),
  startAccount: vi.fn(),
  stopAccount: vi.fn(),
}));

vi.mock('../src/config.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    listAccountIds: vi.fn(() => ['default']),
    resolveAccount: vi.fn(() => ({
      accountId: 'default',
      enabled: true,
      wsUrl: 'ws://localhost:3001',
      token: '',
      botQQ: '10001',
      dmPolicy: 'allowlist',
      allowFrom: [],
      groupPolicy: 'allowlist',
      groupAllowFrom: [],
      thinkingIndicator: false,
      groupContextMessages: 20,
      requireMention: true,
    })),
    defaultAccountId: vi.fn(() => 'default'),
    isEnabled: vi.fn(() => true),
    isConfigured: vi.fn(() => true),
  };
});

vi.mock('../src/poll.js', () => ({
  handlePollAction: vi.fn(),
}));

describe('channel.ts capabilities', () => {
  it('has polls disabled', () => {
    expect(qqChannelPlugin.capabilities.polls).toBe(false);
  });
});

describe('channel.ts action interception', () => {
  const handleAction = qqChannelPlugin.actions!.handleAction;

  it('intercepts poll action and returns isError', async () => {
    const ctx = {
      action: 'poll',
      params: {
        pollQuestion: '今晚吃什么？',
        pollOption: ['火锅', '烧烤'],
        target: 'qq:group:12345',
      },
      cfg: { channels: { qq: { accounts: { default: { botQQ: '10001' } } } } },
      accountId: 'default',
    } as any;

    const result = await handleAction(ctx);

    expect(result).toBeDefined();
    expect((result as any).isError).toBe(true);
    const text = (result as any).content[0].text;
    expect(text).toContain('poll_create');
  });

  it('intercepts send action with pollQuestion and returns isError', async () => {
    const ctx = {
      action: 'send',
      params: {
        pollQuestion: '明天去哪？',
        pollOption: ['公园', '商场'],
        to: 'qq:group:12345',
      },
      cfg: { channels: { qq: { accounts: { default: { botQQ: '10001' } } } } },
      accountId: 'default',
    } as any;

    const result = await handleAction(ctx);

    expect(result).toBeDefined();
    expect((result as any).isError).toBe(true);
    const text = (result as any).content[0].text;
    expect(text).toContain('poll_create');
  });

  it('intercepts send action with pollOption (without pollQuestion) and returns isError', async () => {
    const ctx = {
      action: 'send',
      params: {
        pollOption: ['A', 'B', 'C'],
        to: 'qq:group:12345',
      },
      cfg: { channels: { qq: { accounts: { default: { botQQ: '10001' } } } } },
      accountId: 'default',
    } as any;

    const result = await handleAction(ctx);

    expect(result).toBeDefined();
    expect((result as any).isError).toBe(true);
    const text = (result as any).content[0].text;
    expect(text).toContain('poll_create');
  });

  it('allows normal send action without poll params', async () => {
    const ctx = {
      action: 'send',
      params: {
        message: 'Hello World',
        to: 'qq:group:12345',
      },
      cfg: { channels: { qq: { accounts: { default: { botQQ: '10001' } } } } },
      accountId: 'default',
    } as any;

    const result = await handleAction(ctx);

    expect(result).toBeDefined();
    // Normal send should not be an error
    expect((result as any).isError).toBeUndefined();
    const text = (result as any).content[0].text;
    const data = JSON.parse(text);
    expect(data.channel).toBe('qq');
  });
});

// ── configSchema ────────────────────────────────────────────────────

describe('channel.ts configSchema', () => {
  it('exists and has a schema field', () => {
    expect(qqChannelPlugin.configSchema).toBeDefined();
    expect(qqChannelPlugin.configSchema!.schema).toBeDefined();
  });

  it('schema is a JSON Schema object', () => {
    const schema = qqChannelPlugin.configSchema!.schema as Record<string, unknown>;
    expect(schema.type).toBe('object');
  });
});

// ── setup ───────────────────────────────────────────────────────────

describe('channel.ts setup', () => {
  it('applyAccountConfig sets wsUrl from input.url', () => {
    const cfg = {} as any;
    const result = qqChannelPlugin.setup!.applyAccountConfig({
      cfg,
      accountId: 'default',
      input: { url: 'ws://myhost:3001', token: 'mytoken' } as any,
    });

    const qq = (result as any).channels.qq;
    expect(qq.accounts.default.wsUrl).toBe('ws://myhost:3001');
    expect(qq.accounts.default.token).toBe('mytoken');
  });

  it('applyAccountConfig merges with existing account config', () => {
    const cfg = {
      channels: {
        qq: {
          accounts: {
            default: { botQQ: '12345', wsUrl: 'ws://old:3001' },
          },
        },
      },
    } as any;
    const result = qqChannelPlugin.setup!.applyAccountConfig({
      cfg,
      accountId: 'default',
      input: { url: 'ws://new:3001' } as any,
    });

    const acct = (result as any).channels.qq.accounts.default;
    expect(acct.wsUrl).toBe('ws://new:3001');
    expect(acct.botQQ).toBe('12345'); // preserved
  });
});

// ── resolver ────────────────────────────────────────────────────────

describe('channel.ts resolver', () => {
  const resolveTargets = qqChannelPlugin.resolver!.resolveTargets;

  beforeEach(() => {
    vi.mocked(getActiveClient).mockReturnValue({
      connected: true,
      sendMessage: vi.fn().mockResolvedValue(99999),
      callApi: vi.fn().mockImplementation((api: string) => {
        if (api === 'get_group_list') {
          return Promise.resolve([
            { group_id: 111222, group_name: '测试群' },
            { group_id: 333444, group_name: 'Dev Team' },
          ]);
        }
        if (api === 'get_friend_list') {
          return Promise.resolve([
            { user_id: 10001, nickname: 'Alice', remark: '爱丽丝' },
            { user_id: 20002, nickname: 'Bob' },
          ]);
        }
        return Promise.resolve({});
      }),
    } as any);
  });

  it('resolves group by ID', async () => {
    const results = await resolveTargets({
      cfg: {} as any,
      inputs: ['111222'],
      kind: 'group',
      runtime: {} as any,
    });

    expect(results).toHaveLength(1);
    expect(results[0].resolved).toBe(true);
    expect(results[0].id).toBe('111222');
    expect(results[0].name).toBe('测试群');
  });

  it('resolves group by name (case-insensitive)', async () => {
    const results = await resolveTargets({
      cfg: {} as any,
      inputs: ['dev team'],
      kind: 'group',
      runtime: {} as any,
    });

    expect(results).toHaveLength(1);
    expect(results[0].resolved).toBe(true);
    expect(results[0].id).toBe('333444');
    expect(results[0].name).toBe('Dev Team');
  });

  it('resolves user by ID', async () => {
    const results = await resolveTargets({
      cfg: {} as any,
      inputs: ['10001'],
      kind: 'user',
      runtime: {} as any,
    });

    expect(results).toHaveLength(1);
    expect(results[0].resolved).toBe(true);
    expect(results[0].id).toBe('10001');
    expect(results[0].name).toBe('爱丽丝'); // remark preferred
  });

  it('returns resolved: false for no match', async () => {
    const results = await resolveTargets({
      cfg: {} as any,
      inputs: ['nonexistent'],
      kind: 'user',
      runtime: {} as any,
    });

    expect(results).toHaveLength(1);
    expect(results[0].resolved).toBe(false);
  });

  it('returns note when no active client', async () => {
    vi.mocked(getActiveClient).mockReturnValue(null as any);

    const results = await resolveTargets({
      cfg: {} as any,
      inputs: ['test'],
      kind: 'group',
      runtime: {} as any,
    });

    expect(results).toHaveLength(1);
    expect(results[0].resolved).toBe(false);
    expect(results[0].note).toBe('No active client');
  });
});

// ── streaming ───────────────────────────────────────────────────────

describe('channel.ts streaming', () => {
  it('has blockStreamingCoalesceDefaults with correct values', () => {
    expect(qqChannelPlugin.streaming).toBeDefined();
    const defaults = qqChannelPlugin.streaming!.blockStreamingCoalesceDefaults;
    expect(defaults).toBeDefined();
    expect(defaults!.minChars).toBe(100);
    expect(defaults!.idleMs).toBe(2000);
  });
});

// ── agentPrompt ─────────────────────────────────────────────────────

describe('channel.ts agentPrompt', () => {
  it('messageToolHints returns a non-empty array of strings', () => {
    expect(qqChannelPlugin.agentPrompt).toBeDefined();
    const hints = qqChannelPlugin.agentPrompt!.messageToolHints!({} as any);
    expect(Array.isArray(hints)).toBe(true);
    expect(hints.length).toBeGreaterThan(0);
    for (const h of hints) {
      expect(typeof h).toBe('string');
    }
  });
});

// ── security.collectWarnings ────────────────────────────────────────

describe('channel.ts security.collectWarnings', () => {
  const collectWarnings = qqChannelPlugin.security!.collectWarnings!;

  function makeCtx(overrides: Partial<{
    dmPolicy: string;
    allowFrom: string[];
    groupPolicy: string;
    groupAllowFrom: string[];
    accountId: string;
  }> = {}) {
    return {
      cfg: {} as any,
      accountId: overrides.accountId ?? 'default',
      account: {
        accountId: overrides.accountId ?? 'default',
        enabled: true,
        wsUrl: 'ws://localhost:3001',
        token: '',
        botQQ: '10001',
        dmPolicy: overrides.dmPolicy ?? 'allowlist',
        allowFrom: overrides.allowFrom ?? ['111'],
        groupPolicy: overrides.groupPolicy ?? 'allowlist',
        groupAllowFrom: overrides.groupAllowFrom ?? ['888'],
        thinkingIndicator: false,
        groupContextMessages: 20,
        requireMention: true,
      },
    } as any;
  }

  it('returns empty array when everything is safe', () => {
    const warnings = collectWarnings(makeCtx());
    expect(warnings).toEqual([]);
  });

  it('warns when dmPolicy is open', () => {
    const warnings = collectWarnings(makeCtx({ dmPolicy: 'open' }));
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    expect(warnings.some((w: string) => w.includes('DM policy is "open"'))).toBe(true);
  });

  it('warns when groupPolicy is open', () => {
    const warnings = collectWarnings(makeCtx({ groupPolicy: 'open' }));
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    expect(warnings.some((w: string) => w.includes('Group policy is "open"'))).toBe(true);
  });

  it('warns when dmPolicy is allowlist but allowFrom is empty', () => {
    const warnings = collectWarnings(makeCtx({ dmPolicy: 'allowlist', allowFrom: [] }));
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    expect(warnings.some((w: string) => w.includes('allowFrom is empty'))).toBe(true);
  });

  it('warns when groupPolicy is allowlist but groupAllowFrom is empty', () => {
    const warnings = collectWarnings(makeCtx({ groupPolicy: 'allowlist', groupAllowFrom: [] }));
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    expect(warnings.some((w: string) => w.includes('groupAllowFrom is empty'))).toBe(true);
  });

  it('includes account ID in warning messages', () => {
    const warnings = collectWarnings(makeCtx({ accountId: 'mybot', dmPolicy: 'open' }));
    expect(warnings.some((w: string) => w.includes('mybot'))).toBe(true);
  });

  it('returns multiple warnings when both policies are problematic', () => {
    const warnings = collectWarnings(makeCtx({
      dmPolicy: 'open',
      groupPolicy: 'open',
    }));
    expect(warnings.length).toBe(2);
  });

  it('does not warn about empty allowFrom when dmPolicy is open', () => {
    const warnings = collectWarnings(makeCtx({
      dmPolicy: 'open',
      allowFrom: [],
      groupPolicy: 'allowlist',
      groupAllowFrom: ['888'],
    }));
    // Should only have the "open" warning, not the "empty allowFrom" warning
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('DM policy is "open"');
  });

  it('uses correct config path format with accounts', () => {
    const warnings = collectWarnings(makeCtx({ dmPolicy: 'open', accountId: 'test' }));
    expect(warnings[0]).toContain('channels.qq.accounts.test');
  });
});
