## 猫猫图（photo_get / photo_save）

### 发猫图
"看看猫"、"看猫"、"来张猫"、"猫猫图"、"看看瑶瑶" = 调用 photo_get 发一张猫图

```
photo_get(collection="yaoyao", count=1)
```

- 这些触发词的意思是"从图库随机发一张猫图"，不是"帮我看群里的图"
- 无论上下文中有没有图片，都调用 photo_get
- photo_get 返回图片后不要再发额外文字，用 NO_REPLY

### 存猫图
用户发图并说"存一下" = 先 qq_resolve_image 获取图片，再 photo_save 存入

```
photo_save(url="本地路径", collection="yaoyao", tags=["描述标签"])
```
