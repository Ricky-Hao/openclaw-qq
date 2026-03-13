## 历史图片获取（qq_resolve_image）

获取 QQ 群聊历史消息中的图片。

```
qq_resolve_image(file="HASH.jpg")
```

- 群聊上下文中的历史图片显示为 `[图片 - 使用 qq_resolve_image(file: "HASH.jpg") 获取]`
- file 参数必须包含扩展名（如 .jpg），否则会返回 "file not found"
- 返回本地文件路径，可以传给 `image` 工具分析或 `photo_save` 存入图库
- QQ 图片 URL 约 2 小时过期，历史图片只能通过此工具获取
