# 已定方案、工程裁决与实验项 v0.9

更新：2026-08-31。优先级固定为：用户直接裁定 > 本文件“工程裁决” > 其他设计说明 > 历史材料。未写入已定表的建议不冒充用户同意。

## 0. 当前落地裁决（覆盖下文旧阶段候选）

| 事项 | 当前结论 |
|---|---|
| relay profile | `127.0.0.1:32189` 已作为 active build Freedom Point；extension/client 使用不同 path/subprotocol/role。manifest 固定公钥派生唯一 extension ID/Origin，并由同一生成器投影给 Zig 作 exact gate；这只是 transport endpoint gate，不是业务身份。当前应用 payload 是有界 binary UTF-8 JSON，relay 能路由并看见 payload，但不鉴权；Key 鉴权仍只在扩展。可信本地合作边界下不增加第二套来源身份或会话密钥 |
| 重连 | `transport.retry_interval_ms=10000` 已由生成投影供 offscreen dedicated worker 消费并经 Chromium 实测；当前是 rebuild point，尚无 settings hot-apply |
| 实例 | relay 独占生成 `relayEpoch + instanceNumber`；扩展不生成、接收或持久化 InstanceRef。每次成功重连都是新编号 |
| registry | 当前窄 Node 构建生成器已实际生成 TS/Zig 配置并做 active 引用、consumer path 与 manifest permission 反向检查；未来可换 Zig configurator，但不能把尚未存在的 Zig 版本写成当前事实 |
| active command | 浏览器核心含页面树、等待、保存/截图/演示和 `dom.click.real.v1`；当前共 46 条 active command、40 个 permission、57 个 Freedom Point。完整页面操作树接口见 `docs/implementation/page-information-tree-slice.md`；`.real` 只增加 Windows 原生左击，不夹带 CDP、桌面宏或额外 control 语义 |
| TabRef | `tabs.list/get` 使用 extension-owned runtime epoch + tab generation；关闭、替换、异步读取中退休或连续性不可证明后 fail closed 为 `TAB_REF_STALE`，不把裸 tabId 作为外部目标。list 只用 live keyset page，不再计算 collection revision |
| 当前 bridge | offscreen page 通过 source-gated `runtime.sendMessage` 往返一条 bounded business message，并把原 connection generation 带回 worker；只有原 socket 仍 active 才发送结果。旧文中的 exact Port ACK、route abandon、keepalive、全局 managed-memory 公式是后续强化候选，不是当前实现声明 |

## 0.1 `.real` 已实现边界（2026-08-31）

- 用户已确定：显式 `.real` 后缀；扩展读取页面信息并负责 Key 鉴权，App 提供原生窗口信息与系统点击；不能点到实际不可命中的控件；不通过 CDP 或 DOM 事件伪造替代这条路线。
- 首版已只新增 `dom.click.real` 及同名独立权限；`scrollIntoView=true`、`timeoutMs=10000`、最大 60000 已由 Freedom Point 生成。原 `activate` 参数已撤回；选中目标 tab 与请求对应 Chromium 窗口聚焦是公开的固定准备行为。
- Windows 通过每请求随机临时标题标记把精确文档绑定到唯一 `Chrome_WidgetWin_1`，再唯一匹配可见内容 HWND；普通标题/尺寸/windowId 不作为原生身份。App 只在当前 pending route 和当前扩展实例上接受子请求，client role 无原生入口。
- 实测修正：定向 PostMessage 可产生 trusted click，且已取得另一程序前台、未观测到前台切换的成功样本；其他状态会在 down 自行激活。不能把“必须先前台化”或“保证不抢前台”写成总前提；窗口几何、Z 序、线程内焦点与系统前台各自记录。仅证明 Windows 候选，不立即选择/实现新产品后端。
- 沿用 Key/NodeRef/occupation owner 与实例编号规则；App 只增加原生输入的窄模块和短执行段，不增加 Key 鉴权、长期占据、通用桌面接口或后台自动重试。现有 socket 已补应用层反向子请求，native 子结果不完成外层 route。
- Windows 隔离夹具已通过同一 NodeRef 的 ordinary untrusted=1 与 real trusted=1、原标题恢复及完整后续回归。首版拒绝子 frame；Linux/X11/Wayland 未真实验收，因此 Linux 握手不声明能力，不交给用户猜技术参数。

## 1. 用户冻结事实

| 事项 | 不再漂移的结论 |
|---|---|
| 业务主体 | 只认 Key；不根据 Agent、软件、进程、来源、设备、连接或 socket 建立权限、队列或 occupation 身份 |
| Key owner | 扩展生成、保存、配置、鉴权 Key；本地 relay 不拥有 Key 库或业务决定 |
| 插件确认 | 任何通过Key权限/目标/control/capability检查的指令都不再弹插件确认；Root是对当前resolved artifact全部`status=active` permission atom为true的Key，不是唯一免确认者；pending/retired不是可执行权限 |
| 并列权限 | JS、DOM、当前 DOM、资源请求、设置、调试等入口独立配置；JS 事实上能完成其他效果也不建立权限闭包 |
| 浏览器边界 | 扩展权限路径是主能力；CDP/DevTools 可选且 Chrome 自身调试确认无法消除，也不由插件再加一次确认 |
| 调度 | 同 Key 一般动作串行；多个连接持同 Key 就是同一主体；不同 Key 不进入同一个隐式动作 FIFO |
| occupation | tab/global 归 Key；发现其他 Key 占据时 acquire 只返回冲突 |
| 解除与占据 | 有对应权限的 Key 可解除任何 Key 的占据，但必须先独立 release，再独立 acquire；无 takeover/force/replace、合并命令或客户端隐藏组合，Root 也一样 |
| 信任 | 已授权 Key 的操作者按可信合作处理，不建设敌对多租户身份/委派/登录/session/lease 体系 |
| 范围 | 只做 Chromium 内核；薄本地 relay 同时交付 Windows/Linux |
| 交付 | 浏览器扩展与本地 App 分开给：extension 包解压根目录直接含 `manifest.json`；本地 App 按 Windows/Linux 平台分别交付，解压根目录直接含对应 relay executable。combined 总包不再作为安装入口 |
| Key 管理 UI | 扩展必须有正常可发现的浏览器工具栏入口；点击扩展 action 直接打开完整 Key 管理页，可生成、查看配置、更新、禁用和吊销 Key。`options_page` 保留为 Chrome 详情页的并行入口，不要求用户手输内部 URL，也不把完整管理表硬塞进狭窄 popup |
| 接入 | 通用 Agent 使用扩展 + skill + relay；自家 Agent 原生插件接同一协议；未原生适配的 Agent 也能使用 |
| retry | packaged offscreen document以真实`WORKERS`理由创建dedicated transport worker；未连上relay就持续尝试直到连上，worker可运行时名义间隔10秒，这是首个明确Freedom Point。alarms只重建context，平台冻结无墙钟SLA |
| InstanceRef | 每条已握手扩展 socket 在本地被视为一个实例；编号完全由 relay 生成；扩展不生成、保存、接收或解释实例编号 |
| 技术承载 | 采用 Zig 积累资产；纯核心可编译为扩展内 WASM，浏览器/DOM API 留在 JS 模块 |
| 页面信息组织 | 用户纠正为“不是清洗而是选择，选择如何把完整信息编成一个树”。现已落地：每份未刷新的文档拥有唯一缓存 operation tree；切走再回来保留树和按 Key 展开状态，view 是无状态的一次性 GET。没有 `selection`、“重点区”或快速入口；第 0 层固定为 Document 直接子项，折叠行提供确定性摘要 |

“软件不存在”是业务建模边界，不是否认 relay 进程的物理存在。无论最终transport让relay看到明文还是只看到opaque受保护payload，它都不能把软件/连接变成业务授权或状态 owner；明文并不是用户冻结事实，必须由后续安全证据独立裁决。

## 2. v0.8 工程裁决

以下是为得到可实现闭包而确定的当前方案；它们可按 Freedom Point 或协议发布规则演进，但不得反向改写上一节。

| 事项 | 当前裁决 |
|---|---|
| 权威域 | 一个扩展origin的IndexedDB是一个Key/operation权威域；没有跨安装的全局Key identity |
| authority reset | full reset建立新的内部realm generation并使全部旧Key不可认证；该generation不暴露给relay，也不是稳定route identity。storage-domain security time/admin dedupe不随realm归零 |
| 当前引用 | 当前 active 命令只使用 KeyId、ExtensionRuntimeEpoch、TabRef、transport route 与 relay-only InstanceRef；occupation 不生成 OccupationId。其他引用模型留待真实 consumer 出现时再启用 |
| DocumentRef代际 | Chromium documentId可跨prerender/BFCache生命周期保持不变；扩展只为active incarnation签发DocumentRef并加入单调documentGeneration。离开active永久退休旧generation，再次active必须新ref；port重建只轮换ContentRealmToken |
| target容量 | retired tab/document marker、target子投影和整个runtime projection均有generated count/byte上限；写前整值预检。retired历史超限可轮换epoch，active集合本身超限则target unavailable；禁止丢单项marker后在旧epoch重建generation |
| content/Node容量 | `maximum_query_results`不等于renderer内存上界。background在投递前预留content request/reply bytes及最坏新增NodeRef全局lease；content使用增量DOM builder和有界逐元素selector匹配，不先物化全DOM/NodeList。per-realm+global ref门同时执行，Port/realm失效释放；浏览器内部DOM/selector/structured-clone只作availability边界 |
| 列表分页 | 当前 active 的 `tabs.list` 使用无状态 live keyset page，仅带 `afterTabId + limit`，不计算 collection revision。`keys.list`与尚未 active 的frames列表保留各自旧设计，等真实外部 consumer 出现时再按实现需要裁定，不反向约束当前 tabs 路径 |
| operation identity | 扩展内部为`(AuthorityRealmGeneration, authenticated KeyId, OperationId)`；外部只提交Key与OperationId且不暴露OperationRef/realm。OperationId带毫秒时间与至少128-bit随机nonce；SDK/skill可帮助生成，但caller必须在首个network byte前持有exact ID，禁止隐藏生成并发送 |
| 随机生成边界 | CSPRNG probe只验证API/shape/failure，不能实证熵；熵质量信任Chromium/OS。nonzero/namespace碰撞只在有限attempt内重取，API异常或耗尽fail closed，不退化到时间/counter/Math.random |
| 去重 | accepted identity有有限绝对dedupe window且窗口内tombstone不回收；absent ID窗口外本次KnownNoEffect，Delivered拒绝后client burn。past因单调前沿持续拒绝；future不落tombstone就不虚构永久记忆。当前建议窗口7天，实测前是runtime Freedom Point候选 |
| operation 顺序 | 每 Key admission gate 在首个 await 前建立 reservation；normal FIFO以coordinator的durable admission顺序为准，不把多socket网络发送/到达顺序冒充全局时标。调用方要求A→B时先等A durable accepted/terminal再发B；accepted record durable 后才 ACK/入队；同Key前序terminal后后序才可fence；effect 前 durable fence，receipt durable 后才对外 completed |
| 摘要 | intentDigest只描述显式请求；resolvedPlanDigest冻结默认、目标generation、相关revision、backend与build digest；两者只作extension内部去重/完整性，不向查询者或日志披露低熵内容hash |
| 跨平台build摘要 | Windows relay、Linux relay与extension各有component artifact digest；relay握手只比较共同`transportCompatibilityDigest`。`commandProtocolDigest`只要求extension/client/skill理解，relay仅记录/回显 |
| pending与摘要 | pending Freedom Point没有resolved值，default不得进入transport/command/artifact摘要。P0必须先让实际parser/build point拥有consumer、投影、fixture与反向门并active，之后才emit引用它的digest |
| extension打包身份 | `build.extension.identity_profile`唯一派生expected extension ID/Origin；发布/开发公钥身份进入resolved fact，私有签名密钥不进registry、源码、artifact、digest或日志。packed门验证最终ID，relay禁止首连学习Origin |
| occupation 含义 | 只阻止未来派发，不证明页面静止，也不回滚已开始 effect；release 后旧 in-flight 可能和新 owner 动作重叠，状态必须显式报告 |
| occupation读策略 | v1只门控本扩展的effect；纯tabs/DOM observation不作读锁但仍鉴权/复核。若以后需要读隔离，显式改Command controlPolicy |
| tab间接目标 | 撤回`tabs.create/close = all_occupations`的粗锁候选；它会让无关tab占据破坏跨Key独立。create不得使用隐式“当前窗口”，close不得隐藏active successor副作用。P6先以anchor/未来WindowRef和固定active/inactive语义闭合每个method的target/control，未闭合就保持pending |
| release 语义 | `control.release` 只带 `{scope, tabRef}`；拥有该 permission 的 Key 可清除当前任何 owner。它不生成/要求 OccupationId，不暗中 acquire；旧重试可能清除后来 owner 是该极简接口的已知语义 |
| Key 失效 | 当前 occupation 只保存 owner KeyId，不自动跟随 revoke/disable/expiry 清除；这是可信协作模型下的显式脏状态，任何拥有 `control.release` 的 Key（Root 自然拥有）可按冲突返回的 exact scope/TabRef 单独解除 |
| queued授权冻结 | accepted plan冻结authorizationRevision；任何authz mutation都使旧queued KnownNoEffect，恢复相同值也不复活；secret rotation/displayName不影响 |
| Key时间与撤销 | meta保存单调securityTimeFloorMs，时钟回拨不能复活过期Key；所有checked-add上界派生可提交安全时间域，域外值不写floor。域内错误前跳无法与真实离线区分，这是明确本机时钟边界。revoke清verifier并保留有界tombstone；GC后靠高熵随机与现存记录碰撞检查 |
| Agent时间恢复 | operation route自身对absent identity返回versioned `OPERATION_ID_OUT_OF_WINDOW`及`past\|future`、min/max；Delivered error后调用方burn旧ID并创建新ID，DeliveryUnknown仍重发同一ID。`system.status`只作拥有`system.read`时的可选预取，不是effect权限父级；扩展不代生成/改写ID，也不降低security time |
| 权限授予上界 | regular Key对regular Key新增的每个permission atom必须属于当前`status=active`集合且也在调用Key上求值为true；pending/retired不能新增。删除权限或revoke不要求调用者拥有被删除atom。permission expression仅用正向单调atom，Root对当前全部active声明为true、未来新激活atom自动加入，且每个active Key command必须在该向量下成立，但不跳过其他边界。当前authoring没有也不暗推`grantable`第二状态 |
| Root恢复容量 | ordinary active + retained tombstone共同计入ordinary配额；受信admin另有单一`empty \| active` Root recovery container及独立最小tombstone/receipt headroom。丢secret响应只原地rotate；显式revoke原子写旧KeyId tombstone并释放container承载位 |
| Key storage class | Key record显式且不可变地声明`ordinary \| recovery`；它只决定容量/container归属，不是permission或身份。Agent create只能ordinary，recovery只由受信admin container建立且必须是Root |
| 浏览器运行恢复 | service worker回收在`runtimeProjectionV1`连续性可证时保持runtime epoch；`storage.session`的公开清空合同加顶层startup/install信号证明browser restart、disable/reload/update应产生新epoch，target/session连续性丢失或marker容量也可轮换。原因不一定可区分，旧queued统一`RUNTIME_CONTINUITY_LOST/KnownNoEffect`，旧fenced无receipt为uncertain/unknown，completed保留；目标profile出现旧projection假连续则fail closed |
| 当前持久化 | Key、admin mutation、settings.v1 与 owner-bound immutable Artifact 使用 IndexedDB strict transaction；极简 occupation 作为当前浏览器 session 状态保存到 trusted `storage.session`，内部按 runtime tabId 关联 last TabRef/owner，从而在 worker 回收、TabRef generation 更新后仍阻止 foreign Key 绕过；tab remove/replace 清项，浏览器 session 结束后整体清空。Operation ledger 仍未 active |
| registry | 四份权威声明：Freedom、Command（内含独立 permission declarations）、Error、Capability/Platform；一个 Zig 配置器交叉校验和生成 |
| 平台 profile | chromium-full-v1以Chrome/Chromium 138普通profile为当前最低候选，理由是[`userScripts.execute`从135提供，而138起改为每扩展Allow User Scripts开关](https://developer.chrome.com/docs/extensions/reference/api/userScripts)，避免要求用户打开全局Developer Mode；实际浏览器仍逐项feature probe。WebSocket LNA从147起另行分支验证，不由138 floor暗推；incognito spanning/split在完成独立authority/storage测试前明确unavailable |
| profile版本authoring | `chromium-full-v1`固定版本descriptor唯一拥有支持的Chromium floor并生成`minimum_chrome_version`；Capability条目不重复138。以后若某API有独立最低版本要求，另建有一手证据的capability requirement |
| host access | 主 build profile 在安装/启用阶段申请广泛页面 host access，避免 Agent 逐指令请求；file URL、incognito、受限 scheme 和用户撤权仍按浏览器实际状态 |
| arbitrary JS | `userScripts.execute` 为主后端，USER_SCRIPT/MAIN world 必须显式；userScripts messaging 默认关闭；不可用时返回 capability error，不自动切 CDP |
| relay transport | 有界framing over单一numeric IPv4 `127/8` bind；`127.0.0.1:32189`仍是pending候选，P3可按两平台与凭证状态证据改成专用loopback地址。extension/client使用不同的版本化path、subprotocol、role与Origin policy；没有Key前的server-first hello。当前JSON明文候选只保护尚未发送的application Key：不证明opening request在proxy/PAC状态下仍DIRECT且没先带Cookie/HTTP auth，不证明错误response无Set-Cookie/auth/交互，也不保护`ws://`经代理后的bearer Key/命令/结果。Chromium默认隐式bypass `127/8`但`<-loopback>`可取消，[Chrome 147又把LNA扩展到WebSocket](https://developer.chrome.com/release-notes/147)；一次实验室矩阵不能冻结用户机器以后变化的proxy/PAC。明文profile只有在本次部署可持续证明DIRECT且变化会关socket时才可active；一般Chromium产品若无这种runtime证据，必须先闭合端到端认证/保护application bytes的版本化profile。该profile仍只接受一枚API Key作为外部credential，授权只在extension后台；加解密不下沉到relay/offscreen。当前verifier-only Key record不能被含糊地当成会话密钥：若profile需要新增credential-equivalent派生值，或把extension transport proof封装进同一API Key token，必须先版本化Key token/record并裁定其at-rest含义。opening request状态与LNA仍单独验证。packed extension Origin来自固定打包/签名或显式dev profile，禁止首次连接学习；native direct TCP忽略proxy/credentials，listener exclusive且不可继承；raw codec闭合Accept/mask/RSV/opcode/control/length/fragment规则 |
| protected crypto寿命 | crypto明文/私钥终点只在native client与extension后台。MV3 worker回收下优先评估每请求独立密封、版本化后台transport private material；若选择易失长会话，exact background Port/realm一断必须关socket并重握手。不得让offscreen持钥、持久化未声明session secret或把仍开的TCP当会话连续性。transport proof丢失/轮换会使旧token不可用，必须显式rotate/reissue Key，禁止静默降级明文 |
| protected资源门 | ciphertext限额不等于plaintext/typed内存限额。selected profile必须生成wire膨胀关系、独立transport-crypto并发池与decrypted-application byte bucket；decrypt/encrypt前先取得目标reservation，ciphertext↔plaintext↔typed及response反向转换的并存副本全部进入extension managed-memory。错误proof/tag不进入Key auth池 |
| retry 语义 | offscreen dedicated worker按attempt start名义10000ms cadence；singleflight不重叠，慢attempt结束时overdue则立即再试；alarm只负责context销毁后的粗恢复；service worker回收且无pending route时不应断socket，pending旧Port则关闭；无跨浏览器/设备冻结墙钟10秒保证 |
| retry时基 | live offscreen worker只用`performance.now()`语义计算cadence；wall/security clock不参与。context重建没有可信elapsed continuity，生成fresh generation并立即attempt |
| transport宿主 | service worker唯一拥有业务authority；offscreen page只桥接exact runtime Port，dedicated worker唯一拥有extension WebSocket/timer/connectionGeneration。Port缺失时后台只可发无载荷bridge-reconnect通知，descriptor仍须等page主动建Port后整份传送。各realm独立TS project/import root，AST/import-graph与packed spy禁止offscreen/UI/content直接访问authority IndexedDB、policy/dispatch或业务Chrome API |
| keepalive | 20秒`transport.ping`/45秒extension pong deadline、1秒relay最小ping间隔与90秒relay application-idle deadline只作为待packed-browser验证的当前候选；ping/pong是transport descriptor内exact connection-local shape、单outstanding、不进background/business route。relay-side deadline防TCP仍在而worker已死的假在线实例，RFC Ping/Pong不能刷新它；不伪装成墙钟SLA |
| relay 实例 | relayEpoch 至少 128-bit，instanceNumber 单调 u64；断线/重启失效且重连新编号；不增加稳定 extension route identity |
| relay零实例 | forward只选调用瞬间的exact current socket；零实例立即`EXTENSION_UNAVAILABLE/KnownNotDelivered`，多实例省略target立即要求选择，stale立即拒绝。relay不存Key/command等待未来socket；skill只能轮询`instances.list`后首次发送 |
| relay并发启动 | 端口占用不是ready证据；固定detached/hidden launcher后，每个client startup coordinator只允许一个probe在途，前一结束且最小start间隔到达后才对同一endpoint做下一fresh server-first hello，每次attempt仍被总deadline截断。黑洞服务不能诱导单client叠加socket；多个client由relay总门约束。兼容赢家才复用；不兼容立即失败，连接失败不谎称进程不存在，不杀未知进程、不扫描/fallback端口，hello前不发Key。compat relay不依赖父进程/stdin/client lease |
| extension transport内存 | WebSocket在构造同一task切为ArrayBuffer且只收发binary bytes；incoming source、background admitted-command、待发response和browser `bufferedAmount`分别有build硬上限。background full scan后必须先取得typed/auth/dispatch目标reservation，在source与target副本并存期双计，才可exact release；route abandon不cancel operation，不能借断route提前释放handler仍需的command。扩展自有copy/parser/WASM/route/control按生成最坏扩张系数计费，全部同时存活bucket再checked-sum到`build.extension.maximum_managed_memory_bytes`。WASM linear memory另有64 KiB page对齐的显式maximum，最终binary/import必须反向证明，不能把潜在无界`memory.grow`写成固定开销。worker给每条bridge source分配`inboundItemId`，从首次post到exact release持续占aggregate预算并受总deadline；同route response不能越过release ACK。exact Port对descriptor/release/response共用一个outbound slot，每项另带Port-local单调`bridgeItemId`并由ACK精确回显；单槽不能防旧重复ACK误确认下一项。三类item有派生count、逐项deadline和公平调度，超时失效bridge/context。progress可丢，accepted/terminal/read无法安全排队就关闭socket，durable operation事实仍只在extension ledger；Chromium内部copy只列availability边界，不伪装成扩展完全控制的物理内存 |
| authority hydration内存 | IndexedDB可很大不等于JS heap可无界。bootstrap只常驻有界Key/operation/control索引与runnable摘要，full plan按active-handler预算加载；cursor batch有count/bytes门且累积Map另有总门。P4/P5首次真实consumer在同一变更补record/index/batch Freedom declarations；缺失时相应route保持pending，不现在预造无consumer slot |
| relay raw/总内存 | 每socket header/message/fragment局部上限之外，全部pending HTTP/role与WebSocket assembly bytes必须在append前取得global raw-input reservation；完整message转入queue时无accounting gap，copy并存同时计费。resolver再把raw、forward、response、copy、socket/route/parser/control固定开销求和并证明不超过`build.relay.maximum_managed_memory_bytes`；各bucket分别小于allocator不算总和闭合。该门只保证有界拒绝，不保证敌对连接下的可用性 |
| 实例省略安全 | wire在恰有一个current实例时允许省略target，仅表示“任选此刻唯一实例”。generated client对operation重投/查询及连续性敏感调用先list并显式pin；断线后绝不把新唯一socket猜作旧realm |
| 多实例Key披露 | `instances.list`只给relay局部公开描述，不能靠向所有实例逐个发送bearer Key来识别归属。明文profile无明确选择时fail closed；受保护profile可先向有界current refs做无bearer端点证明，唯一匹配后才发送加密Key，零/多匹配均不执行。外部复制profile可能克隆Key/realm/proof，多个匹配必须显式选择且不虚构跨实例全局幂等 |
| Key secret 持久化 | 用户已否决“一次显示后不可恢复”。扩展 KeyRecord 同时保存 verifier 与完整 `storedApiKey`：认证只用 verifier，普通 projection/Agent/relay 不披露 token；受信 admin 页面显式 `keys.reveal` 可反复查看、隐藏和复制。同一 create mutation 重放返回同一已提交 token。旧 verifier-only record 只标记不可查看，可由用户显式输入原 token、验证 verifier 后补存；禁止在普通认证时隐式迁移 |
| secret并发披露 | 同identity并发只建一个Key；commit前易失join表选择一个仍存活的exact route，最多向它返回secret。其他joiner及发送失败后的重试只得无secret receipt/不可恢复，不把一次性明文复制或转交 |
| admin幂等 | 受信admin页面按用户手势生成带时间和高熵随机量的AdminMutationId；后台按绝对窗口有界durable去重。会自擦该去重域的factory reset在v1延期 |
| dispatch token | DispatchToken只由后台AuthorityCoordinator在fence transition生成并留在后台，同时冻结AuthorityRealmGeneration；content只看到独立易失contentRequestId。v1不恢复跨worker adapter回执：bootstrap看到无本次live continuation的fence就在ready前立即uncertain、清token/敏感plan并关闭staging，不等wall deadline；full authority reset先赢时旧callback只丢弃，不能写新realm |
| 大结果 | protocol frame、inline和采集上限分离；大body先写绑定operation的不可见staging chunks，最后以小型strict事务原子提交committed metadata + receipt；只读committed artifact |
| storage-domain容量 | operation每个phase record用generated canonical sizer做单record+ledger总量账本，和record同事务更新；artifact actual/reserved/staging/orphan同理。full reset只切断旧realm可见性，旧ledger/chunks在物理GC batch提交前继续计入domain上限与aggregate storage预算，不能反复reset获得新配额。逻辑bytes不冒充IDB物理quota |
| operation最小留存 | 完整ResolvedPlan只保留到terminal；terminal事务擦除JS/body/form等执行payload，留下内部digest、最小receipt和tombstone；digest不进查询响应/日志 |
| normal high-water | per-Key sequence high-water与accepted同事务且不回绕；queue仍只由operation records派生，GC后不复用sequence |
| Artifact寿命 | opaque 256-bit ArtifactId属于authority realm并owner-bound；不可变body在留存期内跨browser restart，full authority reset才整体失效 |
| 页面文件边界 | `page.dom.get`是有界live DOM投影；`page.archive.capture`是Chrome `pageCapture`产生的当前tab MHTML；`resource.fetch`是新请求；`network.response.get`只读显式已捕获response。四者都不能互相冒充“最初HTTP原件”。MHTML accepted前预留Artifact容量，返回Blob后限size并分块写；Chrome先构造完整Blob及抓取期间内容稳定性均是不能伪造保证的平台边界 |
| response层 | command强制method+schemaVersion；公共business envelope由`protocol/command` descriptor拥有，result/progress/receipt/error-details由Command Registry逐项闭合；operation frame带OperationId+phaseVersion，纯read不伪造phase。transport外层`frameClass=accepted\|progress\|terminal`让relay保留/删除route而不读取business kind/phase |
| response route释放 | wait timeout、client断线或response背压结束relay route后，relay向exact socket best-effort发transport-only `route.abandon`；extension只删除TransportRouteContext，operation/effect/occupation继续，绝不把它映射成cancel |
| 幂等类型 | Command不用`requiresOperationId` boolean；闭合为`none \| operation_id \| admin_mutation_id`，并与boundary/effect/queue做构建组合门 |
| 错误命名空间 | client/relay使用版本化transport profile外层`transportError`；四registry中的Error只覆盖extension/storage/platform command pipeline，relay不得伪造`message.kind=error` |
| 当前鉴权次数 | 入队前鉴权一次，在同 Key 串行队列真正派发前再鉴权一次；当前核心切片删除第三次结果披露鉴权和 `RESULT_WITHHELD`，不把简单本地命令做成三阶段工作流 |
| clock fault后处理 | 当前核心切片没有 Operation/receipt/security-time 状态机，不把其旧三阶段错误语义带入简单浏览器命令；以后真实长 operation 落地时再按实际 effect fence 单独裁定 |
| strict JSON | relay与extension都独立拒绝重复key，并共享byte/depth/node/field/string上限；relay-owned envelope整数先做词法/范围检查，opaque command number保持lossless并由extension schema裁决，不经有损float |
| capability manifest投影 | API `permissions`、`host_permissions`、content/manifest features、CSP script/worker tokens与connect sources分栏声明；offscreen worker显式贡献`worker-src 'self'`，loopback host-permission为显式空候选。P3 packed正/负例失败则先改authoring，不在template暗加 |
| artifact chunk不可变 | `(ArtifactId, ArtifactStagingToken, chunkIndex)`只写一次；同bytes重投才no-op，manifest与chunk同事务追加，final commit与reader都核对冻结digest |
| artifact staging关闭 | metadata闭合为`staging_open \| committed \| orphaned \| released_tombstone`；chunk write/final commit检查operation phase与writeUntil，终态或late期限到达必须同事务转orphaned并关写权，不能只终结operation |
| bootstrap parser | seal与WASM失败诊断路径使用generated TypeScript strict scanner；它与native/WASM golden一致并先用WebCrypto SHA-256验证包，不能依赖普通JSON.parse或尚未验证WASM |
| bootstrap权限判定 | `backend=extension_generated && effectKind=none && idempotencyKind=none`命令使用从同一resolved expression生成的TS evaluator；当前仅`system.describe`。regular/Root/未知atom真值与native/WASM fixture一致，禁止手写放行 |
| WebSocket分片能力 | raw relay/native parser才可在重组前限制fragment count/assembly deadline；browser WebSocket只暴露完整message，extension在平台allocation后先限最终byteLength。默认Blob不是有效输入模式：worker必须同task切ArrayBuffer并只发binary bytes。合法relay不协商compression，不能把浏览器不可观察事实写成probe通过 |
| hydration入口 | listener顶层注册但不把原始请求/Key/params挂在hydration promise上；未ready Agent显式`LEDGER_NOT_READY`，admin mutation关闭，unsolicited content/page拒绝，无界启动队列不存在 |
| target容量退化 | retired历史超限可轮换RuntimeEpoch一次；若fresh active集合本身仍超限，单值projection记录target capability unavailable并停止签发ref，等待事实改变，不能进入epoch轮换循环 |
| control阶段 | `control.acquire/release` 已基于当前真实 TabRef active；occupation owner 只有 Key，foreign acquire 报冲突，必须独立 release 后再 acquire，没有 takeover/force/replace/OccupationId |
| P4外部纵切 | P4激活无需TabRef的真实`keys/settings` Agent读写与`operations.get`，用它们验证OperationId/secret/desired-applied；synthetic effect adapter永不对外。`operations.cancel`等首个可取消normal command再active |
| Cleaner 隔离 | 旧稿仍在 `docs/historical/`；活动实现不含 PageIR/cleaner。页面操作树不继承清洗、删除、模型推断、selection 或遮罩结构，只保留唯一 operation tree、按 Key 展开状态与确定性折叠摘要 |

平台依据：[offscreen document](https://developer.chrome.com/docs/extensions/reference/api/offscreen) · [service worker 生命周期](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle) · [runtime startup](https://developer.chrome.com/docs/extensions/reference/api/runtime) · [extension storage/IndexedDB](https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies) · [IndexedDB strict durability](https://developer.chrome.com/blog/indexeddb-durability-mode-now-defaults-to-relaxed) · [alarms](https://developer.chrome.com/docs/extensions/reference/api/alarms) · [storage.session](https://developer.chrome.com/docs/extensions/reference/api/storage) · [tabs/session identity](https://developer.chrome.com/docs/extensions/reference/api/tabs) · [webNavigation documentId](https://developer.chrome.com/docs/extensions/reference/api/webNavigation) · [pageCapture](https://developer.chrome.com/docs/extensions/reference/api/pageCapture) · [userScripts](https://developer.chrome.com/docs/extensions/reference/api/userScripts) · [MV3 remote-code policy](https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements) · [Chrome WebSocket](https://developer.chrome.com/docs/extensions/how-to/web-platform/websockets) · [Chromium proxy规则](https://chromium.googlesource.com/chromium/src/+/HEAD/net/docs/proxy.md) · [Local Network Access](https://developer.chrome.com/blog/local-network-access) · [WHATWG WebSockets](https://websockets.spec.whatwg.org/) · [WHATWG Fetch](https://fetch.spec.whatwg.org/)。

## 3. 仍需实验或后续范围裁定

- packed offscreen dedicated worker的实际WebSocket Origin/Host/effective proxy decision/request destination及浏览器托管upgrade headers；矩阵覆盖direct/代理/PAC、默认implicit bypass/`<-loopback>`负例、普通/专用`127/8`、有无host grant、预置Cookie/HSTS/HTTP/proxy auth、LNA WebSocket提示和错误response状态。明文候选只在能持续证明本次deployment为DIRECT、变化会关socket且hello前没有secret/状态/未闭合交互时可用；不能从一次实验、service-worker样例或普通extension page猜测。一般profile若走application保护，还要先裁定与verifier-only Key storage兼容的端点认证/密钥来源；推荐把所需extension transport proof封装在同一API Key token内并让密钥终点留在extension后台，而不是增加第二份操作者credential或让relay/offscreen持有解密能力。该设计还必须闭合多实例发现：无bearer探测、唯一匹配后才发送加密Key、零/多匹配、复制profile克隆proof/realm和session断线失效；不能退回“把Key发给每个实例试试”。
- `page.archive.capture`在目标Chromium中的manifest警告、restricted/file/incognito行为、`undefined`/异常、超大Blob、worker终止和capture中导航/DOM变化；MHTML只作不执行的opaque Artifact。需实测bounded slice写入能约束extension-owned copy，同时明确无法约束Chrome在API返回前构造完整Blob的峰值。
- Chrome/Chromium 138 与目标衍生浏览器的 userScripts、host permission、restricted URL、file/incognito行为。
- offscreen/Port/service-worker回收组合下的10秒timer、20秒ping、pong deadline、alarm重建和设备休眠真实时序。
- IndexedDB strict transaction、quota/persistence/upgrade blocked、storage.session access level及worker/browser/reload crash sweep。
- Zig WASM在扩展 CSP下的加载、ABI、内存与冷启动。
- operation 的 dedupe/result retention、队列和消息上限基于压力向量调整。
- fixed identity的packed开发/企业分发先完成能力证据；是否进入Chrome Web Store以后再裁定，并单独闭合隐私披露、最小权限、single-purpose与审核材料。动态用户代码仍走Chrome明确提供的User Scripts API，不改成remote script。

实验失败只更新 Capability/Platform Registry 或合法 Freedom Point，不添加隐藏 fallback、来源身份、自动 takeover、effect 自动重放或把页面树偷换成破坏性清洗。

## 4. 明确撤下

本地业务 Key 库、连接/session 身份、配对码、按连接 lease、断线取消 Key 任务、跨 Key 同 tab 全局 FIFO、atomic takeover、稳定扩展 route ID、公开 OperationRef、永久幂等但有限 tombstone、裸 tabId/snapshotId 动作定位、`page.raw`把当前 DOM称作原始响应、CDP隐式后备，以及全部预定清洗结构。

## 5. 2026-08-29 全域反证后的阶段纠正

| 事项 | 当前实施选择 |
|---|---|
| 工具链 | 生成语义锁Zig 0.16.0与TypeScript 7.0.2，不引入bundler/test framework；Node 25.2.1只是当前验证主机证据，尚不冒充项目最低版本 |
| registry激活 | 当前源码消费者与反向构建校验均不存在，因此四份registry草案全部pending、consumer为空；声明存在、实现存在、resolved build激活和外部route开放是四件不同事实 |
| P0边界 | 只建立严格registry/configurator、生成投影、模块service worker静态引导与包内WASM startup self-test；不创建offscreen、不连WebSocket、不读storage.session、不申请storage/alarms/offscreen/host，不建立业务command handler；CSP connect-src恰好`'self'`供包内读取，尚无loopback/external来源 |
| 引导与capability | seal/清单完整性产生`artifactIntegrityReady`；WASM instantiate/ABI/self-test是独立startup probe。失败时不开依赖WASM的route，但generated TS描述器仍可在P3后报告`activeCapabilityIds`/`effectiveGlobalCapabilityIds`，不建立诊断依赖环 |
| 第一条外部纵切 | P1建authority，P2建Key；P3把Windows/Linux薄relay、完整握手、真实transport scheduler与带Key的`system.describe`一次接通，不造临时无Key或半握手路线 |
| retry consumer | `transport.retry_interval_ms=10000`仍是用户确认的首个Freedom Point，但在P3 offscreen dedicated scheduler、alarms重建、keepalive/deadline和packed MV3证据一起落地前保持pending；service-worker fake timer不算runtime consumer |
| loopback build fact | Freedom Point只保存一个resolved numeric IPv4 `127/8` bind；`127.0.0.1:32189`目前只是pending候选，可在P3证据后换成专用地址。extension/native path与subprotocol是版本化transport profile常量；三端由同一配置器投影，不做端口、DNS、双栈或服务fallback |
| phase次序 | relay/真实command transport必须早于operation和浏览器effect；否则此前阶段无法进行真实Key鉴权纵切、路由与disconnect证伪 |
| TypeScript模块 | 无bundler，因此采用NodeNext解析并要求源码相对import带`.js`后缀；构建脚本只有目标真实存在后才可作为通过门 |

详细文件图和验收见[P0构建与静态引导](implementation/p0-vertical-slice.md)。

审计过程与采纳/拒绝理由见[证伪报告](audits/2026-08-28-falsification.md)。
