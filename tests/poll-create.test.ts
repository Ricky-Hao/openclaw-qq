/**
 * Tests for poll creation logic — specifically the globalThis Symbol integration
 * for auto-scheduling settlement via agent-cron, and the fallback behavior.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createPollCreateTool } from '../src/poll.js';

// ── Mock dependencies ────────────────────────────────────────────────

// Mock getActiveClient to return a fake OneBotClient
const mockSendMessage = vi.fn().mockResolvedValue(12345);
const mockCallApi = vi.fn().mockResolvedValue({});

vi.mock('../src/gateway.js', () => ({
  getActiveClient: vi.fn(() => ({
    connected: true,
    sendMessage: mockSendMessage,
    callApi: mockCallApi,
  })),
}));

vi.mock('../src/config.js', () => ({
  defaultAccountId: vi.fn(() => 'test-account'),
  resolveAccount: vi.fn(() => ({
    accountId: 'test-account',
    botQQ: '10001',
    wsUrl: 'ws://localhost:3001',
    token: '',
    enabled: true,
    dmPolicy: 'allowlist',
    allowFrom: [],
    groupPolicy: 'allowlist',
    groupAllowFrom: [],
    thinkingIndicator: false,
    groupContextMessages: 20,
  })),
}));

// ── Symbol key ───────────────────────────────────────────────────────
const ADD_JOB_SYMBOL = Symbol.for('openclaw.agentCron.addJob');

describe('poll_create: auto-settlement via globalThis addJob', () => {
  let originalSymbolValue: unknown;

  beforeEach(() => {
    originalSymbolValue = (globalThis as Record<symbol, unknown>)[ADD_JOB_SYMBOL];
    mockSendMessage.mockResolvedValue(12345);
    mockCallApi.mockResolvedValue({});
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Restore globalThis
    if (originalSymbolValue !== undefined) {
      (globalThis as Record<symbol, unknown>)[ADD_JOB_SYMBOL] = originalSymbolValue;
    } else {
      delete (globalThis as Record<symbol, unknown>)[ADD_JOB_SYMBOL];
    }
  });

  it('returns settlementScheduled=true and cronJobId when addJob succeeds', async () => {
    // Set up a mock addJob on globalThis
    const mockAddJob = vi.fn().mockResolvedValue({ ok: true, jobId: 'cron-job-abc' });
    (globalThis as Record<symbol, unknown>)[ADD_JOB_SYMBOL] = mockAddJob;

    const ctx = {
      config: { channels: { qq: { 'test-account': { botQQ: '10001' } } } },
      workspaceDir: '/tmp/test-polls',
      agentId: 'agent-qq',
      agentAccountId: 'test-account',
    };

    const tool = createPollCreateTool(ctx as any);
    const result = await tool.execute('tc1', {
      question: '今晚吃什么？',
      options: ['火锅', '烧烤'],
      target: 'qq:group:12345',
      duration: '10m',
    });

    // Parse result
    const data = JSON.parse((result.content[0] as { text: string }).text);

    expect(data.success).toBe(true);
    expect(data.settlementScheduled).toBe(true);
    expect(data.cronJobId).toBe('cron-job-abc');
    // Should NOT have settleAction when scheduled successfully
    expect(data.settleAction).toBeUndefined();

    // Verify addJob was called with correct params
    expect(mockAddJob).toHaveBeenCalledTimes(1);
    const addJobArgs = mockAddJob.mock.calls[0][0];
    expect(addJobArgs.ownerAgentId).toBe('agent-qq');
    expect(addJobArgs.schedule.kind).toBe('at');
    expect(addJobArgs.delivery.channel).toBe('qq');
    expect(addJobArgs.delivery.to).toBe('qq:group:12345');
  });

  it('returns settleAction hint when globalThis addJob symbol is not set', async () => {
    // Ensure the symbol is NOT on globalThis
    delete (globalThis as Record<symbol, unknown>)[ADD_JOB_SYMBOL];

    const ctx = {
      config: { channels: { qq: { 'test-account': { botQQ: '10001' } } } },
      workspaceDir: '/tmp/test-polls',
      agentId: 'agent-qq',
      agentAccountId: 'test-account',
    };

    const tool = createPollCreateTool(ctx as any);
    const result = await tool.execute('tc2', {
      question: '明天去哪？',
      options: ['公园', '商场'],
      target: 'qq:group:12345',
      duration: '30m',
    });

    const data = JSON.parse((result.content[0] as { text: string }).text);

    expect(data.success).toBe(true);
    expect(data.settlementScheduled).toBeUndefined();
    expect(data.cronJobId).toBeUndefined();
    // Should have settleAction as fallback
    expect(data.settleAction).toBeDefined();
    expect(data.settleAction.instruction).toBeDefined();
    expect(data.settleAction.agent_cron_add_params).toBeDefined();
    expect(data.settleAction.agent_cron_add_params.schedule.kind).toBe('at');
  });

  it('returns settleAction hint when addJob returns ok=false', async () => {
    const mockAddJob = vi.fn().mockResolvedValue({ ok: false, error: 'plugin not initialized' });
    (globalThis as Record<symbol, unknown>)[ADD_JOB_SYMBOL] = mockAddJob;

    const ctx = {
      config: { channels: { qq: { 'test-account': { botQQ: '10001' } } } },
      workspaceDir: '/tmp/test-polls',
      agentId: 'agent-qq',
      agentAccountId: 'test-account',
    };

    const tool = createPollCreateTool(ctx as any);
    const result = await tool.execute('tc3', {
      question: '哪个好？',
      options: ['A', 'B'],
      target: 'qq:group:12345',
      duration: '1h',
    });

    const data = JSON.parse((result.content[0] as { text: string }).text);

    expect(data.success).toBe(true);
    // addJob returned ok=false, so settlement not scheduled
    expect(data.settlementScheduled).toBeUndefined();
    // Fallback to settleAction
    expect(data.settleAction).toBeDefined();
  });

  it('returns settleAction hint when addJob throws an error', async () => {
    const mockAddJob = vi.fn().mockRejectedValue(new Error('network error'));
    (globalThis as Record<symbol, unknown>)[ADD_JOB_SYMBOL] = mockAddJob;

    const ctx = {
      config: { channels: { qq: { 'test-account': { botQQ: '10001' } } } },
      workspaceDir: '/tmp/test-polls',
      agentId: 'agent-qq',
      agentAccountId: 'test-account',
    };

    const tool = createPollCreateTool(ctx as any);
    const result = await tool.execute('tc4', {
      question: '选哪个？',
      options: ['X', 'Y'],
      target: 'qq:group:12345',
      duration: '2h',
    });

    const data = JSON.parse((result.content[0] as { text: string }).text);

    expect(data.success).toBe(true);
    expect(data.settlementScheduled).toBeUndefined();
    expect(data.settleAction).toBeDefined();
  });

  it('does not attempt settlement when no duration is specified', async () => {
    const mockAddJob = vi.fn().mockResolvedValue({ ok: true, jobId: 'should-not-be-called' });
    (globalThis as Record<symbol, unknown>)[ADD_JOB_SYMBOL] = mockAddJob;

    const ctx = {
      config: { channels: { qq: { 'test-account': { botQQ: '10001' } } } },
      workspaceDir: '/tmp/test-polls',
      agentId: 'agent-qq',
      agentAccountId: 'test-account',
    };

    const tool = createPollCreateTool(ctx as any);
    const result = await tool.execute('tc5', {
      question: '永久投票',
      options: ['选项1', '选项2'],
      target: 'qq:group:12345',
      // No duration
    });

    const data = JSON.parse((result.content[0] as { text: string }).text);

    expect(data.success).toBe(true);
    expect(data.expiresAt).toBeUndefined();
    expect(data.settlementScheduled).toBeUndefined();
    expect(data.settleAction).toBeUndefined();
    expect(data.cronJobId).toBeUndefined();
    // addJob should NOT have been called since no duration
    expect(mockAddJob).not.toHaveBeenCalled();
  });

  it('passes agentId from ctx to addJob ownerAgentId', async () => {
    const mockAddJob = vi.fn().mockResolvedValue({ ok: true, jobId: 'cron-123' });
    (globalThis as Record<symbol, unknown>)[ADD_JOB_SYMBOL] = mockAddJob;

    const ctx = {
      config: { channels: { qq: { 'test-account': { botQQ: '10001' } } } },
      workspaceDir: '/tmp/test-polls',
      agentId: 'custom-agent-id',
      agentAccountId: 'test-account',
    };

    const tool = createPollCreateTool(ctx as any);
    await tool.execute('tc6', {
      question: 'test',
      options: ['A', 'B'],
      target: 'qq:group:999',
      duration: '10m',
    });

    expect(mockAddJob).toHaveBeenCalledTimes(1);
    expect(mockAddJob.mock.calls[0][0].ownerAgentId).toBe('custom-agent-id');
  });
});
