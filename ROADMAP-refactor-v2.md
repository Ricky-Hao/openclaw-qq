# openclaw-qq Refactor Roadmap v2

> 目标：将 openclaw-qq 做到与内置 Discord/Telegram 频道同等完善
> 日期：2026-03-09 创建 / 2026-03-10 完成

---

## 总体分层

按依赖关系分 4 批，每批内部条目可并行。

```
批次1（基础管道）→ 批次2（回复质量）→ 批次3（运维能力）→ 批次4（锦上添花）
```

---

## 批次1：入站上下文 + 媒体管道（P0）✅ 已完成

提交: `a7e3c04`

### 1.1 入站媒体改用 SDK 管道 ✅
- 删除 `downloadImageToTmp()`、`downloadImagesWithConcurrency()`
- 改用 `runtime.channel.media.fetchRemoteMedia()` + `saveMediaBuffer()`
- 实测 QQ CDN URL 未被 SSRF 策略拦截

### 1.2 入站临时文件 TTL 清理 ✅
- 随 1.1 自动解决（SDK 管理生命周期）

### 1.3 CommandAuthorized 对齐 SDK 授权链 ✅
- 使用 `resolveCommandAuthorizedFromAuthorizers()`

### 1.4 image segment 大小保护 ✅
- `buildImageSegment`/`buildFileSegment` 加 20MB 限制

---

## 批次2：回复投递质量（P1）✅ 已完成

提交: `7012e66`

### 2.1 回复投递加重试 ✅
- `sendWithRetry()` 指数退避 1s/2s/4s，默认3次

### 2.2 引用回复（quote-reply）✅
- 群聊回复第一条消息自动引用原消息
- `capabilities.reply = true`

### 2.3 出站 text+media 合并发送 ✅
- 最后一个文本 chunk 与第一张图合并为一条消息
- 合并失败自动回退为分开发送

### 2.4 requireMention 可配置 ✅
- `requireMention: false` 可让 bot 不需要 @ 也响应

### 2.5 处理指示器鲁棒性 ✅
- 🔥 emoji 设置失败后不尝试移除

---

## 批次3：运维与健康检查（P2）✅ 已完成

提交: `f9e22b5`

### 3.1 probeAccount 状态探针 ✅
- 调用 `get_login_info` 验证 WS 连接和 bot 在线状态

### 3.2 collectStatusIssues 诊断 ✅
- 检测 WS 断连、连接但未运行状态

### 3.3 directory 适配器 ✅
- self/listPeers/listGroups/listGroupMembers
- 支持 query 过滤和 limit 截断

### 3.4 出站限流 ✅
- `RateLimiter` 滑动窗口 5条/3秒/目标

### 3.5 配置结构迁移 ⏸ 暂缓
- 从 `channels.qq.<accountId>` 迁到 `channels.qq.accounts.<accountId>`
- 影响用户配置文件，风险较高，后续单独处理

---

## 批次4：锦上添花（P3）✅ 已完成

提交: `371df4f`

### 4.1 configSchema ✅
- Zod schema 校验 QQ 配置
- `buildChannelConfigSchema(qqAccountSchema)`

### 4.2 setup 适配器 ✅
- `openclaw setup qq` 基础引导

### 4.3 resolver 适配器 ✅
- 按名称/ID 解析群号和 QQ 号
- 支持好友 remark 匹配

### 4.4 streaming ✅
- `blockStreamingCoalesceDefaults`: minChars 100, idleMs 2000

### 4.5 agentPrompt ✅
- QQ 特定 messageToolHints（不支持 Markdown、消息不可编辑、URL 过期）

### 4.6 自主配对（pairing）⏸ 暂缓
- 最低优先级，按需实现

---

## 统计

| 指标 | 数值 |
|------|------|
| 源码文件 | 11 |
| 源码行数 | 3,448 |
| 测试文件 | 9 |
| 测试用例 | 215 |
| 提交数（本轮） | 4 |
| 总改动 | +1,417 / -275 |

## 遗留项

- [ ] 3.5 配置结构迁移（暂缓）
- [ ] 4.6 自主配对 pairing（暂缓）
- [ ] 重试测试用 real setTimeout 导致测试慢（8s），可用 fake timer 优化
