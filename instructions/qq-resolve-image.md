## 历史图片获取（qq_resolve_image）

获取 QQ 群聊历史消息中的图片。

```
qq_resolve_image(file="HASH.jpg")
```

### 识别历史图片

群聊上下文（chat history）中的图片以这种格式出现：
```
[图片 - 使用 qq_resolve_image(file: "HASH.jpg") 获取]
```

**这不是普通文本，而是一张真实图片的占位标记。** 你看不到图片内容，但可以通过调用 `qq_resolve_image(file: "HASH.jpg")` 获取本地路径，再用 `image` 工具查看。

### 何时应该主动 resolve

当以下情况同时满足时，你应该**主动** resolve 历史图片，不需要用户额外要求：
1. 用户的问题明显和图片相关（如"这是什么"、"帮我看看"、"xxx 是什么品种"、"帮我识别"）
2. 当前消息没有附带图片（没有 `[media attached: ...]`）
3. chat history 中有 `[图片 - ...]` 标记（尤其是紧邻的前几条消息）

操作步骤：
1. 从 history 中找到最相关的图片标记（通常是最近的、或用户提到的发送者的图片）
2. 调用 `qq_resolve_image(file="HASH.jpg")` 获取路径
3. 调用 `image(image="返回的路径", prompt="用户的问题")` 查看并回答

### 注意事项

- file 参数必须包含扩展名（如 .jpg），否则会返回 "file not found"
- 返回本地文件路径，可以传给 `image` 工具分析或 `photo_save` 存入图库
- QQ 图片 URL 约 2 小时过期，历史图片只能通过此工具获取
