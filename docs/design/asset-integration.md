# 既定资产审计与引入边界 v0.8

日期：2026-08-29。状态：只读审计与反向证伪已完成，运行时代码继续暂停。本文件记录“复用哪些思想、拒绝哪些包袱”，不把本机其他项目自动变成依赖。

## 1. 裁定矩阵

| 资产/路线 | 裁定 | 引入 | 拒绝/延期 |
|---|---|---|---|
| Best Agent / CommonAssets Freedom Point | 采用核心方法 | 唯一事实、build/runtime区分、resolve、紧凑投影、双向completeness、显式preview/commit | 项目专用261点、owner/session树、packed path/bit布局、无消费者占位点 |
| 显式操作合同 | 采用 | read/status零隐藏effect；start/retry/fallback/debug/close显式；默认先resolve | 自动修复、隐式CDP、acquire暗含release |
| Protocol/Settings蓝图 | 采用原则 | strict schema、bounded decode、draft→preview→CAS→canonical readback | 多项目通用外壳、双份default、整对象盲写 |
| BraidLink | 选择性重实现 | 稳定错误、generation ref、golden/negative corpus、codec所有权与限额；P3可独立评估标准化authenticated-handshake/AEAD思想 | 其现成pairing/Grant/设备或连接身份、wire/opcode/bit layout及未经本项目descriptor证明的Noise配置；不能因“来自该资产”直接复用，也不能笼统禁止所有受保护transport |
| WordMemory/Task蓝图 | 部分采用 | QueueKey=KeyId、per-Key FIFO、长operation progress/cancel | N+1 TaskManager、jobs第二身份、所有read任务化、public OperationRef |
| Durable Operation Rail | 采用安全不变量 | caller-known OperationId、intent/plan digest、durable-before-effect fence、typed receipt、unknown不重放 | 多attempt自动retry、有限tombstone却永久幂等、公开内部slot、完整通用journal框架 |
| RmWebRuntime诊断注册 | 采用并扩展 | stable code、退役不复用、Zig/TS投影 | 单一错误层；v0.8把transport delivery错误与extension effect错误分开，并给后者producer surface/evidence |
| 既有Chrome extension资产 | 结构性采用 | MV3顶层listener、后台唯一owner、hydration、UI draft、content窄bridge | classic script手工404装配、JS默认双写、长I/O持锁、宽泛无消费者permission、吞错storage |
| Chrome官方extension samples/docs | 采用平台事实 | service worker生命周期、offscreen document、WebSocket keepalive、alarms、storage access、userScripts能力 | 把timer示例当墙钟SLA、用AUDIO_PLAYBACK假理由保活、把brand/version当feature probe |
| AIA插件/Skill合同 | 部分采用 | skill与扩展/native integration分层；skill从Command Registry生成 | `runtimeId(body);` DSL、动态插件身份系统、用DOM UI代替稳定命令API |
| context-menu preload | 不进入核心 | 有真实consumer再审 | 当前增加无关预加载状态机 |
| Session/Admission/Resource Manager/Global Observation | v1拒绝 | 将来出现真实资源/集群压力再独立评估 | 现在创造caller/session/lease/global owner |
| 旧 Cleaner/PageIR 资产 | 不复活 | 仅存`docs/historical/`供追溯 | 当前页面信息树是独立设计；不继承旧摘要、删除、模型或遮罩结构 |

## 2. 证伪后对v0.6的纠正

先前“采用资产”并不意味着资产建议正确。v0.8明确推翻：

- 从Task/operation资产引入的public `OperationRef`：删除；外部请求只携bearer Key与OperationId，不另提交realm或OperationRef；扩展认证后在内部用`(AuthorityRealmGeneration, authenticated KeyId, OperationId)`命名空间隔离。
- “global acceptedSequence”：改为normal lane的`normalSequence={ExtensionRuntimeEpoch,perKeyCounter}`；同Key admission串行，short lane用authority revision，不需要跨Key顺序权威。
- “有界ledger + 永久OperationId不复用”：改为带时间/高熵nonce和绝对dedupe window。
- “三registry足够”：改为四registry；permission declarations独立，Capability/Platform拥有manifest/CSP/host/probe。
- “Command Registry可独自反推manifest”：改为command依赖与平台基础设施依赖的并集。
- “chrome.storage天然足够做事务权威”：改为extension-origin IndexedDB跨store strict transaction；queue从operation store派生，storage.session以单一闭合`runtimeProjectionV1`保存epoch/realm/build/target可重建事实，不把分散key冒充原子写。
- “扩展/relay共用一个relay-json外壳”：拆成agent-relay、relay-extension、extension-wasm三个profile。
- “代际对象全部同一种”：按owner拆分；NodeRef capability-neutral，Artifact/operation result owner-bound，InstanceRef只在relay。
- “service worker timer足以承担10秒retry”：改为packaged offscreen document以真实`WORKERS`理由创建dedicated transport worker；alarms只重建context。浏览器/设备冻结仍无墙钟上界。

这些修正说明资产只提供候选结构，最终合同必须回到本项目用户裁定和可实现性证明。

## 3. 最终保留的组合

```text
Freedom Registry ─────────────┐
Command Registry              │
  ├ permission declarations   ├─> Zig configurator/completeness
  └ command declarations      │       ├ Zig/WASM flat descriptors
Error Registry ───────────────┤       ├ TS types/dispatch maps
Capability/Platform Registry ─┘       ├ manifest/CSP/content/host projection
                                      └ skill/docs/golden/negative fixtures

extension AuthorityCoordinator
  -> Zig pure transition
  -> durable state fence
  -> TypeScript Chromium/DOM effect adapter
  -> typed receipt

Windows/Linux Zig relay
  -> role/Origin-gated socket routing
  -> local InstanceRef only
  -> no business authority or application decryption key
```

## 4. 可复用合同

### 单一命令语义、不同边界

三profile只在明确的value边界复用同一stable command语义，不共享一个可被relay链接的大目录。`protocol/canonical`只提供strict value/canonical bytes；`protocol/transport`拥有role/transport envelope/transportError、响应`frameClass`与只释放response route的`route.abandon`；`protocol/command`拥有公共business message envelope、permission/extension Error/capability与extension-wasm schema。逐命令result/progress/receipt/error-detail schema仍由Command Registry声明。当前明文候选中relay只用`frameClass`保留/删除route并把command/message子树当opaque-secret value，不读取business kind/phase；若P3选择受保护profile，route/frameClass等必要外层仍可见，而auth/command/message变成authenticated ciphertext，加解密只在native client与extension后台。以后WASM换binary ABI或transport增加protected profile都发布新版本，不改变Key、operation或effect语义；不复制BraidLink现成header/handshake配置。

### 显式effect与恢复

read不会启动relay、request permission、连接debugger、release owner、刷新页面或重试。effectful command必须有OperationId；accepted/fence/receipt都durable后才对外宣称相应事实。disconnect/restart只恢复transport和ledger观察，不重放effect。

### generation只用于防陈旧

Tab/Document/Node/Occupation按各自authority使用epoch/generation；Artifact使用authority-realm内不复用的opaque高熵ID并跨browser restart。generation不是permission、session或caller identity。KeyId在保留期内不复用且系统从不主动选择旧值；有界tombstone GC后依靠高熵随机与现存记录碰撞检查。InstanceRef完全本地、每socket易失。

### MV3初始化

service worker listeners顶层注册；所有业务入口过hydration barrier但不把原始请求无界排队，未ready显式拒绝。IndexedDB strict transaction承载业务权威，storage.session保持trusted且以单一闭合runtime projection保存可重建事实；worker回收从durable records重建；不能依赖`onSuspend`异步flush。offscreen dedicated worker只拥有transport timer/socket，借exact runtime Port唤醒后台，不拥有Key/ledger。不同realm使用独立TS project/import root，AST/import-graph与packed spy禁止offscreen/UI/content直接打开authority store或导入业务adapter；content/page只回后台pending request，不进入command/admin dispatcher。

## 5. 源码与许可证

- `D:\\Code\\best agent`审计时工作树高度dirty；只作设计证据，不依赖其编号、生成物或未固定实现。
- `D:\\Code\\通信协议`审计时仓库干净，但根目录未发现许可证；只独立重实现codec/generation/conformance思想。
- `D:\\Code\\Chrome extension`的已审计来源为Apache-2.0，可以在记录来源与许可义务后复用；本轮仍未复制代码。
- AIA与授权不明资产只作设计参考。CommonAssets是索引/快照，源项目才是权威。

任何未来源码复用都要单独记录source path、commit/hash、许可证、复制文件与改动。当前仓库没有引入上述源码。

## 6. 明确不引入

- caller/process/device/connection身份、配对、登录、session token、Grant、lease或issuer hierarchy。
- 让relay/offscreen持有API Key派生秘密、解密application payload或成为protected-session授权者。
- stable extension installation route ID、relay持久实例映射或command spool。
- pending Freedom default进入resolved digest、relay等待未来extension socket、或把一次重连猜成旧实例。
- atomic takeover、force/replace、隐式release+acquire。
- CDP/debugger隐藏fallback、Chrome确认旁路、activeTab临时授权主路径。
- dynamic plugin runtime、任意handler反射、另一套permission/default/error表。
- jobs别名、multi-attempt自动retry、effect unknown重放。
- 清洗目录、模型、输出和“临时默认算法”。

## 7. 引入门

恢复实现时，每项资产必须先回答：owner是否一致、是否引入新身份、namespace/lifetime是否闭合、effect fence是否成立、许可证是否允许、是否有真实consumer、能否用当前registry机械验证。任一答案不清楚就停在参考层，不进入源码。
