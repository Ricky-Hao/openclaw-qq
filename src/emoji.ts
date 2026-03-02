/**
 * QQ Emoji ID mapping for message reactions (set_msg_emoji_like).
 *
 * QQ's set_msg_emoji_like supports TWO types of emoji_id:
 *   - emojiType 1: QQ face ID (length ≤ 3), e.g. "76" = /赞, "77" = /踩
 *   - emojiType 2: Unicode codepoint as decimal (length > 3), e.g. "128077" = 👍
 *
 * NapCat auto-detects: emoji_id.length > 3 → type 2, else type 1.
 *
 * Not ALL emoji work as reactions — only those the QQ client supports.
 * This module provides a curated mapping from:
 *   - Unicode emoji (👍) → emoji_id
 *   - Text shortcodes (thumbsup, 赞) → emoji_id
 *   - QQ face descriptions (/赞, /踩) → emoji_id
 */

export type QQEmojiEntry = {
  emoji?: string;       // Unicode emoji character (if applicable)
  id: string;           // emoji_id for set_msg_emoji_like
  type: 1 | 2;          // 1 = QQ face, 2 = Unicode emoji
  names: string[];       // lookup aliases (shortcodes, Chinese names)
  qqDesc?: string;       // QQ face description like /赞
};

/**
 * Curated list of emoji reactions confirmed/likely to work with QQ.
 *
 * Type 2 (Unicode): verified working via testing
 * Type 1 (QQ face): common QQ faces that should work as reactions
 */
export const QQ_EMOJI_REACTIONS: QQEmojiEntry[] = [
  // ════════════════════════════════════════════════════════════════
  // Type 2: Unicode emoji (codepoint as decimal, length > 3)
  // ════════════════════════════════════════════════════════════════
  { emoji: "👍", id: "128077", type: 2, names: ["thumbsup", "like", "+1", "赞2"] },
  { emoji: "👎", id: "128078", type: 2, names: ["thumbsdown", "-1"] },
  { emoji: "❤️", id: "10084",  type: 2, names: ["heart", "love", "红心"] },
  { emoji: "🔥", id: "128293", type: 2, names: ["fire", "hot", "火"] },
  { emoji: "✨", id: "10024",  type: 2, names: ["sparkles", "stars", "闪光"] },
  { emoji: "🎉", id: "127881", type: 2, names: ["tada", "party", "庆祝2"] },
  { emoji: "😂", id: "128514", type: 2, names: ["joy", "laugh"] },
  { emoji: "😮", id: "128558", type: 2, names: ["surprised", "wow"] },
  { emoji: "😢", id: "128546", type: 2, names: ["cry", "sad"] },
  { emoji: "🙏", id: "128591", type: 2, names: ["pray", "thanks", "祈祷2"] },
  { emoji: "💯", id: "128175", type: 2, names: ["100", "perfect", "满分"] },
  { emoji: "🤔", id: "129300", type: 2, names: ["thinking", "hmm"] },
  { emoji: "😊", id: "128522", type: 2, names: ["blush", "smile"] },
  { emoji: "🥰", id: "129392", type: 2, names: ["smiling_face_with_hearts"] },
  { emoji: "😭", id: "128557", type: 2, names: ["sob", "crying"] },
  { emoji: "😍", id: "128525", type: 2, names: ["heart_eyes"] },
  { emoji: "🤣", id: "129315", type: 2, names: ["rofl"] },
  { emoji: "😘", id: "128536", type: 2, names: ["kissing_heart", "kiss"] },
  { emoji: "🐾", id: "128062", type: 2, names: ["paw", "paw_prints", "爪印"] },
  { emoji: "👀", id: "128064", type: 2, names: ["eyes", "look"] },
  { emoji: "🤝", id: "129309", type: 2, names: ["handshake"] },
  { emoji: "💪", id: "128170", type: 2, names: ["muscle", "strong", "加油2"] },
  { emoji: "👏", id: "128079", type: 2, names: ["clap", "applause"] },
  { emoji: "🫡", id: "129761", type: 2, names: ["salute"] },
  { emoji: "🍻", id: "127867", type: 2, names: ["beers", "cheers", "干杯2"] },
  { emoji: "☕", id: "9749",   type: 2, names: ["coffee"] },
  { emoji: "🌹", id: "127801", type: 2, names: ["rose", "玫瑰2"] },
  { emoji: "🎂", id: "127874", type: 2, names: ["birthday", "cake"] },
  { emoji: "💐", id: "128144", type: 2, names: ["bouquet"] },
  { emoji: "🤡", id: "129313", type: 2, names: ["clown", "小丑"] },
  { emoji: "😈", id: "128520", type: 2, names: ["imp", "devil"] },
  { emoji: "💔", id: "128148", type: 2, names: ["broken_heart"] },
  { emoji: "🥳", id: "129395", type: 2, names: ["partying_face"] },
  { emoji: "🫠", id: "129760", type: 2, names: ["melting_face"] },

  // ════════════════════════════════════════════════════════════════
  // Type 1: QQ native face reactions (QSid, length ≤ 3)
  // ════════════════════════════════════════════════════════════════
  { id: "76",  type: 1, qqDesc: "/赞",      names: ["zan", "赞", "qq赞", "qq:赞"] },
  { id: "77",  type: 1, qqDesc: "/踩",      names: ["cai", "踩", "qq踩", "qq:踩"] },
  { id: "78",  type: 1, qqDesc: "/握手",    names: ["woshou", "握手", "qq握手", "qq:握手"] },
  { id: "79",  type: 1, qqDesc: "/胜利",    names: ["shengli", "胜利", "qq胜利", "qq:胜利"] },
  { id: "13",  type: 1, qqDesc: "/呲牙",    names: ["ziya", "呲牙", "qq呲牙", "qq:呲牙"] },
  { id: "14",  type: 1, qqDesc: "/微笑",    names: ["weixiao", "微笑", "qq微笑", "qq:微笑"] },
  { id: "4",   type: 1, qqDesc: "/得意",    names: ["deyi", "得意", "qq得意", "qq:得意"] },
  { id: "12",  type: 1, qqDesc: "/调皮",    names: ["tiaopi", "调皮", "qq调皮", "qq:调皮"] },
  { id: "6",   type: 1, qqDesc: "/害羞",    names: ["haixiu", "害羞", "qq害羞", "qq:害羞"] },
  { id: "21",  type: 1, qqDesc: "/可爱",    names: ["keai", "可爱", "qq可爱", "qq:可爱"] },
  { id: "9",   type: 1, qqDesc: "/大哭",    names: ["daku", "大哭", "qq大哭", "qq:大哭"] },
  { id: "5",   type: 1, qqDesc: "/流泪",    names: ["liulei", "流泪", "qq流泪", "qq:流泪"] },
  { id: "11",  type: 1, qqDesc: "/发怒",    names: ["fanu", "发怒", "qq发怒", "qq:发怒"] },
  { id: "33",  type: 1, qqDesc: "/嘘",      names: ["xu", "嘘", "qq嘘", "qq:嘘"] },
  { id: "99",  type: 1, qqDesc: "/鼓掌",    names: ["guzhang", "鼓掌", "qq鼓掌", "qq:鼓掌"] },
  { id: "66",  type: 1, qqDesc: "/爱心",    names: ["aixin", "爱心", "qq爱心", "qq:爱心"] },
  { id: "67",  type: 1, qqDesc: "/心碎",    names: ["xinsui", "心碎", "qq心碎", "qq:心碎"] },
  { id: "63",  type: 1, qqDesc: "/玫瑰",    names: ["meigui", "玫瑰", "qq玫瑰", "qq:玫瑰"] },
  { id: "53",  type: 1, qqDesc: "/蛋糕",    names: ["dangao", "蛋糕", "qq蛋糕", "qq:蛋糕"] },
  { id: "201", type: 1, qqDesc: "/点赞",    names: ["dianzan", "点赞", "qq点赞", "qq:点赞"] },
  { id: "282", type: 1, qqDesc: "/敬礼",    names: ["jingli", "敬礼", "qq敬礼", "qq:敬礼"] },
  { id: "179", type: 1, qqDesc: "/doge",    names: ["doge", "qq:doge"] },
  { id: "307", type: 1, qqDesc: "/喵喵",    names: ["miaomiao", "喵喵", "qq喵喵", "qq:喵喵"] },
  { id: "281", type: 1, qqDesc: "/无眼笑",  names: ["wuyanxiao", "无眼笑", "qq无眼笑", "qq:无眼笑"] },
  { id: "277", type: 1, qqDesc: "/汪汪",    names: ["wangwang", "汪汪", "qq汪汪", "qq:汪汪"] },
  { id: "178", type: 1, qqDesc: "/斜眼笑",  names: ["xieyanxiao", "斜眼笑", "qq斜眼笑", "qq:斜眼笑"] },
  { id: "182", type: 1, qqDesc: "/笑哭",    names: ["xiaoku", "笑哭", "qq笑哭", "qq:笑哭"] },
  { id: "124", type: 1, qqDesc: "/OK",      names: ["ok", "qq:ok", "qqok"] },
  { id: "318", type: 1, qqDesc: "/崇拜",    names: ["chongbai", "崇拜", "qq崇拜", "qq:崇拜"] },
  { id: "319", type: 1, qqDesc: "/比心",    names: ["bixin", "比心", "qq比心", "qq:比心"] },
  { id: "320", type: 1, qqDesc: "/庆祝",    names: ["qingzhu", "庆祝", "qq庆祝", "qq:庆祝"] },
  { id: "315", type: 1, qqDesc: "/加油",    names: ["jiayou", "加油", "qq加油", "qq:加油"] },
  { id: "311", type: 1, qqDesc: "/打call",  names: ["dacall", "打call", "qq打call", "qq:打call"] },
];

// ── Lookup maps ──────────────────────────────────────────────────

const byEmoji = new Map<string, string>();
const byName = new Map<string, string>();
const byQQDesc = new Map<string, string>();

for (const entry of QQ_EMOJI_REACTIONS) {
  if (entry.emoji) {
    byEmoji.set(entry.emoji, entry.id);
    // Also strip variation selector for matching (e.g. ❤️ → ❤)
    const base = entry.emoji.replace(/\uFE0F/g, "");
    if (base !== entry.emoji) byEmoji.set(base, entry.id);
  }

  if (entry.qqDesc) {
    byQQDesc.set(entry.qqDesc, entry.id);
    // Also without leading slash
    byQQDesc.set(entry.qqDesc.slice(1), entry.id);
  }

  for (const name of entry.names) {
    byName.set(name.toLowerCase(), entry.id);
  }
}

/**
 * Convert an emoji input to a QQ emoji_id for set_msg_emoji_like.
 *
 * Accepts:
 *   - Unicode emoji: "👍" → "128077"
 *   - English shortcode: "thumbsup" → "128077"
 *   - Chinese name: "赞" → "76" (QQ face)
 *   - QQ desc: "/赞" → "76"
 *   - QQ prefixed: "qq:赞" → "76"
 *   - Raw numeric ID: "128077" → "128077" (passthrough)
 *
 * Returns the emoji_id string, or undefined if unrecognized.
 */
export function emojiToQQEmojiId(input: string): string | undefined {
  const trimmed = input.trim();

  // Direct emoji character match
  if (byEmoji.has(trimmed)) return byEmoji.get(trimmed);

  // QQ face description match (/赞, /踩)
  if (byQQDesc.has(trimmed)) return byQQDesc.get(trimmed);

  // Shortcode/name match (strip colons if present)
  const name = trimmed.replace(/^:|:$/g, "").toLowerCase();
  if (byName.has(name)) return byName.get(name);

  // Raw numeric ID passthrough (if it looks like a valid emoji_id)
  if (/^\d+$/.test(trimmed) && parseInt(trimmed) > 0) {
    return trimmed;
  }

  // Try converting Unicode emoji to codepoint directly
  // This handles emoji not in our curated list — may or may not work on QQ
  if (trimmed.length >= 1 && trimmed.length <= 2) {
    const cp = trimmed.codePointAt(0);
    if (cp && cp > 127) {
      return String(cp);
    }
  }

  return undefined;
}

/**
 * Get a display-friendly list of supported emoji for error messages.
 */
export function getSupportedEmojiList(): string {
  const unicodeEmoji = QQ_EMOJI_REACTIONS
    .filter((e) => e.type === 2 && e.emoji)
    .map((e) => e.emoji)
    .join(" ");

  const qqFaces = QQ_EMOJI_REACTIONS
    .filter((e) => e.type === 1 && e.qqDesc)
    .map((e) => e.qqDesc)
    .join(" ");

  return `Unicode: ${unicodeEmoji}\nQQ表情: ${qqFaces}`;
}
