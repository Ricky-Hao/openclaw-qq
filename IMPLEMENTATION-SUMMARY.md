# QQ History Image Resolve Implementation Summary

## ✅ Implementation Complete

All changes have been successfully implemented and tested according to the design spec.

## Changes Made

### openclaw-qq (`/home/ricky/git/openclaw-qq`)

#### 1. Modified `parseHistoryMessageSegments` in `src/gateway.ts`
- **Before**: Image segments counted and rendered as `[图片xN]`
- **After**: Each image segment rendered individually with resolve hint:
  ```
  [图片 - 使用 qq_resolve_image(file: "HASH.jpg") 获取]
  ```
- The file hash comes from `seg.data.file` field
- Fallback to `[图片]` when file field is missing

#### 2. Created new `qq_resolve_image` tool (`src/resolve-image.ts`)
- **Tool name**: `qq_resolve_image`
- **Input**: `{ file: "HASH.jpg" }`
- **Implementation**:
  - Calls NapCat `get_image` API via active OneBotClient
  - Returns base64 data URL: `data:image/jpeg;base64,<data>`
  - Infers content type from file extension (.jpg/.png/.gif/.webp)
  - Error handling for: no client, API failures, file not found
- **Output**: `{ base64: "data:...", file_name: "...", file_size: N }`

#### 3. Registered tool in `src/index.ts`
- Added import and registration call for `createQQResolveImageTool`

#### 4. Updated tests (`tests/gateway.test.ts`, `tests/resolve-image.test.ts`)
- Updated all existing `parseHistoryMessageSegments` tests to expect new format
- Added comprehensive test suite for `qq_resolve_image` tool (10 tests):
  - Tool metadata validation
  - No active client error
  - API returns no base64 error
  - Successful base64 retrieval (jpeg/png/gif/webp)
  - Content type inference
  - API exception handling
  - Missing file_size handling

### openclaw-photos (`/home/ricky/git/openclaw-photos`)

#### 1. Updated `save()` method in `src/store.ts`
- Added support for base64 data URLs
- **Detection**: Checks if url starts with `data:`
- **Parsing**: Extracts MIME type and base64 data
- **Processing**: Decodes base64 → Buffer, infers extension from MIME type
- Falls back to existing HTTP fetch for non-data URLs
- All existing dedup/hash logic works identically

#### 2. Updated tool schema in `src/tools.ts`
- Changed `url` parameter description:
  - **Before**: "Image URL to download"
  - **After**: "Image URL (http/https) or base64 data URL (data:image/...;base64,...)"

#### 3. Added tests (`test/store.test.ts`)
- Added 6 new tests for base64 support:
  - Save from base64 (jpeg/png/gif/webp)
  - Content verification
  - Deduplication by hash
  - Invalid data URL rejection

## Test Results

### openclaw-qq
- **Before**: 176 tests passing
- **After**: 186 tests passing ✅ (+10 new tests)
- All existing tests updated and passing

### openclaw-photos
- **Before**: 24 tests passing
- **After**: 30 tests passing ✅ (+6 new tests)
- All existing tests still passing

## Expected Bot Behavior

### Example: User saves two images from history

```
User: [sends image A]
User: [sends image B]
User: @bot 把上面两张图存到瑶瑶图库
```

**Bot sees InboundHistory:**
```
User: [图片 - 使用 qq_resolve_image(file: "5E28...jpg") 获取]
User: [图片 - 使用 qq_resolve_image(file: "A7BC...jpg") 获取]
```

**Bot execution:**
1. Calls `qq_resolve_image(file: "5E28...jpg")` → gets `data:image/jpeg;base64,...`
2. Calls `photo_save(url: "data:image/jpeg;base64,...", collection: "yaoyao")` → success
3. Calls `qq_resolve_image(file: "A7BC...jpg")` → gets `data:image/jpeg;base64,...`
4. Calls `photo_save(url: "data:image/jpeg;base64,...", collection: "yaoyao")` → success
5. Replies: "两张图都存好了 ✅"

### Example: User asks about an image

```
User: [sends image]
User: @bot 看看这是什么
```

**Bot sees InboundHistory:**
```
User: [图片 - 使用 qq_resolve_image(file: "5E28...jpg") 获取]
```

**Bot execution:**
1. Calls `qq_resolve_image(file: "5E28...jpg")` → gets base64
2. Base64 image is now in context → bot can describe it directly
3. Replies with image description

## Key Design Decisions

1. **Per-image hints vs batch**: Chose per-image hints for simplicity and better context management
2. **Data URL format**: Used standard `data:image/<type>;base64,<data>` format for compatibility
3. **File extension preservation**: File hash from QQ includes extension (e.g., `HASH.jpg`)
4. **Content type inference**: Infer from file extension rather than magic bytes (simpler, sufficient)
5. **Error handling**: Graceful degradation at each step (no client → error, API fail → error)

## Files Modified

### openclaw-qq
- `src/gateway.ts` - Modified `parseHistoryMessageSegments`
- `src/resolve-image.ts` - New file (tool implementation)
- `src/index.ts` - Added tool registration
- `tests/gateway.test.ts` - Updated existing tests
- `tests/resolve-image.test.ts` - New test file

### openclaw-photos
- `src/store.ts` - Modified `save()` method
- `src/tools.ts` - Updated tool schema description
- `test/store.test.ts` - Added base64 tests

## Next Steps (Optional)

1. Update agent tool allowlists in `.openclaw/config.yaml` to include `qq_resolve_image`
2. Test with real NapCat instance to verify image resolution works end-to-end
3. Monitor NapCat image cache retention to understand how long historical images remain available
4. Consider adding batch resolution support if single-image-at-a-time becomes too slow
