# Freedom Point 与现行生成边界

更新：2026-08-31。只描述当前实现；旧候选草稿已移至 [historical](../historical/freedom-points-v0.9-candidates.md)，不作为待实现清单。

自由点回答三个问题：哪里能改、由谁修改、修改后谁消费。现行声明唯一放在 `registries/freedom.registry.json`；运行时消费生成值，不在 handler 复制默认值。

## 事实与归属

| 事实 | 唯一归属 |
|---|---|
| Key 权限/有效期、占据、页面引用及展开 | 对应业务模块，不是通用设置 |
| build 自由点 | Freedom registry，改后重新生成与构建 |
| runtime Artifact 设置 | extension IndexedDB 的 `settings.v1` 记录 |
| 命令、独立权限、输入输出 schema | Command registry |
| Chromium 能力、manifest/host/CSP 依赖 | Capability registry |
| 业务错误 code 与公开 details | Error registry |

Root 对全部 active permission 为 true，Regular 保存显式集合。当前占据只有独立的 `control.acquire` / `control.release` 权限；获准 release 可以解除其他 Key 的占据，没有 own/any 权限、隐式接管或 OperationId。

## 构建投影

`tools/generate-transport-config.mjs` 校验固定协议和 loopback bind，将 endpoint、重连/握手时间、profile 与扩展 Origin 投影到扩展 TypeScript、relay Zig 与 CLI JavaScript。CLI 不再复制端口/协议/消息上限。`tools/generate-command-config.mjs` 校验 active 命令/权限/schema/error/capability/Freedom 关系，生成 catalog、typed 参数默认值并同步配套 skill 的 registry 引用。它们是现行 Node 构建脚本，不是尚未实现的 Zig configurator。

| Point | 当前默认值 | 消费方 |
|---|---:|---|
| `build.transport.loopback_bind` | `127.0.0.1:32189` | relay、worker、CLI 和 manifest/CSP；不是运行时端口扫描 |
| `transport.retry_interval_ms` | 10000 ms | worker 断连后无限固定重试 |
| `transport.handshake_timeout_ms` | 10000 ms | 从建 socket 至 application ready 的单次期限 |
| `command.resource.fetch.timeout_ms` | 30000 ms | fetch headers/body 完成期限与取消 |
| `command.page.tree.maximum_view_scan_nodes` | 20000 | 当前 view 扫描上限；range 直接定位，不计无关前缀 |
| `command.page.tree.maximum_refs_per_document` | 4096 | 页面唯一 live 树引用表，不用 TTL 驱逐活树 |
| `command.page.wait.default_timeout_ms` | 10000 ms | 扩展命令边界补齐省略参数，业务模块不复制默认 |
| `command.page.wait.maximum_timeout_ms` | 60000 ms | 显式等待上限；不改变同 Key 串行规则 |
| `command.page.wait.poll_interval_ms` | 100 ms | 有限期限内的串行只读探测，首轮立即观察 |
| `command.page.wait.default_until` | complete | typed string 默认阶段，不替代显式节点/文字条件 |
| `command.page.tree.maximum_find_scan_nodes` | 20000 | find 独立扫描预算；直接从 canonical 索引开始 |

focus 的 preventScroll、scroll 的 behavior/block/inline 同样从 boolean/string 自由点生成。列表 limit 和 Artifact 默认分块大小复用现有上限点，不新建一份数值。参数字段通过 `defaultFromFreedomPoint` 引用，在扩展 parser 统一展开一次；null 起始游标、零 offset 是固定协议语义。生成器检查 default 与参数类型/枚举相符，以及 default deadline ≤ maximum deadline；不只是检查声明存在。

其余项及上下界以 registry 为准。build point 不能通过 `settings.update` 修改；定时器受浏览器调度影响，不承诺浏览器暂停时严格墙钟触发。握手重试不重放业务指令。

`resource.fetch` 已激活，对 HTTP(S) 的 host/CSP 要求由现行 capability 声明生成。不能继续把它写成“未来开启”，也不能从任意请求 URL 动态追加权限。

## Runtime 设置

现行 `settings.v1` 只保存 revision 和四个 Artifact 值：retention、单文件大小、数量、总字节软上限。首次读取用生成默认值初始化；`settings.update` 在严格事务里核对 expectedRevision、提交新值并递增 revision。输入范围由 command 边界验证，硬上限由 build 决定。

后续 Artifact 操作直接读取当前设置。这里没有 RuntimeFacts digest、desired/applied 双状态、后台 reconciler 或隐含 timer/socket 重建；也不承诺同值更新不增加 revision。修改设置不能操作 Key、占据或页面树。

## 验证与边界

- active 声明必须有真实源码 consumer；pending 不代表已经可用。
- command limitRefs 明列依赖，新增 GET deadline 进入 `resource.fetch` 声明。
- Node/Chrome 测试验证期限、字节门、逐层视图与实际消费，不以文档中的候选值充当证据。
- 分包器使用 SHA256SUMS 与 ZIP 摘要；当前没有 runtime artifact seal 或多个兼容性摘要系统。
- 隔离测试只在独占 fixture 副本改一个 endpoint 并重编 relay；发布产物仍用 registry 声明的精确地址。
- `tests/command-defaults.test.mjs` 在隔离源副本中改变 timeout、boolean、alignment 和端口，生成后验证真实 parser 与客户端投影；错误类型/枚举必须阻止生成。
- 本次实际修正的架构漏接是 CLI 的重复 transport 常量和缺失的 typed defaults 投影。`consumers` 路径存在检查仍不等于全仓语义反向扫描；历史 UI/算法常量也没有被一律改造成设置。本批没有引入配置平台、运行时双状态或 Zig 业务 owner。
