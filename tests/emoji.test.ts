import { describe, it, expect } from 'vitest';
import { emojiToQQEmojiId, getSupportedEmojiList } from '../src/emoji.js';

describe('emoji.ts', () => {
  describe('emojiToQQEmojiId', () => {
    it('should convert Unicode emoji to emoji ID', () => {
      expect(emojiToQQEmojiId('👍')).toBe('128077');
      expect(emojiToQQEmojiId('❤️')).toBe('10084');
      expect(emojiToQQEmojiId('🔥')).toBe('128293');
      expect(emojiToQQEmojiId('✨')).toBe('10024');
    });

    it('should handle emoji without variation selector', () => {
      expect(emojiToQQEmojiId('❤')).toBe('10084');
    });

    it('should convert English shortcodes to emoji ID', () => {
      expect(emojiToQQEmojiId('thumbsup')).toBe('128077');
      expect(emojiToQQEmojiId('like')).toBe('128077');
      expect(emojiToQQEmojiId('fire')).toBe('128293');
      expect(emojiToQQEmojiId('heart')).toBe('10084');
    });

    it('should handle shortcodes with colons', () => {
      expect(emojiToQQEmojiId(':thumbsup:')).toBe('128077');
      expect(emojiToQQEmojiId(':fire:')).toBe('128293');
    });

    it('should convert Chinese names to QQ face ID', () => {
      expect(emojiToQQEmojiId('赞')).toBe('76');
      expect(emojiToQQEmojiId('踩')).toBe('77');
      expect(emojiToQQEmojiId('爱心')).toBe('66');
    });

    it('should convert QQ face descriptions', () => {
      expect(emojiToQQEmojiId('/赞')).toBe('76');
      expect(emojiToQQEmojiId('/踩')).toBe('77');
      expect(emojiToQQEmojiId('/握手')).toBe('78');
      expect(emojiToQQEmojiId('握手')).toBe('78');
    });

    it('should handle QQ prefixed names', () => {
      expect(emojiToQQEmojiId('qq:赞')).toBe('76');
      expect(emojiToQQEmojiId('qq赞')).toBe('76');
    });

    it('should pass through raw numeric IDs', () => {
      expect(emojiToQQEmojiId('128077')).toBe('128077');
      expect(emojiToQQEmojiId('76')).toBe('76');
      expect(emojiToQQEmojiId('10084')).toBe('10084');
    });

    it('should be case-insensitive for shortcodes', () => {
      expect(emojiToQQEmojiId('THUMBSUP')).toBe('128077');
      expect(emojiToQQEmojiId('ThumbsUp')).toBe('128077');
      expect(emojiToQQEmojiId('FIRE')).toBe('128293');
    });

    it('should return undefined for unrecognized input', () => {
      expect(emojiToQQEmojiId('invalid')).toBeUndefined();
      expect(emojiToQQEmojiId('')).toBeUndefined();
      expect(emojiToQQEmojiId('🦄')).toBeDefined(); // Should convert via codepoint
    });

    it('should handle whitespace trimming', () => {
      expect(emojiToQQEmojiId('  👍  ')).toBe('128077');
      expect(emojiToQQEmojiId('  fire  ')).toBe('128293');
    });

    it('should convert unknown emoji via codepoint', () => {
      const result = emojiToQQEmojiId('🦄');
      expect(result).toBeDefined();
      expect(Number(result)).toBe(129412); // Unicorn codepoint
    });

    it('should reject zero or negative IDs', () => {
      expect(emojiToQQEmojiId('0')).toBeUndefined();
      // Note: '-1' maps to 👎 (128078) via the name alias "-1"
      expect(emojiToQQEmojiId('-1')).toBe('128078');
    });
  });

  describe('getSupportedEmojiList', () => {
    it('should return a formatted list of supported emoji', () => {
      const list = getSupportedEmojiList();
      
      expect(list).toContain('Unicode:');
      expect(list).toContain('QQ表情:');
      expect(list).toContain('👍');
      expect(list).toContain('🔥');
      expect(list).toContain('/赞');
      expect(list).toContain('/踩');
    });

    it('should include both type 1 and type 2 emoji', () => {
      const list = getSupportedEmojiList();
      
      // Type 2 (Unicode)
      expect(list).toMatch(/👍|❤️|🔥/);
      
      // Type 1 (QQ faces)
      expect(list).toMatch(/\/赞|\/踩|\/握手/);
    });

    it('should not be empty', () => {
      const list = getSupportedEmojiList();
      expect(list.length).toBeGreaterThan(0);
    });
  });
});
