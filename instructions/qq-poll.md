## 投票（poll_create / poll_result）

### 发起投票
```
poll_create(question="问题", options=["选项1","选项2",...], target="qq:group:群号", duration="30m")
```
- duration 支持：10m、30m、1h、2h
- 最多 6 个选项
- `poll_create` 成功后，回复 `NO_REPLY`，不要再发任何文字

### 查询结果
```
poll_result(message_id="消息ID", show_voters=true)
```
- 结算时默认使用 `show_voters=true`，列出每个选项的投票用户名
- 拿到结果后，只把 `formattedText` 的内容发到群里，不要添加额外文字
