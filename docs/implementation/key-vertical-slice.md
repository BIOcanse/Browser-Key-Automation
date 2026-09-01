# Key 管理纵切

更新：2026-08-30。本文只描述当前真实实现范围，不扩大后续 transport、operation 或清洗设计。

## 本轮交付

- Chromium extension 的完整标签页管理界面可创建、搜索、筛选、显示、隐藏、复制、编辑、停用和不可逆吊销 `root | regular` Key。
- Key 采用当前 v1 格式 `bk1.<16-byte KeyId>.<32-byte secret>`。新记录在 extension-origin IndexedDB 中同时保存 salted SHA-256 verifier 与完整 `storedApiKey`；所有业务鉴权只使用 verifier。
- `keys.list/get` 的 PublicKeyRecord、状态和错误 details 不含 token，只返回 `secretAvailable`。受信管理页可显式 create/reveal；Agent 也可通过独立授权的 `keys.create/reveal` 获取完整 Key，这些成功响应会经过 relay，不应脱敏掉命令本身的结果。一般诊断不保存请求/Key 正文。
- 页面隐藏、刷新、关闭或 `pagehide` 会从 DOM 和页面内 reveal map 清除当前显示值，但不会删除 IndexedDB 中的 Key；以后仍可再次显示。
- 旧版 verifier-only record 的缺失字段按 `secretAvailable:false` lazy normalize，不伪造、不反推 token。用户可在“补存现有 Key”中显式输入原始 token；后台验证 KeyId 和 verifier 后原子保存。
- create/update/revoke/attachSecret 均带 UI 预生成的 AdminMutationId。相同 create ID 和相同 intent 重放时，从已提交 Key record 返回同一个 token，不创建第二条记录，也不返回本轮未使用的随机候选。
- revoke 清除 verifier 并永久阻止业务鉴权；完整 token 作为本机 admin 历史事实继续保留并可显示，直到未来单独定义删除语义。停用不清除 verifier 或 token。
- admin Port 只接受本扩展 `admin/` 页面；外部 Agent 使用另一条 Key 鉴权的命令入口，不绕过 admin Port 检查。两条入口复用 Key service。
- 管理页使用系统/浅色/深色三态主题、响应式表格/卡片布局、搜索与状态筛选；创建、编辑、补存和吊销均使用独立对话框。

## 文件结构

```text
apps/extension/src/
|-- background.ts                 # 顶层同步注册 Chrome listener
|-- background/
|   |-- admin-router.ts           # trusted admin Port 与闭合 method dispatch
|   |-- database.ts               # IndexedDB schema/strict transaction helper
|   |-- key-crypto.ts             # Key 格式、CSPRNG、verifier、鉴权比较
|   |-- key-model.ts              # durable/public 模型、availability 与权限求值
|   `-- key-service.ts            # create/list/reveal/attach/update/revoke/authenticate
|-- shared/admin-protocol.ts      # admin 页面与后台共同的 closed envelope
`-- admin/admin.ts                # 管理 UI 状态与显式 secret 显示
```

## 现行 Agent 能力与边界

- Agent `keys.list/get/create/update/revoke/reveal` 已实现，与其他命令共同经扩展鉴权和同 Key 串行队列执行。当前总计 39 条 active command、36 个 active permission；真值在 registry，不由 handler 维护第二份列表。
- Root 不保存 permission 快照，Regular 保存显式集合；Regular 新建/新增授予受调用 Key 自身权限上限约束，不能修改 Root。已提交 update 的相同 mutationId/intent 在事务内先识别重放，再对真正新修改核对当前目标、revision 和授权上限；外层鉴权不取消。
- `storageClass=ordinary`、墙钟 expiry 是当前实现。recovery container、rotate、monotonic security time 等旧候选不在本批交付范围，也不是本修复的前置条件。

## 验收

1. TypeScript strict 编译和 Node crypto/model/protocol 测试通过。
2. unpacked 产物不包含硬编码示例 secret 或 Node 运行时依赖。
3. 真实 Chromium 中 create 返回 token；关闭结果、隐藏、刷新与页面重载后，可由行级 reveal 得到逐字节相同 token，再次隐藏后 DOM 不含完整 Key。
4. 相同 AdminMutationId 重复 create 返回相同已提交 token且不产生第二条 Key；不同 intent 冲突不披露 token。
5. legacy record 不生成伪 token；错误原始 Key 被拒绝并从输入框清空，正确原始 Key 可显式 attach 并反复 reveal。
6. list/public projection 不含 `storedApiKey` 或 token；错误 secret 不能鉴权，正确 secret 按 Root/regular 权限求值；停用和 revoke 分别返回既定鉴权失败。
7. 管理页 revoke 使用确认对话框，清 verifier、保留 stored token；revoke 后该 Key 的业务鉴权永久失败。本机管理页及获准 reveal 的调用仍可查看保存值。
