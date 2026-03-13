## 群成员查询（qq_resolve_member）

通过昵称查找群成员的 QQ 号。

```
qq_resolve_member(group_id="群号", name="昵称")
```

- 用于需要 @某人但只知道昵称的场景
- 匹配优先级：群名片（精确）→ QQ昵称（精确）→ 忽略大小写 → 前缀 → 包含
- 返回 found=true 时有 qq 字段，可以直接用 @QQ号 at 对方
- 返回 found=false 时有 candidates 列表供参考
