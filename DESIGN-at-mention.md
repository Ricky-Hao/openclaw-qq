# DESIGN: openclaw-qq @mention 出站 + qq_resolve_member tool

## 概述

两个独立功能：
1. `buildTextSegments` 支持 `@QQ号` 和 `@all` 解析为 OneBot at segment
2. 新增 `qq_resolve_member` tool，通过群昵称反查 QQ 号

## 功能一：@ 出站支持

### 语法（仅两种）

| 输入 | 解析结果 |
|---|---|
| `@123456789` | `{ type: "at", data: { qq: "123456789" } }` |
| `@all` | `{ type: "at", data: { qq: "all" } }` |

其他格式（如 `@用户A`）保持原样输出为纯文本，不做解析。

### 正则

```typescript
const AT_RE = /@(all|\d{5,11})/g;
```

只匹配 `@all` 和 `@5-11位数字`。不匹配昵称、不匹配短数字。

### 改动：src/onebot/message.ts

`buildTextSegments` 现有逻辑只解析 `[表情123]`。改为同时解析 `@` 语法。

合并正则为一个 tokenizer：

```typescript
const TOKEN_RE = /\[(?:表情|face:)(\d+)\]|@(all|\d{5,11})/g;
```

解析逻辑（伪代码）：
```
for each token match:
  if face match → push face segment
  if @all → push { type: "at", data: { qq: "all" } }
  if @digits → push { type: "at", data: { qq: digits } }
  text between tokens → push text segment
```

函数签名不变：
```typescript
export function buildTextSegments(text: string): MessageSegment[]
```

### 测试用例（在 tests/message.test.ts 中新增）

```
"@123456789 快来" → [at:123456789, text:" 快来"]
"@all 开会" → [at:all, text:" 开会"]
"你好@123456789再见" → [text:"你好", at:123456789, text:"再见"]
"[表情201]@123456789" → [face:201, at:123456789]
"@用户A 你好" → [text:"@用户A 你好"]  (不解析昵称)
"@123 短号" → [text:"@123 短号"]  (太短不解析)
"@all@123456789 双at" → [at:all, at:123456789, text:" 双at"]
纯文本 → 现有行为不变
```

## 功能二：qq_resolve_member tool

### 用途

通过群昵称/QQ昵称反查 QQ 号。bot 在不知道 QQ 号时调用此 tool。

### tool 定义

```typescript
name: "qq_resolve_member"
description: "通过群昵称或QQ昵称查找群成员的QQ号。用于需要 @某人但只知道昵称的场景。"

params: {
  group_id: string (required) — 群号
  name: string (required) — 要查找的昵称（群昵称或QQ昵称）
}
```

### 返回值

成功：
```json
{
  "found": true,
  "qq": "987654321",
  "card": "用户A",
  "nickname": "用户B昵称",
  "match_type": "card"
}
```

未找到：
```json
{
  "found": false,
  "candidates": [
    { "qq": "987654321", "card": "用户A", "nickname": "用户B昵称" },
    { "qq": "111222333", "card": "干干", "nickname": "用户C" }
  ],
  "message": "未精确匹配，以下是相似成员"
}
```

无候选：
```json
{
  "found": false,
  "candidates": [],
  "message": "群内没有匹配的成员"
}
```

### 匹配策略

1. 精确匹配 card（群名片）→ 命中
2. 精确匹配 nickname（QQ昵称）→ 命中
3. 忽略大小写匹配 card/nickname → 命中
4. 前缀匹配 card/nickname（name 长度 ≥ 2）→ 返回 candidates
5. 包含匹配 card/nickname → 返回 candidates（最多 5 个）
6. 全部不匹配 → 返回空

### 实现：src/resolve-member.ts

```typescript
import { Type, Static } from "@sinclair/typebox";

const ResolveMemberParams = Type.Object({
  group_id: Type.String({ description: "群号" }),
  name: Type.String({ description: "要查找的昵称" }),
});

export function createQQResolveMemberTool(ctx: ToolContext) {
  return {
    name: "qq_resolve_member",
    description: "通过群昵称或QQ昵称查找群成员的QQ号",
    parameters: ResolveMemberParams,
    async execute(input) {
      const client = getActiveClient(ctx.accountId) ?? getAnyActiveClient();
      if (!client) return error("QQ 未连接");

      const members = await client.callApi("get_group_member_list", {
        group_id: Number(input.group_id),
      });

      // 匹配逻辑...
    }
  };
}
```

### 成员列表缓存

和 poll_result 的 `resolveGroupMemberName` 类似，加模块级缓存：

```typescript
const memberListCache = new Map<string, { data: GroupMember[]; ts: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 分钟
```

### 测试用例（新增 tests/resolve-member.test.ts）

```
精确匹配 card → found: true
精确匹配 nickname → found: true
忽略大小写匹配 → found: true
前缀匹配 → found: false, candidates 不为空
包含匹配 → found: false, candidates 不为空
完全不匹配 → found: false, candidates: []
client 未连接 → error
group_id 无效 → error
```

## tool 注册

在 `src/index.ts` 的 `registerTools` 中注册 `qq_resolve_member`，和 `qq_resolve_image` 一样的模式。

## 配置

在 openclaw.json 的各 agent 的 `alsoAllow` 和 `sandbox.tools.allow` 中加入 `qq_resolve_member`。

## AGENTS.md 更新

所有群 bot 加：

```
## @ 功能
- @某人：写 @QQ号，如 @123456789（群聊上下文里每条消息都有 sender_id）
- @全体成员：写 @all
- 如果只知道昵称不知道 QQ 号，先调 qq_resolve_member(group_id, name) 查询
```

## 文件改动清单

| 文件 | 改动 |
|---|---|
| src/onebot/message.ts | buildTextSegments 加 @ 解析 |
| src/onebot/types.ts | 无改动（AtSegment 已存在）|
| src/resolve-member.ts | 新增文件 |
| src/index.ts | 注册 qq_resolve_member tool |
| tests/message.test.ts | 新增 @ 解析测试 |
| tests/resolve-member.test.ts | 新增文件 |

## 预估

改动量小，预计 coder 30 分钟内完成。
