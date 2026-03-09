# NapCat Image API Investigation (2026-03-08)

## Problem
User sends images in separate QQ messages before @bot. Bot needs to access those images.
- QQ image URLs expire (~2 hours)
- Bot runs in sandbox, can't access `/tmp/qq_img_*`
- InboundHistory only has `[图片xN]` placeholder, no actual image data

## Key Findings

### Image segment from `get_group_msg_history`
```json
{
  "type": "image",
  "data": {
    "file": "5E28D43A2FE346F995BC1D0F5D82829F.jpg",  // stable hash-based ID
    "url": "https://multimedia.nt.qq.com.cn/download?...",  // expires!
    "file_size": "259991",
    "sub_type": 0
  }
}
```

### `get_image` API (OneBot 11 standard)
- Params: `{ file: "<hash>.jpg" }`
- Returns:
  - `file`: local path in NapCat container (`/app/.config/QQ/nt_data/Pic/...`)
  - `url`: refreshed download URL (but returned HTTP 400 in testing — may need investigation)
  - `base64`: full image as base64 (confirmed valid JPEG, 260KB decoded)
  - `file_size`, `file_name`

### `get_file` API (NapCat extended)
- Params: `{ file_id: "<hash>.jpg" }`
- Returns:
  - `file`: base64 data (confirmed JPEG)
  - `file_name`, `file_size`, `url` (url was empty string in test)

### NapCat auto-caches images
- Images cached at `/app/.config/QQ/nt_qq_<id>/nt_data/Pic/<year-month>/Ori/<hash>`
- `enableLocalFile2Url: true` in napcat config

## The `file` hash is the stable identifier
The `file` field (e.g. `5E28D43A2FE346F995BC1D0F5D82829F.jpg`) from image segments is:
- Stable across URL refreshes
- Usable as key for both `get_image` and `get_file` APIs
- Survives URL expiry

## Proposed Design: "Lazy Image Resolve"

### In `parseHistoryMessageSegments`:
Instead of just `[图片xN]`, embed the file hash:
```
[图片:5E28D43A2FE346F995BC1D0F5D82829F.jpg]
```

### New tool or msgCtx field:
Option A: New `qq_resolve_image` tool that bot can call with file hash → downloads via NapCat API → saves to whitelisted path
Option B: `ContextMedia` map in msgCtx with `{ hash → pre-downloaded path }` for recent messages

### For `photo_save`:
Add `filePath` param support (local file import) OR have the resolve step return a URL/base64 that `photo_save` can consume.

## Open Questions
- Why does refreshed URL from `get_image` return HTTP 400? 
- How long does NapCat keep cached images?
- Should we pre-download all history images or truly lazy-resolve?
- `get_image` base64 field: is this standard OneBot 11 or NapCat extension?
