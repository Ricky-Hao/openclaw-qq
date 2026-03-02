// OneBot v11 message segment parsing and building

import { readFileSync, existsSync } from "node:fs";
import { basename, extname } from "node:path";
import type { MessageSegment, MessageTarget } from "./types.js";

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".svg"]);

/**
 * Extract plain text from an array of message segments,
 * skipping `at` segments (they are handled separately for mention detection).
 */
export function extractPlainText(segments: MessageSegment[]): string {
  const parts: string[] = [];
  for (const seg of segments) {
    if (seg.type === "text") {
      parts.push(seg.data.text);
    } else if (seg.type === "face") {
      parts.push(`[表情${seg.data.id}]`);
    }
  }
  return parts.join("").trim();
}

/**
 * Check whether the bot was @-mentioned in the message segments.
 */
export function wasBotMentioned(
  segments: MessageSegment[],
  botQQ: string,
): boolean {
  return segments.some(
    (seg) => seg.type === "at" && seg.data.qq === botQQ,
  );
}

/**
 * Strip leading @bot mentions from the text, returning the cleaned body.
 */
export function stripBotMention(text: string, botQQ: string): string {
  // CQ-style: [CQ:at,qq=xxx]
  const cqPattern = new RegExp(
    `\\[CQ:at,qq=${escapeRegExp(botQQ)}\\]\\s*`,
    "g",
  );
  let result = text.replace(cqPattern, "");

  // Also strip @nickname patterns that NapCat sometimes inserts
  result = result.replace(/^@\S+\s*/, "");
  return result.trim();
}

/**
 * Extract all image URLs from message segments.
 */
export function extractImageUrls(segments: MessageSegment[]): string[] {
  const urls: string[] = [];
  for (const seg of segments) {
    if (seg.type === "image") {
      const url = seg.data.url || seg.data.file;
      if (url) urls.push(url);
    }
  }
  return urls;
}

/**
 * Build message segments from text, parsing embedded QQ face markers.
 *
 * Recognizes:
 *   - [表情XXX]  → face segment with id=XXX
 *   - [face:XXX] → face segment with id=XXX
 *   - Everything else → text segment
 *
 * This allows bots to include QQ native emoji in their replies.
 */
export function buildTextSegments(text: string): MessageSegment[] {
  // Match [表情123] or [face:123]
  const FACE_RE = /\[(?:表情|face:)(\d+)\]/g;

  const segments: MessageSegment[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = FACE_RE.exec(text)) !== null) {
    // Push any text before this match
    if (match.index > lastIndex) {
      segments.push({ type: "text", data: { text: text.slice(lastIndex, match.index) } });
    }
    // Push face segment
    segments.push({ type: "face", data: { id: match[1] } });
    lastIndex = FACE_RE.lastIndex;
  }

  // Push remaining text
  if (lastIndex < text.length) {
    segments.push({ type: "text", data: { text: text.slice(lastIndex) } });
  }

  // If no faces found, return simple text segment
  if (segments.length === 0) {
    return [{ type: "text", data: { text } }];
  }

  return segments;
}

/**
 * Build an image message segment.
 */
export function buildImageSegment(urlOrBase64: string): MessageSegment {
  // Already base64
  if (urlOrBase64.startsWith("base64://")) {
    return { type: "image", data: { file: urlOrBase64 } };
  }
  // HTTP(S) URL — pass directly
  if (urlOrBase64.startsWith("http://") || urlOrBase64.startsWith("https://")) {
    return { type: "image", data: { file: urlOrBase64 } };
  }
  // file:// URI
  if (urlOrBase64.startsWith("file://")) {
    return { type: "image", data: { file: urlOrBase64 } };
  }
  // Local file path — convert to base64
  if (existsSync(urlOrBase64)) {
    const buf = readFileSync(urlOrBase64);
    return { type: "image", data: { file: `base64://${buf.toString("base64")}` } };
  }
  // Fallback: pass as-is (might be a URL or other format)
  return { type: "image", data: { file: urlOrBase64 } };
}

/**
 * Build a file message segment (for non-image files: PDF, docs, etc.).
 */
export function buildFileSegment(pathOrUrl: string, filename?: string): MessageSegment {
  const name = filename || basename(pathOrUrl);

  // Local file path — convert to base64
  if (existsSync(pathOrUrl)) {
    const buf = readFileSync(pathOrUrl);
    return { type: "file", data: { file: `base64://${buf.toString("base64")}`, name } };
  }
  // URL or other — pass directly
  return { type: "file", data: { file: pathOrUrl, name } };
}

/**
 * Build the appropriate media segment based on file type.
 * Images → image segment, everything else → file segment.
 */
export function buildMediaSegment(pathOrUrl: string, filename?: string): MessageSegment {
  const ext = extname(filename || pathOrUrl).toLowerCase();
  if (IMAGE_EXTS.has(ext)) {
    return buildImageSegment(pathOrUrl);
  }
  return buildFileSegment(pathOrUrl, filename);
}

/**
 * Build a target object for sending messages.
 */
export function buildTarget(
  chatType: "private" | "group",
  userId?: number,
  groupId?: number,
): MessageTarget {
  if (chatType === "group" && groupId != null) {
    return { type: "group", groupId };
  }
  return { type: "private", userId: userId ?? 0 };
}

// ── Helpers ──────────────────────────────────────────────────────────

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
