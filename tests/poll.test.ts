import { describe, it, expect } from 'vitest';
import { pickRandomEmoji, parseDuration, resolveTarget, makeBar } from '../src/poll.js';

describe('poll.ts', () => {
  describe('pickRandomEmoji', () => {
    it('should return the requested number of emoji', () => {
      const result = pickRandomEmoji(3);
      expect(result).toHaveLength(3);
    });

    it('should return unique emoji', () => {
      const result = pickRandomEmoji(5);
      const emojiIds = result.map(e => e.emojiId);
      const uniqueIds = new Set(emojiIds);
      expect(uniqueIds.size).toBe(5);
    });

    it('should return emoji with both emoji and emojiId', () => {
      const result = pickRandomEmoji(2);
      expect(result[0]).toHaveProperty('emoji');
      expect(result[0]).toHaveProperty('emojiId');
      expect(result[1]).toHaveProperty('emoji');
      expect(result[1]).toHaveProperty('emojiId');
    });

    it('should handle count of 0', () => {
      const result = pickRandomEmoji(0);
      expect(result).toHaveLength(0);
    });

    it('should handle count of 1', () => {
      const result = pickRandomEmoji(1);
      expect(result).toHaveLength(1);
    });

    it('should not exceed pool size', () => {
      const result = pickRandomEmoji(100);
      // Pool has 14 items based on VERIFIED_EMOJI_POOL
      expect(result.length).toBeLessThanOrEqual(14);
    });

    it('should return valid emojiId strings', () => {
      const result = pickRandomEmoji(3);
      result.forEach(item => {
        expect(item.emojiId).toBeTruthy();
        expect(typeof item.emojiId).toBe('string');
        expect(item.emojiId.length).toBeGreaterThan(0);
      });
    });
  });

  describe('parseDuration', () => {
    it('should parse minutes correctly', () => {
      expect(parseDuration('10m')).toBe(10 * 60 * 1000);
      expect(parseDuration('30m')).toBe(30 * 60 * 1000);
      expect(parseDuration('5min')).toBe(5 * 60 * 1000);
      expect(parseDuration('15mins')).toBe(15 * 60 * 1000);
    });

    it('should parse hours correctly', () => {
      expect(parseDuration('1h')).toBe(1 * 60 * 60 * 1000);
      expect(parseDuration('2h')).toBe(2 * 60 * 60 * 1000);
      expect(parseDuration('1hr')).toBe(1 * 60 * 60 * 1000);
      expect(parseDuration('3hour')).toBe(3 * 60 * 60 * 1000);
      expect(parseDuration('2hours')).toBe(2 * 60 * 60 * 1000);
    });

    it('should be case-insensitive', () => {
      expect(parseDuration('10M')).toBe(10 * 60 * 1000);
      expect(parseDuration('1H')).toBe(1 * 60 * 60 * 1000);
      expect(parseDuration('30MIN')).toBe(30 * 60 * 1000);
      expect(parseDuration('2HR')).toBe(2 * 60 * 60 * 1000);
    });

    it('should handle whitespace', () => {
      expect(parseDuration('10 m')).toBe(10 * 60 * 1000);
      expect(parseDuration('1 h')).toBe(1 * 60 * 60 * 1000);
      expect(parseDuration('30 min')).toBe(30 * 60 * 1000);
    });

    it('should return null for invalid formats', () => {
      expect(parseDuration('invalid')).toBeNull();
      expect(parseDuration('10')).toBeNull();
      expect(parseDuration('m')).toBeNull();
      expect(parseDuration('10x')).toBeNull();
      expect(parseDuration('')).toBeNull();
    });

    it('should return null for negative values', () => {
      // The regex doesn't match negative numbers, so these should return null
      expect(parseDuration('-10m')).toBeNull();
      expect(parseDuration('-1h')).toBeNull();
    });

    it('should handle zero correctly', () => {
      expect(parseDuration('0m')).toBe(0);
      expect(parseDuration('0h')).toBe(0);
    });

    it('should handle large values', () => {
      expect(parseDuration('999m')).toBe(999 * 60 * 1000);
      expect(parseDuration('24h')).toBe(24 * 60 * 60 * 1000);
    });
  });

  describe('resolveTarget', () => {
    it('should parse qq:group:XXX format', () => {
      const result = resolveTarget('qq:group:111222333');
      expect(result).toEqual({ type: 'group', id: '111222333' });
    });

    it('should parse qq:private:XXX format', () => {
      const result = resolveTarget('qq:private:123456');
      expect(result).toEqual({ type: 'private', id: '123456' });
    });

    it('should parse group:XXX format (without qq: prefix)', () => {
      const result = resolveTarget('group:111222333');
      expect(result).toEqual({ type: 'group', id: '111222333' });
    });

    it('should parse private:XXX format (without qq: prefix)', () => {
      const result = resolveTarget('private:123456');
      expect(result).toEqual({ type: 'private', id: '123456' });
    });

    it('should parse bare numeric ID as group', () => {
      const result = resolveTarget('111222333');
      expect(result).toEqual({ type: 'group', id: '111222333' });
    });

    it('should parse qq:XXX format as group', () => {
      const result = resolveTarget('qq:111222333');
      expect(result).toEqual({ type: 'group', id: '111222333' });
    });

    it('should return null for invalid formats', () => {
      expect(resolveTarget('invalid')).toBeNull();
      expect(resolveTarget('abc123')).toBeNull();
      expect(resolveTarget('')).toBeNull();
      expect(resolveTarget('qq:group:')).toBeNull();
    });

    it('should handle long group IDs', () => {
      const result = resolveTarget('qq:group:123456789012345');
      expect(result).toEqual({ type: 'group', id: '123456789012345' });
    });

    it('should not accept non-numeric IDs', () => {
      expect(resolveTarget('qq:group:abc')).toBeNull();
      expect(resolveTarget('group:xyz')).toBeNull();
    });
  });

  describe('makeBar', () => {
    it('should return full bar when count equals maxCount', () => {
      const bar = makeBar(10, 10, 10);
      expect(bar).toBe('██████████');
    });

    it('should return empty bar when count is 0', () => {
      const bar = makeBar(0, 10, 10);
      expect(bar).toBe('░░░░░░░░░░');
    });

    it('should return empty string when maxCount is 0', () => {
      expect(makeBar(0, 0)).toBe('');
      expect(makeBar(5, 0)).toBe('');
    });

    it('should return half-filled bar', () => {
      const bar = makeBar(5, 10, 10);
      expect(bar).toBe('█████░░░░░');
    });

    it('should use default width of 10', () => {
      const bar = makeBar(10, 10);
      expect(bar.length).toBe(10);
      expect(bar).toBe('██████████');
    });

    it('should handle custom width', () => {
      const bar = makeBar(2, 4, 8);
      expect(bar.length).toBe(8);
      expect(bar).toBe('████░░░░');
    });

    it('should handle count of 1 out of large maxCount', () => {
      const bar = makeBar(1, 100, 10);
      // 1/100 * 10 = 0.1, rounds to 0
      expect(bar).toBe('░░░░░░░░░░');
    });
  });
});
