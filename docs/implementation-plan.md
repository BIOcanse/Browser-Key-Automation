# 实施顺序与验收门 v0.9

更新：2026-08-30。运行时实现已经恢复并形成可安装纵切；`page.tree.open.v1 / expand.v2 / view.get.v1` 已落地为按未刷新文档缓存的唯一 operation tree、按 Key 展开状态和一次性 view GET，不含 selection。执行仍以真实纵切优先，registry、反向门和测试随真实 consumer 闭合，不用继续扩文档替代实现。

当前事实：浏览器核心、Key/control、DOM/JS/Artifact 与页面操作树连续链已经通过真实 Chromium—relay；表内 P0-P5 的大量完整硬化候选并未因此整体完成。下一产品设计点是用户后续单独裁定的页面智能选择算法，不反向污染 canonical tree。

## 1. 排序原则

- 每阶段必须形成可独立证伪的闭环；“声明过”“写了handler”“resolved build激活”“可从Agent调用”分开记录。
- extension是primary application与业务owner；Zig/WASM做pure validation/transition，TypeScript/JS做Chromium、storage和DOM I/O；relay只处理本地transport。
- 权威和Key先于真实transport；真实transport先于operation与浏览器effect。不能让半条无鉴权socket或假handler跨阶段占位。
- 每个ID/ref/revision先声明owner、generator、namespace、persistence、invalidator和exhaustion，再进入schema。
- 每阶段只激活拥有真实source consumer、generated projection、probe/test与反向校验的registry项和manifest依赖。
- 读取、诊断和测试不能隐藏创建、启动、权限请求、debug、重导航、网络或fallback。
- Chromium版本只筛选候选，packed extension中的feature probe和行为证据才是运行事实。

## 2. 阶段

| 阶段 | 实施 | 必须通过才能进入下一阶段 |
|---|---|---|
| P0：构建与静态引导基础 | 固定Zig/Node/TS；四registry闭合schema；configurator resolve/emit/completeness；生成Zig/TS/manifest/CSP；MV3 module worker；TS strict scanner + WebCrypto seal验证；包内WASM startup self-test | strict registry/JSON正负例、P0四摘要域的TS/native/WASM golden、双次重建一致；seal完整性与WASM effective capability分层；CSPRNG只证明API/shape/failure并用有限generation attempts，绝不声称样本可证明熵；release artifact的packed worker/WebCrypto/WASM可加载；manifest无storage/alarms/host/content，CSP connect-src仅`'self'`；仅允许精确包内seal/WASM读取，无外部网络与业务状态调用 |
| P1：MV3 authority骨架 | 顶层listener与plane隔离；extension-origin IndexedDB schema/explicit strict transaction capability；无原始请求排队的hydration barrier；AuthorityRealmGeneration、ExtensionRuntimeEpoch、security time；admin sender/port矩阵；storage.session单一闭合`runtimeProjectionV1`；顶层startup/install连续性失效信号 | worker recycle保持epoch；storage.session按官方合同在browser restart/disable/reload/update清空，并以`runtime.onStartup/onInstalled`作冗余失效证据；若packed目标出现旧projection假连续就fail closed；IDB strict/abort/blocked/versionchange/quota/integrity fail closed；persist拒绝只报告风险而非伪造不可用；projection整值write/readback且无假跨key原子；未ready入口有界拒绝；content/page/external-extension进不了admin/authority；尚无外部command route |
| P2：Key与runtime facts | Key格式/verifier；Root/regular逐atom策略；admin面create一次secret、update/revoke/rotation/expiry；runtime settings desired/applied；AdminMutationId；`empty \| active` Root recovery container/独立tombstone与写入headroom。Agent侧`keys/settings` mutation仍pending | secret不落盘/日志/content；时钟回拨不复活；revoke清verifier；ordinary active+retained tombstone容量准确；权限不可洗高；admin create/rotate响应反复丢失不新增Key slot；recovery revoke原子释放container且旧ID仍留tombstone；全部Root丢失与**系统管理的普通配额**已满仍可恢复；外部物理quota失败如实fail closed；revision竞态 |
| P3：relay与第一条真实外部纵切 | Windows/Linux薄Zig relay；两个role path/subprotocol/Origin门；server-first hello；InstanceRef；packaged offscreen `WORKERS` document + dedicated transport worker主动连接；10秒无限retry + alarms重建 + exact two-sided transport ping/pong/deadline；skill/native client；带Key的`system.describe`及同源generated TS permission evaluator | 两平台真实运行；packed Origin由identity profile固定；网页/错误服务/端口占用、bind→listen并发启动收敛及半握手资源耗尽负例；direct/代理/PAC、默认implicit bypass/`<-loopback>`负例、普通/专用`127/8`、有无host grant、预置Cookie/HSTS/HTTP/proxy auth、LNA WebSocket提示与错误response矩阵。静态矩阵不能冻结运行时proxy：明文候选须有当前deployment持续DIRECT证据与变更失效，否则P3先闭合端到端application保护；该profile仍只给调用方一枚API Key，端点认证/加密只终止于native client与extension后台，并先闭合verifier-only存储兼容性，opening request状态/LNA仍单独过门；loopback CSP/API/host-permission三类投影正负例；route descriptor的service-worker/offscreen-worker/storage-session/alarms/WebCrypto/strict-IDB/WebSocket capability闭包；same-task ArrayBuffer/binary-only模式；ping/pong exact shape、单outstanding、错ID和两侧deadline不进business Port；offscreen transport-only scanner→background full scanner双检；每条incoming source以`inboundItemId`计费，background先取得admitted-command目标预算、copy双计后才exact release，同route response不得越过，service worker回收时pending Port/source关闭；无载荷bridge唤醒、descriptor/release/business单outbound slot + `bridgeItemId` exact ACK（含迟到重复负例）/timeout/context teardown、desired/applied descriptor revision、local wait的`route.abandon`；零/一/多实例只选current目标且无未来socket spool；relay与extension各自全部可控内存bucket组合预算闭合；TS/native/WASM权限真值一致；`system.describe`零业务effect且WASM缺口时仍能返回effective-global capability子集 |
| P4：operation与ControlState纯核 | caller-visible OperationId登记与窗口外pre-ledger detail；`system.status`；per-Key admission/FIFO；short lane；intent/resolved digest；durable accepted/fence/receipt；DispatchToken；ControlState纯transition与synthetic full-ref fixtures；非产品、不可路由的synthetic effect adapter。激活无需TabRef的真实Agent纵切：`keys.list/get/create/update/revoke`、`settings.get/update`、`operations.get`；`operations.cancel`等首个可取消normal operation出现后再激活，Agent `control.acquire/release`仍pending | transport上真实证明OperationId在首个network byte前已由caller持有、min/max、internal mutation原子receipt、一次性secret单recipient、settings desired/applied和query；`keys.list`用collection revision/keyset/items+bytes双门且无server cursor；exact retained identity先于absent-ID时间准入；每个persist/effect/ACK crash点；同Key不双effect；前序terminal前后序不fence；different-Key无全局长FIFO；pure control transition证明release/acquire严格两步；worker执行丢失后的orphan fence在ready前立即uncertain、清token/secret plan/关闭staging且不等wall clock；Root不旁路control；没有真实TabRef时不伪造外部control target或cancel能力 |
| P5：target/ref、control route与只读浏览器能力 | capability probes；tabs/frames；TabRef/DocumentRef active-incarnation generation/ContentRealmToken/NodeRef；静态content bridge；有界单值target session projection；激活`control.acquire/release`；`tabs.list/get`、`page.dom.get`、`dom.query/describe` | tab close→同数字复用、onReplaced、导航、prerender→active、active→BFCache→active、document/port替换、history-state、retired历史超限→一次epoch轮换、active集合仍超限→target capability unavailable而非轮换循环；content request总并发/reply source bytes与platform-copy边界；DOM增量builder不先构造全量；selector有界遍历不先物化无界NodeList；NodeRef per-realm + global lease、同node interning/整批预检/耗尽/Port失效归还及late reply均按generation裁决；旧Tab/DocumentRef绝不复活；缺bridge/cross-frame/host/restricted URL如实不可用且read不补注入；页面拿不到Key/DispatchToken/admin route；read零browser/DOM隐藏effect且发送前复核披露权限 |
| P6：逐个真实effect adapter | `page.archive.capture` → tabs动作 → 固定DOM动作 → `resource.fetch` → `js.execute`；每项独立permission/schema/capability/control/limits/receipt；artifact物化 | 页面归档先验证显式`pageCapture` manifest/capability、MHTML≠原始HTTP、API `undefined`/异常、Blob超限、抓取中target变化、浏览器已分配完整Blob的availability边界、bounded slice写入及每个staging/commit/crash点；其后每个adapter单独过P4 crash矩阵，覆盖host撤权、USER_SCRIPT/MAIN、partial effect、timeout/uncertain和跨Key容量；不自动切CDP、不伪造浏览器级输入 |
| P7：增量能力 | wait、截图、下载、显式debug/CDP等按真实需求逐项登记 | 每项有真实consumer与manifest反向门；Chrome调试确认原样存在；错误/effect evidence/limit/crash矩阵通过 |
| 页面操作树 | `open.v1 / expand.v2 / view.get.v1` 已实现唯一缓存 canonical tree、按 Key 展开状态、层级/sibling range/subtree 一次性 view；无 selection/collapse | 真实 Chromium 覆盖缓存、多 Key、frame、长值、刷新失效；historical Cleaner/PageIR 不复活 |

## 3. 阶段依赖的反证理由

- P0不能连接loopback：没有authority ready、Key、完整握手、deadline与MV3恢复时，网络尝试既非零副作用，也没有安全业务意义。
- P3不能晚于浏览器effect：否则P4/P5/P6只能在测试内自说自话，无法证伪真实Key鉴权、wrong-instance、断线和response route。
- P2可以用受信admin plane建立首个Key，但不能提前开放Agent侧`keys.create/update/revoke`或`settings.update`：它们是带OperationId的internal mutation，必须等P4 operation ledger原子提交路径存在。P4用这些真实无TabRef接口闭合Agent operation纵切；synthetic effect adapter只做内部crash门，不进入Command Registry或activeCommandIds。
- `operations.cancel`不能因核心transition已写好就提前active；没有真实可取消normal command时它没有产品consumer。P4先开放`operations.get`，cancel与首个可取消normal route同阶段激活。
- `system.describe`不依赖WASM成功才能诊断WASM。它由generated TypeScript静态描述器和从同一permission expression发射的TS evaluator实现；WASM startup self-test只成为其一个capability事实。这个bootstrap evaluator只允许`extension_generated + effectKind=none + idempotencyKind=none`，并须与native/WASM真值fixture一致，不是手写鉴权旁路。
- `transport.retry_interval_ms=10000`虽然已由用户确认，仍在P3真实scheduler落地前保持pending；确认默认值不等于存在runtime consumer。
- `system.describe`保持`key_required`。P2以前不存在临时无Key Agent route；P3在一次变更中接通relay、auth、handler和route。

P0详细合同见[P0构建与静态引导](implementation/p0-vertical-slice.md)。

## 4. P0首个实现提交

```text
registries/{freedom,commands,errors,capabilities}.registry.json
modules/configurator/
modules/protocol/{canonical,transport,command}/
adapters/extension-wasm/
apps/extension/ 最小module worker + TS strict scanner/WebCrypto seal + packaged WASM self-test
generated/ 可重建投影
tests/{registry,protocol,wasm,extension}/
```

当前所有registry声明保持pending。源码与反向门落地时，只把P0真实消费的module worker、bootstrap WebCrypto、packaged WASM、strict scanner limits和`build.extension.maximum_wasm_linear_memory_bytes`等必要build fact在同一提交激活；WASM memory point必须被最终binary/imported Memory maximum与越界growth fixture反向消费，不能只生成常量。Command/Error/IndexedDB/storage.session/alarms/transport继续pending。构建从空generated目录可重建，生成物携带catalog/build digest但不成为authoring source。

## 5. P3 transport门

第一条外部纵切必须同时证明：

1. relay只绑定生成的单一numeric IPv4 `127/8` endpoint；pending `127.0.0.1:32189`不是用户冻结值，普通/专用loopback地址须先过两平台bind与Chromium凭证状态矩阵。listener exclusive、不可继承且禁用多owner bind；native client direct-connect并忽略proxy/PAC/credential环境。path/subprotocol是版本化transport常量；不扫描、不fallback。
2. 在隔离profile中对direct/系统代理/PAC、默认implicit bypass与`<-loopback>`取消负例、有无host grant、普通/专用`127/8`、预置Cookie/HSTS/HTTP/proxy auth做effective proxy decision/request destination/header capture，并让错误listener返回有效/无效101、3xx、Set-Cookie、401/407及代表性Fetch状态header后复查redirect、浏览器状态、Chrome 147+ LNA WebSocket提示与UI。product path的opening request不得泄露浏览器托管secret、污染未声明状态或产生未闭合交互。对当前明文application候选，还必须在本次deployment持续证明DIRECT、instrumented proxy看不到hello后bytes，且proxy/PAC/policy变化会撤下capability并关闭socket；一次实验室通过不够。一般Chromium环境若不能观察该动态事实，P3先闭合端到端认证/保护application bytes的版本化profile：relay/offscreen仅转发opaque value且不做Key授权/解密，crypto在native client与extension后台终止。该profile不得用一句“由Key材料”跳过Key record设计；当前verifier-only持久化不能直接当双向session key。优先验证“extension endpoint proof封装进同一API Key token、transport private key留后台”的路线；若改为持久化credential-equivalent派生值，必须先显式裁定at-rest语义。MV3生命周期再要求在两个闭合模式中选择：每请求独立密封且新background可恢复版本化private material，或易失长会话并在background Port丢失时立即关socket；offscreen持钥、会话假连续和未声明session key持久化都禁止。密码学transcript/replay/KDF/AEAD nonce/counter、request/response binding、forward-secrecy边界、key rotation/loss、redaction及native/WebCrypto golden先单独通过。即使application加密，opening request状态与LNA仍不可跳过。
3. packed extension Origin来自固定打包/签名或显式dev profile，不首次学习、不跨profile沿用；product relay的101 response固定无Set-Cookie/auth challenge。
4. Capability对API `permissions`、`host_permissions`和CSP `connect-src`分栏生成；当前loopback空host-permission候选必须在packed Chromium中证明，失败就先改authoring而不在template暗加。
5. relay/extension/client只比较共同transportCompatibilityDigest；extension/client/skill另比较commandProtocolDigest，relay仅记录/回显。各自component artifact digest只作精确构建证据，Windows/Linux/extension之间不要求相等。
6. relay只有`forward | instances.list | relay.stop`；后两者是native local envelope，不进Command/Error/Key UI/WASM。
7. relay只验证transport shape/bounds/target并把auth+command当opaque bounded value；method/Key/OperationId/permission均由extension验证。
8. InstanceRef由relay在完成extension role握手后生成；extension从不接收、存储或解释。
9. response route冻结`connectionGeneration + relayRequestId + exactSocketHandle + exactOffscreenPort`；旧handler永远不能写新Port/socket。relay本地wait/client route结束后best-effort发送transport-only `route.abandon`释放该响应路径，绝不等价于`operations.cancel`。
10. `waitTimeoutMs`只终止本地等待，不进入command/effect deadline、不cancel operation、越界不clamp；零实例/多实例省略target/stale target均立即KnownNotDelivered，不保存Key/command等未来socket。
11. retry由offscreen dedicated worker singleflight执行、无限、无backoff/上限/放弃；10秒使用live worker的`performance.now()`语义单调cadence，alarm只重建context，context重建立即attempt，休眠不冒充墙钟SLA。
12. application `transport.ping/pong`有closed shape、单outstanding、最小发送间隔、extension pong deadline与relay application-idle deadline；两侧任一过期都关socket。RFC协议Ping/Pong按closed raw规则有界处理，却不能刷新worker liveness或进入background业务Port。
13. relay从TCP accept起限制总socket、pending handshake、header bytes/fields与deadline；所有socket当前保留的HTTP/role/message assembly bytes还在分配前共享global raw-input reservation，不能让局部上限乘连接数绕过allocator预算。message转入forward/response queue时先取得目标预算，copy并存同时计费，禁止accounting gap；resolver再把raw + forward + response + copy + socket/route/parser/control最坏开销求和并证明不超过`build.relay.maximum_managed_memory_bytes`。HTTP/WebSocket codec固定Accept/subprotocol、mask方向、RSV/opcode、control rate、最短length与fragment状态机。role完成后再限制native client、idle socket、per-client in-flight、全部已选current route、per-extension route和全局buffer。超限不forward，断线/deadline/terminal准确归还；恶意网页仍可能造成**有界availability denial**，门只证明资源有上界，不伪称公平或不可拒绝服务。零实例不建立任何wait/route。
14. extension incoming source bytes、background admitted-command bytes、outbound response bytes和browser WebSocket `bufferedAmount`分别有build上限；实现自有的UTF-16/copy/encode/typed/WASM/parser/route/control allocation以生成的最坏扩张系数计费，并把全部同时存活bucket及转移copy checked-sum到`build.extension.maximum_managed_memory_bytes`，Chromium内部copy只声明availability边界。worker给每条incoming bridge source分配不回绕`inboundItemId`；background full scan后先取得typed/auth/dispatch目标reservation，source与target并存期双计，才可发exact release。目标owned value持续到plan/handler不再需要；`route.abandon`不cancel operation，不能据此提前归还。同route business response不得越过release ACK。exact Port对descriptor/release/business共用一个全局outbound slot；每项带不回绕`bridgeItemId`，descriptor ACK匹配ID+revision，release ACK再匹配inboundItemId，business ACK匹配ID，A迟到重复ACK不得释放B。descriptor只保留最新desired，business count由route closed state、release count由unreleased source派生，三类公平调度并各自冻结单调timeout；超时失效Port/route并销毁transport context。progress可丢；accepted/terminal/read不能安全排队时关闭socket，operation durable truth不丢、不改投，secret清除。
15. `relay.stop`由唯一coordinator线性化进入STOPPING，停止accept/route后best-effort ACK、清易失表、关socket并退出，不改业务状态。固定detached/hidden launcher使兼容relay不依赖父进程、stdin或首个client；空闲native socket可到期关闭但不结束relay。
16. 并发启动中每个client coordinator只有一个probe socket在途；下一probe需前一结束且start interval已到，每次handshake再由总monotonic deadline截断。多个client仍由relay全局socket/handshake门界定；只复用通过fresh hello的兼容赢家，connection failure不谎称进程不存在，spawn failure/总超时分开typed，不杀未知进程。
17. browser WebSocket只在完整message交付后暴露`byteLength`，所以fragment count/assembly deadline只能由拥有raw frame parser的relay/native端强制；extension不得伪造“重组前限额”证据。WebSocket默认Blob必须作为负例；worker在构造器返回的同一task设置ArrayBuffer，所有incoming data精确检查、所有outgoing JSON以UTF-8 binary bytes发送。合法relay不协商compression并发送单一binary message，extension仍在平台已分配后、复制/parse前限最终message。
18. background/offscreen-page/offscreen-worker/admin/content/user-script分别编译并过import-graph/AST门；offscreen不得直接打开IndexedDB、import authority/business adapter或调用页面自动化Chrome API。

多实例识别另设阻断门：明文profile不得向每个InstanceRef试发同一bearer Key；无明确目标时fail closed。受保护profile若采用token内endpoint proof，必须先以transport-only、无bearer的有界探测在current refs中得到唯一匹配，再把crypto session绑定exact InstanceRef并发送加密Key；零/多匹配、断线、重连及外部复制profile造成相同proof/Key/realm的情况均不得first-wins、broadcast或声称跨ledger幂等。

protected profile的资源门必须在同一实施变更加入wire ciphertext↔application plaintext膨胀关系、独立transport-crypto并发池和decrypted-application byte bucket；decrypt前先reserve目标，ciphertext→plaintext→typed command及response plaintext→ciphertext的所有重叠同时计入extension managed-memory。错误proof/tag、probe风暴和worker回收都必须精确归还，不能让加密层成为绕过现有source/admitted预算的新队列。

## 6. P4 operation / ControlState 安全核门

synthetic adapter必须证明以下固定顺序：

```text
caller creates OperationId before first send
and caller possesses that exact ID before the first network byte
→ synchronous per-Key identity reservation
→ accepted record + sequence high-water durable
→ accepted ACK / runner visibility
→ fresh authority/control/target/capability precheck
→ background generates a DispatchToken bound to AuthorityRealmGeneration and commits dispatch fence
→ adapter invocation in the same authority continuation
→ phase + typed receipt durable
→ terminal response/query visibility
```

`system.status.minimumAcceptedOperationTimestampMs`只是可选优化。P4构建门要求每个`idempotencyKind=operation_id` route在精确identity lookup查无record后，直接执行窗口准入；越界必须以versioned `OPERATION_ID_OUT_OF_WINDOW` detail返回`past|future`及min/max，且不建立ledger record。caller收到Delivered error后burn旧ID并创建新ID；DeliveryUnknown仍重发同一逻辑ID。extension不代生成或改写ID，也不能要求effect Key额外拥有`system.read`。

generated SDK/skill不得把OperationId隐藏在“一次调用内部生成后立即发送”。它必须要求caller显式传入，或先通过本地helper把ID交给caller、再执行单独send；helper不进入relay协议，也不因DeliveryUnknown自动产生新ID。

P4还必须在同一实现变更中为真实Key/operation表建立Freedom declarations与consumer：至少闭合active/retained record count、内存index bytes、单批cursor count/bytes、按需完整plan load及active-handler bytes。hydration只常驻有界索引/runnable摘要，durable queued/tombstone正文留在IndexedDB；不能把整张Keys/operations表读入JS Map后仅凭磁盘配额宣称内存有界。当前没有consumer，所以现在不预填这些slot默认值；但缺少它们时P4 route不得active。

强制注入：

1. lookup/reservation、accepted storage、ACK、fence、adapter call、receipt和response前后全部崩溃点。
2. 同identity同/异intent并发；同Key多socket；sequence持久化快慢反转；GC后不复用sequence。
3. Key权限/expiry/control/target/capability在precheck各字段间变化。
4. queued/cancel、fence/cancel、uncertain/late receipt的所有winner。
5. content port、worker、browser、extension、relay/client在每个phase断开；worker bootstrap看到无本次live continuation的fence必须在ready前立即uncertain并擦除token/敏感plan/关闭staging，不得等待wall deadline；full authority reset与旧realm late callback竞争时，旧callback不能写入或创建新realm记录。
6. dedupe/result窗口、quota满、OperationId过旧/未来、时钟回拨/前跳、rejectBefore先提交后GC。
7. internal mutation跨store transaction每个request/commit点终止，只能全提交或全abort，且绝不调用browser adapter。
8. 前序adapter在当前live worker中不返回时按冻结deadline结算uncertain；只有这种仍有exact continuation的路径保留`dispatchPhaseVersion/currentUncertainPhaseVersion + DispatchToken + lateEvidenceAllowed=true`做late CAS。worker执行本身丢失则bootstrap立即uncertain、清token并置false。两者都必须在释放同Keynormal FIFO前durable，不能永久堵塞或重放。
9. 每个operation phase的canonical record/index bytes在同一transaction更新storage-domain ledger usage；单record和总量分别过门。full reset后旧ledger/artifact/chunks仍以retired-pending-GC分类计费，只有实际删除batch提交才释放；连续reset不能获得新大容量，最小Root recovery另有固定headroom。logical账本、`navigator.storage.estimate`与真实quota失败三者分别测试，不能互相冒充。

任何失败先修operation核心，不让真实adapter用“best effort最多一次”绕开。

## 7. 长期验收矩阵

### 身份、生成权与容量

- 同Key跨Agent/进程/连接共享权限/FIFO/occupation；不同Key相同OperationId互不冲突。
- OperationId由调用方首次发送前生成；Tab/Document/ContentRealm/Dispatch/connection generation由各自全局owner生成；InstanceRef只由relay生成。
- 同Keynormal动作以扩展coordinator的durable admission顺序串行；并发多socket请求不承诺网络先后，显式因果必须由前一条durable accepted/terminal建立。
- revision/generation不回绕，耗尽fail closed或轮换上层epoch；任何ref都不授予Key权限。
- Key普通容量满、tombstone待GC、secret响应丢失和全部Root失效均不封死受信恢复面。
- Root令当前resolved artifact中全部`status=active` permission atom为true、未来新激活atom自动加入；pending/retired不进入运行时向量，且无未声明命令、target/control/capability/host或Chrome确认旁路；不得从命令使用情况或UI暗推一个registry中不存在的`grantable`状态。

### control与并发

- `none/global_only/target_tab/global acquire`四组谓词逐项真值测试。
- same-Key acquire幂等；foreign acquire只返回冲突；release必须exact expectedOccupationId；第三Key可以在两条命令间插队。
- invalid Key旧occupation在判定上立即无效并惰性清理；release后旧in-flight如实报告。
- K1 navigate/K2 click、K1 blocking MAIN/K2 DOM证明“扩展调度独立不等于页面隔离”。

### MV3与页面边界

- 顶层listener、统一hydration、IDB strict/abort/blocked/quota/integrity、session trusted access且不依赖`onSuspend`。
- worker recycle保持runtime epoch，但其旧adapter callback不复活：orphan fence在authority ready前立即uncertain。browser restart/reload依`storage.session`清空与startup/install失效证据换epoch并正确结算旧queued/fenced；目标平台若保留旧projection造成假连续就fail closed。
- content/page永远拿不到Key、DispatchToken、admin方法或receipt写权；bridge route丢失不跨worker恢复。
- userScripts开关/world/messaging、host/file/incognito/restricted URL、permission撤权逐目标probe。
- `page.archive.capture`验证MHTML而非原始HTTP、显式pageCapture manifest/capability、`undefined`/异常/超限Blob、抓取期间target变化、固定小块物化和Chrome完整Blob内部峰值availability边界；MHTML按opaque下载处理，不在扩展UI中直接执行。
- tabs create/close在active前必须闭合目标window与active/inactive副作用；不得用Chrome“当前窗口”默认或`all_occupations`粗锁掩盖缺失target模型，无关tab occupation不应阻断可独立动作。
- manifest/CSP/content dependency与Capability Registry双向一致。

### transport与错误

- 网页Origin、错误Host/path/subprotocol、DNS rebinding、假hello、端口占用、wildcard/双栈猜测均拿不到application Key/InstanceRef；未完成HTTP/role握手也受总socket/pending/header/deadline硬上限。敌对网页/同OS进程仍可能占满这些有限槽位造成**有界拒绝服务**；验收只证明状态和内存不会无界增长，不虚构availability或公平性。
- delivery-before/after socket write、wait deadline、relay/client crash不自动重发；wrong-instance not-found不证明未执行。
- Extension Error Registry的producer/phase/effect evidence/retry/redaction一致；relay/client只用transport profile外层错误，relay不能伪造extension error，不存在的relay也不能在wire上自报错误。
- 大结果只经owner-bound artifact；staging始终不可见，final committed metadata与receipt全提交或全abort，孤儿块可恢复清理；每个frame严格小于上限。

## 8. 验证记录与当前状态

每阶段记录artifact digest、Chromium版本/profile、OS、命令、fixture、预期/实际、未覆盖项和可复现失败。静态文档检查不替代构建；unpacked不替代packed；交叉编译不替代Windows/Linux目标运行。

该句所对应的暂停阶段已经结束：当前 runtime、relay、registry、扩展、skill/开发包和真实 Chromium 烟测均已存在。后续仍坚持“目标不存在不能记为验证通过”，但不再用旧暂停门阻止核心实现。
