## 投票（poll_create / poll_result）

### 发起投票
```
poll_create(question="问题", options=["选项1","选项2",...], target="qq:group:群号", duration="30m", show_voters=true)
```
- duration 支持：10m、30m、1h、2h
- 最多 6 个选项
- show_voters：结算时是否展示投票用户名（默认 true，会透传到自动结算）
- `poll_create` 成功后，回复 `NO_REPLY`，不要再发任何文字

### 查询结果
```
poll_result(message_id="消息ID", show_voters=true)
```
- show_voters 默认继承 poll_create 时的设置
- 拿到结果后，只把 `formattedText` 的内容发到群里，不要添加额外文字
