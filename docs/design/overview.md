# 简版架构 v0.9

日期：2026-08-29。当前已经恢复并完成首批运行纵切：Key 管理、Zig relay、offscreen 10秒重连、`system.describe` 与 `tabs.list/get` 均有真实 Chromium 证据。下文尚未实现的 operation/control/DOM/resource/JS/Artifact 仍是设计约束，不是当前能力声明。

## 1. 系统形状

```text
Agent / native integration
        |
        | agent-relay-json-v1（clientRequestId + wait + Key + command + 可选 targetInstance）
        v
Windows/Linux Zig relay
        |
        | relay-extension-json-v1（relayRequestId + Key + command；响应外层有frameClass；剥离全部 InstanceRef/client 字段）
        v
packaged offscreen page + dedicated worker —— 仅socket/timer/易失route
        |
        | exact chrome.runtime Port（bounded source string + route context）
        v
Chromium MV3 extension service worker  —— 唯一业务 owner
        |
        +-- Zig/WASM pure core：registry投影、验证、权限/控制/operation transition
        +-- JS adapters：storage、Chromium API、DOM/content bridge、userScripts
```

业务决策从扩展开始：Key 是唯一外部主体。relay不保存Key策略、不签发许可、不拥有队列/occupation/operation ledger，也不把Agent/进程/socket变成身份。图中的JSON明文是当前pending transport候选，不是用户冻结条件；若一般部署无法持续证明浏览器对exact endpoint保持DIRECT，P3必须先采用版本化protected application profile，使relay/offscreen只见opaque payload。该profile仍只让调用方持一枚API Key、最终授权与crypto终点留在extension后台；verifier-only记录、endpoint proof和会话密钥来源必须先闭合，不能把“由Key材料”当作已经完成的设计。

通用 Agent 通过 skill 启动/使用简单 relay；自家 Agent 的原生插件使用同一命令和 Key。连不上只证明companion endpoint不可达，不证明进程不存在；skill用固定detached/hidden launcher启动后，按有间隔且受总deadline截断的fresh hello只在同一endpoint收敛。兼容relay不依赖父进程/stdin/client连接存活，显式 `relay.stop`关闭；不扫描/fallback端口，也不因`address in use`认定ready。这些状态不影响扩展已接受的 operation。

## 2. 三条互不混淆的边界

- **授权边界**：扩展查 Key、有效期和精确permission expression。Root让当前resolved artifact中每个**`status=active`的已声明**permission atom求值为true，未来新激活atom自动加入；pending/retired不进入运行向量。authoring没有隐藏`grantable`状态；表达式结构、command存在性及其他边界仍照常求值。
- **能力边界**：当前构建、Chromium API/版本、host grant、用户脚本开关、目标 URL/frame/world 共同决定是否可执行。Key不能创造浏览器能力。
- **控制边界**：tab/global occupation按 Key阻止未来派发。它不是页面事务、持续资源隔离或对旧 effect 的回滚。

CDP/DevTools是显式可选 backend。Chrome自己的调试确认必然由Chrome处理，扩展既不能消除，也不再增加一层插件逐次确认。主路径依靠普通 extension/host/userScripts 权限。

## 3. Key、队列与 operation

同 Key 的一般 effectful command经过一个 admission gate：外部只提交bearer Key与OperationId，扩展在当前内部`AuthorityRealmGeneration`中登记完整`(AuthorityRealmGeneration, authenticated KeyId, OperationId)` → 同事务推进per-Key sequence high-water并持久accepted record → ACK/进入该 Key FIFO。FIFO顺序是扩展coordinator的durable admission顺序，不是多个socket的网络到达时间；并发发送只保证最终串行、不保证谁先。调用方要求A先于B时，必须先观察A的durable accepted/terminal事实再发送B。前序必须terminal后后序才可写dispatch fence；前序超时会结算uncertain而不是重放或永久堵队。不同 Key 有不同 runner；它们不被一个长动作全局串行，但操作同一页面仍可能产生真实竞态。需要排他稳定性时由调用方显式 acquire。

所有 mutation/effect命令都带高熵 OperationId。扩展在浏览器 effect 前先写 durable dispatch fence；fence后没有receipt的崩溃只能保守返回 unknown，绝不自动重放。读命令用 transport request ID关联，不创建隐藏 operation。

短 authority lane只处理有界状态读/变更：control、Key/settings mutation、operation get/cancel等。它与普通动作没有隐式网络顺序；调用方要求 release→acquire 时必须等待 release durable receipt，然后再发 acquire。第三个 Key在中间抢占是合法竞态。

详细语义见[功能指令](../contracts/commands.md)、[控制](../contracts/control.md)与[权威/引用](../contracts/authority-and-refs.md)。

## 4. MV3 owner 与恢复

service worker所有authority/UI/content listeners在模块顶层注册；offscreen transport只通过一个由后台创建并验证的exact runtime Port交付bounded frame string。任何UI、content或command入口都经过同一个bootstrap/hydration barrier：

1. generated TypeScript strict scanner先用通过known-answer的service-worker WebCrypto SHA-256验证包内component seal/生成清单并置`artifactIntegrityReady`；它不依赖WASM，也不以普通`JSON.parse`冒充duplicate-key检查。WASM instantiate/ABI/self-test另写全局startup capability fact，其失败不反向封死generated TypeScript诊断入口。随后把`storage.session`访问级别固定为`TRUSTED_CONTEXTS`，再打开extension-origin IndexedDB并证明explicit strict transaction；upgrade blocked、schema/integrity或必需strict写探针失败就fail closed。`navigator.storage.persist()`未获准只是一项durability风险事实，不冒充“数据库不可用”。顶层listener在此期间不保存原始请求等ready：Agent得到`LEDGER_NOT_READY/KnownNoEffect`，admin mutation关闭，unsolicited content/page消息拒绝。
2. 在strict IDB事务中读取authority meta、runtime facts与Key记录，并把持久schema/build事实和已验证的当前`resolvedBuildArtifactDigest`比较；包内文件本身不伪装成IDB事务数据。
3. 只有持久权威与build连续性都成立后，才检查`storage.session`中的单一闭合`runtimeProjectionV1` candidate并恢复或创建ExtensionRuntimeEpoch；epoch、realm/build绑定、target状态和markers不拆成多个假原子key。整值预编码、一次单key`set`完成、完整readback成立后才发布ref；不把session写冒充事务/durability。普通worker recycle才允许在完整证据下复用；browser restart/disable/reload/update依`storage.session`公开清空合同及顶层startup/install信号失效旧projection，missing/invalid或目标平台违反连续性证据都fail closed重建。retired历史超限可用fresh epoch清理；当前active目标本身仍超限则记录target capability unavailable并停止签发，不能重复轮换。live socket/nextAttemptAt/connectionGeneration只属于offscreen worker，session值不能当连接事实。
4. 扫描当前/旧 runtime operation：queued按runtime规则恢复/KnownNoEffect；v1 generic adapter留下的durable fence没有可跨worker恢复的callback，因此在ready前立即strict转`EFFECT_UNCERTAIN`、擦除DispatchToken/敏感plan并关闭staging，不等待wall deadline。只有同一live后台执行中仍持有exact continuation的timeout callback才保留late-evidence窗口。
5. 建立内存索引和公平runners，随后只宣告`authorityReady`。该值只表示artifact/schema/storage/hydration可安全鉴权与持久化，不包含wall-clock是否当前可裁决；`securityClockState`独立，fault时transport仍在线并在正确secret后返回`CLOCK_UNTRUSTED`。当前resolved build中已active的route才可开放，P1本身没有Agent command route。每个route另按自己的capabilityRequirements判定；不要求WASM的generated `system.describe`在P3用generated TS描述器及从同一expression发射的permission evaluator返回active/effective-global capability集合。TS/native/WASM真值门防止它变成手写绕权路径。

Key/settings/control/operation/artifact位于同一个IndexedDB数据库。meta还保存内部authority generation、单调security time和operation拒绝前沿；系统时钟回拨不能复活过期Key/OperationId。revoke清除verifier并保留KeyId tombstone。内部mutation在一个跨object-store的`readwrite` transaction里同时提交domain事实与operation receipt；critical transaction显式`durability: "strict"`并等待complete。浏览器effect仍必须先单独提交dispatch fence transaction，再调用Chromium。队列由operation records派生，`storage.session`只做可丢重建的运行投影。

## 5. 浏览器能力与页面通道

chromium-full-v1当前最低候选为Chrome/Chromium 138普通profile：`userScripts.execute`从135可用，而[138起由每扩展Allow User Scripts开关取代全局Developer Mode要求](https://developer.chrome.com/docs/extensions/reference/api/userScripts)，所以138是有理由的产品floor而非随手版本号。衍生浏览器仍必须feature probe；147起的WebSocket LNA是另一条动态能力分支，不由floor推断。主profile申请广泛host access以避免Agent逐命令触发授权，但浏览器用户仍可限制file URL、站点和扩展开关。incognito spanning/split在完成独立Key authority、IndexedDB与worker生命周期测试前明确返回unavailable，不猜测它与普通profile共享同一realm。

消息面严格分开：

- relay command plane：始终带Key，只从完成role握手的offscreen extension WebSocket，经验证的exact runtime Port进入后台。
- extension admin UI plane：仅本扩展 popup/options/admin页，可在全部 Root丢失时恢复；不能从 content/page/外部 extension到达。
- content execution plane：只响应后台创建的、绑定 TabRef/DocumentRef的有界 pending request。
- USER_SCRIPT/MAIN plane：页面可观察/影响的数据执行面，没有 Key、admin route或receipt权威。

这些边界由独立TS projects和import graph落实：offscreen page/worker只可导入transport scanner/descriptor与窄bridge，admin/content/user-script只可导入各自消息schema；任何非background realm直接打开authority IndexedDB、导入policy/dispatch/storage或调用不属于本realm的业务Chrome API都使构建失败。offscreen worker在构造WebSocket的同一task把默认Blob切为ArrayBuffer并只收发binary bytes；即便如此，也只能在完整browser message到达后检查最终`byteLength`。fragment count/assembly deadline只能由拥有raw frame parser的native端强制，不能把浏览器未暴露的证据写进probe。

DOM查询返回 DocumentRef + NodeRef；动作使用完整引用与guard，不使用文本序号、裸tabId或清洗snapshot。content请求在投递前由background取得总并发、reply source bytes和最坏新增NodeRef lease；DOM用增量byte/node/depth builder，selector在有界遍历中逐元素匹配，不能先用`querySelectorAll`物化无界NodeList再截前N项。per-realm和全局NodeRef容量同时成立，Port/realm失效释放整realm lease；浏览器selector/DOM字符串和structured-clone内部copy仍是renderer availability边界。任意JS使用显式 USER_SCRIPT/MAIN world；不可用时返回能力缺口，不隐式连接debugger。

protocol frame、inline结果与采集上限分开。大resource/JS结果由extension先分批写owner-bound、不可见`staging_open` chunks，再用一个小型strict transaction原子提交committed artifact metadata与operation receipt；operation终态/late期限会同事务转orphaned并关闭写权，reader只认commit marker并用有界range读取，orphaned正文不可见且有界GC。无OperationId的`page.dom.get`只能返回明确截断的有界live结果，不能根据大小暗中变成持久capture。P6另加`page.archive.capture`：它用Chrome `pageCapture`得到当前tab的MHTML，不冒充最初HTTP响应；accepted前预留Artifact逻辑容量，返回后按Blob size限额并分块物化。Chrome在Promise完成前已构造完整Blob，所以扩展只能约束自己的后续copy/IDB写入，不能声称限制了浏览器内部峰值；target/URL未变也不证明页面内容在抓取期间静止。

固定isolated bridge的manifest/runtime参数由Capability Registry拥有：`run_at=document_start`、允许时`all_frames`及明确的`match_origin_as_fallback`策略；每个frame仍逐origin检查host grant。扩展安装前已打开或静态注入漏掉的document在纯read中固定返回typed capability gap，不能顺手程序化注入、刷新或用旧frame缓存猜目标。以后若需要补bridge，必须登记独立effectful command、OperationId、target/control/receipt和`chrome.scripting` capability，不能藏进`page.dom.get/dom.query`。

ResolvedManifest/ResolvedCsp也由该registry生成：extension pages只允许包内script与包内WASM所需的`wasm-unsafe-eval`，不开放普通`unsafe-eval`或remote code；P0 `connect-src`只有`'self'`。P3 offscreen capability显式加入`worker-src 'self'`，transport capability再追加唯一numeric loopback endpoint；二者不能由模板或CSP fallback暗推。到P6若`resource.fetch`真实激活，其独立network capability才可按build profile追加明确的`https:`及必要`http:`data-connection来源，并同时要求Key permission、host grant、请求schema和结果上限；不能在P0/P3提前放宽，也不能把data connection误作remote script许可。内部admin/WASM/generated资源默认不列入`web_accessible_resources`。任意页面JS由userScripts backend执行，不能靠放宽extension-page CSP实现。

## 6. relay 与实例

relay绑定单一numeric loopback，本地 native client和extension socket分离path/subprotocol/Origin规则。`127.0.0.1:32189`只是pending候选，P3要比较普通/专用`127/8`地址的两平台与浏览器凭证状态证据。native client direct-connect且忽略proxy/credential环境，在校验server-first product/protocol hello之前不得发送Key。该握手能挡网页和错误服务，但不声称抵御能仿造relay的恶意同用户本地进程；它也不能撤回浏览器HTTP upgrade中可能先发出的Cookie/HTTP auth、错误响应造成的Set-Cookie/auth/站点状态与交互，更不能在`ws://`经过代理时保护hello之后的bearer Key/命令/结果。Chromium默认对`127/8`隐式bypass，但`<-loopback>`可取消；[Chrome 147又把WebSocket纳入LNA](https://developer.chrome.com/release-notes/147)。P3实验必须证明被测profile对exact endpoint的effective decision为DIRECT、代理看不到application bytes且没有未闭合LNA/browser提示，但静态实验不能冻结用户机器以后变化的proxy/PAC。明文候选只有在当前deployment能持续证明DIRECT且变化会关socket时才可active；面向一般Chromium的路线若没有这种runtime证据，就先闭合端到端application保护，让relay/代理只见路由元数据与opaque payload。外部仍只持一枚API Key；推荐把extension endpoint proof封装在该token内，以维持verifier-only bearer存储，并让加解密只在native client与extension后台终止。不能把现有verifier digest临时当会话密钥，也不能让offscreen/relay得到decrypt能力；opening request状态和Chrome自己的LNA交互仍是独立阻断门。鉴于MV3后台会回收，优先评估每请求独立密封envelope与后台持久transport private material；若使用易失长会话，background Port一断必须连socket一起关闭，不能同时要求offscreen无密钥又让session跨worker继续。

每条成功extension socket由relay分配 `{relayEpoch, instanceNumber}`。零实例立即KnownNotDelivered且不保存Key/command等未来连接；一个实例的首次“任选当前实例”read可以省略target，多个实例必须选择。generated client对operation重投、查询及任何要求连续实例的调用先列举并显式固定current InstanceRef；断线后不猜重连者。不能为了找出Key属于哪个实例而把bearer Key逐个试发：明文profile无明确选择就fail closed；受保护profile可先做transport-only无bearer端点证明，唯一匹配后才发送加密Key，多个匹配仍要求显式选择。复制浏览器profile可能同时复制Key/realm/proof，系统不会谎称两个独立ledger仍全局幂等。relay转发前剥离target，扩展schema拒绝全部instance字段。断线使ref失效，重连新编号；没有稳定extension route identity。

P3由service worker在artifact/authority ready后确保唯一packaged offscreen document存在；该document以真实`WORKERS`理由创建dedicated worker，worker独占WebSocket、connectionGeneration与名义每10秒无限retry timer。cadence只用live worker的`performance.now()`语义；context重建无可信elapsed continuity，直接立即attempt。offscreen page本身只做worker↔exact runtime Port窄桥，不解析业务权限；Port缺失时后台唯一可发的是无业务载荷的reconnect通知，真实descriptor仍须等page主动建Port并通过documentId门后整份推送。service worker回收且无pending route/source时socket可继续；pending route或未release source的Port丢失就关socket，不能改投新Port。relay本地wait/client结束后best-effort发`route.abandon`只释放响应路径，不cancel operation。alarms只检查/重建offscreen context，不驱动10秒节拍。P3 route要求service-worker、offscreen-worker、storage.session、alarms、WebCrypto、strict IndexedDB与loopback WebSocket capability及authority/artifact ready；20秒`transport.ping`/45秒extension pong deadline与90秒relay application-idle deadline仍是待实测候选，RFC Ping/Pong不冒充worker活性。incoming source、background admitted command、outbound source和browser `bufferedAmount`各有硬门，扩展自有copy/parser/WASM/route/control按生成最坏扩张系数计费并合计进入extension managed-memory总预算。worker为每条bridge source分配`inboundItemId`；background full scan后必须先取得typed/auth/dispatch目标reservation、在copy重叠期双计，才可exact release，目标值则保留到plan/handler不再使用。source总deadline或release失败都关socket。exact Port对descriptor/release/response共用一个outbound slot，每项仍带Port-local单调`bridgeItemId`并要求ACK原样回显，防旧重复ACK误确认下一项；同route response不得越过release ACK。descriptor只保留最新desired，三类item受派生count、逐项deadline和有界公平调度约束，超时就失效bridge并销毁transport context。transport control只在offscreen worker/relay本地结算，不进background业务命令。

packed extension的expected ID/Origin来自显式`build.extension.identity_profile`。profile只含发布/开发公钥身份及期望值；私有签名密钥不进registry、源码、artifact、digest或日志。build/package门核对最终packed ID，relay禁止第一次连接学习Origin。Web Store发布不是P0-P6前置；先以固定identity的packed开发/企业交付验证，若以后上架再单独闭合商店隐私、最小权限与single-purpose材料，不改变Key或执行协议。

## 7. Freedom Point 和四份 registry

一个Zig配置器读取四份闭合data-only声明并生成紧凑Zig/TS表、manifest、skill说明与fixtures：

1. Freedom Registry：真正可调整的build/runtime决定。
2. Command Registry：独立permission declarations与command declarations。
3. Error Registry：extension/storage/platform command错误、producer surface与effect evidence；relay/client delivery错误属于transport profile常量。
4. Capability/Platform Registry：构建能力、Chromium API/版本/开关、manifest/host/CSP/content依赖与probe。

运行热路径不解析registry字符串。build facts只能由构建产生，runtime facts由扩展以revision/CAS提交。完整设计见[Freedom Point](freedom-points.md)。

## 8. 当前范围

基础模块是 Key、settings、control、operation、tabs/frames、当前DOM读取、DOM定位/动作、任意JS和新网络请求；截图/下载/debug按能力逐步加入。

页面信息组织已经采用[唯一缓存 operation tree 与一次性 view](page-tree-view-interaction-proposal.md)：完整实时信息从 rootRef 可达，同一未刷新文档按 Key 保留展开状态，不设置 `selection`、“重点区”或快速入口。现行实现见[页面操作树](page-information-tree.md)。历史 Cleaner/PageIR 稿仍在[历史目录](../historical/README.md)，活动源码不复活 `page_model/cleaner`。

恢复落地时先做registry/configurator与MV3静态引导，再做authority和Key；随后尽早接通薄relay并用带Key的`system.describe`证明第一条真实外部纵切。P4再用真实`keys/settings` internal mutation与`operations.get`贯通Agent OperationId、secret交付和desired/applied，但synthetic effect adapter保持不可路由；P5有真实TabRef后才开放control，P6才允许第一个浏览器effect handler。
