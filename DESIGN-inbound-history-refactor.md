# Design Spec: openclaw-qq Group Context Refactor

## Problem

When a user @mentions the bot in a QQ group, the plugin currently:
1. Fetches the last N group messages via `get_group_msg_history`
2. Concatenates them into a single text string with `[以下是群聊中最近的N条消息]` / `[以上是历史消息]` delimiters
3. Prepends this string to the user's message in `BodyForAgent`
4. Collects **all** image URLs from history messages and merges them into `MediaPaths` alongside the current message's images

This causes two critical issues:
- **Image confusion**: The model receives N images as flat image blocks with no way to distinguish "user's current images" from "someone else's image from 10 minutes ago". This leads to misattribution (e.g., user says "看看猫" but model tries to analyze historical images instead of calling `photo_get`).
- **Lost structure**: The model sees a wall of text for history. Message boundaries, timestamps, and sender identity are all compressed into a single string.

## Solution

Adopt the same pattern used by Discord, Slack, and iMessage channels in openclaw core: use the **`InboundHistory`** context field.

## Core Mechanism (already exists, no core changes needed)

openclaw core supports `InboundHistory` on the inbound context object:

```typescript
InboundHistory: Array<{
  sender: string;      // display name
  body: string;        // text content (with media placeholders)
  timestamp: number;   // epoch ms
}>
```

Core renders this as a structured JSON block in the user message prefix:

```
Chat history since last reply (untrusted, for context):
```json
[
  { "sender": "张三", "timestamp_ms": 1772956800000, "body": "今天天气真好" },
  { "sender": "李四", "timestamp_ms": 1772956810000, "body": "看看这个 [图片x2]" },
  { "sender": "瑶瑶bot", "timestamp_ms": 1772956820000, "body": "收到啦～" }
]
```
```

The model sees this as clearly labeled untrusted context, separate from the user's actual message and media.

## Changes Required

### File: `src/gateway.ts`

#### 1. Build `InboundHistory` array instead of `groupContext` string

**Before** (lines ~299-340):
```typescript
let groupContext = "";
const contextImageUrls: string[] = [];
// ... fetch history, build text lines, collect image URLs ...
groupContext = `[以下是群聊中最近的${contextMsgs.length}条消息]\n${lines.join("\n")}\n[以上是历史消息，以下是用户@你的消息]`;
```

**After**:
```typescript
let inboundHistory: Array<{ sender: string; body: string; timestamp: number }> | undefined;
if (isGroup && account.groupContextMessages > 0) {
  try {
    const histResult = await client.callApi("get_group_msg_history", {
      group_id: event.group_id,
      count: account.groupContextMessages + 5,
    }) as { messages?: Array<Record<string, unknown>> } | undefined;

    const messages = histResult?.messages;
    if (messages && messages.length > 0) {
      const contextMsgs = messages
        .filter((m) => (m.message_id as number) !== event.message_id)
        .slice(-(account.groupContextMessages));

      if (contextMsgs.length > 0) {
        inboundHistory = contextMsgs.map((m) => {
          const sender = (m.sender as Record<string, string>)?.card
            || (m.sender as Record<string, string>)?.nickname
            || String(m.user_id);
          const segs = m.message as Array<{ type: string; data: Record<string, string> }>;
          const parsed = parseHistoryMessageSegments(segs);
          const timestamp = typeof m.time === "number" ? m.time * 1000 : Date.now();
          return { sender, body: parsed.text, timestamp };
        });
      }
    }
  } catch (err) {
    log?.warn?.(`Failed to fetch group history: ${err instanceof Error ? err.message : String(err)}`);
  }
}
```

Key changes:
- `parseHistoryMessageSegments` already produces `[图片xN]` placeholders in `text` — **keep that behavior, just stop collecting `imageUrls`**
- Return value is a structured array, not a concatenated string
- Timestamps come from each message's `time` field (OneBot epoch seconds → ms)

#### 2. Remove `contextImageUrls` collection entirely

Delete the `contextImageUrls` array and all code that collects image URLs from history messages. The `parseHistoryMessageSegments` function's `imageUrls` return value is no longer used.

#### 3. Set `BodyForAgent` to just the user's text (no prepended history)

**Before**:
```typescript
const bodyForAgent = groupContext
  ? `${groupContext}\n\n${rawText}`
  : rawText;
```

**After**:
```typescript
const bodyForAgent = rawText;
```

The history is now in `InboundHistory`, not in the body.

#### 4. Add `InboundHistory` to `msgCtx`

```typescript
const msgCtx: Record<string, unknown> = {
  Body: rawText,
  BodyForAgent: rawText,  // no longer has history prepended
  // ... other fields ...
  InboundHistory: inboundHistory,  // NEW
};
```

#### 5. `MediaPaths` / `MediaUrls` — current message only

**Before**:
```typescript
const allImageUrls = [...imageUrls, ...contextImageUrls];
```

**After**:
```typescript
const allImageUrls = imageUrls;  // current message only
```

No other changes to the media download/attach logic.

#### 6. Remove `MAX_CONTEXT_IMAGES` constant

No longer needed since we don't collect history images.

### File: `src/gateway.ts` — `parseHistoryMessageSegments`

**No changes needed**. The function already returns `{ text, imageUrls }`. The `text` field already includes `[图片xN]` placeholders. We simply stop using the `imageUrls` portion of the return value in the history-building code.

Optional cleanup: the function signature could be simplified to only return `text` (since `imageUrls` is now unused), but this is a minor refactor and can be done later if desired. Keeping `imageUrls` in the return type doesn't hurt — it just goes unused.

### File: `src/config.ts`

**No changes needed**. `groupContextMessages` config still controls the number of history messages fetched.

### File: `src/onebot/message.ts`

**No changes needed**.

## What the Model Sees (Before vs After)

### Before
User message content:
```
[以下是群聊中最近的5条消息，供你了解上下文]
张三: 今天天气真好
李四: 这是什么？ [图片x2]
王五: 好看
TestUser: [图片x3]
瑶瑶bot: 收到啦
[以上是历史消息，以下是用户@你的消息]

看看猫
```
\+ 5 image blocks (2 from 李四's history + 3 from TestUser's history, all flattened)

### After
User message prefix (generated by core):
```
Conversation info (untrusted metadata):
```json
{ "message_id": "qq_123", "sender_id": "100000001", "sender": "TestUser", "timestamp": "...", "history_count": 5 }
```

Chat history since last reply (untrusted, for context):
```json
[
  { "sender": "张三", "timestamp_ms": 1772956800000, "body": "今天天气真好" },
  { "sender": "李四", "timestamp_ms": 1772956810000, "body": "这是什么？ [图片x2]" },
  { "sender": "王五", "timestamp_ms": 1772956815000, "body": "好看" },
  { "sender": "TestUser", "timestamp_ms": 1772956818000, "body": "[图片x3]" },
  { "sender": "瑶瑶bot", "timestamp_ms": 1772956820000, "body": "收到啦" }
]
```
```
User message:
```
看看猫
```
\+ 0 image blocks (user's current message "看看猫" has no attached images)

## Impact

### Positive
- Model can clearly distinguish "user's current message + media" from "group chat history"
- History images don't pollute `MediaPaths` — saves API cost (no base64 encoding of unrelated images)
- Structured JSON is more parseable than delimiter-based text
- Aligns with Discord/Slack/iMessage pattern — consistent behavior across channels
- History entries have individual timestamps — model can reason about time gaps

### Side Effects
- **Model can no longer "see" history images**: If someone posts a photo in the group and then another user @bot says "what's that?", the model won't see the image content. It will only see `[图片x1]` in the history. This matches Discord/Slack behavior and is the intended tradeoff — processing all history images is expensive and usually unnecessary.
- **AGENTS.md cleanup**: The `[以上是历史消息，以下是用户@你的消息]` delimiter rules in AGENTS.md are no longer needed since the delimiter no longer exists. The image URL extraction rules can also be simplified.
- **Existing session context**: Active sessions may have history with the old delimiter format in their context. This is harmless — the model simply stops seeing the old format in new messages.

## Testing

### Existing tests (`tests/gateway.test.ts`)
- Update tests that assert on `groupContext` string format to assert on `InboundHistory` array structure instead
- Update tests that check `MediaPaths` to confirm history images are NOT included

### New test cases
1. **Basic InboundHistory**: Verify that group messages produce `InboundHistory` array with correct `sender`, `body`, `timestamp` fields
2. **Image placeholders**: Verify history messages with images produce `[图片xN]` in `body` but images are NOT in `MediaPaths`
3. **Current message media**: Verify that the @-mentioning user's own images ARE still in `MediaPaths`
4. **Mixed scenario**: History has images + current message has images → only current message images in `MediaPaths`
5. **Empty @**: `[用户@了你但没有附带任何文字]` still works with `InboundHistory` present
6. **DM**: No `InboundHistory` for direct messages (same as before — no history for DMs)
7. **groupContextMessages=0**: No `InboundHistory` when disabled

### Manual QA
1. @bot "看看猫" in a group with recent image messages → bot calls `photo_get`, NOT `image` tool
2. @bot with 3 attached images → bot sees exactly 3 images, not 3 + N history images
3. @bot "存一下" with images → bot correctly processes only the attached images

## Files Changed

| File | Change |
|---|---|
| `src/gateway.ts` | Replace `groupContext` string with `InboundHistory` array; remove `contextImageUrls`; simplify `MediaPaths` to current-message-only |
| `tests/gateway.test.ts` | Update existing tests, add new InboundHistory tests |

## Files NOT Changed

| File | Reason |
|---|---|
| `src/config.ts` | `groupContextMessages` config unchanged |
| `src/onebot/message.ts` | Message parsing unchanged |
| `src/onebot/types.ts` | Types unchanged |
| `src/index.ts` | Plugin registration unchanged |
| `src/channel.ts` | Outbound channel unchanged |
