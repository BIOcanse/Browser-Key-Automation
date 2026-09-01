# 权威、命名空间与引用合同 v0.8

日期：2026-08-29。状态：当前架构的中心合同，尚无实现。任何其他文档出现同名概念时以本文件为准。

## 1. 权威、生成者与失效者

“业务只看 Key”不等于系统里只能存在一种编号；它的准确含义是：只有 Key 能成为外部业务权限、队列和占据的主体。其余引用只定位事实，不能授予权限。

`事实 owner`、`token 生成者`和`失效裁决者`不是同义词。生成位置必须同时满足该 token 的用途：需要调用方重投的 ID 由调用方在首次发送前生成；需要全局枚举/路由的 ref 由拥有该命名空间全局视野的一侧生成；失效只能由掌握生命周期事实的 owner 裁决。任何实现不得仅凭“谁最先需要这个值”临时选择生成位置。

| 事实或对象 | 唯一事实 owner / 裁决者 | token 生成者或 issuer | 权威存储 | 命名空间与生命周期 |
|---|---|---|---|---|
| Registry 源事实 | 四份 authoring registry | 人工显式编写稳定 ID；配置器只验证，不反向拥有源事实 | 仓库中的四份 registry | 当前源码/发布线；直到显式版本变更 |
| 已解析 build facts | 构建系统 | Zig 配置器 | 带摘要的不可变生成代 | transport digest跨relay/extension/client；command digest跨extension/client/skill；artifact digest属于单个component/target |
| runtime settings | 扩展后台 | 受信管理入口提交值；扩展分配 revision | extension-origin IndexedDB | 当前扩展存储域；卸载或显式重置前 |
| AuthorityRealmGeneration | 扩展后台 | 扩展 CSPRNG；fresh realm/full authority reset各生成一次 | IndexedDB meta | 当前 extension storage domain；full authority reset 原子退役旧 generation |
| ExtensionRuntimeEpoch | 扩展后台 bootstrap/reconciler | 扩展 CSPRNG；可信session candidate缺失、绑定的authority realm/build不匹配或明确runtime continuity断裂时生成 | `storage.session`中的单一闭合`runtimeProjectionV1`同时包含epoch并绑定内部AuthorityRealmGeneration/build digest；IndexedDB records只冻结引用值 | 当前浏览器运行；worker回收保持，浏览器重启/扩展reload/full authority reset后换新 |
| Key 记录 | 扩展后台 | 扩展 CSPRNG 生成 KeyId 与 secret | extension-origin IndexedDB | 当前 AuthorityRealmGeneration；active或revoked tombstone |
| KeyCollectionRevision | 扩展后台 | 每次list-visible Key集合/record事实真正改变时在同一strict transaction推进 | IndexedDB meta，与Key mutation同事务 | 当前AuthorityRealmGeneration；canonical u64不回绕，只给keyset page检测集合变化，不是KeyId或权限 |
| operation ledger | 扩展后台 | OperationId 由调用方首次发送前生成；扩展登记/碰撞裁决 | extension-origin IndexedDB | `(AuthorityRealmGeneration, KeyId, OperationId)`；去重/结果留存合同决定 |
| AdminMutationId ledger | 扩展后台 | 受信 admin UI 在用户手势首次发送前生成 | IndexedDB admin_mutations | 当前 extension storage domain；跨full authority reset；factory reset能力当前延期 |
| occupation | 扩展后台 | 扩展在 ControlState strict transaction 中推进 generation | runtime-scoped IndexedDB ControlState；session只有缓存 | `ExtensionRuntimeEpoch + scope/TabRef`；当前浏览器运行 |
| Key 普通动作队列 | 扩展后台 | 扩展 admission gate | durable operation记录；内存仅是投影 | `(ExtensionRuntimeEpoch, KeyId)`；当前浏览器运行 |
| normal sequence high-water | 扩展后台 | 扩展在accepted transaction中推进 | IndexedDB queue_counters | `(ExtensionRuntimeEpoch, KeyId)`；u64不回绕 |
| operation phaseVersion | 扩展后台 AuthorityCoordinator | 扩展在每次合法phase transition中推进 | operation record | 单operation；u64不回绕，旧版本回调只能丢弃 |
| TabRef | 扩展后台 target registry | 扩展后台为每次live incarnation推进tabGeneration；Chromium的tabId只是输入证据 | session target registry及retired high-water | `ExtensionRuntimeEpoch + chromeTabId + live incarnation`；close/replace/连续性丢失永久退休当前generation |
| TargetCollectionRevision | 扩展后台 target registry | 每次tabs/frames list-visible current target集合或字段真正改变时推进 | `runtimeProjectionV1` target投影与后台内存 | 当前ExtensionRuntimeEpoch；canonical u64不回绕，只给target keyset page和fresh precheck排序，不是TabRef/DocumentRef或occupation |
| DocumentRef | 扩展后台 target registry | 扩展后台为每次active incarnation推进documentGeneration；Chromium documentId/frameId/lifecycle只是输入证据 | session target registry | `TabRef + documentId + active incarnation`；离开active、替换或target连续性丢失即永久失效，BFCache/prerender再次active签发新generation |
| ContentRealmToken | 扩展后台 target registry | 扩展后台 CSPRNG；验证bridge port/document注册后生成 | 后台route与对应content realm内存 | `DocumentRef`；每次realm/port重建都换新 |
| NodeRef | 对应 document 的 content realm | content realm分配slot/generation；realm token由后台签发 | content realm 中的有界表 | `DocumentRef + ContentRealmToken`；document/realm/slot失效前 |
| NodeRef capacity lease | 扩展后台target/content coordinator拥有全局计数；content realm拥有本realm actual slots | background在exact query投递前按最坏新增数reserve，content reply报告actual reuse/new后结算 | 后台易失per-ContentRealmToken账本 + content realm slot表 | 当前ExtensionRuntimeEpoch/exact ContentRealmToken；query完成保留actual new额度，Port/realm失效释放整realm，late reply不得复活lease；不是Key配额或权限 |
| ArtifactRef | 扩展后台 | 扩展 CSPRNG | IndexedDB有界artifact store | `AuthorityRealmGeneration + ownerKeyId + ArtifactId`；到期/释放/full reset前 |
| ArtifactStagingToken | 扩展后台 artifact coordinator | 某个已reserve结果首次开始物化时由扩展CSPRNG生成 | artifact metadata与以`(ArtifactId, token, chunkIndex)`为key的immutable-once-written chunks；不上wire | `(AuthorityRealmGeneration, ArtifactId, staging generation)`；仅`staging_open`且operation phase/期限仍可接收结果时有写权，commit/orphan close后失权，GC后删除 |
| DispatchToken | 扩展后台 AuthorityCoordinator | 扩展 CSPRNG；与dispatch fence transition绑定生成 | operation record/一次性adapter context | `AuthorityRealmGeneration + operation identity + 单operation phase + 创建它的live后台执行`；只留后台；terminal、后台执行丢失或late window结束即擦除，full authority reset后旧token永远不能写新realm |
| contentRequestId | 扩展后台 bridge coordinator | 后台按exact bridge port单调分配 | 后台与content易失pending表 | 单bridge port；完成/断开/deadline即失效，不参与authority |
| inboundItemId | 扩展offscreen transport worker | worker按exact connectionGeneration从1开始单调分配canonical u64 string | worker的source reservation表、page转发值与后台当前incoming处理项 | 单exact WebSocket generation；后台完成独立full scan并取得所需副本后，经exact Port回传release item才释放；counter不回绕，只作入口内存所有权相关，不进relay/business/operation |
| bridgeItemId | 扩展后台 offscreen outbound coordinator | 每个exact offscreen Port从1开始单调分配canonical u64 string | 后台唯一outbound slot与page/worker当前item | 单exact offscreen Port；ACK/timeout/Port断开即结束当前item，counter不回绕；只作Port相关性，不进relay/business/operation |
| relayEpoch | 本地 relay coordinator | relay每次进程启动由OS CSPRNG生成 | relay内存与server hello/local response | 单relay进程；退出即永久失效，不持久化或复用 |
| InstanceRef | 本地 relay | relay在extension role握手完成后推进instanceNumber并分配 | relay 内存 | `relayEpoch`；socket断开或relay退出立即失效 |
| clientRequestId | native client/integration | client在首次发送前生成`cr1.<base64url-16-byte-random>` | client与relay易失in-flight表 | 单client socket；当前in-flight唯一，route结束后token可删除但客户端不主动复用 |
| relayRequestId | 本地 relay | relay从1开始单调分配`rr1.<canonical-u64-decimal>` | relay易失route表 | `relayEpoch`；回应、deadline或断线前，counter不回绕 |
| connectionGeneration | 扩展offscreen dedicated transport worker | 每次connect attempt由该worker的CSPRNG生成 | offscreen worker易失状态；后台session只保存经exact port上报的诊断摘要 | 单attempt/socket；新attempt绝不复用旧值 |
| protected connection challenge（仅selected profile） | 扩展offscreen transport worker拥有socket事实；后台验证其与exact Port/outer frame绑定 | 每条成功socket由offscreen CSPRNG生成公开非零challenge；relay/client可见但extension永不接收InstanceRef | offscreen易失状态、relay current instance descriptor与后台exact Port投影 | 单connectionGeneration/socket；只作protected transcript的current-route binding，不是secret、InstanceRef、安装身份或业务session；断线即失效 |
| transport private material（仅selected protected profile） | 扩展后台 | 扩展后台CSPRNG/经过批准的key generation primitive；绝不由relay/offscreen生成 | 版本化extension-origin受限持久记录或显式易失background session，二者必须在P3择一闭合 | 公开proof版本绑定API Key token；私钥不进入offscreen/relay/WASM policy。丢失/轮换使旧proof token不可用并要求显式Key rotate/reissue；不能fallback明文 |
| TransportRouteContext | offscreen transport coordinator与扩展后台共同裁决 | offscreen收到frame时冻结socket generation；后台入口再冻结exact offscreen runtime Port | 两侧易失pending表/handler closure | `(connectionGeneration, relayRequestId, exact socket handle, exact offscreen Port)`；socket/Port关闭、terminal或transport-only`route.abandon`使其失效，只能丢弃，永不改投新context；abandon不改operation |

扩展service worker后台是全部业务事实的唯一owner。offscreen document/dedicated worker只拥有extension WebSocket、retry timer与当前route的易失传输事实；它不能打开Key dispatcher、Chromium业务API或authority store。Zig/WASM纯核心可以验证快照并返回transition；JS适配器负责持久化和Chromium I/O；relay只维护本地socket与请求返回路由。任何缓存或transport context都不得反向成为第二业务owner。各extension realm使用独立TS project/import root；AST/import-graph和packed spy必须把offscreen/UI/content对authority模块、IndexedDB直接访问与业务Chrome API调用变成构建失败，而不是依赖“开发者不会import”的约定。

所有 revision/generation 必须在声明自己的 issuer、命名空间、持久化位置、递增条件和耗尽行为后才能进入schema。计数型值使用无符号64位语义且绝不回绕；耗尽时拒绝新对象或轮换其上层高熵epoch，不能清零复用。高熵generation/token至少128-bit、非零，并通过命名空间而不是字符串外观区分。revision是排序事实，不是secret、permission或caller identity。

CSPRNG probe只能证明目标realm中的API存在、调用成功、长度/编码正确和异常能fail closed，不能用少量样本“证明熵”。熵质量是Chromium WebCrypto或目标OS CSPRNG的平台信任边界。所有由本系统生成的高熵ID/token使用`build.crypto.maximum_identifier_generation_attempts`有限尝试：primitive异常立即失败；候选为禁止的零值或与当前namespace仍保留的identity碰撞时才消耗下一次；达到上限在任何业务effect前typed fail closed。不得写`while collision { random() }`无界循环，也不得在失败后退化为时间、counter、Math.random或内容hash。

Key/settings/control/operation/artifact使用同一个extension-origin IndexedDB数据库和跨object-store transaction；critical写事务显式请求`durability: "strict"`并等待transaction complete。meta store还保存AuthorityRealmGeneration、storage-domain单调`securityTimeFloorMs`和每个authority realm自己的operation拒绝水位。full authority reset可以退役realm-scoped水位，但绝不能降低storage-domain time floor或跨realm admin dedupe前沿。它们不出现在relay协议里。`chrome.storage.session`只保存一个可重建的`runtimeProjectionV1`及其他显式独立诊断值，并保持`TRUSTED_CONTEXTS`；epoch/realm/build/target markers不得拆成多key后宣称原子。content script调用IndexedDB时属于宿主页面origin，不能直接打开扩展origin数据库；popup/options也必须通过后台admin port，不自行成为第二写owner。

## 2. Key 与 operation 身份

`KeyId` 是扩展生成的高熵、非秘密标识。系统从不主动复用；生成时查当前realm全部active/retained记录。撤销先压缩成保留KeyId的tombstone，至少保留到相关审计/去重窗口结束；依赖只需ownerKeyId时可在各自record内继续保存，Key tombstone满足有界GC条件后允许删除，之后防碰撞依赖128-bit随机安全性而不是无限存储承诺。它只在当前扩展origin的IndexedDB权威域内有意义；另一浏览器配置或另一扩展安装中恰好相同的字符串不是同一主体。轮换 secret 保留 `KeyId`，提高 credential revision，并立即使旧 secret 失效。full authority reset退役整个旧realm并建立新的AuthorityRealmGeneration，同时使旧Key全部不可认证；它不是稳定安装route identity，也不向relay暴露。

“当前扩展origin”是逻辑owner边界，不是不可复制硬件根。若操作者或平台在磁盘层复制整个浏览器profile，Key records、AuthorityRealmGeneration、operation ledger与transport private material都可能被一并克隆；复制后的两个运行实例各自继续写自己的数据库，系统无法提供跨副本原子性或全局幂等。多实例客户端必须显式选择current InstanceRef，检测到同一protected proof的多个匹配时报告歧义而非广播；要重新建立唯一权威只能由操作者在副本上做显式full reset/Key rotate。不得用“随机ID通常唯一”掩盖完整状态被逐字复制的事实。

外部 effectful operation 的唯一身份是：

```text
OperationIdentity = (current extension authority realm, authenticated KeyId, OperationId)
```

当前 authority realm 不需要也不得通过 relay 暴露为稳定安装身份。两个 Key 可以安全复用相同的 OperationId 字符串；不同扩展实例中的相同 KeyId/OperationId 也彼此无关。

OperationId是caller-generated idempotency token，不是第二业务身份。Agent/integration必须在逻辑operation首次发送前生成并在投递/响应不确定时保留同一ID与同一intent；relay与extension不得代生成、替换，或从clientRequestId/relayRequestId推导。generated SDK/skill可以提供本地CSPRNG helper，但要么要求调用者显式传入OperationId，要么必须在首个网络字节前把新ID返回并交给调用方状态持有；禁止内部隐藏“生成后立即发送”，否则连接丢失时caller没有可查询/重投的identity。该helper不是relay local kind、不持久化业务owner，也不能在DeliveryUnknown后自动换ID。扩展仍是当前realm/Key命名空间中的唯一登记、同ID异intent冲突与到期裁决者。

OperationId 使用闭合格式：

```text
op1.<13-digit-unix-ms>.<base64url-16-random-bytes>
```

- timestamp数值域固定为`1000000000000..9999999999999`，不是“任意长度整数再pad成13位”。configurator只从active integer point的显式`contributesToSecurityTimeHorizon=true`上界及固定descriptor的显式duration contribution派生`maximumRequiredSecurityHorizonMs`，因此可提交上界固定为`9999999999999 - maximumRequiredSecurityHorizonMs`；pending default、名称或prose不得被偷偷计入。任何可能随后做checked-add的floor都必须先落在该安全域。fresh storage的security time至少初始化到下界。wall clock低于下界时沿用单调floor；高于派生安全上界、非有限值或任何checked-add溢出时进入typed clock fault，不提交坏floor、不wrap/clamp后继续授权。transport、authority storage与错误secret判定仍可在线；正确secret的新业务请求在command/operation admission前返回`CLOCK_UNTRUSTED/KnownNoEffect`，错误secret仍只返回`UNAUTHENTICATED`。已accepted但未fence的operation可durable结算KnownNoEffect；已fenced operation的匹配callback仍能以最后合法floor和显式clock-quality提交phase/receipt，但依赖wall比较的deadline/expiry/GC暂停，最终正文披露失败使用phase-sensitive`RESULT_WITHHELD`。受信admin诊断可读取最后一个合法floor；因为坏wall value未提交，平台时钟回到安全域后可重新推进。
- nonce 必须由 CSPRNG 生成且至少 128 bit；短编号、递增 `req-101` 或从请求内容可预测的 ID 不合法。
- 创建时间必须位于 registry 规定的去重窗口内，并只允许有限未来时钟偏差；校验时间使用扩展单调不减的security time，而不是可回拨后重新变小的裸`Date.now()`。
- `system.status.minimumAcceptedOperationTimestampMs`只是拥有`system.read`的调用方可选预取，不是effect权限的隐含依赖。每条已认证`operation_id` route对查无既存record的ID做准入窗口检查；窗口外返回versioned resolved pre-ledger `OPERATION_ID_OUT_OF_WINDOW/KnownNoEffect`，detail固定包含`reason=past|future`、`minimumAcceptedOperationTimestampMs`与`maximumAcceptedOperationTimestampMs`。调用方据此创建**新的**OperationId；extension不生成、不替换原ID，也不降低security time或让旧ID复活。
- 该error只证明**这一次**没有建立record、没有effect。收到`Delivered`的窗口外error后，client必须把该ID视为burned并创建新ID；不能根据min/max改写原ID或把旧请求自动排队到以后。`reason=past`因单调reject floor永远保持窗口外；`reason=future`若完全不落record，时间推进后可能自然进入窗口，有限状态系统不能同时声称“不建tombstone”又永久记住任意未来ID。若transport没有带回确定business error而只是DeliveryUnknown，重发同一ID仍代表同一逻辑operation，不会凭空成为第二identity；skill不得把这种不确定自动换成新ID。
- age/reject-before规则只裁决**当前Key/realm中不存在的identity**。请求先完成closed command/params canonicalization，再在authority transaction以当前realm查精确`(AuthorityRealmGeneration, authenticated KeyId, OperationId)`：已有record即使其ID时间段现在已越过新接收窗口，仍在该record自己的`dedupeUntil`内比较intent并join/返回；只有查无record时才用timestamp、future skew与operationRejectBeforeMs决定能否创建。这是“边缘timestamp也获得完整接受后dedupe期”的必要条件，不能先按当前时间拒绝再查ledger。
- 首次接受时冻结`acceptedSecurityTimeMs`和`dedupeUntil = acceptedSecurityTimeMs + resolved dedupe window`；调用者即使把合法timestamp放在年龄窗口边缘，也得到完整的接受后去重期。到dedupeUntil前identity tombstone不得被容量回收；容量不足必须在接受和 effect 之前返回 `LIMIT_EXCEEDED/KnownNoEffect`。
- 完整结果正文可以比 identity tombstone 更早过期；届时查询返回已完成但 `RESULT_EXPIRED`，不能重做 effect。
- 扩展持久化单调不减的 `operationRejectBeforeMs`。它只能推进到一个**连续安全前沿**：此前所有timestamp对应的accepted identity均已越过各自冻结的`dedupeUntil`；仍有较长旧窗口记录时不得越过它。GC在一个strict IndexedDB transaction中同时推进该前沿并删除前沿以前已到期的tombstone。机器时钟回拨不得降低水位或重新接受旧ID。任意位于派生安全域内、已被扩展观察并strict提交的较晚wall time都会推进security floor；纯本地系统无法区分真实长时间离线与一个仍在可表示域内的错误前跳，因此不伪造“异常跳变自动识别”能力。
- 每条accepted record保存自己的`dedupeUntil`；以后缩短Freedom Point只影响新operation，已有identity仍保留到原期限。

外部 API 不暴露 `OperationRef`。实现内部若使用 slot/generation，只能停留在 extension↔WASM 边界，不能进入 relay、skill、日志或持久协议。

## 3. 浏览器运行与目标引用

扩展在完成 trusted storage 初始化后生成非零 128-bit `ExtensionRuntimeEpoch`，并把它连同内部AuthorityRealmGeneration、resolvedBuildArtifactDigest、target registry状态与完整markers放进单一闭合`runtimeProjectionV1`值。普通 service worker 回收后只有整值schema/integrity、三者绑定与target连续性都成立才继续使用。[`storage.session`的公开合同](https://developer.chrome.com/docs/extensions/reference/api/storage)明确在browser restart、extension disable/reload/update时清空；v1把这一平台语义、顶层`runtime.onStartup/onInstalled`连续性失效信号和packed crash矩阵共同作为能力证据，而不是凭某个残留值猜测。若目标Chromium在这些事件后仍出现可被误认成连续运行的旧projection，profile必须fail closed并轮换epoch，不能静默沿用。full authority reset、realm/build不匹配、session/target连续性状态丢失，以及为防retired marker/编码容量耗尽的主动轮换也生成新值。IDB realm mutation与`storage.session`写入没有跨API事务：realm先线性化时command plane保持关闭，随后reconcile fresh epoch；中途崩溃由下次bootstrap继续。

RuntimeEpoch变化的业务原因不一定能被精确证明，所以统一结算名是`RUNTIME_CONTINUITY_LOST`，不是`BROWSER_RESTARTED`。旧epoch queued operation在新epoch ready前durable KnownNoEffect；旧fenced无receipt转为`EFFECT_UNCERTAIN`并对外表示`RESULT_UNKNOWN/EffectMayHaveOccurred`；completed receipt仍保留。只有epoch在同一live后台执行内主动轮换、且原exact adapter callback仍真实存在时，uncertain记录才可在原DispatchToken/late window内收窄ledger证据；browser/worker/reload连续性丢失后的bootstrap没有这种回调，必须立即清token与敏感payload，不能虚构跨worker恢复。旧ControlState立即不参与冲突，新normal sequence使用新epoch命名空间。这个轮换本身不改AuthorityRealmGeneration、Key或ArtifactRef，也不自动重放或迁移任何effect。

它是防止旧引用误命中新运行的 generation，不是稳定安装/profile ID，不参与 Key 鉴权，也不能由 relay 用来保持 InstanceRef 连续性。

目标引用采用结构化值：

```text
TabRef      = { extensionRuntimeEpoch, chromeTabId, tabGeneration }
DocumentRef = { tab: TabRef, frameId, documentId, documentGeneration }
NodeRef     = { document: DocumentRef, contentRealmToken, slot, generation }
```

`chromeTabId`、`frameId`与`slot`使用各自闭合范围内的安全JSON integer；`tabGeneration`、`documentGeneration`、Node slot `generation`及其他u64 counter一律使用无前导零的规范十进制字符串上wire，避免JS安全整数截断。高熵epoch/token使用固定字节数的base64url-no-padding；显示字符串不能混作另一类型。

- 所有 tab 动作和 control 目标使用完整 `TabRef`；扩展命令 schema 禁止裸 `tabId`。TabRef与DocumentRef只由后台target registry签发；content bridge只上报sender/port/document证据并消费已登记DocumentRef。
- [Chrome tabs合同](https://developer.chrome.com/docs/extensions/reference/api/tabs)把tab ID描述为browser session内的标识，但公开schema不依赖“close后数字绝不复用”这一更强、未冻结保证。每次某个chromeTabId建立新的live mapping时推进`tabGeneration`；close/`tabs.onReplaced`永久退休当前generation，retired high-water至少保留到ExtensionRuntimeEpoch结束。若相同数字再次出现必须签发更高generation，不能删除entry后从1开始。
- tab high-water/retired集合达到generated marker上限、整个target projection达到编码字节上限/实际`storage.session`可用配额，或worker恢复时不能证明session缓存与当前tab集合连续，就进入fail-closed RuntimeEpoch reconcile并使全部旧TabRef失效；不能LRU丢一个closed tab marker后继续沿用epoch。写session前先对完整canonical `runtimeProjectionV1`预编码并检查整值/target子预算；fresh epoch与初始projection通过一次单key`set`完成和完整readback后才发布ref。这里不假设session事务/durability；崩溃后missing/invalid值让下次bootstrap重建，失败时不发布内存-only或半份projection。轮换只能清掉retired历史；若当下active tab/document集合本身仍超限，就在fresh projection记录`targetRegistryState=capacity_unavailable`且不签发ref，等待集合缩小或配置/构建改变后再重建，不能立刻再次轮换形成循环。tab关闭可清理绑定旧完整TabRef的occupation/Document records正文，但不能在同一epoch清理防TabRef复活所需的counter marker。
- target registry只为当前`documentLifecycle=active`的incarnation签发可动作DocumentRef；prerender/cached/pending_deletion可以作为frames观察事实返回，但不带可用于动作的DocumentRef。导航替换或当前document离开active时，立即永久退休该documentGeneration及其全部NodeRef；不能等到下一次动作才决定是否“还是同一页”。
- [Chrome的instant navigation说明](https://developer.chrome.com/blog/extension-instantnav/)明确指出同一`documentId`会在prerender/active/cached生命周期间保持不变，BFCache恢复时还会再次触发active事件。因此每次某个`(TabRef, documentId)`从非active进入active，后台都推进不回绕的`documentGeneration`并签发新DocumentRef；旧generation永远`STALE_TARGET`，即使documentId、URL和DOM对象都再次出现。这样accepted operation不能在“离开页面→BFCache恢复”后穿透旧目标检查。
- 每个`(TabRef, documentId)`的documentGeneration high-water/retired marker至少保留到tab关闭或整个ExtensionRuntimeEpoch退役；不能因该document暂时cached或为节省target表空间而删除后从1重建。全局document marker与target projection bytes均有generated build上限，并在session写前整份预检；retired历史或counter耗尽时拒绝本次签发并进入RuntimeEpoch轮换reconcile，不能LRU驱逐一个仍可能从BFCache返回的旧document identity。若fresh active集合本身无法完整保存，则按上一条进入`capacity_unavailable`，不能再次轮换。
- content bridge port断开只使ContentRealmToken/NodeRef失效；如果后台仍能独立证明active document identity，DocumentRef本身不因一个执行通道重建而失效。反之，只剩port缓存、frameId或URL而无法证明target连续性时，退休document generation；整个session target registry丢失时轮换ExtensionRuntimeEpoch，不猜high-water。
- 同document保持active时的fragment/history-state URL变化不自动推进documentGeneration；依赖URL/origin/host grant的命令另冻结并复核target URL revision，不能把generation当全部target事实。
- 后台每次验证一个bridge port/document注册都生成新的非零高熵ContentRealmToken并绑定exact port route；重连/重注入不迁移旧token。content realm只拥有该token下的有界node slot表。slot generation不得回绕；达到上限时轮换整个realm token或拒绝新ref，具体选择在P5 target/ref实现前冻结。
- NodeRef 只代表“这个 document 中的这个节点 generation”，不是权限凭证，也不绑定创建它的 Key。任何拿到 NodeRef 且拥有对应命令权限、通过当前占据/目标检查的 Key 都可使用它。
- NodeRef identity本身不编码墙钟`expiresAt`。query在内部entry冻结TTL，并可在结果元数据中给出`remainingTtlMsAtResponse`之类的观察提示；提示不参与identity，也不证明到下一次调用仍有效。content realm对当前DOM node做identity interning：同一node已有未过期entry时返回完全相同的slot/generation且不续期；新query在一个不跨await的content turn中先解析完整有界结果、复用existing refs并预检全部新增slot容量，容量不足则`LIMIT_EXCEEDED`且一个新slot都不提交，容量足够才整批分配。因此丢response后的同realm重试不会为相同节点继续泄漏slot。realm使用单调elapsed time并锁存expired；realm重建由新token整体失效。只回收已过期或已确认disconnect的entry并在复用slot时递增generation；不得用另一个Key的查询LRU驱逐仍有效ref。若以后需要主动释放，另登记显式命令，不暗含在query/action里。
- content/page/userScripts 永远不接收 Key、KeyId、permission bitset、operation ledger handle 或 admin route。

## 4. Occupation 与 artifact 引用

OccupationId 的概念结构为：

```text
OccupationId = {
  extensionRuntimeEpoch,
  scope,                 # global | tab
  targetTabRef?,
  ownerKeyId,
  generation
}
```

每次从空闲变为占据都从对应ControlState的持久generation high-water递增产生新值；record内部另冻结owner当时的`controlEligibilityRevision`，但该revision不进入公开OccupationId。release只清current owner，不回退/删除high-water。同 Key 对同一当前有效占据重复 acquire 是幂等读取，返回原 OccupationId。owner的control eligibility变化后旧占据永久失效，即使后来恢复相同权限也不会复活；无关permission、secret rotation或displayName变化不影响。release 必须带调用方刚观察到的完整 `expectedOccupationId`；跨 Key 冲突响应会返回所需的一个或多个当前ID，因此不需要隐式 takeover 或先做额外状态命令。迟到 ID 不得清除后来建立的占据。

“失效后调度清理”绝不授权异步任务按scope盲删。判定失效的事务可以在建立新occupation前原子覆盖旧record；若交给后台sweeper，则cleanup job必须冻结完整OccupationId及其内部ownerControlEligibilityRevision，并在同一strict transaction重读仍精确相等后才清current owner。tab close/replace、Key失效、expiry与capacity GC均遵循相同compare-and-clear规则；旧cleanup晚到时只能no-op，不能删除同scope/TabRef上后来更高generation的占据。

ArtifactRef 是不透明`ar1.<base64url-32-byte-random>`。ArtifactId由扩展CSPRNG生成、对当前realm的live/tombstone记录查重且从不主动复用；旧tombstone最终删除后的防碰撞依赖256-bit随机安全性，不伪称无限存储下的数学绝不碰撞。ownerKeyId和创建RuntimeEpoch只存在record，不编码进公开token。Artifact是已持久化的不可变结果，所以普通worker/browser restart不能仅因RuntimeEpoch变化使其提前失效；full authority reset则整体退役旧realm。Artifact到期使用扩展单调effective time或durable expired marker，一旦判定过期不得因墙钟回拨恢复。默认只能由 owner Key 读取/释放；跨 Key 操作必须由 Command Registry 显式声明 `.any` 权限并逐次检查。知道ArtifactRef不授予访问权，也不给relay一个可主动用于重连路由的realm字段。

ArtifactStagingToken只防止旧物化回调把chunks并入另一代staging manifest；它不是DispatchToken、permission或effect receipt。metadata状态闭合为`staging_open | committed | orphaned | released_tombstone`。每个chunk写事务同时触发metadata和chunks store：先要求metadata仍是`staging_open`、token/operation/phase相同、operation仍允许该phase的result且未越过冻结`writeUntil`，再要求`(ArtifactId, token, chunkIndex)`不存在，写入bytes并在同事务向有界manifest加入length/digest。同index重投只能对完全相同bytes返回no-op，不得原地覆盖。final commit同时触发operation与metadata store，只接受相同token、operation identity、phaseVersion、仍可接受的late-result状态及精确匹配的完整manifest count/bytes/root digest。所有writer、terminal close与final commit因共同metadata store而排序；commit后metadata冻结该token作为reader选择不可变chunk generation的内部字段，但`committed`使所有后续chunk写失败。operation不再允许late result或期限到达时，同一strict transition必须把metadata改为`orphaned`并关闭写权，不能只把operation结算terminal。reader逐chunk验证冻结length/digest；不能靠猜到同一token覆盖正文。orphaned staging保留token到GC完成，不能借它提交另一个operation。

受信admin页面为每次用户手势生成`am1.<13-digit-unix-ms>.<base64url-16-byte-random>` AdminMutationId并在响应不确定时只重发同一ID。UI在启用mutation控件前先从后台只读取得`minimumAcceptedAdminTimestampMs`，它至少是storage-domain time floor与admin连续reject前沿允许的下界；生成时间段取`max(Date.now(), minimumAcceptedAdminTimestampMs)`。后台用相同storage-domain effective time做past/future window判断，因此系统时钟回拨不会让本机恢复面凭空停摆，且ID仍在首次mutation发送前由UI生成。后台验证sender/port后，以当前extension storage domain内的AdminMutationId去重并保存intent digest/最小receipt。同ID异intent固定冲突，不执行第二次。每个accepted ID冻结dedupeUntil，窗口内tombstone不得提前GC；窗口外拒绝只证明该次KnownNoEffect，UI收到确定拒绝后burn该ID。past ID由单调前沿持续拒绝；future ID在不写拒绝tombstone的前提下不作虚假的永久记忆承诺。容量不足在mutation前拒绝。receipts跨full authority reset保留到各自窗口结束。若由后台收到mutation后才生成ID，丢响应时UI无法证明重试是同一mutation，因此该路线禁止。AdminMutationId只解决内部admin plane的重复投递，不成为Agent身份、Key或occupation owner。会自擦该dedupe domain的factory reset响应不确定语义尚未闭合，v1当前延期；卸载/浏览器外清数据仍是平台动作。

AdminMutationId timestamp使用与OperationId相同的13位闭合数值域、派生安全上界和checked arithmetic。若当前wall clock越过安全域，UI不能把坏值塞进ID；后台返回最后合法minimum floor并标记clock fault，允许受信admin读取诊断，但在clock恢复前不谎称普通Key expiry/operation时间可安全裁决。

AdminMutationId同样先查exact retained identity、再对absent ID应用时间窗口/reject-before；已接受记录在自己的dedupeUntil内不能因墙钟推进而被先判out-of-window。该顺序不允许未知ID绕过floor，只保证已存receipt可重放。

## 5. relay InstanceRef

本地 relay 每次启动生成 CSPRNG 非零 `relayEpoch`（至少 128 bit），并把 `instanceNumber` 从 1 以无符号 64-bit 单调递增。完整引用为：

```json
{"relayEpoch":"m0n2p4q6r8s1t3u5v7w9xA","instanceNumber":"1"}
```

- 一条完成 extension role 握手的 socket 恰好分配一个 InstanceRef；同 socket 重复 hello 不得分配第二个。
- 断线立即失效；重连是新 socket、新 instanceNumber；relay 重启是新 relayEpoch。
- 计数器不得回绕或复用；达到上限时拒绝新实例。
- `targetInstance` 只存在于 Agent→relay profile；relay 选定 socket后必须删除。extension profile、WASM profile和扩展持久状态出现任何 instance 字段都应 schema 拒绝。
- 零实例返回 unavailable；一个实例且省略 target 时可以解析到该实例；多个实例必须提供完整 targetInstance。
- InstanceRef 没有跨断线连续性。relay 不引入 extension 安装/profile 稳定身份；多实例重连后不能自动猜测哪个新 socket 持有旧 operation ledger。某个当前实例返回对象专用的not-found错误也不得被解释为“其他实例一定没有执行”。

## 6. 明确禁止的关系

以下推导全部非法，并应有负向测试：

- Agent 名称、进程、可执行文件、Origin、连接、socket 或 InstanceRef → Key 权限、队列主体或 occupation owner。
- relayEpoch/instanceNumber → ExtensionRuntimeEpoch、KeyId、OperationId 或稳定浏览器实例身份。
- clientRequestId/relayRequestId → OperationId，或反向复用。
- NodeRef → 调用权限；ArtifactRef/OperationId → 跨 Key 结果披露权限。
- Root → 未安装命令、缺失 host permission、受限页面、用户脚本开关、用户手势或 Chrome 调试确认的旁路。
- `js.execute` → DOM/raw/resource 等 permission bit 自动闭包。它们是并列入口；脚本事实上能完成部分同类效果不改变权限模型。

transport 的 Origin/Host/path/role 校验只阻止网页或错误 endpoint 进入本地协议，不是新的业务 caller identity。relay 在请求存活期间看得到 bearer Key，属于该 Key 的 transport TCB；“relay 不拥有业务状态”不能表述成“relay 在密码学上无法冒充该 Key”。
