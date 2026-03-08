import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  parseHistoryMessageSegments,
  downloadImageToTmp,
  downloadImagesWithConcurrency,
} from '../src/gateway.js';
import { existsSync, unlinkSync, readFileSync } from 'node:fs';

// ── parseHistoryMessageSegments ─────────────────────────────────────

describe('parseHistoryMessageSegments', () => {
  it('should extract text from text segments', () => {
    const segs = [
      { type: 'text', data: { text: 'Hello ' } },
      { type: 'text', data: { text: 'world!' } },
    ];
    const result = parseHistoryMessageSegments(segs);
    expect(result.text).toBe('Hello world!');
    expect(result.imageUrls).toEqual([]);
  });

  it('should include face segments as [表情XX]', () => {
    const segs = [
      { type: 'text', data: { text: 'Hi ' } },
      { type: 'face', data: { id: '76' } },
    ];
    const result = parseHistoryMessageSegments(segs);
    expect(result.text).toBe('Hi [表情76]');
  });

  it('should count images and append [图片xN] marker', () => {
    const segs = [
      { type: 'text', data: { text: 'Look at this' } },
      { type: 'image', data: { url: 'https://example.com/1.jpg' } },
      { type: 'image', data: { url: 'https://example.com/2.jpg' } },
    ];
    const result = parseHistoryMessageSegments(segs);
    expect(result.text).toBe('Look at this [图片x2]');
    expect(result.imageUrls).toEqual([
      'https://example.com/1.jpg',
      'https://example.com/2.jpg',
    ]);
  });

  it('should extract image URL from data.file when data.url is missing', () => {
    const segs = [
      { type: 'image', data: { file: 'https://example.com/file.jpg' } },
    ];
    const result = parseHistoryMessageSegments(segs);
    expect(result.text).toBe('[图片x1]');
    expect(result.imageUrls).toEqual(['https://example.com/file.jpg']);
  });

  it('should prefer data.url over data.file for images', () => {
    const segs = [
      { type: 'image', data: { url: 'https://example.com/url.jpg', file: 'https://example.com/file.jpg' } },
    ];
    const result = parseHistoryMessageSegments(segs);
    expect(result.imageUrls).toEqual(['https://example.com/url.jpg']);
  });

  it('should skip images without url or file', () => {
    const segs = [
      { type: 'image', data: {} },
    ];
    const result = parseHistoryMessageSegments(segs);
    expect(result.text).toBe('[图片x1]');
    expect(result.imageUrls).toEqual([]);
  });

  it('should append [文件: name] for file segments', () => {
    const segs = [
      { type: 'text', data: { text: 'Here is a doc' } },
      { type: 'file', data: { name: 'report.pdf' } },
    ];
    const result = parseHistoryMessageSegments(segs);
    expect(result.text).toBe('Here is a doc [文件: report.pdf]');
    expect(result.imageUrls).toEqual([]);
  });

  it('should use data.file for file name when data.name is missing', () => {
    const segs = [
      { type: 'file', data: { file: 'document.docx' } },
    ];
    const result = parseHistoryMessageSegments(segs);
    expect(result.text).toBe('[文件: document.docx]');
  });

  it('should use "未知文件" when file has no name or file field', () => {
    const segs = [
      { type: 'file', data: {} },
    ];
    const result = parseHistoryMessageSegments(segs);
    expect(result.text).toBe('[文件: 未知文件]');
  });

  it('should handle mixed segments: text + images + files', () => {
    const segs = [
      { type: 'text', data: { text: 'Check these: ' } },
      { type: 'image', data: { url: 'https://example.com/pic.jpg' } },
      { type: 'file', data: { name: 'notes.txt' } },
      { type: 'face', data: { id: '14' } },
    ];
    const result = parseHistoryMessageSegments(segs);
    expect(result.text).toBe('Check these: [表情14] [图片x1] [文件: notes.txt]');
    expect(result.imageUrls).toEqual(['https://example.com/pic.jpg']);
  });

  it('should return [非文本消息] for empty segments', () => {
    const result = parseHistoryMessageSegments([]);
    expect(result.text).toBe('[非文本消息]');
    expect(result.imageUrls).toEqual([]);
  });

  it('should return [非文本消息] for null/undefined segments', () => {
    expect(parseHistoryMessageSegments(null).text).toBe('[非文本消息]');
    expect(parseHistoryMessageSegments(undefined).text).toBe('[非文本消息]');
  });

  it('should return [非文本消息] for only unknown segment types', () => {
    const segs = [
      { type: 'share', data: { url: 'https://example.com' } },
    ];
    const result = parseHistoryMessageSegments(segs);
    expect(result.text).toBe('[非文本消息]');
  });

  it('should handle image-only messages with [图片xN] as text', () => {
    const segs = [
      { type: 'image', data: { url: 'https://example.com/a.jpg' } },
      { type: 'image', data: { url: 'https://example.com/b.jpg' } },
      { type: 'image', data: { url: 'https://example.com/c.jpg' } },
    ];
    const result = parseHistoryMessageSegments(segs);
    expect(result.text).toBe('[图片x3]');
    expect(result.imageUrls).toHaveLength(3);
  });

  it('should handle multiple files', () => {
    const segs = [
      { type: 'file', data: { name: 'a.pdf' } },
      { type: 'file', data: { name: 'b.doc' } },
    ];
    const result = parseHistoryMessageSegments(segs);
    expect(result.text).toBe('[文件: a.pdf] [文件: b.doc]');
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
