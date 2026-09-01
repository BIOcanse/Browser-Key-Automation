# 历史：Freedom Point v0.9 候选草稿

2026-08-30 已撤出实施依据。本文混有尚未实现或已放弃的 own/any 权限、RuntimeFacts/reconciler、operation ledger、保护传输与发布 seal 候选；不能据此补建产品功能。现行事实见 [Freedom Point](../design/freedom-points.md)，原文仅供追溯。

日期：2026-08-30。状态：方法和边界已采用。浏览器核心扩展纵切新增 Artifact 大小/总量/读取块、DOM 查询/引用、frame/resource 列表和文本 preview 等 build Freedom Point；所有 active 点必须同时拥有真实 consumer、生成投影与反向构建检查。`settings.v1` 只开放确有运行时 consumer 的 Artifact retention/容量软上限，且受 build hard maximum 约束。10 秒 retry 仍是 rebuild point，不伪造成热设置。Freedom Point 的目标是把“哪里能改、谁能改、改后谁受影响”变成可验证事实，同时让热路径只读取紧凑投影。

## 1. 四类事实先分开

| 类别 | 例子 | 处理 |
|---|---|---|
| 冻结不变量 | 业务只认Key；release/acquire分开；无限retry不退避；InstanceRef仅relay生成；Chromium-only | 合同 + 负向测试；绝不做设置 |
| 领域事实 | 某Key权限/有效期、occupation、operation phase、TabRef | 由对应owner保存；不是Freedom Point |
| Freedom Point | retry间隔、dedupe窗口、消息/结果上限、JS默认world、编译模块选择 | registry唯一声明、resolve、revision/CAS、投影 |
| 派生事实 | 有效capability、manifest union、权限bitset、ResolvedPlan、digest | 从前三者计算；不能再编辑 |

协议magic、公开schema/错误编号、密码学下限、owner关系、生命周期、browser restart结算、完整性门本身和纯算法内部常量不是Freedom Point。某个具体Key选择的权限、到期时间也不是“设置点”。

## 2. 四份职责互斥的权威声明

authoring层使用四份闭合、data-only、版本化registry。当前落地层由窄Node构建生成器解析并发射TS/Zig投影，Zig configurator仍是后续替换位；runtime只读取生成结果，不在handler复制已激活ID和值。

| Registry | 唯一负责 | 不负责 |
|---|---|---|
| Freedom | build/runtime可选择值、合同、owner、默认、update class、消费者 | Key/operation/occupation实例，固定协议身份 |
| Command | 独立permission declarations；command schema、effect、queue、owner expression、backend与依赖 | 自动从命令名创造permission，保存运行状态 |
| Error | extension command pipeline的稳定code、producer surface、公开语义、effect evidence、retry条件、redaction、退役 | client/relay transport错误、用diagnostic决定准入、复用旧编号 |
| Capability/Platform | build capability、Chrome API/版本/开关、manifest/host/CSP/content依赖、动态probe与不可用原因 | Key授权、运行设置值、隐藏fallback |

Command Registry的`permissionDeclarations`和`commandDeclarations`是同一文件中的两张独立表。command只能引用已声明permission；未被任何command使用的permission也必须显式解释为特权/预留，否则completeness失败。`control.release.any`、`operations.read.any`等是上下文权限，不靠Root或角色隐式推导；目标是自己时`.own OR .any`，foreign时只`.any`，由生成真值表机械验证。

Root令当前resolved artifact中每个`status=active`的已声明permission atom求值为true；pending/retired声明不进入运行时向量，未来新激活atom自动加入。当前Command元schema没有第二个`grantable`字段，resolver也不得从命令引用、UI显示或capability状态暗推一个未声明布尔量；若以后确需区分，必须先版本化authoring schema。v1表达式语法只允许正向单调`allOf/anyOf`，并由completeness强制每个active Key command在该全true向量下成立。表达式仍按原结构求值，Command/Capability/target/control/error合同仍全部运行；未知atom、否定/deny节点或未声明command不能凭空成立。

Capability descriptor分为：

- `staticBuildCapability`：该backend/模块是否编进resolved artifact。
- `dynamicEffectiveCapability`：当前浏览器API、版本、host grant、开关、目标URL/frame/world和runtime probe是否满足。

浏览器版本事实也分层：固定版本化`chromium-full-v1` profile descriptor唯一拥有当前主动支持的最低主版本并生成manifest的`minimum_chrome_version`；Capability条目不重复这一profile级值。某API的真实最低版本若以后需要参与兼容裁决，必须用带一手证据、独立命名的capability requirement表达，不能把profile floor复制八遍后冒充API引入版本。最终可用性仍由当前目标probe裁决。

manifest不是“Command Registry里permission字符串的并集”，也不能把API `permissions`、`host_permissions`、content declarations和CSP sources混成一个无类型字符串集合。Capability descriptor对它们分栏声明；当前JSON即使为空也显式保留`manifestPermissions`/`manifestHostPermissions`、`cspScriptTokens`、`cspWorkerTokens`与connect source引用，生成器不得用模板暗加。总体来自：

```text
manifest requirements =
  active platform/module infrastructure dependencies
  ∪ active command capability dependencies
```

IndexedDB schema/strict durability、`storage`、alarms、offscreen permission/dedicated-worker `worker-src`、WASM CSP、service worker、content scripts、host permissions等基础设施即使没有同名command也必须由Capability/Platform Registry提供。extension-page CSP同时作用于page/worker context；P3 offscreen transport显式投影`worker-src 'self'`，不依赖未登记fallback或放宽到远程worker。`unlimitedStorage`不是IndexedDB成立的默认前置；只有容量证据和真实consumer要求时才作为独立capability加入，不能被“可能更稳”隐式带入manifest。

`connect-src`同样按capability求并集：安全基线始终含`'self'`；P3 loopback transport只追加精确numeric WebSocket origin；其`host_permissions`当前候选为显式空集，必须由packed正/负例证明后才激活，不从CSP或普通`fetch()`规则猜测。未来extension-origin `resource.fetch`只有在真实handler/permission/host probe一起active时才追加其显式`https:`/`http:`data来源与host grant投影。CSP source不从请求参数动态拼接，也不提前为未来命令放宽。

## 3. Freedom Point唯一身份与schema

每个point只用一个稳定`pointId`作为authoritative identity，例如`transport.retry_interval_ms`。display group、UI label或历史path都是派生显示，不能再引入第二个`path`身份。

当前bootstrap Freedom authoring使用与JSON草案完全同形的flat tagged schema，不允许文档一套`defaultValue/valueContract`、文件另一套判别式：

```text
pointId
family                   # build | runtime
kind                     # integer | string | loopback_bind | 后续经元schema显式加入的闭合类型
defaultInteger           # integer时有值，其他kind必须null
defaultString            # string时有值，其他kind必须null
defaultLoopbackBind      # loopback_bind时为{host,port}，其他kind必须null
minimumInteger
maximumInteger           # 仅integer使用；两端闭区间
contributesToSecurityTimeHorizon # exact boolean；仅security epoch checked-add duration为true
allowedStrings           # 仅string使用；非空、有序、唯一
owner                    # build_profile | extension_runtime
updateClass              # hot_apply | restart | rebuild
editableInSettings       # exact boolean field
status                   # pending | active | retired
consumers                # stable consumer declarations
emitTargets
safetyContract
```

非当前kind的tagged payload必须严格为`null`/空数组，不是“忽略多余字段”。`loopback_bind`的元schema要求单一numeric IPv4 `127/8`地址与`1..65535`端口；resolved build只得到一个exact endpoint。当前active开发/发布值为`127.0.0.1:32189`，绝不运行时扫描/fallback。`contributesToSecurityTimeHorizon=true`只允许用于有有限`maximumInteger`、会以security epoch milliseconds参与checked-add的duration；transport monotonic timer、计数、byte limit都必须为false。跨point关系由resolver机械验证，不把point名称或prose `safetyContract`当成可执行range。固定协议duration若也参与security checked-add，必须在其版本化descriptor中以同形的显式maximum contribution声明。以后需要structured kind时先发布元schema版本并给对应runtime/golden增加验证，不得在某个point的consumer中局部解释。

- build point只由构建/打包输入commit；extension UI不能commit build facts。
- runtime point的当前值保存在`RuntimeFacts{revision,digest,values}`，不是重新写入生成TS/docs/manifest。
- runtime `hot_apply`表示consumer按新revision在线reconcile；`restart`表示该consumer显式停止/重建自己的易失资源，并不暗指重启Chromium、reload扩展或轮换RuntimeEpoch，除非point safetyContract逐项明写。`rebuild`只适用于build point。
- `null`、absent、false、0、空集合和显式default有不同authoring语义；resolver在consumer前全部规范化。
- structured point编译成flat plan；运行handler不能重新解释preset/default。
- numeric enum/index只在相同resolvedBuildArtifactDigest内有效，不得持久化或上wire。
- pending point不得有runtime consumer；active point必须双向对应真实consumer。

## 4. 设置变更流

extension settings UI和`settings.update`只操作`editableInSettings=true`的runtime point：

```text
read canonical RuntimeFacts + revision
→ edit local draft
→ normalize/validate
→ preview exact derived changes and restart need
→ commit with expectedRevision
→ persist one canonical RuntimeFacts record
→ consumer reconciler applies desired revision
→ read canonical desired/applied result
```

revision冲突失败，不做whole-object盲覆盖。Key管理是独立领域编辑器，不通过generic Freedom settings修改具体Key。

normalized values与当前RuntimeFacts完全相同时返回no-op receipt且不推进revision/触发reconcile；不能让重复写同值无故使accepted plan依赖失效。

RuntimeFacts commit只原子化“期望配置”，不能假装同时原子化timer/socket等运行资源。每个consumer保存/报告`desiredRuntimeFactsRevision`与`appliedRuntimeFactsRevision`，按revision幂等reconcile；worker在commit后崩溃则hydration继续应用。`settings.update` receipt必须列出已commit值、仍待reconcile消费者和updateClass，不能把未完成重连/重建写成已经生效。失败consumer进入typed degraded状态，但不得回写另一套默认。

build point走`Validate → ResolveBuildFacts → CompileProjection → VerifyCompleteness → atomic publish`；扩展运行时没有commit build point的API。

## 5. 相互隔离的摘要族

| 摘要 | 证明什么 | 不能证明什么 |
|---|---|---|
| `registryCatalogDigest` | 四份authoring registry的规范内容 | 某次build实际选择了什么 |
| `transportCompatibilityDigest` | 固定transport envelope/path/subprotocol/transportError与wire limit语义 | 任何业务command是否存在 |
| `commandProtocolDigest` | 固定common business-message descriptor + 当前`externalExposure=agent_relay`的command/permission/schema/extension-error wire投影，以及仍在留存窗内可查询的retired receipt decoder schema | admin-only方法、relay framing或某个组件文件是否相同 |
| `resolvedBuildArtifactDigest` | **单个组件/目标**的resolved build facts + 生成物集合 | 另一个组件artifact、当前用户runtime settings/host grant |
| `runtimeFactsRevision/runtimeFactsDigest` | 当前可编辑runtime facts | 某次operation具体计划 |
| `intentDigest/resolvedPlanDigest` | 调用者显式意图 / 首次接受后冻结执行计划 | transport来源或Key secret |

source digest本身不能证明“代码里没有隐藏常量”。完整性结论只能覆盖被工具机械约束的import、generated accessor、handler map、manifest projection、AST/lint rule和probe fixture。

所有digest只证明给定bytes/投影相等，不认证发布者，也不替代extension签名、relay分发来源或本机信任。恶意同OS进程能复制公开transport/command digest；握手摘要防误配，不把本地transport升级成新的业务身份。

v1摘要统一为`sha256-v1.<base64url-no-padding>`。哈希输入使用各摘要独立domain separator与长度前缀的canonical byte segments，不能靠可能出现在payload中的分隔字符拼接；不同摘要domain不能互换。`transportCompatibilityDigest`包含固定transport descriptor及其**显式列出的**、会改变wire解析/limit语义的active resolved build-point值；required ref pending就失败，不读default。它不按point命名前缀自动扫入endpoint或组件私有事实。Windows relay、Linux relay、extension和client的该digest必须一致或命中显式transport兼容表。只有extension/client/skill需要理解agent-relay `commandProtocolDigest`；admin-only方法不进入该domain。relay可在instance descriptor中记录/回显它，但不解析、不要求与自己的build相等，也不因新增命令必须重建。`resolvedBuildArtifactDigest`按`componentKind + targetTriple + resolved facts + 按portable ASCII path bytes排序的{relativePath, fileKind, executableFlag, byteLength, contentDigest}`计算；release payload只允许regular file，禁止靠未声明symlink/junction改变内容。Windows relay、Linux relay与extension各有自己的值，绝不要求相等。

组件payload不得内嵌自己的最终artifact digest。构建先产生不含自digest的payload，再计算清单并写独立`artifact.seal.json`；seal本身不进入该digest，包含component kind、target triple、**该组件适用**的transport/command/catalog或resolved-facts摘要、resolvedBuildArtifactDigest与完整payload清单。build/package verifier枚举产物根并证明除seal外文件集合精确相等；extension运行时没有包目录枚举能力，只验证seal与每个已声明文件，不能把“未发现额外文件”列为runtime证据。relay seal不携带完整Command/Error catalog digest，只携transport digest与其实际消费的resolved transport build facts；因此无关命令变更不重打relay。extension/relay启动先读取seal并按各自可观察范围验证payload，成功后才在`system.describe`/hello报告该值。若以后必须单文件native，再单独设计可规范排除的签名/metadata section并做目标级golden，不能把整个含自digest binary直接哈希。relativePath固定为portable ASCII、组件产物根相对、`/`分隔；拒绝ASCII case-fold碰撞、Windows保留basename/尾点空格、控制字符、drive/绝对路径/`.`/`..`/反斜杠和任何symlink/junction。生成文本固定UTF-8无BOM与LF，时间戳、本机cache路径和绝对工具路径不入摘要。secret、verifier、auth envelope、InstanceRef和transport request ID永不进入上述摘要。

## 6. 当前候选清单

下表同时列出已经active的首批点和后续候选；纯fixture或未来路径名称不算consumer。

| pointId | family / kind | 当前候选值 | update | 设计状态 |
|---|---|---:|---|---|
| `build.transport.loopback_bind` | build / loopback_bind | `127.0.0.1:32189` | rebuild | **active**；extension/relay生成投影，numeric loopback无扫描/fallback |
| `build.artifact.chunk_bytes` | build / integer | `1048576` | rebuild | **active**；Artifact 正文的 IndexedDB chunk 大小；生成器保证一次 read 最多跨两个 chunk、单 Artifact 不超过 1024 chunks |
| `command.js.maximum_source_bytes` | build / integer | `32768` | rebuild | **active**；dispatcher 在进入 Key lane 前按 UTF-8 bytes 验证完整 source |
| `command.js.maximum_timeout_ms` | build / integer | `120000` | rebuild | **active**；dispatcher 验证，browser adapter 只停止等待而不虚构取消页面代码 |
| `command.js.maximum_value_json_bytes` | build / integer | `45000` | rebuild | **active**；browser adapter 返回带显式 truncated 标志的有界 JSON preview |
| `command.dom.maximum_descriptor_text_characters` | build / integer | `256` | rebuild | **active**；DOM descriptor 单字段上限，并由生成器与 inline 总预算建立最坏 escape 关系 |
| `command.keys.list.maximum_items` | build / integer | `100` | rebuild | **active**；Key 列表先受条数门，再受统一 inline JSON byte 门 |
| `command.page.dom.maximum_html_json_bytes` | build / integer | `45000` | rebuild | **active**；固定 DOM 读取函数在跨 API 返回前截断 HTML preview |
| `command.tabs.list.maximum_items` | build / integer | `100` | rebuild | **active**；closed params validator与tab-service共同消费 |
| `command.inline.maximum_result_json_bytes` | build / integer | `49152` | rebuild | **active**；为所有可变 inline result 在65536-byte transport frame内保留envelope余量 |
| `command.page.tree.maximum_index_depth` | build / integer | `128` | rebuild | **active**；caller/response canonical indexPath 深度门，不限制底层 DOM 深度 |
| `command.page.tree.maximum_label_scan_nodes` | build / integer | `256` | rebuild | **active**；单个 DOM 派生 label 的有界扫描节点数 |
| `command.page.tree.maximum_preview_characters` | build / integer | `256` | rebuild | **active**；TreeItem 原始值 preview 字符上限，完整值仍可展开为 value chunks |
| `command.page.tree.maximum_refs_per_document` | build / integer | `4096` | rebuild | **active**；页面侧每文档 TreeRef registry 容量，满后明确 `LIMIT_EXCEEDED` |
| `command.page.tree.maximum_view_items` | build / integer | `256` | rebuild | **active**；单次无状态 view 的 materialized 行数 |
| `command.page.tree.maximum_view_scan_nodes` | build / integer | `20000` | rebuild | **active**；单次非递归已展开轮廓扫描量，命中只截断本次 view |
| `command.tabs.maximum_text_bytes` | build / integer | `2048` | rebuild | **active**；逐UTF-8 code point截断并报告标志 |
| `transport.retry_interval_ms` | build / integer | `10000` | rebuild | **active**；当前由生成投影改变，仅数值自由，无backoff/上限/放弃是不变量 |
| `transport.connect_handshake_timeout_ms` | runtime / integer | `5000` | hot_apply | planned；冻结到每次connection generation，超时关闭后回到无限retry |
| `transport.offscreen_bridge_timeout_ms` | runtime / integer | `5000` | hot_apply | planned；每条incoming source从worker首次post到background full scan后exact release的冻结总期限，包含Port断开时单帧重建；第二条、未release或超时关闭socket并一次性清该generation预算，绝不形成spool |
| `transport.outbound_bridge_ack_timeout_ms` | runtime / integer | `5000` | hot_apply | planned；background向exact Port投递唯一全局在途item（descriptor或response）时连同Port-local单调`bridgeItemId`冻结；exact ACK超时就失效Port/context并销毁对应offscreen transport，不把有界队列误当可无限等待 |
| `transport.keepalive_interval_ms` | runtime / integer | `20000` | restart | planned；packed Chromium实测 |
| `transport.pong_timeout_ms` | runtime / integer | `45000` | restart | planned；必须大于keepalive并有关系约束 |
| `operations.dedupe_window_ms` | runtime / integer | `604800000`（7天） | hot_apply | planned；每条accepted record冻结dedupeUntil，缩短只影响新ID和连续前沿 |
| `admin.dedupe_window_ms` | runtime / integer | `604800000`（7天） | hot_apply | planned；跨authority reset的AdminMutationId去重窗口；不与operation窗口暗中共用同一setting |
| `operations.max_future_clock_skew_ms` | runtime / integer | `300000` | hot_apply | planned；OperationId时间校验 |
| `operations.result_retention_ms` | runtime / integer | `86400000`（24小时） | hot_apply | planned；accepted时冻结；可短于dedupe，过期只删正文 |
| `operations.maximum_pending_per_key` | runtime / integer | `128` | hot_apply | planned；降额不丢已接受record |
| `operations.maximum_pending_total` | runtime / integer | `2048` | hot_apply | planned；不同Key不能绕过全局容量 |
| `operations.maximum_ledger_bytes` | runtime / integer | `268435456` | hot_apply | planned；不足以守完整dedupe时先拒绝新operation，绝不提前删identity |
| `storage.maximum_managed_bytes` | runtime / integer | `805306368` | hot_apply | planned；storage-domain逻辑编码预算，覆盖current+retired realms的ledger/artifact/Key/admin/meta/index及GC中数据；full reset不重置，降额不删旧事实只阻止新增。它不是IndexedDB物理预分配或quota保证 |
| `operations.default_effect_timeout_ms` | runtime / integer | `30000` | hot_apply | planned；每条accepted plan冻结；fence后超时结算uncertain而非重放 |
| `operations.late_receipt_window_ms` | runtime / integer | `300000` | hot_apply | planned；uncertain记录冻结lateReceiptUntil，窗口外回调只丢弃 |
| `keys.maximum_ordinary_records` | runtime / integer | `1024` | hot_apply | planned；计数ordinary active + retained tombstone；GC完成才释放，admin Root recovery container不计入；降额不删现有 |
| `results.inline_maximum_bytes` | runtime / integer | `65536` | hot_apply | planned；ordinary command result先计最坏envelope，支持artifact的命令越界则物化，不支持的read明确截断；专门的artifact chunk响应不受此ordinary阈值约束 |
| `reads.maximum_list_items_per_page` | runtime / integer | `256` | hot_apply | planned；所有可能超inline的business list还受结果byte上限；每页冻结limit，使用collection revision + keyset after，无后台cursor/session |
| `artifacts.read_chunk_maximum_bytes` | runtime / integer | `262144` | hot_apply | planned；是有独立schema的bounded streaming chunk例外，raw bytes经base64url膨胀再加最坏JSON/envelope后必须严格小于protocol frame上限，不能再次物化artifact |
| `artifacts.retention_ms` | runtime / integer | `3600000` | hot_apply | planned；accepted时冻结duration/policy，artifact commit时计算absolute expiry；降额不追删旧body |
| `artifacts.maximum_total_bytes` | runtime / integer | `268435456` | hot_apply | planned；storage-domain actual+reserved+staging/orphan+retired-pending-GC共同计数；降额不删现有，只阻止新reservation |
| `dom.maximum_query_results` | runtime / integer | `1000` | hot_apply | planned；只约束 DOM query，不影响页面信息树选择 |
| `dom.maximum_traversal_nodes` | runtime / integer | `100000` | hot_apply | planned；有界停止 |
| `dom.maximum_node_refs_per_realm` | runtime / integer | `4096` | hot_apply | planned；不驱逐未过期connected ref，满则LIMIT_EXCEEDED |
| `dom.maximum_node_refs_total` | runtime / integer | `65536` | hot_apply | planned；background在发query前为最坏新增refs取得runtime-scoped全局lease，content返回actual reuse/new计数后结算；Port/realm失效释放整realm额度。降额不驱逐现有ref，只阻止新增 |
| `dom.node_ref_ttl_ms` | runtime / integer | `300000` | hot_apply | planned；每个query结果冻结expiresAt，过期slot才可复用 |
| `control.maximum_tab_occupations_per_key` | runtime / integer | `256` | hot_apply | planned；降额不释放现有，占满拒绝新acquire |
| `control.maximum_total_occupations` | runtime / integer | `2048` | hot_apply | planned；失效record不计有效容量并调度清理 |
| `control.maximum_conflicts_per_response` | runtime / integer | `64` | hot_apply | planned；global冲突有界分批，不生成隐藏snapshot |
| `javascript.default_world` | runtime / string | `USER_SCRIPT` | hot_apply | planned；已接受plan不随变更重解析 |
| `javascript.maximum_result_bytes` | runtime / integer | `1048576` | hot_apply | planned |
| `page.archive.maximum_bytes` | runtime / integer | `67108864` | hot_apply | planned；P6真实`page.archive.capture` consumer落地时才进入registry/resolve；accepted先取得同额Artifact逻辑reservation，Blob返回后按size拒绝超限。它不能阻止Chrome在API内部先构造更大的完整Blob |
| `resource.request_defaults` | runtime / future structured kind | explicit credentials/cache/redirect preset | hot_apply | planned |
| `resource.maximum_response_bytes` | runtime / integer | `16777216` | hot_apply | planned |
| `build.crypto.maximum_identifier_generation_attempts` | build / integer | `8` | rebuild | planned；高熵ID/token候选因nonzero或当前namespace碰撞而重取的硬上限；entropy API失败立即fail closed，达到上限也失败，不允许无限循环 |
| `build.protocol.maximum_message_bytes` | build / integer | `1048576` | rebuild | planned；relay先限额；extension在Chromium已分配ArrayBuffer后、decode/parse/WASM再分配前限额 |
| `build.protocol.maximum_json_depth` | build / integer | `64` | rebuild | planned；relay与extension strict parser一致，超限在递归validator/第二份对象前拒绝 |
| `build.protocol.maximum_json_nodes` | build / integer | `100000` | rebuild | planned；包含object成员与array元素的结构预算，byte limit不能替代 |
| `build.protocol.maximum_object_fields` | build / integer | `4096` | rebuild | planned；单object字段硬上限，duplicate-key set和validator不得只靠总nodes |
| `build.protocol.maximum_string_bytes` | build / integer | `524288` | rebuild | planned；按解码前UTF-8 token与解码后scalar预算中更严格者执行，必须小于message limit |
| `build.protocol.maximum_number_token_bytes` | build / integer | `128` | rebuild | planned；opaque command number保持lossless但不能用超长数字耗尽parser |
| `build.protocol.maximum_object_key_bytes` | build / integer | `256` | rebuild | planned；key在duplicate检测前先限UTF-8 bytes，业务schema通常更窄 |
| `build.protocol.maximum_websocket_fragments_per_message` | build / integer | `64` | rebuild | planned；relay在完整message前限制fragment count并禁用压缩，防碎片/压缩放大绕过byte门 |
| `build.protocol.maximum_websocket_message_assembly_ms` | build / integer | `5000` | rebuild | planned；role完成后的单message单调组装deadline，不与HTTP/role握手deadline混用 |
| `build.transport.maximum_protocol_control_frames_per_window` | build / integer | `120` | rebuild | planned；raw relay/native每socket RFC Ping/Pong/Close churn硬上限；浏览器WebSocket内部control不可见，不伪造extension侧证据 |
| `build.transport.protocol_control_rate_window_ms` | build / integer | `60000` | rebuild | planned；与上一项构成有界单调窗口；它不是application keepalive interval |
| `build.transport.minimum_application_ping_interval_ms` | build / integer | `1000` | rebuild | planned；extension role中过快`transport.ping`关闭socket，防合法递增ID被用作CPU flood |
| `build.transport.extension_application_idle_timeout_ms` | build / integer | `90000` | rebuild | planned；relay未按期收到专用application ping就移除假在线InstanceRef；RFC Ping/Pong与普通TCP仍活着不能替代 |
| `build.transport.maximum_inflight_per_client` | build / integer | `64` | rebuild | planned；relay route表硬上限 |
| `build.transport.maximum_inflight_per_extension` | build / integer | `128` | rebuild | planned；relay按目标socket计数，extension独立反向限同值；fake relay超限关socket |
| `build.transport.maximum_open_sockets_total` | build / integer | `160` | rebuild | planned；从TCP accept开始计数，pending与完成role都占用；满则立即关闭 |
| `build.transport.maximum_raw_input_bytes_total` | build / integer | `67108864` | rebuild | planned；relay所有socket当前保留的HTTP/role bytes与WebSocket assembly bytes在分配/append前共享全局reservation；局部header/message上限不能乘连接数后绕过allocator总预算 |
| `build.relay.maximum_managed_memory_bytes` | build / integer | `268435456` | rebuild | planned；relay可控raw/forward/response、同时copy、socket/route/parser metadata与control headroom的组合上界；单个bucket各自小于allocator不算通过，必须由生成代数证明总和不超过此值 |
| `build.transport.maximum_pending_handshakes` | build / integer | `32` | rebuild | planned；HTTP upgrade与role hello未完成都计入，网页不能停在Origin校验前耗尽socket |
| `build.transport.handshake_timeout_ms` | build / integer | `5000` | rebuild | planned；从accept到role完成的单调deadline，不与extension主动connect timeout混用 |
| `build.client.relay_startup_convergence_timeout_ms` | build / integer | `10000` | rebuild | planned；client启动固定relay后只轮询同一endpoint到此单调总期限；不兼容hello立即失败，期间绝不发送Key、扫端口或fallback；是client artifact私有事实，不自动进入transport digest |
| `build.client.relay_startup_probe_interval_ms` | build / integer | `100` | rebuild | planned；singleflight startup coordinator在前一probe结束后才可按该最小start间隔建立下一fresh connection，防connection-refused tight loop与黑洞handshake重叠；最后一次handshake仍被总deadline截断；client私有，不自动进入transport digest |
| `build.transport.maximum_upgrade_header_bytes` | build / integer | `16384` | rebuild | planned；在完整复制/header map构造前限制HTTP upgrade bytes |
| `build.transport.maximum_upgrade_header_fields` | build / integer | `64` | rebuild | planned；重复关键header仍按closed handshake规则拒绝，不靠map覆盖 |
| `build.transport.maximum_client_connections` | build / integer | `64` | rebuild | planned；已完成native role的连接上限，加入role表前检查 |
| `build.transport.native_client_idle_timeout_ms` | build / integer | `300000` | rebuild | planned；无in-flight/local request的native socket到期关闭，client可重连；不是Key session/lease，也不结束relay进程 |
| `build.transport.maximum_inflight_total` | build / integer | `1024` | rebuild | planned；全部已选current extension route共同计数，跨client不能绕过per-client上限；零实例不建wait/route |
| `build.transport.maximum_wait_timeout_ms` | build / integer | `300000` | rebuild | planned；native envelope越界严格拒绝、不clamp；只限制本地等待 |
| `build.transport.maximum_buffered_forward_bytes_per_extension` | build / integer | `16777216` | rebuild | planned；写入目标extension socket前的请求buffer预算；超限且尚未写socket时KnownNotDelivered |
| `build.transport.maximum_buffered_forward_bytes_total` | build / integer | `67108864` | rebuild | planned；跨extension的请求buffer总预算；relay不保存零实例command spool |
| `build.transport.maximum_buffered_response_bytes_per_client` | build / integer | `4194304` | rebuild | planned；先丢transport外层标为progress的frame，不能spool accepted/terminal |
| `build.transport.maximum_buffered_response_bytes_total` | build / integer | `67108864` | rebuild | planned；跨全部client/route的全局buffer上限，防per-client上限线性放大 |
| `build.transport.maximum_extension_instances` | build / integer | `64` | rebuild | planned；达到上限拒绝新role握手，不复用编号 |
| `build.extension.maximum_concurrent_auth_checks` | build / integer | `16` | rebuild | planned；WebCrypto验证worker pool硬上限；只有authority ready且已通过transport计数/aggregate byte reservation的frame可在per-extension有界auth队列等待，不复用hydration队列 |
| `build.extension.maximum_concurrent_content_requests` | build / integer | `64` | rebuild | planned；background按exact ContentRealmToken发出的全部page/DOM请求总数；每request先取得reply source与最坏新增NodeRef lease，超限不向renderer投递 |
| `build.extension.maximum_content_bridge_source_bytes_total` | build / integer | `16777216` | rebuild | planned；覆盖content realm有界builder、runtime Port序列化源与background接收/验证副本；每request和aggregate同时有门，平台内部structured-clone copy另列availability边界 |
| `build.extension.maximum_concurrent_transport_crypto_checks` | build / integer | `8` | rebuild | planned；仅selected protected profile激活，限制endpoint probe/decapsulation/AEAD open并与Key verifier auth池分开；非法密文不能占用无界promise或饿死已解封auth队列 |
| `build.extension.maximum_admitted_command_bytes_total` | build / integer | `16777216` | rebuild | planned；background完成full scan后、从source release前先取得的typed/auth/dispatch command所有权总预算；route结束不等于operation结束，直到plan/handler不再需要才归还 |
| `build.extension.maximum_decrypted_application_bytes_total` | build / integer | `16777216` | rebuild | planned；仅selected protected profile激活；AEAD open前按closed envelope计算最大plaintext并取得，密文、plaintext与typed command转移重叠全部双/三计，解封失败精确归还 |
| `build.extension.maximum_operation_record_bytes` | build / integer | `2097152` | rebuild | planned；accepted完整ResolvedPlan、任一phase record和terminal tombstone的canonical encoded bytes+generated index overhead均不得越过；不是IDB物理page size |
| `build.extension.maximum_inflight_source_bytes` | build / integer | `16777216` | rebuild | planned；覆盖offscreen source、page/Port复制和background full parse直到exact release的生命周期；转入admitted command时两bucket并存双计，不能复用relay写socket前已归还的forward queue预算 |
| `build.extension.maximum_managed_memory_bytes` | build / integer | `134217728` | rebuild | planned；extension自有source/decrypted application/admitted command/outbound plaintext+ciphertext/WASM/route/parser/control及所有转移copy的组合上界；plaintext profile中crypto bucket为零，Chromium内部copy另列availability边界，不冒充可控内存 |
| `build.extension.maximum_outbound_response_source_bytes` | build / integer | `16777216` | rebuild | planned；background待发accepted/progress/terminal/read总source预算；exact Port同时只有一个bridge frame在途 |
| `build.extension.maximum_wasm_linear_memory_bytes` | build / integer | `33554432` | rebuild | planned；必须是64 KiB page整数倍并同时成为WASM module/imported Memory的显式maximum；没有maximum或可越过的`memory.grow`使构建失败 |
| `build.extension.maximum_websocket_buffered_amount_bytes` | build / integer | `4194304` | rebuild | planned；每次browser WebSocket send前用checked `bufferedAmount + frame + controlHeadroom`门；超限关闭而非无界排队 |
| `build.extension.maximum_retired_tab_markers` | build / integer | `8192` | rebuild | planned；达到上限轮换整个RuntimeEpoch，不删单个marker后复用tab generation |
| `build.extension.maximum_document_markers` | build / integer | `32768` | rebuild | planned；覆盖active/cached/prerender/retired identity，高水位不能LRU |
| `build.extension.maximum_target_projection_bytes` | build / integer | `4194304` | rebuild | planned；给storage.session其他投影留余量；编码前预检，retired历史超限可轮换epoch，fresh active集合仍超限则target unavailable |
| `build.extension.maximum_runtime_projection_bytes` | build / integer | `8388608` | rebuild | planned；单一`runtimeProjectionV1`整值预算；target子预算必须更小，写后还要完整readback与实际quota探针 |
| `build.extension.identity_profile` | build / string | fixed development/release identity profile | rebuild | planned；由显式打包公钥/发布身份派生expected extension ID与Origin；私钥不进registry、artifact或日志，Origin禁止首连学习 |
| `build.modules.enabled` | build / future structured kind | first-slice module set | rebuild | planned |

旧 Cleaner/PageIR 没有 point。页面信息树只登记上述已有真实消费者的选择、展开、preview 和 ref 容量；不存在 consumer 时仍不创建“以后也许用”的模型、摘要、Key table slot、operation slot或额外 ref slot point。

额外关系固定为：`build.client.relay_startup_convergence_timeout_ms >= build.transport.handshake_timeout_ms`、`0 < build.client.relay_startup_probe_interval_ms < build.client.relay_startup_convergence_timeout_ms`，且`build.crypto.maximum_identifier_generation_attempts`、`transport.offscreen_bridge_timeout_ms`与`transport.outbound_bridge_ack_timeout_ms`必须是有限正数。每次startup handshake实际deadline还必须取`min(perAttemptTimeout,totalRemaining)`；单个startup coordinator只允许一个probe在途，下一probe同时要求前一结束和start间隔已到，不能把100ms解释为允许并发叠加。多个client的总量仍由relay pending/socket门界定。这些点只让同一固定endpoint的并发启动有界收敛，不允许tight loop、扫描或fallback。generation attempt只给nonzero/namespace碰撞重取设界，不能把CSPRNG API异常变成忙循环。application liveness另要求`build.transport.minimum_application_ping_interval_ms <= transport.keepalive_interval_ms < build.transport.extension_application_idle_timeout_ms`且`transport.pong_timeout_ms < build.transport.extension_application_idle_timeout_ms`；协议层control rate窗口/count均为有限正数，不能拿RFC Pong刷新application deadline。两个bridge timeout分别约束incoming source从首次post到exact release的总寿命与background任一outbound item的ACK；它们可能同时作用于release item，不得因默认值相同而在实现中合并成一个含糊timer。

resolver必须机械验证跨point关系：pong timeout大于keepalive并满足上述relay-side liveness夹逼；JSON depth/nodes/object-fields/key/string/number-token、WebSocket fragment/assembly与message byte limit均为正、彼此不超过可编码/allocator上界且拥有raw frame parser的native两端一致；browser WebSocket不暴露fragment，extension只共享final message byte/JSON限额，不能伪造重组前证据。若各role/pending上限被声明为可同时达到，`maximum_open_sockets_total >= maximum_client_connections + maximum_extension_instances + maximum_pending_handshakes`，不能只分别与总量比较后留下组合超卖；upgrade header与message局部上限都不得大于`maximum_raw_input_bytes_total`，该global reservation在append前取得。更高一层必须以checked arithmetic证明`raw total + forward total + response total + simultaneous-copy worst case + socket/route/parser/control fixed overhead <= build.relay.maximum_managed_memory_bytes`，并让该值落入目标allocator/地址空间预算；逐bucket各自小于allocator或先释放raw再申请queue都不算闭合。完整message的reservation转移必须无accounting gap，copy并存则两边同时计。transport total inflight不大于`maximum_client_connections × maximum_inflight_per_client`，per-extension与total关系可编码；forward/response的per-peer与global buffer分别闭合，`maximum_concurrent_auth_checks <= maximum_inflight_per_extension`。extension aggregate input/admitted/output source预算各自至少容纳一个最大合法message并受allocator上界；`maximum_wasm_linear_memory_bytes`必须为64 KiB整数倍、严格不大于extension managed-memory预算，并由build verifier检查最终module/imported Memory的maximum及增长失败边界，不能只在TS常量里写值。实现控制的UTF-16/source copy、编码buffer、typed objects、WASM/parser节点与route/control metadata必须用生成的固定最坏扩张系数证明受这些逻辑预算约束，且checked-sum满足`source + admitted command + outbound response + simultaneous-copy worst case + WASM linear maximum + route/parser/control fixed overhead <= build.extension.maximum_managed_memory_bytes`。Chromium messaging/WebSocket/OS内部copy另列availability边界，不能混进可控allocator证明。每条incoming bridge source有worker生成、不回绕的`inboundItemId`，从首次post到background full scan后的exact release受总deadline；background必须先取得admitted-command或立即错误response的目标reservation，copy并存双计，再发送release，绝不先释source后等auth/dispatch预算。目标reservation持续到typed plan/handler不再需要，`route.abandon`不cancel operation，不能据此提前归还。release作为background全局outbound slot的一类item，ACK同时匹配bridgeItemId与inboundItemId，同route response不得越过它。browser `bufferedAmount` cap必须大于一个最大合法frame加generated control headroom，不能用relay已归还的queue budget冒充extension内存；outbound exact Port只允许一个在途slot，每个item有不回绕`bridgeItemId`和独立ACK deadline，ACK必须echo exact ID，不能把单槽当成抗迟到重复的相关标识。待发business item count还必须由active routes及每route closed state上界派生；release item count由unreleased incoming上界派生，三类调度均不可饿死。target marker最坏编码必须不超过target projection byte limit，target projection又必须小于整个`runtimeProjectionV1`预算；运行时还要与实际storage.session quota/完整readback共同验证。retired历史超限可轮换epoch，active集合本身超限则target capability unavailable，不能反复轮换。ordinary inline结果连同最坏envelope严格小于protocol message上限；artifact read chunk是独立schema例外，不要求小于ordinary inline阈值，但raw chunk经base64url膨胀再加最坏envelope后也必须严格小于protocol message上限。`maximumRequiredSecurityHorizonMs`只从active且`contributesToSecurityTimeHorizon=true`的integer point maximum及固定descriptor的显式contribution派生；未打tag、pending项、名称匹配或prose都不得进入，AdminMutationId也不得偷用operation窗口。result retention与artifact tombstone语义闭合；resource/JS采集上限大于单frame时必须有active artifact materializer consumer；dedupe窗口缩短不能推进越过旧record的连续reject前沿。上述关系失败时settings preview/build均拒绝，不把运行时截断当配置成功。

artifact-producing command另有一组强制关系：冻结的`maximumResultBytes <= artifacts.maximum_total_bytes`，且必须在dispatch fence前取得同额逻辑reservation；没有reservation不得调用adapter。`page.archive.maximum_bytes`只限制扩展接受和持久化的MHTML，不限制`pageCapture`在Chrome内部已经构造的完整Blob，也不进入extension-owned managed-memory的虚假“全物理内存”证明。返回Blob超过冻结值时丢弃且不写可见Artifact；合格Blob只能按固定小块读取，所有extension-owned chunk/copy仍进入handler与aggregate预算。

selected protected transport还有profile-specific代数：wire ciphertext/base64url或binary envelope的最大值、固定header/nonce/tag/ephemeral-key开销与最大application plaintext之间必须由descriptor做checked双向关系，不能让“同一message limit”在两端代表不同层。AEAD open前即可从合法shape得出plaintext上界并取得`maximum_decrypted_application_bytes_total` reservation；source ciphertext、decoded ciphertext、plaintext、typed command及parse copy可同时存在时全部计入managed-memory。response同理先保留business plaintext，再取得ciphertext/encoding目标预算，成功移交后才擦除/归还旧owner。`maximum_concurrent_transport_crypto_checks <= maximum_inflight_per_extension`且与Key verifier pool分别有count/fairness；probe/非法tag/错误proof也受相同总byte/deadline门。plaintext profile中这些点没有consumer且保持pending，不能为统一代码形状伪激活。

content plane必须由background预发容量lease，而不是相信每个renderer各自“有上限”就自动得到全局上界：`maximum_concurrent_content_requests × per-request maximum reply source`必须可编码且不大于`maximum_content_bridge_source_bytes_total`，并与background receiving copy/typed result的最坏重叠一起进入extension managed-memory证明。`dom.maximum_node_refs_total`不大于所有active realm局部容量之和，但本身提供更紧的全局门；query在投递前按最坏新增数reserve，response精确报告reuse/new，Port/ContentRealmToken失效释放该realm全部lease。page DOM/result builder按UTF-8 byte、node、depth、field和string增量停止并记录omission，禁止先构造整棵对象/JSON再截断。CSS匹配优先在有界显式遍历中逐元素`matches`，不得用可能先物化无界静态NodeList的`querySelectorAll`冒充结果上限；浏览器在读取单个巨大DOM字符串或执行selector engine时的内部工作仍是renderer availability边界。

list page同时受`reads.maximum_list_items_per_page`和ordinary inline encoded-byte上限；resolver要求最小合法limit为正、每个command最坏单item+envelope严格可放入一页。runtime降额只影响新page，不改变调用方已拿到的值；下一页仍需相同collection revision，否则显式冲突重启。禁止offset、后台cursor TTL或“先全量加载再slice”；keys用IDB key range，tabs/frames用有界target index keyset。collection revision是不回绕u64排序事实，不是Key/target身份。

storage配额使用storage-domain逻辑账本，不因AuthorityRealmGeneration轮换归零。每个operation transition先用同一generated canonical sizer得到新record bytes与index overhead；accepted前要求单record不超过`build.extension.maximum_operation_record_bytes`且domain ledger delta不超过`operations.maximum_ledger_bytes`，transaction与record一起CAS更新usage，commit后才释放旧版本差额。Artifact的actual/reserved/staging/orphan/retired-pending-GC同样始终计入storage-domain `artifacts.maximum_total_bytes`；full reset只切断旧realm可见性，把旧usage分类为retired pending GC，不返还。全域checked sum再要求ledger上限、artifact上限、Key/admin/meta/index最坏容量和固定recovery/GC headroom不超过`storage.maximum_managed_bytes`。GC每批删除实际records/chunks并在同一transaction按canonical账本减量；崩溃不会先释放额度。该逻辑预算不能预测IndexedDB压缩、WAL/page amplification或平台quota，`navigator.storage.estimate`与真实strict写仍可更早fail closed。

## 7. 明确不是Freedom Point

- protocol/schema/error版本与退役编号。
- Key-only主体、Root语义、permission并列关系。
- loopback-only、extension主动连接、无限retry不backoff。
- browser restart/reload的operation/occupation结算。
- release/acquire 分开、不使用 OccupationId、防 takeover；旧 release 重试可能清除后来 owner 是已知极简语义。
- OperationId格式、至少128-bit nonce、accepted identity去重与absent-ID窗口判定；Delivered窗口外拒绝后client必须burn。past由单调前沿持续拒绝，future无tombstone时不作永久记忆承诺。
- OperationId/AdminMutationId与security time的13位闭合数值域、由全部active checked-add声明上界派生的安全上界、checked arithmetic和域外clock fault；不是可放宽Freedom Point。
- 单调operationRejectBeforeMs必须先durable推进再GC tombstone，时钟回拨不能降低。
- 单调securityTimeFloorMs、revoked Key不可恢复及KeyId tombstone保留。
- admin Root恢复所需的单一`empty | active` recovery container、至少一次revoke tombstone与admin receipt的最小写入headroom；它由最大编码大小推导，不能由ordinary配额或普通settings降为零。丢secret响应只原地rotate active record；显式revoke原子释放container承载位并把旧KeyId放独立有界tombstone预算。物理磁盘/quota或反复admin mutation耗尽保留预算仍是可报告故障，不能承诺无限次滥用。
- InstanceRef完全relay-owned、断线失效、extension拒绝instance字段。
- `forward`只路由调用瞬间已经解析出的exact current InstanceRef；零实例立即KnownNotDelivered，多实例省略target立即要求选择。relay不把Key/command排队等待未来socket，也不把重连首个实例猜成旧目标。
- native client direct-connect numeric loopback且忽略proxy/PAC/credential环境；relay listener exclusive、不可继承且禁用多owner bind。companion启动不依赖父进程/stdin/client lease，只有显式stop或真实process/OS failure结束正常运行。
- extension-origin IndexedDB是业务权威、critical transaction使用strict durability、storage.session保持`TRUSTED_CONTEXTS`和统一hydration barrier。
- arbitrary JS不自动fallback CDP、Chrome调试确认不旁路。
- 页面树必须保持完整信息可达性与唯一 canonical 结构；目标合同不含重点 selection。折叠摘要的未来 Freedom Point 只能限制摘要计算/编码成本，不能删除树内容、建立第二套节点或暗中展开。

这些必须用合同/负向测试保证，不能给设置UI一个“危险选项”。

## 8. 双向完整性门

构建必须失败：

- active Freedom point无真实consumer，或pending/retired point被读取。
- pending point的default被摘要、manifest、fixture或生成runtime常量读取；“为了先得到确定digest”不构成consumer豁免。
- source模块绕过generated accessor读raw JSON、环境变量或另一份default。
- command缺params/result schema、effect/queue/control分类、permission expression、capability、`idempotencyKind`、`secretDeliveryPolicy`、必要receipt/progress或闭合错误集合，或boundary/effect与`none | operation_id | admin_mutation_id`组合不合法。`progressSchema=null`却发progress、error details无显式schema mapping、boundary details无顶层mapping同样失败。`preLedgerErrorIds`不是allowed子集、read使用非空集合、未列error却在无phase响应出现也失败。secret policy非none却无独立ephemeral schema，或普通result用optional secret代替一次性披露合同也失败。
- incoming request之外复用`SCHEMA_INVALID/KnownNoEffect`，或post-fence plan/adapter/result/receipt/response validation failure未保留phase-sensitive evidence。
- 任一security timestamp checked-add使用没有声明有限上界的duration、绕过生成的`maximumRequiredSecurityHorizonMs`，或可提交floor超过派生安全上界。
- active Key command的permission expression含否定/deny节点，或在当前`status=active` atom全true时仍不成立；pending/retired atom进入grant UI/runtime bitset、或实现暗推未声明的`grantable`状态同样失败。
- permission引用未声明、退役permission仍可授予，或build-disabled命令仍出现在UI/skill。
- handler存在但无唯一command declaration，或active命令声明无handler/probe。retired effect handler必须不可达；仍在旧dedupe窗口内的stable operation/receipt decoder作为单独兼容consumer显式登记并到期删除。
- Error Registry code由未登记extension/storage/platform surface产生、secret字段未redact、effect evidence冲突；client/relay错误误进业务registry或relay伪造extension error同样失败。
- manifest/CSP/host/content dependency与Capability Registry消费者不双向对应。
- local relay command误进extension dispatcher/Key UI，或extension command误成`auth=none`。
- runtime-editable point无UI/API投影、expectedRevision或canonical readback。
- relay、extension、client的`transportCompatibilityDigest`不一致却仍握手；extension/client/skill把不匹配的`commandProtocolDigest`当完全兼容；或某组件projection携带另一组件artifact digest。各digest必须按自己的domain反向校验，relay不得因命令目录变化被迫理解业务。

结构保证优先于文本搜索：业务模块只能import生成的typed descriptor/ResolvedConfig；CI对raw registry import、numeric permission bit、直接manifest capability和散落settings key做AST/lint限制。文档中的“完整”只指这些机械覆盖面，不声称数学证明任意隐藏行为不存在。

## 9. 热路径性能合同

- registry/JSON只在build或显式settings commit解析；每次command不扫描字符串registry。
- Zig使用生成enum/index、bitset、flat tables和有界iterative loop；持久/外部身份始终用稳定string/structured ref。
- capability static部分按build预计算，dynamic部分按runtime revision/target probe缓存；缓存不成为owner。
- 先有benchmark再采用SoA、packed bits或binary wire；不照搬其他资产的bit layout。
- Freedom Point既防硬编码也不是“所有数值都可调”。只有确实存在替代策略且安全更新语义闭合的决定才登记。

## 10. 分阶段纵切

恢复编码后的P0用固定版本化`chromium-full-v1` Capability profile descriptor、真实strict scanner消费的protocol hard limits、module service worker、bootstrap WebCrypto/TS strict scanner与packaged WASM等静态事实贯通四registry、resolver、Zig/TS projection、manifest和fixtures。只有一个profile时它不是Freedom Point；出现第二个真实实现后才建立build选择点。激活必要protocol build points并完成反向门之前，当前全pending Freedom authoring不产生引用point值的resolved transport/command/artifact digest。此时IndexedDB/storage.session/alarms、`transport.retry_interval_ms`、skill、relay、Key和`system.describe` route都不得成为runtime consumer。P0必须证明：显式default/省略规范化、非法值/死点/伪consumer失败、pending default不能进摘要、runtime不解析registry字符串、build/runtime owner不能互相commit。

P1建立authority，P2通过受信admin面建立Key；直到P3才在同一闭环中激活loopback transport、10秒retry、Windows/Linux relay、skill生成投影和带Key的`system.describe`。P4再加入operation与ControlState纯核及无TabRef真实纵切；Agent control route必须等P5真实TabRef，不能把“第一纵切”当作绕过Key或提前打开半条transport的理由。
