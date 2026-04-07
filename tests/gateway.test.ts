import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  parseHistoryMessageSegments,
  resolveReplyContext,
  handleInboundMessage,
  sendWithRetry,
} from '../src/gateway.js';
import { existsSync, unlinkSync, readFileSync } from 'node:fs';
import type { OneBotMessageEvent } from '../src/onebot/types.js';
import type { QQResolvedAccount } from '../src/config.js';

// ── parseHistoryMessageSegments ─────────────────────────────────────

describe('parseHistoryMessageSegments', () => {
  it('should extract text from text segments', async () => {
    const segs = [
      { type: 'text', data: { text: 'Hello ' } },
      { type: 'text', data: { text: 'world!' } },
    ];
    const result = await parseHistoryMessageSegments(segs);
    expect(result).toBe('Hello world!');
  });

  it('should include face segments as [表情XX]', async () => {
    const segs = [
      { type: 'text', data: { text: 'Hi ' } },
      { type: 'face', data: { id: '76' } },
    ];
    const result = await parseHistoryMessageSegments(segs);
    expect(result).toBe('Hi [表情76]');
  });

  it('should count images and append per-image resolve hints', async () => {
    const segs = [
      { type: 'text', data: { text: 'Look at this' } },
      { type: 'image', data: { file: '5E28D43A2FE346F995BC1D0F5D82829F.jpg' } },
      { type: 'image', data: { file: 'A7BCE4AD4BF4784F1D3A25C84D3A06EC.jpg' } },
    ];
    const result = await parseHistoryMessageSegments(segs);
    expect(result).toBe('Look at this [图片 - 使用 qq_resolve_image(file: "5E28D43A2FE346F995BC1D0F5D82829F.jpg") 获取] [图片 - 使用 qq_resolve_image(file: "A7BCE4AD4BF4784F1D3A25C84D3A06EC.jpg") 获取]');
  });

  it('should render resolve hint when data.file is present', async () => {
    const segs = [
      { type: 'image', data: { file: 'ABC123.jpg' } },
    ];
    const result = await parseHistoryMessageSegments(segs);
    expect(result).toBe('[图片 - 使用 qq_resolve_image(file: "ABC123.jpg") 获取]');
  });

  it('should use file field for resolve hint', async () => {
    const segs = [
      { type: 'image', data: { url: 'https://example.com/url.jpg', file: 'HASH123.jpg' } },
    ];
    const result = await parseHistoryMessageSegments(segs);
    expect(result).toBe('[图片 - 使用 qq_resolve_image(file: "HASH123.jpg") 获取]');
  });

  it('should use fallback [图片] when file hash is missing', async () => {
    const segs = [
      { type: 'image', data: {} },
    ];
    const result = await parseHistoryMessageSegments(segs);
    expect(result).toBe('[图片]');
  });

  it('should append [文件: name] with download hint for file segments with file_id', async () => {
    const segs = [
      { type: 'text', data: { text: 'Here is a doc' } },
      { type: 'file', data: { name: 'report.pdf', file_id: '/acde6471-798b-4fb0-b6fb-c8aaf3a515ae' } },
    ];
    const result = await parseHistoryMessageSegments(segs);
    expect(result).toBe('Here is a doc [文件: report.pdf - 使用 qq_download_group_file(file_id: "/acde6471-798b-4fb0-b6fb-c8aaf3a515ae") 下载]');
  });

  it('should append [文件: name] without download hint for file segments without file_id', async () => {
    const segs = [
      { type: 'text', data: { text: 'Here is a doc' } },
      { type: 'file', data: { name: 'report.pdf' } },
    ];
    const result = await parseHistoryMessageSegments(segs);
    expect(result).toBe('Here is a doc [文件: report.pdf]');
  });

  it('should use data.file for file name when data.name is missing', async () => {
    const segs = [
      { type: 'file', data: { file: 'document.docx', file_id: '/some-id' } },
    ];
    const result = await parseHistoryMessageSegments(segs);
    expect(result).toBe('[文件: document.docx - 使用 qq_download_group_file(file_id: "/some-id") 下载]');
  });

  it('should use data.file for file name without file_id', async () => {
    const segs = [
      { type: 'file', data: { file: 'document.docx' } },
    ];
    const result = await parseHistoryMessageSegments(segs);
    expect(result).toBe('[文件: document.docx]');
  });

  it('should use "未知文件" when file has no name or file field', async () => {
    const segs = [
      { type: 'file', data: {} },
    ];
    const result = await parseHistoryMessageSegments(segs);
    expect(result).toBe('[文件: 未知文件]');
  });

  it('should render reply segment without client as fallback', async () => {
    const segs = [
      { type: 'reply', data: { id: '123' } },
    ];
    const result = await parseHistoryMessageSegments(segs);
    expect(result).toBe('[回复消息]');
  });

  it('should resolve reply segment with text message when client is provided', async () => {
    const mockClient = {
      callApi: vi.fn().mockResolvedValue({
        sender: { card: '张三', nickname: 'zhangsan' },
        message: [{ type: 'text', data: { text: '消息内容' } }],
      }),
    };

    const result = await parseHistoryMessageSegments([
      { type: 'reply', data: { id: '123' } },
    ], mockClient);

    expect(result).toBe('[回复 张三: 消息内容]');
    expect(mockClient.callApi).toHaveBeenCalledWith('get_msg', { message_id: 123 });
  });

  it('should resolve reply segment with image message when client is provided', async () => {
    const mockClient = {
      callApi: vi.fn().mockResolvedValue({
        sender: { card: '张三', nickname: 'zhangsan' },
        message: [{ type: 'image', data: { file: 'HASH.jpg' } }],
      }),
    };

    const result = await parseHistoryMessageSegments([
      { type: 'reply', data: { id: '123' } },
    ], mockClient);

    expect(result).toBe('[回复 张三: [图片 - 使用 qq_resolve_image(file: "HASH.jpg") 获取]]');
  });

  it('should fallback when reply get_msg fails', async () => {
    const mockClient = {
      callApi: vi.fn().mockRejectedValue(new Error('boom')),
    };

    const result = await parseHistoryMessageSegments([
      { type: 'reply', data: { id: '123' } },
    ], mockClient);

    expect(result).toBe('[回复消息]');
  });

  it('should recursively resolve nested replies up to maxDepth', async () => {
    const mockClient = {
      callApi: vi.fn().mockResolvedValue({
        sender: { card: '张三', nickname: 'zhangsan' },
        message: [{ type: 'reply', data: { id: '456' } }],
      }),
    };

    const result = await parseHistoryMessageSegments([
      { type: 'reply', data: { id: '123' } },
    ], mockClient);

    // With default maxDepth=3, starting at depth=0:
    // depth 0: resolves reply 123 → gets reply 456 → recurse depth 1
    // depth 1: resolves reply 456 → gets reply 456 → recurse depth 2
    // depth 2: resolves reply 456 → gets reply 456 → recurse depth 3
    // depth 3: depth >= maxDepth → [回复消息]
    expect(result).toBe('[回复 张三: [回复 张三: [回复 张三: [回复消息]]]]');
    // 3 API calls: depths 0, 1, 2
    expect(mockClient.callApi).toHaveBeenCalledTimes(3);
  });

  it('should not recursively call API when maxDepth is 1', async () => {
    const mockClient = {
      callApi: vi.fn().mockResolvedValue({
        sender: { card: '张三', nickname: 'zhangsan' },
        message: [{ type: 'reply', data: { id: '456' } }],
      }),
    };

    const result = await parseHistoryMessageSegments([
      { type: 'reply', data: { id: '123' } },
    ], mockClient, 0, 1);

    expect(result).toBe('[回复 张三: [回复消息]]');
    expect(mockClient.callApi).toHaveBeenCalledTimes(1);
  });

  it('should render @all for at segment with qq=all', async () => {
    const result = await parseHistoryMessageSegments([
      { type: 'at', data: { qq: 'all' } },
    ]);
    expect(result).toBe('@全体成员');
  });

  it('should render @qq for at segment with specific qq', async () => {
    const result = await parseHistoryMessageSegments([
      { type: 'at', data: { qq: '123456' } },
    ]);
    expect(result).toBe('@123456');
  });

  it('should render record segment as [语音消息]', async () => {
    const result = await parseHistoryMessageSegments([
      { type: 'record', data: { file: 'voice.amr' } },
    ]);
    expect(result).toBe('[语音消息]');
  });

  it('should render forward segment as [合并转发消息]', async () => {
    const result = await parseHistoryMessageSegments([
      { type: 'forward', data: { id: '1' } },
    ]);
    expect(result).toBe('[合并转发消息]');
  });

  it('should render video segment as [视频]', async () => {
    const result = await parseHistoryMessageSegments([
      { type: 'video', data: { file: 'video.mp4' } },
    ]);
    expect(result).toBe('[视频]');
  });

  it('should render json segment as [卡片消息]', async () => {
    const result = await parseHistoryMessageSegments([
      { type: 'json', data: { data: '{"app":"com.tencent"}' } },
    ]);
    expect(result).toBe('[卡片消息]');
  });

  it('should handle mixed segments: text + reply + image + at', async () => {
    const mockClient = {
      callApi: vi.fn().mockResolvedValue({
        sender: { card: '张三', nickname: 'zhangsan' },
        message: [{ type: 'text', data: { text: '原消息' } }],
      }),
    };

    const segs = [
      { type: 'text', data: { text: '你好 ' } },
      { type: 'reply', data: { id: '123' } },
      { type: 'image', data: { file: 'PIC123.jpg' } },
      { type: 'at', data: { qq: '123456' } },
    ];
    const result = await parseHistoryMessageSegments(segs, mockClient);
    expect(result).toBe('你好 [回复 张三: 原消息]@123456 [图片 - 使用 qq_resolve_image(file: "PIC123.jpg") 获取]');
  });

  it('should handle mixed segments: text + images + files (with file_id)', async () => {
    const segs = [
      { type: 'text', data: { text: 'Check these: ' } },
      { type: 'image', data: { file: 'PIC123.jpg' } },
      { type: 'file', data: { name: 'notes.txt', file_id: '/file-abc' } },
      { type: 'face', data: { id: '14' } },
    ];
    const result = await parseHistoryMessageSegments(segs);
    expect(result).toBe('Check these: [表情14] [图片 - 使用 qq_resolve_image(file: "PIC123.jpg") 获取] [文件: notes.txt - 使用 qq_download_group_file(file_id: "/file-abc") 下载]');
  });

  it('should handle mixed segments: text + images + files (without file_id)', async () => {
    const segs = [
      { type: 'text', data: { text: 'Check these: ' } },
      { type: 'image', data: { file: 'PIC123.jpg' } },
      { type: 'file', data: { name: 'notes.txt' } },
      { type: 'face', data: { id: '14' } },
    ];
    const result = await parseHistoryMessageSegments(segs);
    expect(result).toBe('Check these: [表情14] [图片 - 使用 qq_resolve_image(file: "PIC123.jpg") 获取] [文件: notes.txt]');
  });

  it('should return [非文本消息] for empty segments', async () => {
    const result = await parseHistoryMessageSegments([]);
    expect(result).toBe('[非文本消息]');
  });

  it('should return [非文本消息] for null/undefined segments', async () => {
    await expect(parseHistoryMessageSegments(null)).resolves.toBe('[非文本消息]');
    await expect(parseHistoryMessageSegments(undefined)).resolves.toBe('[非文本消息]');
  });

  it('should return [非文本消息] for only unknown segment types', async () => {
    const segs = [
      { type: 'share', data: { url: 'https://example.com' } },
    ];
    const result = await parseHistoryMessageSegments(segs);
    expect(result).toBe('[非文本消息]');
  });

  it('should handle image-only messages with per-image hints', async () => {
    const segs = [
      { type: 'image', data: { file: 'A.jpg' } },
      { type: 'image', data: { file: 'B.jpg' } },
      { type: 'image', data: { file: 'C.jpg' } },
    ];
    const result = await parseHistoryMessageSegments(segs);
    expect(result).toBe('[图片 - 使用 qq_resolve_image(file: "A.jpg") 获取] [图片 - 使用 qq_resolve_image(file: "B.jpg") 获取] [图片 - 使用 qq_resolve_image(file: "C.jpg") 获取]');
  });

  it('should handle multiple files with file_id', async () => {
    const segs = [
      { type: 'file', data: { name: 'a.pdf', file_id: '/id-a' } },
      { type: 'file', data: { name: 'b.doc', file_id: '/id-b' } },
    ];
    const result = await parseHistoryMessageSegments(segs);
    expect(result).toBe('[文件: a.pdf - 使用 qq_download_group_file(file_id: "/id-a") 下载] [文件: b.doc - 使用 qq_download_group_file(file_id: "/id-b") 下载]');
  });

  it('should handle multiple files without file_id', async () => {
    const segs = [
      { type: 'file', data: { name: 'a.pdf' } },
      { type: 'file', data: { name: 'b.doc' } },
    ];
    const result = await parseHistoryMessageSegments(segs);
    expect(result).toBe('[文件: a.pdf] [文件: b.doc]');
  });

  it('should handle mixed files: some with file_id, some without', async () => {
    const segs = [
      { type: 'file', data: { name: 'a.pdf', file_id: '/id-a' } },
      { type: 'file', data: { name: 'b.doc' } },
    ];
    const result = await parseHistoryMessageSegments(segs);
    expect(result).toBe('[文件: a.pdf - 使用 qq_download_group_file(file_id: "/id-a") 下载] [文件: b.doc]');
  });

  // ── Forward segment tests ────────────────────────────────────────

  it('should render forward segment as [合并转发消息] without client', async () => {
    const result = await parseHistoryMessageSegments([
      { type: 'forward', data: { id: 'fwd-123' } },
    ]);
    expect(result).toBe('[合并转发消息]');
  });

  it('should expand forward segment when client returns messages', async () => {
    const mockClient = {
      callApi: vi.fn().mockImplementation((action: string) => {
        if (action === 'get_forward_msg') {
          return Promise.resolve({
            messages: [
              {
                sender: { card: '张三', nickname: 'zhangsan' },
                content: [{ type: 'text', data: { text: '消息一' } }],
              },
              {
                sender: { nickname: '李四' },
                content: [{ type: 'text', data: { text: '消息二' } }],
              },
            ],
          });
        }
        return Promise.resolve({});
      }),
    };

    const result = await parseHistoryMessageSegments([
      { type: 'forward', data: { id: 'fwd-123' } },
    ], mockClient);

    expect(result).toBe('[合并转发消息:\n张三: 消息一\n李四: 消息二]');
    expect(mockClient.callApi).toHaveBeenCalledWith('get_forward_msg', { message_id: 'fwd-123' });
  });

  it('should use message field when content is absent (NapCat compat)', async () => {
    const mockClient = {
      callApi: vi.fn().mockResolvedValue({
        messages: [
          {
            sender: { card: '王五', nickname: 'wangwu' },
            message: [{ type: 'text', data: { text: 'NapCat格式' } }],
          },
        ],
      }),
    };

    const result = await parseHistoryMessageSegments([
      { type: 'forward', data: { id: 'fwd-456' } },
    ], mockClient);

    expect(result).toBe('[合并转发消息:\n王五: NapCat格式]');
  });

  it('should fallback to [合并转发消息] when get_forward_msg fails', async () => {
    const mockClient = {
      callApi: vi.fn().mockRejectedValue(new Error('API error')),
    };

    const result = await parseHistoryMessageSegments([
      { type: 'forward', data: { id: 'fwd-789' } },
    ], mockClient);

    expect(result).toBe('[合并转发消息]');
  });

  it('should fallback to [合并转发消息] when messages array is empty', async () => {
    const mockClient = {
      callApi: vi.fn().mockResolvedValue({ messages: [] }),
    };

    const result = await parseHistoryMessageSegments([
      { type: 'forward', data: { id: 'fwd-empty' } },
    ], mockClient);

    expect(result).toBe('[合并转发消息]');
  });

  it('should expand forward containing images', async () => {
    const mockClient = {
      callApi: vi.fn().mockResolvedValue({
        messages: [
          {
            sender: { card: '张三' },
            content: [
              { type: 'text', data: { text: '看这张图 ' } },
              { type: 'image', data: { file: 'FWD_IMG.jpg' } },
            ],
          },
        ],
      }),
    };

    const result = await parseHistoryMessageSegments([
      { type: 'forward', data: { id: 'fwd-img' } },
    ], mockClient);

    expect(result).toBe('[合并转发消息:\n张三: 看这张图 [图片 - 使用 qq_resolve_image(file: "FWD_IMG.jpg") 获取]]');
  });

  it('should expand nested forward up to maxDepth and degrade deeper levels', async () => {
    let callCount = 0;
    const mockClient = {
      callApi: vi.fn().mockImplementation((action: string) => {
        if (action === 'get_forward_msg') {
          callCount++;
          return Promise.resolve({
            messages: [
              {
                sender: { card: `层级${callCount}` },
                content: [{ type: 'forward', data: { id: `nested-${callCount}` } }],
              },
            ],
          });
        }
        return Promise.resolve({});
      }),
    };

    // Start at depth 0, maxDepth 2 → should expand 2 levels, degrade at level 3
    const result = await parseHistoryMessageSegments([
      { type: 'forward', data: { id: 'fwd-root' } },
    ], mockClient, 0, 2);

    // depth 0: expand → 层级1: [forward nested-1]
    // depth 1: expand → 层级2: [forward nested-2]
    // depth 2: >= maxDepth → [合并转发消息]
    expect(result).toBe('[合并转发消息:\n层级1: [合并转发消息:\n层级2: [合并转发消息]]]');
    // 2 API calls (at depth 0 and depth 1), depth 2 degrades
    expect(mockClient.callApi).toHaveBeenCalledTimes(2);
  });

  it('should expand forward containing reply segments', async () => {
    const mockClient = {
      callApi: vi.fn().mockImplementation((action: string, params: any) => {
        if (action === 'get_forward_msg') {
          return Promise.resolve({
            messages: [
              {
                sender: { card: '张三' },
                content: [
                  { type: 'reply', data: { id: '999' } },
                  { type: 'text', data: { text: '回复内容' } },
                ],
              },
            ],
          });
        }
        if (action === 'get_msg' && params.message_id === 999) {
          return Promise.resolve({
            sender: { card: '李四' },
            message: [{ type: 'text', data: { text: '原始消息' } }],
          });
        }
        return Promise.resolve({});
      }),
    };

    const result = await parseHistoryMessageSegments([
      { type: 'forward', data: { id: 'fwd-reply' } },
    ], mockClient);

    expect(result).toBe('[合并转发消息:\n张三: [回复 李四: 原始消息]回复内容]');
  });

  // ── Depth control tests ──────────────────────────────────────────

  it('should degrade both reply and forward when depth >= maxDepth', async () => {
    const mockClient = {
      callApi: vi.fn(),
    };

    const result = await parseHistoryMessageSegments([
      { type: 'reply', data: { id: '123' } },
      { type: 'text', data: { text: ' ' } },
      { type: 'forward', data: { id: 'fwd-1' } },
    ], mockClient, 3, 3);

    // depth >= maxDepth → both reply and forward degrade
    expect(result).toBe('[回复消息] [合并转发消息]');
    // No API calls should be made
    expect(mockClient.callApi).not.toHaveBeenCalled();
  });

  it('should use default depth=0 and maxDepth=3 when not specified', async () => {
    const mockClient = {
      callApi: vi.fn().mockResolvedValue({
        sender: { card: '张三' },
        message: [{ type: 'text', data: { text: '嗨' } }],
      }),
    };

    // Not passing depth/maxDepth — should default to 0/3
    const result = await parseHistoryMessageSegments([
      { type: 'reply', data: { id: '123' } },
    ], mockClient);

    expect(result).toBe('[回复 张三: 嗨]');
    expect(mockClient.callApi).toHaveBeenCalledTimes(1);
  });

  it('should fallback to [合并转发消息] when forward has no id', async () => {
    const mockClient = {
      callApi: vi.fn(),
    };

    const result = await parseHistoryMessageSegments([
      { type: 'forward', data: {} },
    ], mockClient);

    expect(result).toBe('[合并转发消息]');
    expect(mockClient.callApi).not.toHaveBeenCalled();
  });
});

// ── resolveReplyContext ──────────────────────────────────────────────

describe('resolveReplyContext', () => {
  it('should return empty string when no reply segment exists', async () => {
    const segments = [
      { type: 'text', data: { text: 'hello' } },
      { type: 'image', data: { file: 'pic.jpg' } },
    ];
    const mockClient = { callApi: vi.fn() };
    const result = await resolveReplyContext(segments, mockClient);
    expect(result).toBe('');
    expect(mockClient.callApi).not.toHaveBeenCalled();
  });

  it('should return empty string when reply segment has no id', async () => {
    const segments = [
      { type: 'reply', data: {} },
    ];
    const mockClient = { callApi: vi.fn() };
    const result = await resolveReplyContext(segments, mockClient);
    expect(result).toBe('');
    expect(mockClient.callApi).not.toHaveBeenCalled();
  });

  it('should return empty string when no client is provided', async () => {
    const segments = [
      { type: 'reply', data: { id: '123' } },
    ];
    const result = await resolveReplyContext(segments);
    expect(result).toBe('');
  });

  it('should resolve reply with text message', async () => {
    const mockClient = {
      callApi: vi.fn().mockResolvedValue({
        sender: { card: '张三', nickname: 'zhangsan' },
        message: [{ type: 'text', data: { text: '你好' } }],
      }),
    };
    const segments = [
      { type: 'reply', data: { id: '123' } },
      { type: 'text', data: { text: '回复你' } },
    ];
    const result = await resolveReplyContext(segments, mockClient);
    expect(result).toBe('[引用 张三 的消息: 你好]\n');
    expect(mockClient.callApi).toHaveBeenCalledWith('get_msg', { message_id: 123 });
  });

  it('should resolve reply with image message', async () => {
    const mockClient = {
      callApi: vi.fn().mockResolvedValue({
        sender: { card: '张三', nickname: 'zhangsan' },
        message: [{ type: 'image', data: { file: 'HASH.jpg' } }],
      }),
    };
    const segments = [{ type: 'reply', data: { id: '456' } }];
    const result = await resolveReplyContext(segments, mockClient);
    expect(result).toBe('[引用 张三 的消息: [图片 - 使用 qq_resolve_image(file: "HASH.jpg") 获取]]\n');
  });

  it('should resolve reply with file message (with file_id)', async () => {
    const mockClient = {
      callApi: vi.fn().mockResolvedValue({
        sender: { card: '张三', nickname: 'zhangsan' },
        message: [{ type: 'file', data: { name: 'report.pdf', file_id: '/acde6471' } }],
      }),
    };
    const segments = [{ type: 'reply', data: { id: '789' } }];
    const result = await resolveReplyContext(segments, mockClient);
    expect(result).toBe('[引用 张三 的消息: [文件: report.pdf - 使用 qq_download_group_file(file_id: "/acde6471") 下载]]\n');
  });

  it('should return empty string when get_msg fails', async () => {
    const mockClient = {
      callApi: vi.fn().mockRejectedValue(new Error('API error')),
    };
    const segments = [{ type: 'reply', data: { id: '123' } }];
    const result = await resolveReplyContext(segments, mockClient);
    expect(result).toBe('');
  });

  it('should use nickname when card is empty', async () => {
    const mockClient = {
      callApi: vi.fn().mockResolvedValue({
        sender: { card: '', nickname: 'NickName' },
        message: [{ type: 'text', data: { text: 'hi' } }],
      }),
    };
    const segments = [{ type: 'reply', data: { id: '123' } }];
    const result = await resolveReplyContext(segments, mockClient);
    expect(result).toBe('[引用 NickName 的消息: hi]\n');
  });

  it('should use "?" when both card and nickname are missing', async () => {
    const mockClient = {
      callApi: vi.fn().mockResolvedValue({
        sender: {},
        message: [{ type: 'text', data: { text: 'hi' } }],
      }),
    };
    const segments = [{ type: 'reply', data: { id: '123' } }];
    const result = await resolveReplyContext(segments, mockClient);
    expect(result).toBe('[引用 ? 的消息: hi]\n');
  });

  it('should recursively resolve nested replies in quoted message up to maxDepth', async () => {
    const mockClient = {
      callApi: vi.fn().mockResolvedValue({
        sender: { card: '张三', nickname: 'zhangsan' },
        message: [
          { type: 'reply', data: { id: '456' } },
          { type: 'text', data: { text: '嵌套回复' } },
        ],
      }),
    };
    const segments = [{ type: 'reply', data: { id: '123' } }];
    const result = await resolveReplyContext(segments, mockClient);
    // resolveReplyContext calls parseHistoryMessageSegments with depth=1, maxDepth=3
    // depth 1: resolves reply 456 → gets reply 456 + text → recurse depth 2
    // depth 2: resolves reply 456 → gets reply 456 + text → recurse depth 3
    // depth 3: depth >= maxDepth → [回复消息]
    expect(result).toBe('[引用 张三 的消息: [回复 张三: [回复 张三: [回复消息]嵌套回复]嵌套回复]嵌套回复]\n');
    // 1 call from resolveReplyContext + 2 calls from parseHistoryMessageSegments recursion
    expect(mockClient.callApi).toHaveBeenCalledTimes(3);
  });

  it('should return empty string when get_msg returns no message', async () => {
    const mockClient = {
      callApi: vi.fn().mockResolvedValue({
        sender: { card: '张三' },
        // no message field
      }),
    };
    const segments = [{ type: 'reply', data: { id: '123' } }];
    const result = await resolveReplyContext(segments, mockClient);
    expect(result).toBe('');
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
      requireMention: true,
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
        media: {
          fetchRemoteMedia: vi.fn().mockResolvedValue({
            buffer: Buffer.from('fake-image'),
            contentType: 'image/jpeg',
          }),
          saveMediaBuffer: vi.fn().mockResolvedValue({
            id: 'media-1',
            path: '/tmp/openclaw/media/inbound/test.jpg',
            size: 10,
            contentType: 'image/jpeg',
          }),
        },
        commands: {
          resolveCommandAuthorizedFromAuthorizers: vi.fn().mockImplementation(
            (params: { authorizers: Array<{ allowed: boolean }> }) =>
              params.authorizers.some((a) => a.allowed),
          ),
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

  // ── Test 2: Image resolve hints in history, NOT in MediaPaths ──

  it('should include per-image resolve hints in history body but NOT put history images in MediaPaths', async () => {
    const historyMessages = [
      {
        message_id: 9001,
        user_id: 222,
        sender: { card: '李四', nickname: 'lisi' },
        message: [
          { type: 'text', data: { text: '这是什么？' } },
          { type: 'image', data: { file: '5E28D43A2FE346F995BC1D0F5D82829F.jpg' } },
          { type: 'image', data: { file: 'A7BCE4AD4BF4784F1D3A25C84D3A06EC.jpg' } },
        ],
        time: 1772956800,
      },
    ];

    const account = makeAccount();
    const runtime = makeRuntime();
    const client = makeClient(historyMessages);

    await handleInboundMessage(makeGroupEvent(), account, cfg, runtime, client, log);

    expect(capturedCtx).not.toBeNull();
    // History should have per-image resolve hints
    const history = capturedCtx!.InboundHistory as Array<{ sender: string; body: string; timestamp: number }>;
    expect(history).toHaveLength(1);
    expect(history[0].body).toBe('这是什么？ [图片 - 使用 qq_resolve_image(file: "5E28D43A2FE346F995BC1D0F5D82829F.jpg") 获取] [图片 - 使用 qq_resolve_image(file: "A7BCE4AD4BF4784F1D3A25C84D3A06EC.jpg") 获取]');

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
          { type: 'image', data: { file: 'HIST123.jpg' } },
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

    // History should have per-image resolve hint
    const history = capturedCtx!.InboundHistory as Array<{ sender: string; body: string; timestamp: number }>;
    expect(history[0].body).toBe('[图片 - 使用 qq_resolve_image(file: "HIST123.jpg") 获取]');

    // Cleanup temp files
    for (const p of capturedCtx!.MediaPaths as string[]) {
      try { unlinkSync(p); } catch { /* ignore */ }
    }
  });

  // ── Test 4: Mixed scenario — history + current images ───────────

  it('should separate history images (resolve hints) from current images (MediaPaths)', async () => {
    const historyMessages = [
      {
        message_id: 9001,
        user_id: 333,
        sender: { card: '王五', nickname: 'wangwu' },
        message: [
          { type: 'image', data: { file: 'H1.jpg' } },
          { type: 'image', data: { file: 'H2.jpg' } },
          { type: 'image', data: { file: 'H3.jpg' } },
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

    // History shows 3 images with per-image resolve hints
    const history = capturedCtx!.InboundHistory as Array<{ sender: string; body: string; timestamp: number }>;
    expect(history[0].body).toBe('[图片 - 使用 qq_resolve_image(file: "H1.jpg") 获取] [图片 - 使用 qq_resolve_image(file: "H2.jpg") 获取] [图片 - 使用 qq_resolve_image(file: "H3.jpg") 获取]');

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
    // RawBody keeps the original empty extractPlainText output
    // (but since it was empty and became the placeholder, all three match)
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

  // ── Test 8: BodyForAgent uses stripped text, RawBody keeps original ─

  it('should set BodyForAgent to stripped text and RawBody to original text', async () => {
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
    // BodyForAgent should have bot mention stripped
    expect(capturedCtx!.BodyForAgent).toBe('看看猫');
    expect(capturedCtx!.Body).toBe('看看猫');
    // RawBody keeps original extractPlainText output (no @bot since extractPlainText skips at segments)
    expect(capturedCtx!.RawBody).toBe('看看猫');
    // Confirm no history delimiters in BodyForAgent
    expect(capturedCtx!.BodyForAgent).not.toContain('[以下是群聊中');
    expect(capturedCtx!.BodyForAgent).not.toContain('[以上是历史消息');
  });

  // ── Test 8b: RawBody preserves original when stripBotMention changes text ─

  it('should keep RawBody as original extractPlainText when stripBotMention modifies text', async () => {
    // Simulate a message where extractPlainText returns text with an @mention pattern
    // (NapCat sometimes puts @nickname in text segments)
    const event = makeGroupEvent({
      message: [
        { type: 'at', data: { qq: '100001' } },
        { type: 'text', data: { text: '@BotName 请帮忙查一下' } },
      ],
    });

    const account = makeAccount();
    const runtime = makeRuntime();
    const client = makeClient();

    await handleInboundMessage(event, account, cfg, runtime, client, log);

    expect(capturedCtx).not.toBeNull();
    // RawBody keeps the original extractPlainText output (includes @BotName)
    expect(capturedCtx!.RawBody).toBe('@BotName 请帮忙查一下');
    // BodyForAgent should have the @mention stripped
    expect(capturedCtx!.BodyForAgent).toBe('请帮忙查一下');
    expect(capturedCtx!.Body).toBe('请帮忙查一下');
  });

  // ── Test 8c: DM BodyForAgent equals RawBody (no stripping) ──────

  it('should set BodyForAgent equal to RawBody for direct messages', async () => {
    const account = makeAccount({ dmPolicy: 'open' });
    const runtime = makeRuntime();
    const client = makeClient();

    await handleInboundMessage(makeDmEvent(), account, cfg, runtime, client, log);

    expect(capturedCtx).not.toBeNull();
    expect(capturedCtx!.Body).toBe('你好');
    expect(capturedCtx!.BodyForAgent).toBe('你好');
    expect(capturedCtx!.RawBody).toBe('你好');
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

// ── sendWithRetry ───────────────────────────────────────────────────

describe('sendWithRetry', () => {
  it('should succeed on first attempt without retrying', async () => {
    const client = {
      sendMessage: vi.fn().mockResolvedValue(42),
    } as any;
    const target = { type: 'group' as const, groupId: 888 };
    const segments = [{ type: 'text' as const, data: { text: 'hello' } }];

    const result = await sendWithRetry(client, target, segments);
    expect(result).toBe(42);
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('should retry on failure and succeed on second attempt', async () => {
    const client = {
      sendMessage: vi.fn()
        .mockRejectedValueOnce(new Error('network error'))
        .mockResolvedValueOnce(99),
    } as any;
    const target = { type: 'group' as const, groupId: 888 };
    const segments = [{ type: 'text' as const, data: { text: 'hello' } }];
    const mockLog = { warn: vi.fn(), error: vi.fn() };

    const result = await sendWithRetry(client, target, segments, mockLog, 3);
    expect(result).toBe(99);
    expect(client.sendMessage).toHaveBeenCalledTimes(2);
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.stringContaining('Send attempt 1/3 failed'),
    );
  });

  it('should throw after all attempts exhausted', async () => {
    const client = {
      sendMessage: vi.fn()
        .mockRejectedValue(new Error('persistent error')),
    } as any;
    const target = { type: 'group' as const, groupId: 888 };
    const segments = [{ type: 'text' as const, data: { text: 'hello' } }];
    const mockLog = { warn: vi.fn(), error: vi.fn() };

    await expect(
      sendWithRetry(client, target, segments, mockLog, 2),
    ).rejects.toThrow('persistent error');
    expect(client.sendMessage).toHaveBeenCalledTimes(2);
    expect(mockLog.warn).toHaveBeenCalledTimes(1); // only 1 warn for attempt 1/2
  });

  it('should work with maxAttempts=1 (no retry)', async () => {
    const client = {
      sendMessage: vi.fn().mockRejectedValue(new Error('fail')),
    } as any;
    const target = { type: 'private' as const, userId: 123 };
    const segments = [{ type: 'text' as const, data: { text: 'hi' } }];

    await expect(
      sendWithRetry(client, target, segments, undefined, 1),
    ).rejects.toThrow('fail');
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
  });
});

// ── Batch 2: Quote-reply, text+media merge, requireMention, robust indicators ─

describe('handleInboundMessage — Batch 2', () => {
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
      groupContextMessages: 0,
      requireMention: true,
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
        { type: 'text', data: { text: ' 你好' } },
      ],
      raw_message: '@bot 你好',
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

  /** Capture sendMessage calls to verify segments. */
  let sendCalls: Array<{ target: any; segments: any[] }>;
  /** Capture dispatchReplyWithBufferedBlockDispatcher deliver function. */
  let capturedDeliver: ((payload: any) => Promise<void>) | null;

  function makeRuntime() {
    capturedDeliver = null;
    return {
      channel: {
        routing: {
          resolveAgentRoute: vi.fn().mockReturnValue({
            agentId: 'agent-1',
            sessionKey: 'sess-1',
          }),
        },
        reply: {
          finalizeInboundContext: vi.fn().mockImplementation((ctx: Record<string, unknown>) => ctx),
          dispatchReplyWithBufferedBlockDispatcher: vi.fn().mockImplementation(
            async (params: { dispatcherOptions: { deliver: (payload: any) => Promise<void> } }) => {
              capturedDeliver = params.dispatcherOptions.deliver;
            },
          ),
        },
        session: {
          resolveStorePath: vi.fn().mockReturnValue('/tmp/store'),
          recordInboundSession: vi.fn().mockResolvedValue(undefined),
        },
        text: {
          resolveTextChunkLimit: vi.fn().mockReturnValue(4000),
          chunkText: vi.fn().mockImplementation((t: string) => [t]),
        },
        media: {
          fetchRemoteMedia: vi.fn().mockResolvedValue({
            buffer: Buffer.from('fake-image'),
            contentType: 'image/jpeg',
          }),
          saveMediaBuffer: vi.fn().mockResolvedValue({
            id: 'media-1',
            path: '/tmp/openclaw/media/inbound/test.jpg',
            size: 10,
            contentType: 'image/jpeg',
          }),
        },
        commands: {
          resolveCommandAuthorizedFromAuthorizers: vi.fn().mockReturnValue(true),
        },
      },
    } as any;
  }

  function makeClient() {
    sendCalls = [];
    return {
      callApi: vi.fn().mockResolvedValue({}),
      sendMessage: vi.fn().mockImplementation((target: any, segments: any[]) => {
        sendCalls.push({ target, segments });
        return Promise.resolve(sendCalls.length);
      }),
    } as any;
  }

  const cfg = {} as any;
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  afterEach(() => {
    vi.restoreAllMocks();
    sendCalls = [];
    capturedDeliver = null;
  });

  // ── Quote-reply: group message should have reply segment ────────

  it('should prepend reply segment to first text message in group chat', async () => {
    const account = makeAccount();
    const runtime = makeRuntime();
    const client = makeClient();

    await handleInboundMessage(makeGroupEvent(), account, cfg, runtime, client, log);

    // capturedDeliver should have been set by the mock
    expect(capturedDeliver).not.toBeNull();

    // Simulate delivering a text reply
    await capturedDeliver!({ text: 'Hello back!' });

    expect(sendCalls.length).toBe(1);
    const firstCall = sendCalls[0];
    // First segment should be reply
    expect(firstCall.segments[0]).toEqual({ type: 'reply', data: { id: '9999' } });
    // Second segment should be text
    expect(firstCall.segments[1].type).toBe('text');
    expect(firstCall.segments[1].data.text).toBe('Hello back!');
  });

  it('should NOT prepend reply segment in DM', async () => {
    const account = makeAccount();
    const runtime = makeRuntime();
    const client = makeClient();

    await handleInboundMessage(makeDmEvent(), account, cfg, runtime, client, log);

    expect(capturedDeliver).not.toBeNull();
    await capturedDeliver!({ text: 'Hello DM!' });

    expect(sendCalls.length).toBe(1);
    // No reply segment — first segment is text
    expect(sendCalls[0].segments[0].type).toBe('text');
    expect(sendCalls[0].segments.every((s: any) => s.type !== 'reply')).toBe(true);
  });

  it('should prepend reply segment to media-only message in group when no text', async () => {
    const account = makeAccount();
    const runtime = makeRuntime();
    const client = makeClient();

    await handleInboundMessage(makeGroupEvent(), account, cfg, runtime, client, log);

    expect(capturedDeliver).not.toBeNull();
    await capturedDeliver!({ mediaUrl: 'https://example.com/cat.jpg' });

    expect(sendCalls.length).toBe(1);
    // Reply segment prepended to the media message
    expect(sendCalls[0].segments[0]).toEqual({ type: 'reply', data: { id: '9999' } });
    expect(sendCalls[0].segments[1].type).toBe('image');
  });

  // ── Text+media merge ────────────────────────────────────────────

  it('should merge last text chunk with first media into one message', async () => {
    const account = makeAccount();
    const runtime = makeRuntime();
    const client = makeClient();

    await handleInboundMessage(makeGroupEvent(), account, cfg, runtime, client, log);

    expect(capturedDeliver).not.toBeNull();
    await capturedDeliver!({
      text: 'Here is the image:',
      mediaUrl: 'https://example.com/cat.jpg',
    });

    // Should be 1 call: text + media merged (+ reply in group)
    expect(sendCalls.length).toBe(1);
    const segments = sendCalls[0].segments;
    // reply + text + image
    expect(segments[0].type).toBe('reply');
    expect(segments[1].type).toBe('text');
    expect(segments[2].type).toBe('image');
  });

  it('should fallback to separate sends if merge fails', async () => {
    const account = makeAccount();
    const runtime = makeRuntime();
    sendCalls = [];
    const client = {
      callApi: vi.fn().mockResolvedValue({}),
      sendMessage: vi.fn().mockImplementation((target: any, segments: any[]) => {
        // Any call with both text and image segments fails (merge not supported)
        const hasText = segments.some((s: any) => s.type === 'text');
        const hasImage = segments.some((s: any) => s.type === 'image');
        if (hasText && hasImage) {
          return Promise.reject(new Error('merge not supported'));
        }
        sendCalls.push({ target, segments });
        return Promise.resolve(sendCalls.length);
      }),
    } as any;

    await handleInboundMessage(makeGroupEvent(), account, cfg, runtime, client, log);

    expect(capturedDeliver).not.toBeNull();
    await capturedDeliver!({
      text: 'Look at this',
      mediaUrl: 'https://example.com/cat.jpg',
    });

    // Merge failed after retries, then fallback: text separately, then media separately
    expect(sendCalls.length).toBe(2);
    // First fallback: text (with reply)
    const textCall = sendCalls[0];
    expect(textCall.segments.some((s: any) => s.type === 'reply')).toBe(true);
    expect(textCall.segments.some((s: any) => s.type === 'text')).toBe(true);
    expect(textCall.segments.every((s: any) => s.type !== 'image')).toBe(true);
    // Second fallback: media alone
    const mediaCall = sendCalls[1];
    expect(mediaCall.segments.some((s: any) => s.type === 'image')).toBe(true);
  });

  it('should send additional mediaUrls separately', async () => {
    const account = makeAccount();
    const runtime = makeRuntime();
    const client = makeClient();

    await handleInboundMessage(makeGroupEvent(), account, cfg, runtime, client, log);

    expect(capturedDeliver).not.toBeNull();
    await capturedDeliver!({
      text: 'Multiple images:',
      mediaUrl: 'https://example.com/1.jpg',
      mediaUrls: ['https://example.com/1.jpg', 'https://example.com/2.jpg'],
    });

    // Call 1: merged text + first media (+ reply)
    // Call 2: second media separately
    expect(sendCalls.length).toBe(2);
    expect(sendCalls[0].segments.some((s: any) => s.type === 'text')).toBe(true);
    expect(sendCalls[0].segments.some((s: any) => s.type === 'image')).toBe(true);
    // Second image sent separately
    expect(sendCalls[1].segments.length).toBe(1);
    expect(sendCalls[1].segments[0].type).toBe('image');
  });

  // ── requireMention configurable ─────────────────────────────────

  it('should skip group message without @mention when requireMention=true', async () => {
    const account = makeAccount({ requireMention: true });
    const runtime = makeRuntime();
    const client = makeClient();

    // No @bot mention
    const event = makeGroupEvent({
      message: [
        { type: 'text', data: { text: '随便聊聊' } },
      ],
    });

    await handleInboundMessage(event, account, cfg, runtime, client, log);

    // Should be skipped — no dispatch
    expect(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
  });

  it('should process group message without @mention when requireMention=false', async () => {
    const account = makeAccount({ requireMention: false });
    const runtime = makeRuntime();
    const client = makeClient();

    // No @bot mention but requireMention=false
    const event = makeGroupEvent({
      message: [
        { type: 'text', data: { text: '随便聊聊' } },
      ],
    });

    await handleInboundMessage(event, account, cfg, runtime, client, log);

    // Should proceed to dispatch
    expect(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalled();
  });

  // ── Robust indicators ───────────────────────────────────────────

  it('should not attempt to remove 🔥 if setting it failed', async () => {
    const account = makeAccount();
    const runtime = makeRuntime();
    const callApiCalls: string[] = [];
    const client = {
      callApi: vi.fn().mockImplementation((action: string, params: any) => {
        callApiCalls.push(action);
        // Fail the processing emoji set
        if (action === 'set_msg_emoji_like' && params.emoji_id === '128293' && params.set !== false) {
          return Promise.reject(new Error('emoji API unavailable'));
        }
        return Promise.resolve({});
      }),
      sendMessage: vi.fn().mockResolvedValue(0),
    } as any;

    await handleInboundMessage(makeGroupEvent(), account, cfg, runtime, client, log);

    // 🔥 set was attempted, but failed → should NOT try to remove it
    // ✨ done should still be attempted
    const emojiCalls = callApiCalls.filter((a) => a === 'set_msg_emoji_like');
    // First call: set 🔥 (failed)
    // Second call: set ✨ done (should always happen)
    // NO third call for removing 🔥
    expect(emojiCalls.length).toBe(2);

    // Verify the second emoji call was the done emoji, NOT remove-processing
    const allCalls = client.callApi.mock.calls;
    const emojiApiCalls = allCalls.filter((c: any[]) => c[0] === 'set_msg_emoji_like');
    // First: set 🔥 (failed)
    expect(emojiApiCalls[0][1].emoji_id).toBe('128293');
    // Second: set ✨
    expect(emojiApiCalls[1][1].emoji_id).toBe('10024');
  });

  it('should remove 🔥 then set ✨ when processing emoji was set successfully', async () => {
    const account = makeAccount();
    const runtime = makeRuntime();
    const client = makeClient();

    await handleInboundMessage(makeGroupEvent(), account, cfg, runtime, client, log);

    // callApi should be called for: set 🔥, remove 🔥, set ✨
    const emojiCalls = client.callApi.mock.calls.filter(
      (c: any[]) => c[0] === 'set_msg_emoji_like',
    );
    expect(emojiCalls.length).toBe(3);
    // set 🔥
    expect(emojiCalls[0][1]).toEqual(expect.objectContaining({ emoji_id: '128293' }));
    expect(emojiCalls[0][1].set).toBeUndefined(); // set is not passed when adding
    // remove 🔥
    expect(emojiCalls[1][1]).toEqual(expect.objectContaining({ emoji_id: '128293', set: false }));
    // set ✨
    expect(emojiCalls[2][1]).toEqual(expect.objectContaining({ emoji_id: '10024' }));
  });

  // ── Quote-reply: only first message gets reply segment ──────────

  it('should only prepend reply segment to the first chunk in multi-chunk text', async () => {
    const account = makeAccount();
    const runtime = makeRuntime();
    // Make chunkText return 2 chunks
    runtime.channel.text.chunkText = vi.fn().mockReturnValue(['chunk1', 'chunk2']);
    const client = makeClient();

    await handleInboundMessage(makeGroupEvent(), account, cfg, runtime, client, log);

    expect(capturedDeliver).not.toBeNull();
    await capturedDeliver!({ text: 'long text that gets chunked' });

    expect(sendCalls.length).toBe(2);
    // First chunk has reply
    expect(sendCalls[0].segments[0].type).toBe('reply');
    // Second chunk does NOT have reply
    expect(sendCalls[1].segments.every((s: any) => s.type !== 'reply')).toBe(true);
  });

  it('should prepend reply context to Body and BodyForAgent while keeping RawBody unchanged', async () => {
    let capturedCtx: Record<string, unknown> | null = null;
    const runtime = makeRuntime();
    runtime.channel.reply.finalizeInboundContext = vi.fn().mockImplementation((ctx: Record<string, unknown>) => {
      capturedCtx = ctx;
      return ctx;
    });

    const client = {
      callApi: vi.fn().mockImplementation((action: string, params: any) => {
        if (action === 'get_msg' && params.message_id === 123) {
          return Promise.resolve({
            sender: { card: 'TestUser', nickname: 'testuser' },
            message: [{ type: 'image', data: { file: 'E0A6.jpg' } }],
          });
        }
        return Promise.resolve({});
      }),
      sendMessage: vi.fn().mockResolvedValue(0),
    } as any;

    const event = makeGroupEvent({
      message: [
        { type: 'reply', data: { id: '123' } },
        { type: 'at', data: { qq: '100001' } },
        { type: 'text', data: { text: ' 这张图说了什么？' } },
      ],
    });

    await handleInboundMessage(event, makeAccount(), cfg, runtime, client, log);

    expect(capturedCtx).not.toBeNull();
    expect(capturedCtx!.Body).toBe('[引用 TestUser 的消息: [图片 - 使用 qq_resolve_image(file: "E0A6.jpg") 获取]]\n这张图说了什么？');
    expect(capturedCtx!.BodyForAgent).toBe('[引用 TestUser 的消息: [图片 - 使用 qq_resolve_image(file: "E0A6.jpg") 获取]]\n这张图说了什么？');
    expect(capturedCtx!.RawBody).toBe('这张图说了什么？');
    expect(capturedCtx!.CommandBody).toBe('[引用 TestUser 的消息: [图片 - 使用 qq_resolve_image(file: "E0A6.jpg") 获取]]\n这张图说了什么？');
    expect(client.callApi).toHaveBeenCalledWith('get_msg', { message_id: 123 });
  });

  it('should keep Body unchanged when current reply context resolution fails', async () => {
    let capturedCtx: Record<string, unknown> | null = null;
    const runtime = makeRuntime();
    runtime.channel.reply.finalizeInboundContext = vi.fn().mockImplementation((ctx: Record<string, unknown>) => {
      capturedCtx = ctx;
      return ctx;
    });

    const client = {
      callApi: vi.fn().mockImplementation((action: string, params: any) => {
        if (action === 'get_msg' && params.message_id === 123) {
          return Promise.reject(new Error('boom'));
        }
        return Promise.resolve({});
      }),
      sendMessage: vi.fn().mockResolvedValue(0),
    } as any;

    const event = makeGroupEvent({
      message: [
        { type: 'reply', data: { id: '123' } },
        { type: 'at', data: { qq: '100001' } },
        { type: 'text', data: { text: ' 这张图说了什么？' } },
      ],
    });

    await handleInboundMessage(event, makeAccount(), cfg, runtime, client, log);

    expect(capturedCtx).not.toBeNull();
    expect(capturedCtx!.Body).toBe('这张图说了什么？');
    expect(capturedCtx!.BodyForAgent).toBe('这张图说了什么？');
    expect(capturedCtx!.RawBody).toBe('这张图说了什么？');
  });
});
