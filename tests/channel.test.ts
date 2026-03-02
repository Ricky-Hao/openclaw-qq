/**
 * Tests for channel.ts action interception:
 * - poll action → isError (use poll_create instead)
 * - send action with pollQuestion → isError (use poll_create instead)
 * - capabilities.polls = false
 */

import { describe, it, expect, vi } from 'vitest';
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

vi.mock('../src/config.js', () => ({
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
  })),
  defaultAccountId: vi.fn(() => 'default'),
  isEnabled: vi.fn(() => true),
  isConfigured: vi.fn(() => true),
}));

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
      cfg: { channels: { qq: { default: { botQQ: '10001' } } } },
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
      cfg: { channels: { qq: { default: { botQQ: '10001' } } } },
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
      cfg: { channels: { qq: { default: { botQQ: '10001' } } } },
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
      cfg: { channels: { qq: { default: { botQQ: '10001' } } } },
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
