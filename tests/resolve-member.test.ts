import { describe, it, expect, vi, beforeEach } from 'vitest';
import { matchMember, type GroupMember } from '../src/resolve-member.js';

// ── Test data ────────────────────────────────────────────────────

const members: GroupMember[] = [
  { user_id: 100000002, nickname: 'MockUserANick', card: 'MockUserA' },
  { user_id: 100000004, nickname: 'MockUserC', card: '干干' },
  { user_id: 100000001, nickname: 'Ricky', card: 'RickyLi' },
  { user_id: 100200300, nickname: 'TestUser', card: '' },
  { user_id: 200300400, nickname: 'Alice', card: 'ALICE_CARD' },
];

describe('resolve-member matchMember', () => {
  // ── Exact match ──────────────────────────────────────────────

  it('should exact match card', () => {
    const result = matchMember(members, 'MockUserA');
    expect(result).toEqual({
      found: true,
      qq: '100000002',
      card: 'MockUserA',
      nickname: 'MockUserANick',
      match_type: 'card',
    });
  });

  it('should exact match nickname when card does not match', () => {
    const result = matchMember(members, 'TestUser');
    expect(result).toEqual({
      found: true,
      qq: '100200300',
      card: '',
      nickname: 'TestUser',
      match_type: 'nickname',
    });
  });

  it('should prefer card match over nickname match', () => {
    // '干干' is a card, not a nickname — should match card first
    const result = matchMember(members, '干干');
    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.qq).toBe('100000004');
      expect(result.match_type).toBe('card');
    }
  });

  it('should exact match nickname (Ricky)', () => {
    const result = matchMember(members, 'Ricky');
    expect(result).toEqual({
      found: true,
      qq: '100000001',
      card: 'RickyLi',
      nickname: 'Ricky',
      match_type: 'nickname',
    });
  });

  // ── Case-insensitive match ───────────────────────────────────

  it('should case-insensitive match card', () => {
    const result = matchMember(members, 'rickyli');
    expect(result).toEqual({
      found: true,
      qq: '100000001',
      card: 'RickyLi',
      nickname: 'Ricky',
      match_type: 'card_ci',
    });
  });

  it('should case-insensitive match nickname', () => {
    const result = matchMember(members, 'ricky');
    expect(result).toEqual({
      found: true,
      qq: '100000001',
      card: 'RickyLi',
      nickname: 'Ricky',
      match_type: 'nickname_ci',
    });
  });

  it('should case-insensitive match card (ALICE_CARD → alice_card)', () => {
    const result = matchMember(members, 'alice_card');
    expect(result).toEqual({
      found: true,
      qq: '200300400',
      card: 'ALICE_CARD',
      nickname: 'Alice',
      match_type: 'card_ci',
    });
  });

  // ── Prefix match ─────────────────────────────────────────────

  it('should return candidates for prefix match (card)', () => {
    const result = matchMember(members, 'Ric');
    expect(result.found).toBe(false);
    if (!result.found) {
      expect(result.candidates.length).toBeGreaterThan(0);
      expect(result.candidates.some(c => c.qq === '100000001')).toBe(true);
      expect(result.message).toBe('未精确匹配，以下是相似成员');
    }
  });

  it('should return candidates for prefix match (nickname)', () => {
    const result = matchMember(members, 'Test');
    expect(result.found).toBe(false);
    if (!result.found) {
      expect(result.candidates.length).toBeGreaterThan(0);
      expect(result.candidates.some(c => c.qq === '100200300')).toBe(true);
    }
  });

  it('should not do prefix match for single character names', () => {
    // Single character — prefix match requires length >= 2
    const result = matchMember(members, 'R');
    // Should fall through to contains match
    expect(result.found).toBe(false);
    if (!result.found) {
      // Contains match should still find RickyLi / Ricky
      expect(result.candidates.some(c => c.qq === '100000001')).toBe(true);
    }
  });

  // ── Contains match ───────────────────────────────────────────

  it('should return candidates for contains match', () => {
    const result = matchMember(members, '永恒');
    expect(result.found).toBe(false);
    if (!result.found) {
      expect(result.candidates.length).toBeGreaterThan(0);
      expect(result.candidates.some(c => c.qq === '100000004')).toBe(true);
      expect(result.message).toBe('未精确匹配，以下是相似成员');
    }
  });

  it('should limit candidates to 5', () => {
    // Create a large member list where many match
    const manyMembers: GroupMember[] = Array.from({ length: 10 }, (_, i) => ({
      user_id: 10000 + i,
      nickname: `UserTest${i}`,
      card: `TestCard${i}`,
    }));
    const result = matchMember(manyMembers, 'Test');
    expect(result.found).toBe(false);
    if (!result.found) {
      expect(result.candidates.length).toBeLessThanOrEqual(5);
    }
  });

  // ── No match ─────────────────────────────────────────────────

  it('should return empty candidates when no match at all', () => {
    const result = matchMember(members, '完全不存在的人');
    expect(result).toEqual({
      found: false,
      candidates: [],
      message: '群内没有匹配的成员',
    });
  });

  it('should return empty candidates for random string', () => {
    const result = matchMember(members, 'xyzzy999');
    expect(result).toEqual({
      found: false,
      candidates: [],
      message: '群内没有匹配的成员',
    });
  });

  // ── Edge cases ───────────────────────────────────────────────

  it('should handle empty member list', () => {
    const result = matchMember([], 'MockUserA');
    expect(result).toEqual({
      found: false,
      candidates: [],
      message: '群内没有匹配的成员',
    });
  });

  it('should handle members with empty card', () => {
    const result = matchMember(members, 'TestUser');
    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.card).toBe('');
      expect(result.match_type).toBe('nickname');
    }
  });

  it('should match card before nickname when both could match', () => {
    // '干干' matches card of member 100000004
    // It's also a prefix of card 'MockUserA' but exact card match wins
    const result = matchMember(members, '干干');
    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.qq).toBe('100000004');
      expect(result.match_type).toBe('card');
    }
  });
});
