# Design: QQ History Image Resolve

## Problem

When a user sends images in separate QQ messages before @bot, the bot cannot access those images:
- The @bot message itself has no image attachments (MediaPaths is empty)
- InboundHistory currently shows only `[图片xN]` placeholder — no way to retrieve the actual image
- QQ image URLs expire within ~2 hours
- Bot runs in sandbox, cannot access local temp files

## Solution

Two changes:

### 1. Embed resolve hint in InboundHistory body (openclaw-qq)

In `parseHistoryMessageSegments`, replace the generic `[图片xN]` placeholder with a per-image resolve hint that tells the bot exactly how to retrieve each image.

**Before:**
```
TestUser: 看这个 [图片x2]
```

**After:**
```
TestUser: 看这个 [图片 - 使用 qq_resolve_image(file: "5E28D43A2FE346F995BC1D0F5D82829F.jpg") 获取] [图片 - 使用 qq_resolve_image(file: "A7BCE4AD4BF4784F1D3A25C84D3A06EC.jpg") 获取]
```

The `file` value comes from the image segment's `data.file` field in the message history — this is a stable hash-based identifier that survives URL expiry.

### 2. New tool: `qq_resolve_image` (openclaw-qq)

A new tool registered by the openclaw-qq plugin that resolves a QQ image file hash to base64 data via NapCat's `get_image` API.

**Tool schema:**
```typescript
{
  name: "qq_resolve_image",
  description: "获取QQ聊天历史中的图片。传入历史消息中 [图片 - 使用 qq_resolve_image(file: \"xxx\") 获取] 标记里的 file 值。返回 base64 编码的图片数据。",
  parameters: {
    file: {
      type: "string",
      description: "图片文件标识，如 5E28D43A2FE346F995BC1D0F5D82829F.jpg"
    }
  }
}
```

**Tool return:**
```typescript
{
  content: [{
    type: "text",
    text: JSON.stringify({
      base64: "data:image/jpeg;base64,/9j/4AAQ...",
      file_name: "5E28D43A2FE346F995BC1D0F5D82829F.jpg",
      file_size: 259991
    })
  }]
}
```

**Internal implementation:**
1. Find an active OneBotClient (any connected account)
2. Call NapCat API: `get_image({ file: "<hash>.jpg" })`
3. NapCat returns `{ base64: "<raw base64>", file_size, file_name, ... }`
4. Wrap the base64 with data URL prefix (`data:image/jpeg;base64,`)
5. Return to bot

**Error cases:**
- No active QQ client → `{ error: "No active QQ connection" }`
- NapCat API fails → `{ error: "Failed to resolve image: <reason>" }`
- File not found in NapCat cache → `{ error: "Image not found or expired from cache" }`

### 3. Update `photo_save` to accept base64 (openclaw-photos)

Currently `photo_save` only accepts `url` (HTTP URL). Add support for `data:` URLs (base64 input).

**Schema change:**
```typescript
// url description changes from "Image URL to download" to:
url: {
  type: "string",
  description: "Image URL (http/https) or base64 data URL (data:image/...;base64,...)"
}
```

**Implementation change in `store.save()`:**
```typescript
async save(url: string, ...): Promise<PhotoRecord> {
  let buffer: Buffer;
  let ct: string;

  if (url.startsWith("data:")) {
    // Parse data URL: data:image/jpeg;base64,/9j/...
    const match = url.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) throw new Error("Invalid data URL format");
    ct = match[1];
    buffer = Buffer.from(match[2], "base64");
  } else {
    // Existing HTTP fetch logic
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Failed to download image: HTTP ${resp.status}`);
    buffer = Buffer.from(await resp.arrayBuffer());
    ct = resp.headers.get("content-type") || "image/jpeg";
  }
  // ... rest unchanged (hash, save to disk, insert DB)
}
```

## Expected bot behavior

User sends two images, then @bot "把上面两张图存到瑶瑶图库":

```
Turn 1: Bot sees InboundHistory with two [图片 - 使用 qq_resolve_image(...) 获取] hints
  → Calls qq_resolve_image(file: "5E28...jpg")
  → Gets base64
  → Calls photo_save(url: "data:image/jpeg;base64,...", collection: "yaoyao")
  → Success

Turn 2: Previous base64 is out of context
  → Calls qq_resolve_image(file: "A7BC...jpg")
  → Gets base64
  → Calls photo_save(url: "data:image/jpeg;base64,...", collection: "yaoyao")
  → Success

Turn 3: Replies "两张图都存好了 ✅"
```

For "看看上面那张图是什么":
```
Turn 1: Bot calls qq_resolve_image(file: "5E28...jpg")
  → Gets base64
  → The base64 image data is in context, bot can describe it directly
  → Replies with image description
```

## Files to modify

### openclaw-qq
- `src/gateway.ts`: Modify `parseHistoryMessageSegments()` — per-image hint format
- `src/gateway.ts` or new file: Register `qq_resolve_image` tool via plugin runtime
- Need access to active OneBotClient from tool execution context

### openclaw-photos  
- `src/store.ts`: `save()` method — support `data:` URL prefix
- `src/tools.ts`: Update `url` param description

### Config (.openclaw)
- Agent tool allowlists: Add `qq_resolve_image` to agents that need it
- AGENTS.md: No changes needed — the hint format is self-documenting

## NapCat API details

`get_image` API (OneBot 11 standard + NapCat extension):
- Request: `{ action: "get_image", params: { file: "<hash>.jpg" } }`
- Response: `{ status: "ok", data: { file: "<container path>", url: "<refreshed URL>", base64: "<raw base64>", file_size: N, file_name: "..." } }`
- The `file` param is the hash filename from image segments in message history
- NapCat caches images locally; this API reads from cache
- No URL expiry concern — uses local cache, not QQ CDN

## Open questions

- How long does NapCat retain cached images? Need to test with older images.
- Should we add a `qq_resolve_image` call with multiple files support (batch resolve)?
  → Probably not for v1 — one at a time keeps context small and is simpler.
- Content type detection: `get_image` doesn't explicitly return content-type. 
  Infer from file extension or base64 magic bytes.
