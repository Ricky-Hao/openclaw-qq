import { describe, it, expect } from 'vitest';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildTextSegments,
  extractPlainText,
  wasBotMentioned,
  stripBotMention,
  extractImageUrls,
  buildImageSegment,
  buildFileSegment,
  buildMediaSegment,
  buildTarget,
} from '../src/onebot/message.js';
import type { MessageSegment } from '../src/onebot/types.js';

describe('onebot/message.ts', () => {
  describe('extractPlainText', () => {
    it('should extract text from text segments', () => {
      const segments: MessageSegment[] = [
        { type: 'text', data: { text: 'Hello ' } },
        { type: 'text', data: { text: 'world!' } },
      ];
      expect(extractPlainText(segments)).toBe('Hello world!');
    });

    it('should convert face segments to [表情XXX] format', () => {
      const segments: MessageSegment[] = [
        { type: 'text', data: { text: 'Hi ' } },
        { type: 'face', data: { id: '76' } },
        { type: 'text', data: { text: ' there' } },
      ];
      expect(extractPlainText(segments)).toBe('Hi [表情76] there');
    });

    it('should skip at segments', () => {
      const segments: MessageSegment[] = [
        { type: 'at', data: { qq: '123456' } },
        { type: 'text', data: { text: 'Hello' } },
      ];
      expect(extractPlainText(segments)).toBe('Hello');
    });

    it('should handle empty segments', () => {
      expect(extractPlainText([])).toBe('');
    });

    it('should trim the result', () => {
      const segments: MessageSegment[] = [
        { type: 'text', data: { text: '  Hello  ' } },
      ];
      expect(extractPlainText(segments)).toBe('Hello');
    });

    it('should handle mixed segment types', () => {
      const segments: MessageSegment[] = [
        { type: 'at', data: { qq: '123' } },
        { type: 'text', data: { text: ' Hi ' } },
        { type: 'face', data: { id: '14' } },
        { type: 'image', data: { file: 'test.jpg' } },
      ];
      expect(extractPlainText(segments)).toBe('Hi [表情14]');
    });
  });

  describe('wasBotMentioned', () => {
    const botQQ = '1001';

    it('should return true when bot is mentioned', () => {
      const segments: MessageSegment[] = [
        { type: 'at', data: { qq: '1001' } },
        { type: 'text', data: { text: 'Hello' } },
      ];
      expect(wasBotMentioned(segments, botQQ)).toBe(true);
    });

    it('should return false when bot is not mentioned', () => {
      const segments: MessageSegment[] = [
        { type: 'at', data: { qq: '2002' } },
        { type: 'text', data: { text: 'Hello' } },
      ];
      expect(wasBotMentioned(segments, botQQ)).toBe(false);
    });

    it('should return false with no at segments', () => {
      const segments: MessageSegment[] = [
        { type: 'text', data: { text: 'Hello' } },
      ];
      expect(wasBotMentioned(segments, botQQ)).toBe(false);
    });

    it('should return true with multiple mentions including bot', () => {
      const segments: MessageSegment[] = [
        { type: 'at', data: { qq: '2002' } },
        { type: 'at', data: { qq: '1001' } },
        { type: 'text', data: { text: 'Hello' } },
      ];
      expect(wasBotMentioned(segments, botQQ)).toBe(true);
    });

    it('should handle empty segments', () => {
      expect(wasBotMentioned([], botQQ)).toBe(false);
    });
  });

  describe('stripBotMention', () => {
    const botQQ = '1001';

    it('should strip CQ-style mention', () => {
      const text = '[CQ:at,qq=1001] Hello world';
      expect(stripBotMention(text, botQQ)).toBe('Hello world');
    });

    it('should strip multiple CQ mentions', () => {
      const text = '[CQ:at,qq=1001] [CQ:at,qq=1001] Hi';
      expect(stripBotMention(text, botQQ)).toBe('Hi');
    });

    it('should strip @nickname patterns', () => {
      const text = '@BotName Hello';
      expect(stripBotMention(text, botQQ)).toBe('Hello');
    });

    it('should handle text without mentions', () => {
      const text = 'Hello world';
      expect(stripBotMention(text, botQQ)).toBe('Hello world');
    });

    it('should strip both CQ and @ mentions', () => {
      const text = '[CQ:at,qq=1001]@BotName Hello';
      expect(stripBotMention(text, botQQ)).toBe('Hello');
    });

    it('should trim the result', () => {
      const text = '[CQ:at,qq=1001]   Hello  ';
      expect(stripBotMention(text, botQQ)).toBe('Hello');
    });
  });

  describe('buildTextSegments', () => {
    it('should return single text segment for plain text', () => {
      const result = buildTextSegments('Hello world');
      expect(result).toEqual([
        { type: 'text', data: { text: 'Hello world' } },
      ]);
    });

    it('should parse [表情XXX] into face segment', () => {
      const result = buildTextSegments('Hi [表情76] there');
      expect(result).toEqual([
        { type: 'text', data: { text: 'Hi ' } },
        { type: 'face', data: { id: '76' } },
        { type: 'text', data: { text: ' there' } },
      ]);
    });

    it('should parse [face:XXX] into face segment', () => {
      const result = buildTextSegments('Hi [face:14] there');
      expect(result).toEqual([
        { type: 'text', data: { text: 'Hi ' } },
        { type: 'face', data: { id: '14' } },
        { type: 'text', data: { text: ' there' } },
      ]);
    });

    it('should handle multiple face markers', () => {
      const result = buildTextSegments('[表情1] test [表情2]');
      expect(result).toEqual([
        { type: 'face', data: { id: '1' } },
        { type: 'text', data: { text: ' test ' } },
        { type: 'face', data: { id: '2' } },
      ]);
    });

    it('should handle face at start', () => {
      const result = buildTextSegments('[表情76] Hello');
      expect(result).toEqual([
        { type: 'face', data: { id: '76' } },
        { type: 'text', data: { text: ' Hello' } },
      ]);
    });

    it('should handle face at end', () => {
      const result = buildTextSegments('Hello [表情76]');
      expect(result).toEqual([
        { type: 'text', data: { text: 'Hello ' } },
        { type: 'face', data: { id: '76' } },
      ]);
    });

    it('should handle consecutive faces', () => {
      const result = buildTextSegments('[表情1][表情2][表情3]');
      expect(result).toEqual([
        { type: 'face', data: { id: '1' } },
        { type: 'face', data: { id: '2' } },
        { type: 'face', data: { id: '3' } },
      ]);
    });

    it('should handle empty string', () => {
      const result = buildTextSegments('');
      expect(result).toEqual([{ type: 'text', data: { text: '' } }]);
    });

    it('should preserve text without face markers', () => {
      const result = buildTextSegments('No faces here [just brackets]');
      expect(result).toEqual([
        { type: 'text', data: { text: 'No faces here [just brackets]' } },
      ]);
    });

    it('should handle mixed face formats', () => {
      const result = buildTextSegments('[表情1] and [face:2]');
      expect(result).toEqual([
        { type: 'face', data: { id: '1' } },
        { type: 'text', data: { text: ' and ' } },
        { type: 'face', data: { id: '2' } },
      ]);
    });
  });

  describe('extractImageUrls', () => {
    it('should extract URL from image segment', () => {
      const segments: MessageSegment[] = [
        { type: 'image', data: { url: 'https://example.com/image.jpg' } },
      ];
      expect(extractImageUrls(segments)).toEqual(['https://example.com/image.jpg']);
    });

    it('should extract file from image segment', () => {
      const segments: MessageSegment[] = [
        { type: 'image', data: { file: 'https://example.com/image.jpg' } },
      ];
      expect(extractImageUrls(segments)).toEqual(['https://example.com/image.jpg']);
    });

    it('should prefer url over file', () => {
      const segments: MessageSegment[] = [
        { type: 'image', data: { url: 'https://example.com/url.jpg', file: 'https://example.com/file.jpg' } },
      ];
      expect(extractImageUrls(segments)).toEqual(['https://example.com/url.jpg']);
    });

    it('should extract multiple images', () => {
      const segments: MessageSegment[] = [
        { type: 'image', data: { url: 'https://example.com/1.jpg' } },
        { type: 'text', data: { text: 'Text' } },
        { type: 'image', data: { url: 'https://example.com/2.jpg' } },
      ];
      expect(extractImageUrls(segments)).toEqual([
        'https://example.com/1.jpg',
        'https://example.com/2.jpg',
      ]);
    });

    it('should return empty array when no images', () => {
      const segments: MessageSegment[] = [
        { type: 'text', data: { text: 'Hello' } },
      ];
      expect(extractImageUrls(segments)).toEqual([]);
    });

    it('should skip images without url or file', () => {
      const segments: MessageSegment[] = [
        { type: 'image', data: {} },
      ];
      expect(extractImageUrls(segments)).toEqual([]);
    });
  });

  describe('buildImageSegment', () => {
    it('should handle base64:// prefix', () => {
      const result = buildImageSegment('base64://abc123');
      expect(result).toEqual({ type: 'image', data: { file: 'base64://abc123' } });
    });

    it('should handle http:// URL', () => {
      const result = buildImageSegment('http://example.com/image.jpg');
      expect(result).toEqual({ type: 'image', data: { file: 'http://example.com/image.jpg' } });
    });

    it('should handle https:// URL', () => {
      const result = buildImageSegment('https://example.com/image.jpg');
      expect(result).toEqual({ type: 'image', data: { file: 'https://example.com/image.jpg' } });
    });

    it('should handle file:// URI', () => {
      const result = buildImageSegment('file:///path/to/image.jpg');
      expect(result).toEqual({ type: 'image', data: { file: 'file:///path/to/image.jpg' } });
    });

    it('should convert local file to base64', () => {
      const tempFile = join(tmpdir(), `test-image-${Date.now()}.jpg`);
      writeFileSync(tempFile, Buffer.from('fake image data'));
      try {
        const result = buildImageSegment(tempFile);
        expect(result.type).toBe('image');
        expect(result.data.file).toMatch(/^base64:\/\//);
      } finally {
        if (existsSync(tempFile)) unlinkSync(tempFile);
      }
    });

    it('should pass through unknown format', () => {
      const result = buildImageSegment('unknown://format');
      expect(result).toEqual({ type: 'image', data: { file: 'unknown://format' } });
    });
  });

  describe('buildFileSegment', () => {
    it('should handle URL without filename', () => {
      const result = buildFileSegment('https://example.com/path/document.pdf');
      expect(result).toEqual({
        type: 'file',
        data: { file: 'https://example.com/path/document.pdf', name: 'document.pdf' },
      });
    });

    it('should use provided filename', () => {
      const result = buildFileSegment('https://example.com/file', 'custom.pdf');
      expect(result).toEqual({
        type: 'file',
        data: { file: 'https://example.com/file', name: 'custom.pdf' },
      });
    });

    it('should convert local file to base64', () => {
      const tempFile = join(tmpdir(), `test-file-${Date.now()}.pdf`);
      writeFileSync(tempFile, Buffer.from('fake pdf data'));
      try {
        const result = buildFileSegment(tempFile);
        expect(result.type).toBe('file');
        expect(result.data.file).toMatch(/^base64:\/\//);
        expect(result.data.name).toMatch(/\.pdf$/);
      } finally {
        if (existsSync(tempFile)) unlinkSync(tempFile);
      }
    });

    it('should use custom filename for local file', () => {
      const tempFile = join(tmpdir(), `test-file-${Date.now()}.txt`);
      writeFileSync(tempFile, Buffer.from('test data'));
      try {
        const result = buildFileSegment(tempFile, 'custom.txt');
        expect(result.type).toBe('file');
        expect(result.data.file).toMatch(/^base64:\/\//);
        expect(result.data.name).toBe('custom.txt');
      } finally {
        if (existsSync(tempFile)) unlinkSync(tempFile);
      }
    });
  });

  describe('buildMediaSegment', () => {
    it('should build image segment for .jpg', () => {
      const result = buildMediaSegment('https://example.com/image.jpg');
      expect(result.type).toBe('image');
    });

    it('should build image segment for .png', () => {
      const result = buildMediaSegment('https://example.com/image.png');
      expect(result.type).toBe('image');
    });

    it('should build image segment for .gif', () => {
      const result = buildMediaSegment('https://example.com/image.gif');
      expect(result.type).toBe('image');
    });

    it('should build file segment for .pdf', () => {
      const result = buildMediaSegment('https://example.com/document.pdf');
      expect(result.type).toBe('file');
    });

    it('should build file segment for .doc', () => {
      const result = buildMediaSegment('https://example.com/document.doc');
      expect(result.type).toBe('file');
    });

    it('should be case-insensitive for extensions', () => {
      expect(buildMediaSegment('https://example.com/image.JPG').type).toBe('image');
      expect(buildMediaSegment('https://example.com/image.PNG').type).toBe('image');
    });

    it('should use provided filename extension', () => {
      expect(buildMediaSegment('https://example.com/file', 'test.jpg').type).toBe('image');
      expect(buildMediaSegment('https://example.com/file', 'test.pdf').type).toBe('file');
    });
  });

  describe('buildTarget', () => {
    it('should build group target', () => {
      expect(buildTarget('group', undefined, 123456)).toEqual({
        type: 'group',
        groupId: 123456,
      });
    });

    it('should build private target with userId', () => {
      expect(buildTarget('private', 789012, undefined)).toEqual({
        type: 'private',
        userId: 789012,
      });
    });

    it('should build private target without userId (defaults to 0)', () => {
      expect(buildTarget('private', undefined, undefined)).toEqual({
        type: 'private',
        userId: 0,
      });
    });

    it('should prioritize group type when groupId is provided', () => {
      expect(buildTarget('group', 789012, 123456)).toEqual({
        type: 'group',
        groupId: 123456,
      });
    });

    it('should fallback to private when group type but no groupId', () => {
      expect(buildTarget('group', 789012, undefined)).toEqual({
        type: 'private',
        userId: 789012,
      });
    });
  });
});
