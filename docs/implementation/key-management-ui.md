# 可重复查看的 Key 管理与现代化管理页

更新：2026-08-30。本文冻结当前 Key 管理 UI 与扩展内 secret 持久化语义。用户已经明确否决“明文只显示一次”的产品设计；本地受信浏览器中的管理体验优先采用 Google AI Studio 一类 API Key 控制台的可查看、可复制、可配置模式。

## 无损业务描述

1. 扩展仍是 Key、权限、有效期、启停、吊销和 occupation 身份的唯一 owner；relay 与 Agent 侧没有 Key 库。
2. 新建 Key 时，扩展在同一条 IndexedDB `KeyRecord` 中同时保存 verifier 与完整 `storedApiKey`。认证只使用 verifier；保存完整 token 只服务于受信 admin 页面再次查看。
3. 普通 `keys.list` 永远不返回 token，只返回 `secretAvailable`。用户显式点击某一行的“显示”后，受信 admin route 才以 `keys.reveal` 返回该 Key 的完整 token；“隐藏”会立即从该行 DOM 中清除明文，刷新或关闭页面也清除所有已显示值，但以后仍可再次 reveal。
4. create 的同一 `AdminMutationId` 已经提交时，后台从已提交记录返回同一个 token，不再制造“创建成功但永远丢失明文”的状态。
5. 旧 verifier-only 记录没有可逆材料，不能伪造恢复。列表将它标为 `secretAvailable:false`；用户可显式选择“补存现有 Key”，在本地输入仍持有的完整 token。后台验证 KeyId 和 verifier 后以 strict transaction 保存；不得在普通认证、读取或 Agent 调用中隐式补存。
6. revoke 继续不可逆地清除 verifier 并使认证失效，但不自动删除已保存 token；管理页仍可查看该历史值，直到未来出现用户明确要求的删除语义。当前不新增删除命令。

## 存储与协议

```text
KeyRecord
|-- secretVerifier: SecretVerifier | null     # 认证；revoke 后为 null
`-- storedApiKey: string | null               # 受信 admin reveal；legacy 可为 null

PublicKeyRecord
`-- secretAvailable: boolean                  # 不含 token

admin-only
|-- keys.reveal({ keyId }) -> { keyId, apiKey }
`-- keys.attachSecret({ mutationId, keyId, apiKey }) -> PublicKeyRecord
```

- `keys.reveal` 是受信 admin read，不带 mutationId，不修改状态。
- `keys.attachSecret` 是显式内部 mutation，使用 `AdminMutationId`。WebCrypto 验证在事务外完成；strict transaction 内重读相同 credential revision/verifier 后才写入，避免与 revoke/rotate 竞态。
- `storedApiKey` 不进入 `toPublicKeyRecord`、Agent response、relay frame、日志、状态文案、错误 details 或测试输出。
- IndexedDB object store 是 schemaless record；本轮不需要改 keyPath/index，因此数据库版本保持 1。读取旧记录时把缺失字段规范化为 `null`。

## 管理页结构

```text
admin/
|-- index.html       # 应用壳、顶栏、API Keys 标题区、筛选、表格、dialog
|-- admin.css        # token、light/dark、responsive、reduced-motion
`-- admin.ts         # admin client、render、reveal/hide/copy、create/edit/attach/revoke
```

页面采用当前 LLM/API 控制台的共同信息层级，而不是把全部字段作为裸表单堆在首页：

- 顶栏：产品名、版本、本地后台连接状态。
- 标题区：`API Keys`、一句用途说明、右上主按钮“创建 Key”。
- 工具区：名称/KeyId 搜索、状态筛选、刷新。
- Key 表格：名称、遮罩 Key、类型、权限摘要、状态、有效期、行操作；编辑进入对话框，不在表格里铺满 input/checkbox。
- 创建/编辑对话框：按任务分组显示类型、有效期、启用和权限；Root 明确显示“全部当前权限”。
- reveal：行内眼睛按钮切换显示/隐藏，复制按钮独立；legacy 行显示“补存现有 Key”。
- revoke：保留两步确认，不增加浏览器弹窗或 hidden takeover。
- 页面无外部字体、脚本或网络资源；light/dark 由系统色彩方案决定。只使用轻量 hover/focus 过渡，并为 `prefers-reduced-motion` 完全关闭。

## 空置后的后台重连

管理页最多持有一个当前 admin Port。Manifest V3 service worker 可以在页面空置期间结束，旧 Port 随之失效；Port 不是管理状态 owner，也不能要求用户刷新页面来重新初始化业务状态。

- 旧 Port 断开时，只把当时仍在等待的请求标为结果未知并全部结束，绝不把可能已经送达的 create/update/revoke 暗中重放。
- 断开且没有请求时不发送 heartbeat，不为了维持 UI 而阻止 service worker 正常休眠。
- 用户下一次刷新列表、显示 Key、创建或修改时，admin client 先建立一个新 Port，再只发送这一次新请求；成功响应后继续使用原页面内的筛选、表单和已加载记录。
- 旧 Port 的迟到 message/disconnect 不能影响已经建立的新 Port。只有扩展整体更新导致页面 extension context 已失效时，浏览器本身才可能要求重新打开管理页。

自然语言状态只有两个：存在一个当前 Port，或没有当前 Port。业务请求从“没有”进入时创建 Port；当前 Port 断开就回到“没有”。pending request 只属于发出它的当前 Port，断开后结果未知且不自动迁移。

## 验收

1. 新 Key 创建、刷新管理页后仍能显示相同完整 token；隐藏后 DOM 不保留 token，再次显示仍相同。
2. 同一 create mutation 重放返回同一 token，不新增 Key。
3. `keys.list`、公共 projection、Agent 响应和 CLI 输出都不含 `storedApiKey`。
4. legacy record 明确不可查看；错误 token 不能补存；正确 token 补存后可 reveal。
5. disabled、expired、revoked Key 的认证语义不变；reveal 只改变管理可见性。
6. Chromium smoke 通过创建、刷新、显示、隐藏、复制接口、编辑、两步 revoke；最终截图需在 light/dark 至少一个真实渲染中人工复核布局。
7. 强制结束扩展 service worker 后，已打开的管理页先观察到断开；不 reload 页面，点击刷新即建立新 Port、重新启动 worker 并成功读取原有 Key。断开瞬间存在的 mutation 不得自动重试。

## 真实个人浏览器复核

2026-08-30 用户重新加载开发扩展后，relay 为该连接签发实例 `3`。已经打开的真实管理页在空置后顶部明确显示“已断开”，页面内仍保留 1 条现有 Key。没有 reload 页面，只点击列表右侧刷新按钮；约 1.2 秒后顶部变为绿色“已连接”，同一条 Key 仍在。过程中只关闭了创建完成后的明文弹窗，没有创建、修改、吊销或复制 Key。
