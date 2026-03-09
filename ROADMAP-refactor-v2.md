# openclaw-qq Refactor Roadmap v2

> 目标：将 openclaw-qq 做到与内置 Discord/Telegram 频道同等完善
> 日期：2026-03-09

---

## 总体分层

按依赖关系分 4 批，每批内部条目可并行。

```
批次1（基础管道）→ 批次2（回复质量）→ 批次3（运维能力）→ 批次4（锦上添花）
```

---

## 批次1：入站上下文 + 媒体管道（P0）

这是后续所有改进的基础。当前入站图片走自己的 fetch + /tmp 路径，绕过 SDK 的标准管道。

### 1.1 入站媒体改用 SDK 管道
- **现状**: `downloadImageToTmp()` 用原生 fetch 下载到 `/tmp/qq_img_*`，无大小限制、无内容类型验证、无清理
- **目标**: 改用 `runtime.channel.media.fetchRemoteMedia()` + `runtime.channel.media.saveMediaBuffer()`
- **改动文件**: `src/gateway.ts` — 删除 `downloadImageToTmp()`、`downloadImagesWithConcurrency()`，替换为 SDK 调用
- **效果**: 自动走 SDK 的大小限制/content-type 校验/集中存储路径/生命周期管理
- **风险**: 需确认 QQ 图片 URL 能否被 SDK 的 SSRF 策略放行（QQ CDN 域名如 `multimedia.nt.qq.com.cn`）
- **优先级**: P0-1
- **工作量**: 小（约2小时）

### 1.2 入站临时文件 TTL 清理
- **现状**: 入站图片下载后无清理机制
- **目标**: 如果 1.1 完成则此项自动解决（SDK 管理生命周期）；如 1.1 有阻塞，则退而加 TTL 清理
- **改动文件**: `src/gateway.ts`
- **优先级**: P0-2（随 1.1 一起解决）
- **工作量**: 极小

### 1.3 CommandAuthorized 对齐 SDK 授权链
- **现状**: `commandAuthorized = account.allowFrom.includes(senderId)` — 硬编码逻辑
- **目标**: 使用 `runtime.channel.commands.resolveCommandAuthorizedFromAuthorizers()`
- **改动文件**: `src/gateway.ts` 约第362行
- **注意**: 需确认 SDK 函数签名和所需参数，可能需要传入更多上下文
- **优先级**: P0-3
- **工作量**: 小

### 1.4 image segment 大小保护
- **现状**: `buildImageSegment` 中 `readFileSync` 无大小限制
- **目标**: 加 `statSync` 大小检查，超过阈值（如 20MB）抛错
- **改动文件**: `src/onebot/message.ts` 约第120行
- **优先级**: P0-4
- **工作量**: 极小

---

## 批次2：回复投递质量（P1）

### 2.1 回复投递加重试
- **现状**: `deliverReply()` 中每个 `client.sendMessage()` 失败仅 log，不重试
- **目标**: 包裹重试循环（3次，指数退避 1s/2s/4s）
- **做法**: 提取 `sendWithRetry(client, target, segments, log)` 工具函数，复用 `OneBotClient.callApi()` 已有的重试模式
- **改动文件**: `src/gateway.ts` 的 `deliverReply()` 函数
- **优先级**: P1-1
- **工作量**: 小

### 2.2 引用回复（quote-reply）
- **现状**: `capabilities.reply = false`，回复不引用原消息
- **目标**: 在第一条回复消息前加 `{ type: "reply", data: { id: event.message_id } }` 段
- **改动文件**: 
  - `src/gateway.ts` — `deliverReply()` 第一个 chunk 加 reply 段
  - `src/channel.ts` — `capabilities.reply = true`
  - `src/onebot/message.ts` — 添加 `buildReplySegment(messageId)` 函数
- **注意**: 仅群聊启用引用回复；私聊无需引用
- **优先级**: P1-2
- **工作量**: 小

### 2.3 出站 text+media 合并发送
- **现状**: `sendPayload` 先发文本再发媒体，两条消息
- **目标**: 文本和第一张图合并为一条消息（OneBot 支持混合段）
- **改动文件**: `src/channel.ts` 的 `outbound.sendPayload`
- **优先级**: P1-3
- **工作量**: 小

### 2.4 requireMention 可配置
- **现状**: 群消息必须 @bot 才响应，硬编码
- **目标**: 支持 `requireMention: true|false` 配置项，默认 true
- **改动文件**: 
  - `src/config.ts` — 添加字段
  - `src/gateway.ts` — 读取配置决定是否检查 mention
  - `src/channel.ts` — `groups.resolveRequireMention` 读取配置
- **优先级**: P1-4
- **工作量**: 小

### 2.5 处理指示器鲁棒性
- **现状**: 🔥→✨ emoji 反应为即发即忘，初始设置失败仍尝试移除
- **目标**: 追踪 🔥 是否设置成功，失败则跳过后续移除
- **改动文件**: `src/gateway.ts`
- **优先级**: P1-5
- **工作量**: 极小

---

## 批次3：运维与健康检查（P2）

### 3.1 probeAccount 状态探针
- **现状**: status 适配器无 `probeAccount`
- **目标**: 调用 `get_login_info` API 验证 WS 连接和 bot 在线状态
- **改动文件**: `src/channel.ts` 的 `status` 适配器
- **优先级**: P2-1
- **工作量**: 小

### 3.2 collectStatusIssues 诊断
- **现状**: 无
- **目标**: 检测常见问题（WS 未连接、token 错误、bot 被禁言等）
- **改动文件**: `src/channel.ts`
- **优先级**: P2-2
- **工作量**: 中

### 3.3 directory 适配器
- **现状**: 无法通过 CLI 列出群/好友
- **目标**: 使用 `get_friend_list` / `get_group_list` / `get_group_member_list` 实现
- **改动文件**: `src/channel.ts` 添加 `directory` 适配器
- **优先级**: P2-3
- **工作量**: 中

### 3.4 出站限流
- **现状**: 无限流保护
- **目标**: 简单的令牌桶或间隔队列，防止快速分块回复触发 NapCat 限流
- **改动文件**: `src/gateway.ts` 或新建 `src/rate-limiter.ts`
- **优先级**: P2-4
- **工作量**: 中

### 3.5 配置结构迁移
- **现状**: `channels.qq.<accountId>` 不符合标准 `channels.qq.accounts.<accountId>`
- **目标**: 迁移到标准结构，保持向后兼容
- **改动文件**: `src/config.ts`
- **注意**: 需要同时更新 openclaw.json 配置
- **优先级**: P2-5
- **工作量**: 中

---

## 批次4：锦上添花（P3）

### 4.1 configSchema
- **现状**: 无
- **目标**: 添加 TypeBox/Zod schema 让 Web UI 可以校验配置
- **优先级**: P3-1

### 4.2 onboarding 适配器
- **现状**: 无引导设置
- **目标**: `openclaw setup qq` 提供交互式配置
- **优先级**: P3-2

### 4.3 resolver 适配器
- **现状**: 目标仅支持裸 QQ 号
- **目标**: 支持名称到 QQ ID 的解析
- **优先级**: P3-3

### 4.4 streaming 适配器
- **现状**: 无流式回复
- **目标**: 评估 QQ 是否可通过 `blockStreaming` 合并模式实现某种程度的渐进回复
- **注意**: QQ 不支持消息编辑，流式价值有限
- **优先级**: P3-4

### 4.5 自主配对（pairing）
- **现状**: 无配对流程
- **目标**: 实现 `pairing` 适配器，让陌生用户发验证码请求访问
- **优先级**: P3-5（最低优先级）

---

## 执行建议

| 批次 | 预估总工作量 | 建议方式 |
|------|------------|---------|
| 批次1 | 3-4h | 一次性 coder task，4个改动打包 |
| 批次2 | 4-5h | 分2个 coder task：(2.1+2.2+2.5) 和 (2.3+2.4) |
| 批次3 | 6-8h | 每项单独 coder task |
| 批次4 | 按需 | 用到时再做 |

批次1 完成后立即 build+test+commit；批次2 同理。批次3、4 可以分散做。
