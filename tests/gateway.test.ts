import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  parseHistoryMessageSegments,
  downloadImageToTmp,
  downloadImagesWithConcurrency,
  handleInboundMessage,
} from '../src/gateway.js';
import { existsSync, unlinkSync, readFileSync } from 'node:fs';
import type { OneBotMessageEvent } from '../src/onebot/types.js';
import type { QQResolvedAccount } from '../src/config.js';

// ── parseHistoryMessageSegments ─────────────────────────────────────

describe('parseHistoryMessageSegments', () => {
  it('should extract text from text segments', () => {
    const segs = [
      { type: 'text', data: { text: 'Hello ' } },
      { type: 'text', data: { text: 'world!' } },
    ];
    const result = parseHistoryMessageSegments(segs);
    expect(result).toBe('Hello world!');
  });

  it('should include face segments as [表情XX]', () => {
    const segs = [
      { type: 'text', data: { text: 'Hi ' } },
      { type: 'face', data: { id: '76' } },
    ];
    const result = parseHistoryMessageSegments(segs);
    expect(result).toBe('Hi [表情76]');
  });

  it('should count images and append [图片xN] marker', () => {
    const segs = [
      { type: 'text', data: { text: 'Look at this' } },
      { type: 'image', data: { url: 'https://example.com/1.jpg' } },
      { type: 'image', data: { url: 'https://example.com/2.jpg' } },
    ];
    const result = parseHistoryMessageSegments(segs);
    expect(result).toBe('Look at this [图片x2]');
  });

  it('should count image even when data.file is used instead of data.url', () => {
    const segs = [
      { type: 'image', data: { file: 'https://example.com/file.jpg' } },
    ];
    const result = parseHistoryMessageSegments(segs);
    expect(result).toBe('[图片x1]');
  });

  it('should count images regardless of url/file fields', () => {
    const segs = [
      { type: 'image', data: { url: 'https://example.com/url.jpg', file: 'https://example.com/file.jpg' } },
    ];
    const result = parseHistoryMessageSegments(segs);
    expect(result).toBe('[图片x1]');
  });

  it('should count images even without url or file', () => {
    const segs = [
      { type: 'image', data: {} },
    ];
    const result = parseHistoryMessageSegments(segs);
    expect(result).toBe('[图片x1]');
  });

  it('should append [文件: name] for file segments', () => {
    const segs = [
      { type: 'text', data: { text: 'Here is a doc' } },
      { type: 'file', data: { name: 'report.pdf' } },
    ];
    const result = parseHistoryMessageSegments(segs);
    expect(result).toBe('Here is a doc [文件: report.pdf]');
  });

  it('should use data.file for file name when data.name is missing', () => {
    const segs = [
      { type: 'file', data: { file: 'document.docx' } },
    ];
    const result = parseHistoryMessageSegments(segs);
    expect(result).toBe('[文件: document.docx]');
  });

  it('should use "未知文件" when file has no name or file field', () => {
    const segs = [
      { type: 'file', data: {} },
    ];
    const result = parseHistoryMessageSegments(segs);
    expect(result).toBe('[文件: 未知文件]');
  });

  it('should handle mixed segments: text + images + files', () => {
    const segs = [
      { type: 'text', data: { text: 'Check these: ' } },
      { type: 'image', data: { url: 'https://example.com/pic.jpg' } },
      { type: 'file', data: { name: 'notes.txt' } },
      { type: 'face', data: { id: '14' } },
    ];
    const result = parseHistoryMessageSegments(segs);
    expect(result).toBe('Check these: [表情14] [图片x1] [文件: notes.txt]');
  });

  it('should return [非文本消息] for empty segments', () => {
    const result = parseHistoryMessageSegments([]);
    expect(result).toBe('[非文本消息]');
  });

  it('should return [非文本消息] for null/undefined segments', () => {
    expect(parseHistoryMessageSegments(null)).toBe('[非文本消息]');
    expect(parseHistoryMessageSegments(undefined)).toBe('[非文本消息]');
  });

  it('should return [非文本消息] for only unknown segment types', () => {
    const segs = [
      { type: 'share', data: { url: 'https://example.com' } },
    ];
    const result = parseHistoryMessageSegments(segs);
    expect(result).toBe('[非文本消息]');
  });

  it('should handle image-only messages with [图片xN] as text', () => {
    const segs = [
      { type: 'image', data: { url: 'https://example.com/a.jpg' } },
      { type: 'image', data: { url: 'https://example.com/b.jpg' } },
      { type: 'image', data: { url: 'https://example.com/c.jpg' } },
    ];
    const result = parseHistoryMessageSegments(segs);
    expect(result).toBe('[图片x3]');
  });

  it('should handle multiple files', () => {
    const segs = [
      { type: 'file', data: { name: 'a.pdf' } },
      { type: 'file', data: { name: 'b.doc' } },
    ];
    const result = parseHistoryMessageSegments(segs);
    expect(result).toBe('[文件: a.pdf] [文件: b.doc]');
  });
});

// ── downloadImageToTmp ──────────────────────────────────────────────

describe('downloadImageToTmp', () => {
  const createdFiles: string[] = [];

  afterEach(() => {
    for (const f of createdFiles) {
      try { if (existsSync(f)) unlinkSync(f); } catch { /* ignore */ }
    }
    createdFiles.length = 0;
    vi.restoreAllMocks();
  });

  it('should download image and save to /tmp', async () => {
    const fakeImageData = Buffer.from('fake-png-data');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      headers: new Map([['content-type', 'image/png']]) as any,
      arrayBuffer: () => Promise.resolve(fakeImageData.buffer.slice(
        fakeImageData.byteOffset,
        fakeImageData.byteOffset + fakeImageData.byteLength,
      )),
    }));

    const path = await downloadImageToTmp('https://example.com/test.png');
    expect(path).toBeTruthy();
    expect(path).toMatch(/^\/tmp\/qq_img_.*\.png$/);
    createdFiles.push(path!);

    const content = readFileSync(path!);
    expect(content.toString()).toBe('fake-png-data');
  });

  it('should use .jpg extension for jpeg content-type', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      headers: new Map([['content-type', 'image/jpeg']]) as any,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)),
    }));

    const path = await downloadImageToTmp('https://example.com/test.jpg');
    expect(path).toMatch(/\.jpg$/);
    createdFiles.push(path!);
  });

  it('should use .gif extension for gif content-type', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      headers: new Map([['content-type', 'image/gif']]) as any,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)),
    }));

    const path = await downloadImageToTmp('https://example.com/test.gif');
    expect(path).toMatch(/\.gif$/);
    createdFiles.push(path!);
  });

  it('should return null and log warning on HTTP error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
    }));

    const log = { warn: vi.fn() };
    const path = await downloadImageToTmp('https://example.com/missing.jpg', log);
    expect(path).toBeNull();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('HTTP 404'));
  });

  it('should return null and log warning on fetch error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));

    const log = { warn: vi.fn() };
    const path = await downloadImageToTmp('https://example.com/fail.jpg', log);
    expect(path).toBeNull();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('Network error'));
  });

  it('should default to .jpg when no content-type header', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      headers: new Map() as any,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)),
    }));

    const path = await downloadImageToTmp('https://example.com/noext');
    expect(path).toMatch(/\.jpg$/);
    createdFiles.push(path!);
  });
});

// ── downloadImagesWithConcurrency ───────────────────────────────────

describe('downloadImagesWithConcurrency', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should download multiple images concurrently', async () => {
    let callCount = 0;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
      callCount++;
      return Promise.resolve({
        ok: true,
        headers: new Map([['content-type', 'image/jpeg']]) as any,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)),
      });
    }));

    const urls = [
      'https://example.com/1.jpg',
      'https://example.com/2.jpg',
      'https://example.com/3.jpg',
    ];

    const results = await downloadImagesWithConcurrency(urls, 3);

    expect(results).toHaveLength(3);
    expect(callCount).toBe(3);

    for (const r of results) {
      expect(r.url).toBeTruthy();
      expect(r.path).toMatch(/^\/tmp\/qq_img_/);
      // Cleanup
      try { unlinkSync(r.path); } catch { /* ignore */ }
    }
  });

  it('should respect concurrency limit', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;

    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      return new Promise((resolve) => {
        setTimeout(() => {
          concurrent--;
          resolve({
            ok: true,
            headers: new Map([['content-type', 'image/jpeg']]) as any,
            arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)),
          });
        }, 10);
      });
    }));

    const urls = Array.from({ length: 6 }, (_, i) => `https://example.com/${i}.jpg`);
    const results = await downloadImagesWithConcurrency(urls, 2);

    expect(maxConcurrent).toBeLessThanOrEqual(2);
    expect(results).toHaveLength(6);

    // Cleanup
    for (const r of results) {
      try { unlinkSync(r.path); } catch { /* ignore */ }
    }
  });

  it('should skip failed downloads gracefully', async () => {
    let callIndex = 0;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
      callIndex++;
      if (callIndex === 2) {
        return Promise.resolve({ ok: false, status: 500 });
      }
      return Promise.resolve({
        ok: true,
        headers: new Map([['content-type', 'image/jpeg']]) as any,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)),
      });
    }));

    const urls = [
      'https://example.com/1.jpg',
      'https://example.com/fail.jpg',
      'https://example.com/3.jpg',
    ];

    const log = { warn: vi.fn() };
    const results = await downloadImagesWithConcurrency(urls, 3, log);

    expect(results).toHaveLength(2);
    expect(log.warn).toHaveBeenCalled();

    // Cleanup
    for (const r of results) {
      try { unlinkSync(r.path); } catch { /* ignore */ }
    }
  });

  it('should return empty array for empty input', async () => {
    const results = await downloadImagesWithConcurrency([], 3);
    expect(results).toEqual([]);
  });

  it('should handle all downloads failing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network down')));

    const log = { warn: vi.fn() };
    const results = await downloadImagesWithConcurrency(
      ['https://example.com/1.jpg', 'https://example.com/2.jpg'],
      3,
      log,
    );

    expect(results).toEqual([]);
    expect(log.warn).toHaveBeenCalledTimes(2);
  });
});

// ── handleInboundMessage — InboundHistory integration ───────────────

describe('handleInboundMessage — InboundHistory', () => {
  // Shared mocks & helpers

  function makeAccount(overrides: Partial<QQResolvedAccount> = {}): QQResolvedAccount {
    return {
      accountId: 'test-account',
      enabled: true,
      wsUrl: 'ws://localhost:3001',
      token: '',
      botQQ: '100001',
      dmPolicy: 'open',
      allowFrom: ['100000001'],
      groupPolicy: 'open',
      groupAllowFrom: ['888888'],
      thinkingIndicator: false,
      groupContextMessages: 5,
      ...overrides,
    };
  }

  function makeGroupEvent(overrides: Partial<OneBotMessageEvent> = {}): OneBotMessageEvent {
    return {
      post_type: 'message',
      message_type: 'group',
      sub_type: 'normal',
      message_id: 9999,
      user_id: 100000001,
      group_id: 888888,
      message: [
        { type: 'at', data: { qq: '100001' } },
        { type: 'text', data: { text: ' 看看猫' } },
      ],
      raw_message: '@bot 看看猫',
      font: 0,
      sender: { user_id: 100000001, nickname: 'TestUser', card: 'Ricky' },
      time: 1772956830,
      self_id: 100001,
      ...overrides,
    };
  }

  function makeDmEvent(overrides: Partial<OneBotMessageEvent> = {}): OneBotMessageEvent {
    return {
      post_type: 'message',
      message_type: 'private',
      sub_type: 'friend',
      message_id: 8888,
      user_id: 100000001,
      message: [
        { type: 'text', data: { text: '你好' } },
      ],
      raw_message: '你好',
      font: 0,
      sender: { user_id: 100000001, nickname: 'TestUser' },
      time: 1772956830,
      self_id: 100001,
      ...overrides,
    };
  }

  /** Capture what was passed to finalizeInboundContext. */
  let capturedCtx: Record<string, unknown> | null;

  function makeRuntime() {
    capturedCtx = null;
    return {
      channel: {
        routing: {
          resolveAgentRoute: vi.fn().mockReturnValue({
            agentId: 'agent-1',
            sessionKey: 'sess-1',
          }),
        },
        reply: {
          finalizeInboundContext: vi.fn().mockImplementation((ctx: Record<string, unknown>) => {
            capturedCtx = ctx;
            return ctx;
          }),
          dispatchReplyWithBufferedBlockDispatcher: vi.fn().mockResolvedValue(undefined),
        },
        session: {
          resolveStorePath: vi.fn().mockReturnValue('/tmp/store'),
          recordInboundSession: vi.fn().mockResolvedValue(undefined),
        },
        text: {
          resolveTextChunkLimit: vi.fn().mockReturnValue(4000),
          chunkText: vi.fn().mockImplementation((t: string) => [t]),
        },
      },
    } as any;
  }

  function makeClient(historyMessages?: Array<Record<string, unknown>>) {
    return {
      callApi: vi.fn().mockImplementation((action: string) => {
        if (action === 'get_group_msg_history') {
          return Promise.resolve({ messages: historyMessages || [] });
        }
        return Promise.resolve({});
      }),
      sendMessage: vi.fn().mockResolvedValue(0),
    } as any;
  }

  const cfg = {} as any;
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  afterEach(() => {
    vi.restoreAllMocks();
    capturedCtx = null;
  });

  // ── Test 1: Basic InboundHistory ────────────────────────────────

  it('should produce InboundHistory array with correct sender/body/timestamp', async () => {
    const historyMessages = [
      {
        message_id: 9001,
        user_id: 111,
        sender: { card: '张三', nickname: 'zhangsan' },
        message: [{ type: 'text', data: { text: '今天天气真好' } }],
        time: 1772956800,
      },
      {
        message_id: 9002,
        user_id: 222,
        sender: { card: '', nickname: '李四' },
        message: [{ type: 'text', data: { text: '是啊' } }],
        time: 1772956810,
      },
    ];

    const account = makeAccount();
    const runtime = makeRuntime();
    const client = makeClient(historyMessages);

    await handleInboundMessage(makeGroupEvent(), account, cfg, runtime, client, log);

    expect(capturedCtx).not.toBeNull();
    expect(capturedCtx!.InboundHistory).toEqual([
      { sender: '张三', body: '今天天气真好', timestamp: 1772956800000 },
      { sender: '李四', body: '是啊', timestamp: 1772956810000 },
    ]);
  });

  // ── Test 2: Image placeholders in history, NOT in MediaPaths ────

  it('should include [图片xN] in history body but NOT put history images in MediaPaths', async () => {
    const historyMessages = [
      {
        message_id: 9001,
        user_id: 222,
        sender: { card: '李四', nickname: 'lisi' },
        message: [
          { type: 'text', data: { text: '这是什么？' } },
          { type: 'image', data: { url: 'https://example.com/hist1.jpg' } },
          { type: 'image', data: { url: 'https://example.com/hist2.jpg' } },
        ],
        time: 1772956800,
      },
    ];

    const account = makeAccount();
    const runtime = makeRuntime();
    const client = makeClient(historyMessages);

    await handleInboundMessage(makeGroupEvent(), account, cfg, runtime, client, log);

    expect(capturedCtx).not.toBeNull();
    // History should have image placeholders
    const history = capturedCtx!.InboundHistory as Array<{ sender: string; body: string; timestamp: number }>;
    expect(history).toHaveLength(1);
    expect(history[0].body).toBe('这是什么？ [图片x2]');

    // MediaPaths/MediaUrls should NOT contain history images
    // (current message "看看猫" has no images)
    expect(capturedCtx!.MediaPaths).toBeUndefined();
    expect(capturedCtx!.MediaUrls).toBeUndefined();
  });

  // ── Test 3: Current message media still in MediaPaths ───────────

  it('should include current message images in MediaPaths (not history images)', async () => {
    const historyMessages = [
      {
        message_id: 9001,
        user_id: 222,
        sender: { card: '李四', nickname: 'lisi' },
        message: [
          { type: 'image', data: { url: 'https://example.com/hist1.jpg' } },
        ],
        time: 1772956800,
      },
    ];

    // Current message has images
    const event = makeGroupEvent({
      message: [
        { type: 'at', data: { qq: '100001' } },
        { type: 'text', data: { text: ' 存一下' } },
        { type: 'image', data: { url: 'https://example.com/current1.jpg' } },
        { type: 'image', data: { url: 'https://example.com/current2.jpg' } },
      ],
    });

    // Mock fetch for image downloads
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      headers: new Map([['content-type', 'image/jpeg']]) as any,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)),
    }));

    const account = makeAccount();
    const runtime = makeRuntime();
    const client = makeClient(historyMessages);

    await handleInboundMessage(event, account, cfg, runtime, client, log);

    expect(capturedCtx).not.toBeNull();
    // MediaUrls should only have current message images
    expect(capturedCtx!.MediaUrls).toEqual([
      'https://example.com/current1.jpg',
      'https://example.com/current2.jpg',
    ]);
    // MediaPaths should exist (downloaded)
    expect(capturedCtx!.MediaPaths).toBeDefined();
    expect((capturedCtx!.MediaPaths as string[]).length).toBe(2);

    // History should still mention the image as placeholder
    const history = capturedCtx!.InboundHistory as Array<{ sender: string; body: string; timestamp: number }>;
    expect(history[0].body).toBe('[图片x1]');

    // Cleanup temp files
    for (const p of capturedCtx!.MediaPaths as string[]) {
      try { unlinkSync(p); } catch { /* ignore */ }
    }
  });

  // ── Test 4: Mixed scenario — history + current images ───────────

  it('should separate history images (placeholders only) from current images (MediaPaths)', async () => {
    const historyMessages = [
      {
        message_id: 9001,
        user_id: 333,
        sender: { card: '王五', nickname: 'wangwu' },
        message: [
          { type: 'image', data: { url: 'https://example.com/h1.jpg' } },
          { type: 'image', data: { url: 'https://example.com/h2.jpg' } },
          { type: 'image', data: { url: 'https://example.com/h3.jpg' } },
        ],
        time: 1772956800,
      },
    ];

    const event = makeGroupEvent({
      message: [
        { type: 'at', data: { qq: '100001' } },
        { type: 'text', data: { text: ' 看看' } },
        { type: 'image', data: { url: 'https://example.com/mine.jpg' } },
      ],
    });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      headers: new Map([['content-type', 'image/jpeg']]) as any,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)),
    }));

    const account = makeAccount();
    const runtime = makeRuntime();
    const client = makeClient(historyMessages);

    await handleInboundMessage(event, account, cfg, runtime, client, log);

    expect(capturedCtx).not.toBeNull();

    // Only current message's 1 image in MediaUrls
    expect(capturedCtx!.MediaUrls).toEqual(['https://example.com/mine.jpg']);
    expect((capturedCtx!.MediaPaths as string[]).length).toBe(1);

    // History shows 3 images as placeholder
    const history = capturedCtx!.InboundHistory as Array<{ sender: string; body: string; timestamp: number }>;
    expect(history[0].body).toBe('[图片x3]');

    // Cleanup
    for (const p of capturedCtx!.MediaPaths as string[]) {
      try { unlinkSync(p); } catch { /* ignore */ }
    }
  });

  // ── Test 5: Empty @bot with InboundHistory ──────────────────────

  it('should handle empty @bot with InboundHistory present', async () => {
    const historyMessages = [
      {
        message_id: 9001,
        user_id: 111,
        sender: { card: '张三', nickname: 'zhangsan' },
        message: [{ type: 'text', data: { text: '有人在吗' } }],
        time: 1772956800,
      },
    ];

    // Empty @bot — no text, no images, just an @mention
    const event = makeGroupEvent({
      message: [
        { type: 'at', data: { qq: '100001' } },
      ],
    });

    const account = makeAccount();
    const runtime = makeRuntime();
    const client = makeClient(historyMessages);

    await handleInboundMessage(event, account, cfg, runtime, client, log);

    expect(capturedCtx).not.toBeNull();
    expect(capturedCtx!.Body).toBe('[用户@了你但没有附带任何文字]');
    expect(capturedCtx!.BodyForAgent).toBe('[用户@了你但没有附带任何文字]');
    expect(capturedCtx!.InboundHistory).toEqual([
      { sender: '张三', body: '有人在吗', timestamp: 1772956800000 },
    ]);
  });

  // ── Test 6: DM — no InboundHistory ──────────────────────────────

  it('should NOT set InboundHistory for direct messages', async () => {
    const account = makeAccount({ dmPolicy: 'open' });
    const runtime = makeRuntime();
    const client = makeClient();

    await handleInboundMessage(makeDmEvent(), account, cfg, runtime, client, log);

    expect(capturedCtx).not.toBeNull();
    expect(capturedCtx!.InboundHistory).toBeUndefined();
    expect(capturedCtx!.Body).toBe('你好');
    expect(capturedCtx!.ChatType).toBe('direct');
  });

  // ── Test 7: groupContextMessages=0 — no InboundHistory ─────────

  it('should NOT set InboundHistory when groupContextMessages is 0', async () => {
    const account = makeAccount({ groupContextMessages: 0 });
    const runtime = makeRuntime();
    const client = makeClient();

    await handleInboundMessage(makeGroupEvent(), account, cfg, runtime, client, log);

    expect(capturedCtx).not.toBeNull();
    expect(capturedCtx!.InboundHistory).toBeUndefined();
    // Should not even call get_group_msg_history
    expect(client.callApi).not.toHaveBeenCalledWith(
      'get_group_msg_history',
      expect.anything(),
    );
  });

  // ── Test 8: BodyForAgent is just rawText (no history prepended) ─

  it('should set BodyForAgent to rawText without prepending history', async () => {
    const historyMessages = [
      {
        message_id: 9001,
        user_id: 111,
        sender: { card: '张三', nickname: 'zhangsan' },
        message: [{ type: 'text', data: { text: '你好' } }],
        time: 1772956800,
      },
    ];

    const account = makeAccount();
    const runtime = makeRuntime();
    const client = makeClient(historyMessages);

    await handleInboundMessage(makeGroupEvent(), account, cfg, runtime, client, log);

    expect(capturedCtx).not.toBeNull();
    expect(capturedCtx!.BodyForAgent).toBe('看看猫');
    expect(capturedCtx!.Body).toBe('看看猫');
    // Confirm no history delimiters in BodyForAgent
    expect(capturedCtx!.BodyForAgent).not.toContain('[以下是群聊中');
    expect(capturedCtx!.BodyForAgent).not.toContain('[以上是历史消息');
  });

  // ── Test 9: History filters out current message_id ──────────────

  it('should filter out current message from history', async () => {
    const historyMessages = [
      {
        message_id: 9001,
        user_id: 111,
        sender: { card: '张三', nickname: 'zhangsan' },
        message: [{ type: 'text', data: { text: '之前的消息' } }],
        time: 1772956800,
      },
      {
        message_id: 9999, // same as the triggering event
        user_id: 100000001,
        sender: { card: 'Ricky', nickname: 'TestUser' },
        message: [
          { type: 'at', data: { qq: '100001' } },
          { type: 'text', data: { text: ' 看看猫' } },
        ],
        time: 1772956830,
      },
    ];

    const account = makeAccount();
    const runtime = makeRuntime();
    const client = makeClient(historyMessages);

    await handleInboundMessage(makeGroupEvent(), account, cfg, runtime, client, log);

    expect(capturedCtx).not.toBeNull();
    const history = capturedCtx!.InboundHistory as Array<{ sender: string; body: string; timestamp: number }>;
    expect(history).toHaveLength(1);
    expect(history[0].sender).toBe('张三');
  });

  // ── Test 10: Sender fallback — nickname then user_id ────────────

  it('should fallback to nickname when card is empty, then to user_id', async () => {
    const historyMessages = [
      {
        message_id: 9001,
        user_id: 111,
        sender: { card: '', nickname: 'NickOnly' },
        message: [{ type: 'text', data: { text: 'msg1' } }],
        time: 1772956800,
      },
      {
        message_id: 9002,
        user_id: 222,
        sender: { card: '', nickname: '' },
        message: [{ type: 'text', data: { text: 'msg2' } }],
        time: 1772956810,
      },
    ];

    const account = makeAccount();
    const runtime = makeRuntime();
    const client = makeClient(historyMessages);

    await handleInboundMessage(makeGroupEvent(), account, cfg, runtime, client, log);

    const history = capturedCtx!.InboundHistory as Array<{ sender: string; body: string; timestamp: number }>;
    expect(history[0].sender).toBe('NickOnly');
    expect(history[1].sender).toBe('222');
  });

  // ── Test 10b: Missing sender object — fallback to user_id ──────

  it('should fallback to user_id when sender is undefined or null', async () => {
    const historyMessages = [
      {
        message_id: 9001,
        user_id: 333,
        sender: undefined,
        message: [{ type: 'text', data: { text: 'no sender obj' } }],
        time: 1772956800,
      },
      {
        message_id: 9002,
        user_id: 444,
        sender: null,
        message: [{ type: 'text', data: { text: 'null sender' } }],
        time: 1772956810,
      },
    ];

    const account = makeAccount();
    const runtime = makeRuntime();
    const client = makeClient(historyMessages);

    await handleInboundMessage(makeGroupEvent(), account, cfg, runtime, client, log);

    const history = capturedCtx!.InboundHistory as Array<{ sender: string; body: string; timestamp: number }>;
    expect(history).toHaveLength(2);
    expect(history[0].sender).toBe('333');
    expect(history[1].sender).toBe('444');
  });

  // ── Test 11: History fetch failure — graceful degradation ───────

  it('should set InboundHistory to undefined if history fetch fails', async () => {
    const account = makeAccount();
    const runtime = makeRuntime();
    const client = {
      callApi: vi.fn().mockImplementation((action: string) => {
        if (action === 'get_group_msg_history') {
          return Promise.reject(new Error('API unavailable'));
        }
        return Promise.resolve({});
      }),
      sendMessage: vi.fn().mockResolvedValue(0),
    } as any;

    await handleInboundMessage(makeGroupEvent(), account, cfg, runtime, client, log);

    expect(capturedCtx).not.toBeNull();
    expect(capturedCtx!.InboundHistory).toBeUndefined();
    expect(capturedCtx!.BodyForAgent).toBe('看看猫');
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to fetch group history'));
  });

  // ── Test 12: Timestamps use message time field (seconds → ms) ───

  it('should convert OneBot time (seconds) to milliseconds in InboundHistory timestamps', async () => {
    const historyMessages = [
      {
        message_id: 9001,
        user_id: 111,
        sender: { card: 'Test', nickname: 'Test' },
        message: [{ type: 'text', data: { text: 'hi' } }],
        time: 1700000000, // seconds
      },
    ];

    const account = makeAccount();
    const runtime = makeRuntime();
    const client = makeClient(historyMessages);

    await handleInboundMessage(makeGroupEvent(), account, cfg, runtime, client, log);

    const history = capturedCtx!.InboundHistory as Array<{ sender: string; body: string; timestamp: number }>;
    expect(history[0].timestamp).toBe(1700000000000); // milliseconds
  });

  // ── Test 12b: Missing time falls back to event.time ─────────────

  it('should fallback to event.time when history message has no time field', async () => {
    const historyMessages = [
      {
        message_id: 9001,
        user_id: 111,
        sender: { card: 'Test', nickname: 'Test' },
        message: [{ type: 'text', data: { text: 'no timestamp' } }],
        // no time field
      },
    ];

    const event = makeGroupEvent({ time: 1772956830 });
    const account = makeAccount();
    const runtime = makeRuntime();
    const client = makeClient(historyMessages);

    await handleInboundMessage(event, account, cfg, runtime, client, log);

    const history = capturedCtx!.InboundHistory as Array<{ sender: string; body: string; timestamp: number }>;
    expect(history[0].timestamp).toBe(1772956830 * 1000); // event.time * 1000
  });
});
