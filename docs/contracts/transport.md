# 本地 relay 与传输合同 v0.9

日期：2026-08-29。relay是Windows/Linux薄适配，不进入业务主体模型。业务授权始终由扩展逐请求验证bearer Key。

当前 active profile 的事实范围较窄：exact `127.0.0.1:32189`、分角色 path/subprotocol、manifest 固定公钥派生并生成给 Zig 的 exact extension Origin、server-first hello、binary/uncompressed/restricted RFC6455、64 KiB message、relay-only InstanceRef、有界在线实例/route table、10秒extension重连，以及 source-gated `runtime.sendMessage` business round-trip。round-trip 保留原 connection generation，旧异步结果不能改投新 socket。它是可信本地明文路由，relay可见但不裁决Key payload；Origin 只是 endpoint gate，不是业务身份。下文仍写作候选/P3门槛的 strict JSON scanner、proxy/PAC持续证明、application encryption、Port ACK/backpressure、keepalive/deadline与组合内存公式保留为未来强化，不得拿来描述当前产物；与本段冲突时以本段和 `decisions.md` 的“当前落地裁决”为准。

## 1. 固定拓扑

```text
Agent/native client -> relay client listener
Chromium extension offscreen transport worker -> relay extension listener
relay只按调用瞬间的current InstanceRef选择socket -> extension authority
```

v1 relay只绑定一个生成的numeric IPv4 loopback bind；registry中的`127.0.0.1:32189`只是尚未激活、尚未由用户确认的候选。P3必须同时验证目标Windows/Linux对选定`127/8`地址的bind、浏览器连接和cookie namespace行为；若专用numeric loopback地址能减少与其他localhost服务共享浏览器凭证状态，可在同一个`loopback_bind`点内改候选，但仍只解析一个exact endpoint。不允许`0.0.0.0`、`::`、LAN、远端、DNS hostname、端口扫描或“找到任意兼容服务”。bind由`build.transport.loopback_bind`投影给relay、extension和client；extension/native的path与`Sec-WebSocket-Protocol`是版本化transport profile常量，同样由一个配置器生成，不能各持runtime默认。若以后加入`[::1]`，必须作为有序endpoint profile显式发布，不做双栈猜测/fallback。application message固定为单个WebSocket binary message中的strict UTF-8 JSON；UTF-8 BOM、text message、非法UTF-8、重复object key、超过生成的结构深度/节点/字段/字符串上限、多个JSON值或首尾JSON whitespace之外的尾随字节均拒绝。首尾只允许RFC JSON的space/tab/CR/LF，不接受其他Unicode空白。object key先按JSON规则解码为Unicode scalar序列再做exact duplicate比较，因此`"a"`与`"\u0061"`冲突；拒绝孤立surrogate，不做NFC、大小写或locale folding。拥有raw frame parser的relay/native端在完整重组前执行message byte、fragment count与assembly deadline；结构上限在构造第二份对象或递归validator前执行。浏览器`WebSocket` API只把已重组/解压后的完整message交给extension，JS无法观察fragment数量、assembly时长或协商结果，因此extension只能在平台已分配后先限最终`byteLength`、再限结构，不能伪造“重组前已挡住”的证据。合法relay不协商`permessage-deflate`或任何WebSocket extension并只发送单一binary message；packed Chromium实际提出的header只作为有界已知offer被server忽略，不能让relay库默认开启压缩。恶意同OS假server可在JS看见前迫使Chromium分配，这是明确本地availability边界。

relay listener必须是唯一进程owner：Windows使用不允许共享bind的exclusive socket语义，Linux明确禁用`SO_REUSEPORT`及任何可让两个live listener同时接收的选项；listener handle/fd不可继承并带close-on-exec。native client同样只用direct TCP连接该numeric endpoint，不读取`HTTP_PROXY`/`HTTPS_PROXY`/PAC、不做DNS、不带cookie或HTTP/proxy credential。extension的浏览器网络栈不能由插件作同样承诺，所以其proxy/credential行为属于下述P3阻断矩阵。exclusive bind只消除正常实现的双owner，不抵御同OS进程抢先占端口。

path、subprotocol、role、profile-local字段、response `frameClass`、`route.abandon`与transportError ID/字段的唯一authoring owner是`modules/protocol/transport`中的版本化transport descriptor；configurator把它投影到relay、extension、client和skill fixture。它不是第五份可配置registry：固定字段不能被settings或build Freedom Point改写，任何wire变更都发布新profile并保留明确兼容/拒绝规则。`transportCompatibilityDigest`覆盖该descriptor以及它显式引用、会改变两端解析/限额语义的resolved build-point值；Freedom Registry仍是这些数值的唯一authoring owner。只改endpoint位置或某个组件私有打包事实不冒充wire兼容变化，引用哪些point由descriptor闭合列出，不能由生成器扫描名称猜测。pending point没有resolved值；required ref未active就生成失败，绝不读取pending default凑digest。

Chromium扩展不能为本地程序开放一个可主动拨入并唤醒MV3 service worker的WebSocket server。v1因此由extension主动连接relay。为让未连接状态的10秒cadence不依赖会休眠的service worker timer，后台创建唯一packaged offscreen document，并以真实`WORKERS`理由让其dedicated worker拥有WebSocket/retry；offscreen page只用`chrome.runtime`连接后台。Native Messaging在Windows/Linux也由extension调用`connectNative()`启动host，无法反转这一方向；v1不申请`nativeMessaging`。

平台依据：[Offscreen API](https://developer.chrome.com/docs/extensions/reference/api/offscreen) · [实时连接](https://developer.chrome.com/docs/extensions/develop/concepts/real-time) · [WebSocket service worker](https://developer.chrome.com/docs/extensions/how-to/web-platform/websockets) · [Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)。

## 2. 角色、网页隔离与握手

extension socket与native client使用两个分离的path及精确`Sec-WebSocket-Protocol`。`instances.list`和`relay.stop`是native transport envelope的local kind，不再建立第三业务/控制command plane。HTTP upgrade后只允许版本化transport hello/role-handshake frame；在role握手完成前不分配InstanceRef、不接受`forward/instances.list/relay.stop`或任何business frame。hello是握手帧，不得被文字上的“无application frame”禁令否定。

资源门必须从TCP accept/HTTP upgrade开始，而不是等role成功：全部open sockets、pending HTTP/role handshakes、upgrade header bytes/field count和握手单调deadline各有generated build hard limit；达到任一上限立即关闭且不分配role/InstanceRef/route。除此之外，relay对所有socket当前保留的HTTP/role bytes与WebSocket message assembly bytes维护一个`build.transport.maximum_raw_input_bytes_total`全局reservation，在append/read buffer分配前原子取得、consume/close时精确归还；不能让160个各自“低于1 MiB”的合法局部buffer绕过allocator总预算。这个单项global仍不足以证明进程总内存：resolver还必须把raw input、forward queue、response queue、socket/route/parser固定最坏开销、control headroom及同时存在的copy系数求和，证明不超过`build.relay.maximum_managed_memory_bytes`；不能让三个各自“低于allocator预算”的64 MiB bucket组合成未声明峰值。pending socket占总socket与pending-handshake计数，成功后原子转入native/extension role计数，失败/timeout/disconnect精确归还。若三个上限宣称可同时达到，构建关系必须要求总socket至少容纳native + extension + pending之和。网页即使最终会被Origin拒绝，也不能靠许多半握手连接绕过role后的client/instance上限。role完成后每条WebSocket message仍有fragment count、assembly deadline和双方buffer预算；relay分别限制发往extension的per-extension/global forward bytes及发往client的per-client/global response bytes。达到response预算先丢transport外层明确标为`progress`的frame，accepted/terminal无法安全写时关闭route；不能让多个client或慢socket线性放大内存。

relay至少验证：

- HTTP method/version/upgrade/connection/WebSocket version/key等握手字段符合closed profile；Host、Origin、Sec-WebSocket-Protocol及其他singleton字段重复一律拒绝，不能由通用header map“最后一个覆盖”。header name按ASCII case-insensitive规则归一后计重复，value不做逗号拼接来绕过exact role检查。
- HTTP header拒绝obs-fold、裸LF、NUL/其他禁止CTL、冲突Content-Length/Transfer-Encoding和upgrade后的额外请求字节；客户端精确验证server的101、`Sec-WebSocket-Accept`与唯一selected subprotocol，不能只因TCP已连或收到任意hello就发送Key。
- `Sec-WebSocket-Extensions`只接受P3抓包证明的有界浏览器offer形状并在response中明确不协商；native profile固定不提出extension。任何未知/重复offer拒绝，relay库的自动compression必须关闭。
- Host/authority恰好是已解析的numeric loopback endpoint。
- path与subprotocol恰好匹配声明role。
- client path只接受无浏览器Origin的native连接，拒绝`http:`、`https:`、`null`等网页Origin。
- extension path只接受目标packed extension实测并由同一build profile明确列出的extension Origin。该值必须来自固定打包/签名证据或显式开发profile，不能首次连接自动学习；实际header在首轮packed Chromium测试前保持fail-closed。
- manifest不声明`externally_connectable`；不注册外部extension/web command listener。

role成功后的raw WebSocket codec同样闭合而非交给库默认：client→relay frame必须masked、relay→client frame必须unmasked；RSV位在未协商extension时全零；只接受合法binary/continuation/control opcode和fragment sequence；control frame必须FIN、payload≤125且close payload/code/reason合法UTF-8；64-bit length最高位必须零，`126/127`扩展长度必须使用最短编码，并在分配、mask/unmask和累计前先做checked limit。text application frame、孤立continuation、新data frame打断未完成fragment、fragmented control、未知opcode、错误mask方向、非规范长度和超限均关闭连接且不交给JSON scanner。raw relay/native profile还必须固定RFC control语义：incoming protocol Ping只在per-socket control-rate/queued-byte预算内回同payload Pong；unsolicited Pong只作bounded discard；合法Close走一次闭合handshake，重复/非法立即终止。v1 relay不主动发协议层Ping，协议层control也不重置下文的**application-worker liveness**，否则浏览器网络栈自动Pong会把已经不运行的extension worker伪装成在线。浏览器WebSocket侧的协议Ping/Pong由Chromium内部处理、JS不可观察，因此只把这一事实列为平台边界，不伪造extension rate probe。使用第三方库也必须用这些negative fixture证明配置，不能把“库能连通”当closed profile证据。[RFC 6455](https://www.rfc-editor.org/rfc/rfc6455)是该层固定协议依据；应用层仍只允许一个binary message中的strict JSON。

server-first hello只保护尚未发送的application Key，不能倒推HTTP upgrade在hello前零凭证、零状态副作用。[WebSockets Standard](https://websockets.spec.whatwg.org/)把opening request接入Fetch，固定`credentials mode=include`、`cache mode=no-store`和`redirect mode=error`；[Fetch Standard](https://fetch.spec.whatwg.org/)同时定义Cookie/HTTP authentication和`Set-Cookie`处理。因此要分开验证两个方向：请求可能在101前向错误占用者或被配置代理发送`Cookie`、`Authorization`、`Proxy-Authorization`或其他浏览器托管secret；错误占用者的握手响应也可能在应用hello验证前写入cookie/auth状态或触发浏览器交互。更重要的是，`ws://`若经过代理，代理即使只透明转发合法hello，也能继续看到后续bearer Key、命令与结果；“最终到达正确endpoint”不等于直连或保密。[Chromium proxy合同](https://chromium.googlesource.com/chromium/src/+/HEAD/net/docs/proxy.md)对`127/8`有隐式bypass，但手工`<-loopback>`可以取消这一规则；这不是扩展可凭默认值永久假定的事实。P3必须用无真实用户secret的隔离profile，在无/有host permission、普通`127.0.0.1`/候选专用`127/8`地址、direct/系统代理/PAC、默认implicit bypass与`<-loopback>`负例、预置host-only/partitioned/SameSite/Secure cookie、HSTS/HTTP/proxy auth状态的矩阵中抓取effective proxy decision、request destination和headers；并让受控错误listener返回有效/无效101、3xx、`Set-Cookie`、401/407/auth challenge及有界代表性Fetch状态header，再检查redirect确实不跟随、cookie/auth/站点状态、UI/prompt和后续请求。还要覆盖[Chrome 147已把LNA扩展到WebSocket](https://developer.chrome.com/release-notes/147)后，目标版本对extension-origin连接是否触发/阻止/记忆浏览器权限；未预先满足时不得让10秒retry形成重复提示。一次实验室矩阵只能证明被测配置，不能把用户机器以后可变的系统代理/PAC或enterprise policy永久冻结为DIRECT。当前明文profile只有在**本次部署/运行**能得到并持续维持exact endpoint为DIRECT的有效证据、代理变化会使能力失效并关socket，且hello前无托管secret、错误响应无未声明状态、连接无未闭合交互时才能active；若扩展没有权限/接口观察这些动态事实，就只能把它限定到有外部强制且可审计的deployment profile，不能面向一般Chromium安装宣称安全。通用profile应先采用不向relay/代理暴露bearer secret、且由Key材料端到端认证与保护application bytes的版本化transport，或其他显式extension transport；具体密码学descriptor必须另行闭合transcript、replay、key-derivation、AEAD counter、redaction与native/WebCrypto golden，不能临时自创。该加密只改变传输机密性，Key授权裁决仍唯一在extension；它也不解决opening request状态或LNA提示。relay事后拒绝/不记录header无法撤回错误listener/代理已看到的bytes，也无法撤销浏览器已处理的响应。全部握手header值按secret处理，不进入日志；产品relay生成的101也固定禁止`Set-Cookie`和auth challenge。能仿造完整relay hello的恶意同OS进程仍属于当前明文候选的本地transport TCB边界，但普通系统/远端代理不能因配置存在就被无声提升为TCB。

loopback capability对manifest的三类投影分别是API `permissions`、`host_permissions`和extension-page CSP `connect-src`，生成器不得把其中任一类隐含在另一类。当前pending capability显式声明空`manifestPermissions`、空`manifestHostPermissions`与唯一numeric loopback `connect-src`候选；P3必须在packed Chromium中以正/负例证明WebSocket确实不需要host permission才能active。若实测要求host permission，必须先把精确派生pattern加入Capability authoring/schema与manifest反向门，不得在TS或manifest template暗加。官方文档对extension-origin `fetch()`明确要求host permission，但WebSocket教程未声明这项；因此两者不能互相推导，以P3实证为激活依据。

握手顺序：

1. relay先验证自己的非自指artifact seal，再发送不含secret的`product + transportProfile + transportCompatibilityDigest + componentKind + targetTriple + resolvedBuildArtifactDigest` hello；seal缺失/不一致时不监听业务role。
2. native client或extension验证product/profile，并要求transportCompatibilityDigest相等或命中该profile显式生成的transport兼容表；hello中明确属于relay component的`resolvedBuildArtifactDigest`只供诊断/供应链核对，绝不要求与extension/client的同名字段相等。失败立即关闭。
3. endpoint先验证自己的component seal，再发送role hello和bounded static descriptor，包含自己的`componentKind + targetTriple + resolvedBuildArtifactDigest`与同一transportCompatibilityDigest。extension/client descriptor还可携带各自的commandProtocolDigest供client选择和诊断；relay只保存/回显，不解析也不与自己的build比较。descriptor不含Key、ExtensionRuntimeEpoch、tab/URL、浏览器profile/install身份或可被relay当稳定route identity的字段。
4. relay只按transport profile compatibility验证后才把socket加入对应role。extension socket此时在relay内分配InstanceRef，但响应绝不把InstanceRef发给extension。Windows relay、Linux relay和extension因component kind、target和文件集合不同而拥有不同`resolvedBuildArtifactDigest`是正常事实；新增extension命令本身不要求relay重建。
5. 当前明文候选中的native client只在完成server-first hello后发送`auth.apiKey`；受保护profile在端点认证与加密channel成立前不得发送bearer Key或application明文，server-first compatibility hello本身不算该密码学证明。

Origin/Host/role门能阻止普通网页和错误服务，不是Agent/business identity，也不能认证能仿造整个协议的恶意同OS用户原生进程。relay是否能看到bearer Key取决于P3最终选择的application profile：当前明文候选把relay纳入bearer-Key transport TCB；受保护profile则必须在任何Key/application明文离开native client或extension后台前完成端点认证与加密，使relay/offscreen只见路由元数据和opaque payload。两者都不把endpoint proof混入Key权限、queue或occupation，也都不改变extension是最终Key授权者。

## 3. 三个严格profile

### Agent → relay：`agent-relay-json-v1`（当前明文候选）

```json
{
  "profile": "agent-relay-json-v1",
  "kind": "forward",
  "clientRequestId": "cr1.B5m8P2s6V9x3A7d1F4h0jQ",
  "waitTimeoutMs": 30000,
  "targetInstance": {
    "relayEpoch": "m0n2p4q6r8s1t3u5v7w9xA",
    "instanceNumber": "12"
  },
  "auth": {"apiKey": "<secret>"},
  "command": {
    "method": "system.describe",
    "schemaVersion": 1,
    "params": {}
  }
}
```

extension-bound command必须有auth。relay在请求准入的同一coordinator临界区立即解析目标：targetInstance在恰有一个online extension时可省略；零个立即返回`EXTENSION_UNAVAILABLE/KnownNotDelivered`，多个省略target立即返回`TARGET_INSTANCE_REQUIRED/KnownNotDelivered`，显式stale target立即返回`STALE_INSTANCE/KnownNotDelivered`。省略只表达“本次意图就是任意唯一current实例”；generated skill/client对`operation_id`重投、operation查询以及任何要求实例连续性的调用先`instances.list`并显式固定ref，不能把wire允许省略误写成重连安全。relay绝不保存Key/command等待未来socket，也不把重连后第一个实例猜成旧目标；需要等待extension出现的skill/client只能轮询无Key的`instances.list`，确认current InstanceRef后再首次发送command。

若P3采用受保护application profile，它可以在business command前登记一组**transport-only、无bearer、无OperationId**的端点证明/crypto-handshake frame；这些frame不进入Command Registry、不建立业务caller/session/lease，也不能携带命令。native client只能向`instances.list`返回的有界current InstanceRef逐个发公开proof绑定的密码学探测，relay/offscreen只转发bounded ciphertext，extension后台终止验证。恰好一个匹配后才可发送加密Key；零匹配失败，多个匹配返回显式歧义并要求操作者选择，绝不first-wins、广播业务命令或把重连socket猜成旧安全上下文。该探测协议、最大尝试数、transcript和错误形状必须进入受保护transport descriptor；它不是当前明文JSON profile的隐含功能。

protected profile必须显式选择crypto状态寿命，不能同时声称“密钥只在background”和“background消失后session/socket无损继续”。当前优先验证**每请求独立密封application envelope**：Key token携带公开endpoint proof；extension后台持有版本化transport private material；每条request使用fresh nonce/ephemeral material并把profile、当前extension-socket公开challenge、inner schema/OperationId及response key binding纳入closed transcript，background醒来后可独立解封，offscreen始终只见ciphertext。mutation/effect replay仍由OperationId ledger裁决，read replay只形成有界重复观察/负载，不能产生隐藏effect。具体primitive、nonce唯一性、forward-secrecy边界及response binding仍需golden后裁定，不能从本段名字发明密码学。若最终改用长会话密钥，则会话只在exact live background realm；background Port/realm丢失必须立即销毁session并关闭extension socket，使InstanceRef失效后重握手，禁止让offscreen持钥、把session key持久化成未声明credential，或沿用仍开着的socket制造假continuity。

relay只验证transport envelope、字段/消息/结构硬上限、`auth.apiKey`是有界字符串、`command`是一个有界JSON object以及target route shape。**relay-owned envelope**中的无符号整数字段（例如`waitTimeoutMs`）词法固定为`0|[1-9][0-9]*`且必须落入字段闭合范围；不接受负号、fraction、exponent、前导零，也不能先转为有损float再验证。u64 route/generation继续使用规范十进制字符串。

native client连接数、每client in-flight和全部已选route总数分别受生成的硬上限约束。总socket/pending-handshake门先于role；通过role校验但native role已满时，在加入role表前关闭。达到per-client/total in-flight上限时返回`TRANSPORT_LIMIT_EXCEEDED/KnownNotDelivered`且不分配relayRequestId、不缓存auth/command。目标选择后还必须原子预留对应extension route count以及per-extension/global forward-byte预算；在任何socket write前失败仍是KnownNotDelivered。完整message从raw assembly转入forward/response queue时，必须先取得目标bucket及其最坏copy headroom，再原子转移buffer所有权或在两份buffer并存期同时记账，最后才归还raw reservation；禁止“先释放raw、后申请queue”的瞬间无owner，也禁止把copy同时存在从总内存代数中漏掉。socket已接受frame write后释放relay持有的auth/command source buffer并尽力显式清零；只保留小型route metadata。客户端断线、deadline或terminal删除route并归还计数；不能只限每client而允许许多client绕出无界总表。

relay还按每条extension socket冻结`inflightRouteCount`与queued-forward bytes，达到`maximum_inflight_per_extension`或forward-byte预算时在写socket前返回`TRANSPORT_LIMIT_EXCEEDED/KnownNotDelivered`。extension offscreen worker与service worker用同一resolved count/aggregate-source-byte预算独立约束当前socket generation的已接收未terminal route，并用更小的generated WebCrypto auth worker pool处理；normal relay永不越界，恶意/错误fake relay出现duplicate relayRequestId、超count/bytes或非法outer frame时extension关闭该socket且不为溢出frame创建business operation。WebSocket API已经交付的ArrayBuffer分配仍属于平台层，之后的decode/Port复制/parse/auth/plan副本与并发必须保持在这些计数内。

`command`内部number只由relay检查为合法JSON number token、token长度与整体结构预算；负数、小数和指数形式是否允许、是否必须规范化以及具体范围全部由extension的command schema决定。relay必须用lossless token/validated source-slice表示保存该opaque child，不能先转IEEE-754再重发而改变数值。它通过重建outgoing **外层** envelope剥离client/instance字段，但可嵌入已经独立strict-scan且保持逐字节number/string语义的command值。对当前明文候选而言，relay仍把`auth`与`command`当作不解释但可见的opaque-secret value；Key格式、method/schemaVersion、OperationId、permission、target/control/capability全部由目标extension严格验证。extension也独立执行strict JSON/重复key/结构上限检查，不能把可信relay当唯一parser防线；同OS假relay属于该明文候选的TCB但不因此获得无限输入预算。若P3选择受保护profile，relay对应位置只能扫描版本化外层路由字段与bounded ciphertext，不能获得解密能力或复用本段的明文child scanner。

受保护profile不能把“ciphertext bounded”当成background内存已闭合。descriptor必须固定wire encoding及其最坏膨胀、nonce/tag/ephemeral-key长度和可解封plaintext上界；extension在调用任何私钥/AEAD primitive前先过outer shape/count/deadline并取得独立crypto-work slot与可计算的plaintext target reservation。密文source、base64/binary decode、AEAD plaintext、strict parse与typed command并存时分别计费，只有目标owner已取得后才释放上一层；tag/proof失败立即清理且不进入Key auth池。response则在稳定business plaintext与目标ciphertext预算同时存在时加密，成功post ciphertext后才清理plaintext。relay/client也按同一descriptor证明ciphertext frame与application limit关系；不能让明文limit加密后越过wire上限，或让非法密文制造无界WebCrypto promises。具体受保护profile未选中时这些字段/points无consumer、不可出现在当前明文摘要中。

native local kind使用同profile，省略auth、target和command。闭合集合只有：

```json
{
  "profile": "agent-relay-json-v1",
  "kind": "instances.list",
  "clientRequestId": "cr1.B5m8P2s6V9x3A7d1F4h0jQ"
}
```

另一个local kind为`relay.stop`。两个local kind都是当前relay coordinator内的立即操作，schema禁止`waitTimeoutMs`、auth、target和command；client自己的socket deadline不变成relay字段。产品/protocol/build描述已经由server-first hello给出；运行与实例状态已经由握手成功/失败及`instances.list`给出，因此删除重复的`relay.describe`与`relay.status`。local kind不进入Command Registry、Key permission UI、extension dispatcher、WASM或业务Error Registry。无Key不代表允许网页调用；native role/Origin门仍强制。

client-local/relay transport错误ID是该profile的闭合集合：`CLIENT_COMPANION_UNREACHABLE`（仅client在未请求启动时合成，不能把connection failure断言成“进程未运行”）、`CLIENT_COMPANION_START_FAILED`（固定launcher/child给出明确失败证据）、`RELAY_STARTUP_TIMEOUT`（启动收敛总期限内没有兼容hello）、`TRANSPORT_PROTOCOL_MISMATCH`、`TRANSPORT_SCHEMA_INVALID`、`REQUEST_ID_IN_USE`、`TARGET_INSTANCE_REQUIRED`、`STALE_INSTANCE`、`EXTENSION_UNAVAILABLE`、`ROUTE_DELIVERY_UNKNOWN`、`WAIT_TIMEOUT`、`RELAY_STOPPING`和`TRANSPORT_LIMIT_EXCEEDED`。relay返回时使用外层`transportError.errorId`且没有extension `message`；只有extension frame可产生`message.kind=error`。这组ID由transport profile版本生成，不复用业务Error Registry的numeric `code`字段，relay也不加载该registry。client-only启动错误从不伪装成wire response；可选details只允许闭合的阶段/OS错误类别和脱敏exit code，不含任意stderr、路径或环境值。

forward在选不到实例时的形状例如：

```json
{
  "profile": "agent-relay-json-v1",
  "clientRequestId": "cr1.B5m8P2s6V9x3A7d1F4h0jQ",
  "delivery": "KnownNotDelivered",
  "transportError": {
    "errorId": "EXTENSION_UNAVAILABLE"
  }
}
```

`transportError`与`message`互斥；选过实例时可附冻结的`routedInstance`。`instances.list/relay.stop`等local response没有extension delivery，固定省略`delivery`和`routedInstance`，使用各自闭合result或transportError。

`instances.list`只返回relay生成的InstanceRef、socket连接时间/role状态以及握手中的transportCompatibilityDigest、extension commandProtocolDigest和放在extension component descriptor内的`resolvedBuildArtifactDigest`。response可另有明确命名的relay component descriptor；两者不得混容器或比较相等。client/skill可据commandProtocolDigest判断自己的生成目录是否精确匹配；不匹配时仍只能按稳定method/schemaVersion显式处理兼容性，relay不能改写command。**禁止**为了区分两个外观相同的实例而把同一bearer Key依次发送给每个InstanceRef；wrong instance也会在验证前看到整枚credential，且只读命令不会把这种泄露变安全。当前明文候选在多实例且调用方没有明确选择依据时只返回`TARGET_INSTANCE_REQUIRED`并停止。受保护profile只能使用上一段无bearer密码学探测，唯一匹配后才发送加密Key；多个匹配仍不自动选择。relay不得缓存探测/业务结果或据此建立重连映射。`relay.stop`的线性化语义见第7节。

### relay → extension：`relay-extension-json-v1`（当前明文候选）

```json
{
  "profile": "relay-extension-json-v1",
  "relayRequestId": "rr1.27",
  "auth": {"apiKey": "<secret>"},
  "command": {
    "method": "system.describe",
    "schemaVersion": 1,
    "params": {}
  }
}
```

同一profile中唯一按response route寻址的无business payload控制frame为：

```json
{
  "profile": "relay-extension-json-v1",
  "kind": "route.abandon",
  "relayRequestId": "rr1.27"
}
```

它禁止`auth`、`command`、`frameClass`、client/instance字段和任何自由details。普通command frame禁止`kind`；因此两种closed shape不能靠字段优先级歧义解析。abandon只在relay已经结束对应本地response route后best-effort发送，不是extension business command、ACK或cancel。

connection-local keepalive另有两个固定transport shape，不使用relayRequestId、Key、command、frameClass或business message：extension→relay的`{profile, kind="transport.ping", pingId}`与relay→extension的`{profile, kind="transport.pong", pingId}`。`pingId`是从1开始、不回绕的canonical u64 string；每socket最多一个outstanding ping，pong必须在同一exact socket逐字匹配当前ID。relay在role完成时启动单调application-liveness deadline，只对严格递增的下一个ping立即回相同pong并推进deadline；首个/相邻ping快于`build.transport.minimum_application_ping_interval_ms`、在`build.transport.extension_application_idle_timeout_ms`内未收到下一ping、重复、跳号、混入业务字段、未知kind或counter耗尽都关闭socket并使InstanceRef失效。普通business response或RFC协议层Ping/Pong不能替代该专用worker-liveness证据。两种frame由transport descriptor生成并使用独立的小型逻辑control-frame预算，永不进入client route、background Port、Command Registry或operation ledger；物理WebSocket send buffer仍共享，预算或保留headroom不足时不排队，直接关闭socket进入正常retry。`route.abandon`因此仍是唯一response-route控制frame，而不是整个profile唯一transport control。

relay只在当前target socket已经精确选定、全部route/byte预算已经预留后，为forward分配唯一易失`rr1.<canonical-u64-decimal>` relayRequestId，并保存`relayRequestId -> exact extension socket generation + client response channel`直到terminal/wait deadline/disconnect。`waitTimeoutMs`是transport-only正整数；relay按生成的闭合上限严格验证，越界即拒绝而不暗中clamp，并在target选择成功时换算为进程单调deadline。它不用于等待未来实例，不进入extension command、OperationId或effect timeout，也不cancel已接受operation。转发前删除targetInstance、clientRequestId、waitTimeoutMs与kind。extension schema出现`targetInstance`、`relayEpoch`、`instanceNumber`或client route字段时必须拒绝。若client断线、wait deadline或response backpressure在business terminal前结束本地route，relay在删除route后向同一exact extension socket best-effort发送transport-only `route.abandon{relayRequestId}`；它只让offscreen/background丢弃该TransportRouteContext和后续response，不改变operation、Key、occupation、effect deadline或cancel状态。socket关闭自然清全部route；重复/迟到abandon幂等丢弃。

`clientRequestId`闭合为`cr1.<base64url-16-byte-random>`，只需在当前client connection的in-flight集合中唯一；重复in-flight ID返回`REQUEST_ID_IN_USE`且不forward。relayRequestId由relay在relayEpoch内从1单调分配、达到u64上限拒绝，不因client ID复用而复用；deadline/断线删除route后迟到extension response按旧relayRequestId丢弃，绝不能误投给后来请求。二者都是transport correlation，不是Key/caller identity。

route record同时冻结目标extension socket generation；只有该socket上的相同relayRequestId响应可命中。另一个实例即使猜到ID也不能替代回应；目标socket断开后route按已有证据终止，绝不迁移到其他socket。

`WebSocket.binaryType`规范默认是`blob`，所以每个connect attempt必须在构造器返回的**同一JS task**内、任何事件可被交付前设置`socket.binaryType = "arraybuffer"`；首个server hello及之后每条message都要求`event.data`精确为`ArrayBuffer`，Blob/string/其他shape立即关闭。这样避免把默认Blob/潜在磁盘spool误当已受source-byte门约束，但仍不声称能控制Chromium在事件前的内部allocation。extension所有outgoing application frame也先生成exact UTF-8 bytes并以binary `ArrayBufferView`发送，绝不把JSON string交给`send()`形成text frame。

offscreen dedicated worker收到浏览器已完整交付的binary message时先按最终`byteLength`、当前generation的inflight count和`build.extension.maximum_inflight_source_bytes` aggregate reservation限额，拒绝BOM并用fatal UTF-8 decode；该reservation覆盖worker source、page/Port复制和background full parse所需的有界逻辑倍数，不能复用relay写socket前已经归还的forward-queue预算。每条需要桥接的business/abandon source由worker在当前connectionGeneration内分配不回绕的`inboundItemId`，从交给page前开始冻结`transport.offscreen_bridge_timeout_ms`单调deadline；只有后台完成独立full scan、先取得`build.extension.maximum_admitted_command_bytes_total`或对应立即错误路径的目标预算、在源和typed副本并存期同时计费，并通过下述exact release handshake后，worker才能归还该source reservation。没有目标reservation或wire-level release就不能在prose里声称“后台已接管/明确释放”；禁止先释放source再申请auth/dispatch storage。平台内部copy仍单列availability边界；实现自己的字符串、编码buffer和parser对象必须由生成的最坏扩张系数反向证明落入各realm allocator预算，不能仅把raw bytes相加就叫实际内存上界。所有extension可控source、admitted command、outbound response、WASM/route/parser/control固定开销及转移copy还必须checked-sum到`build.extension.maximum_managed_memory_bytes`，逐bucket有上限不等于组合峰值闭合。worker不能观察或声称验证WebSocket fragment/assembly/compression。随后只能调用由`protocol/transport`生成的transport-only strict outer scanner：验证profile、closed outer shape并提取exact relayRequestId，识别closed `route.abandon`，或在worker本地消费exact `transport.pong`；禁止先用`JSON.parse`、禁止解释auth、method、params或business schema。duplicate command relayRequestId、错误pong或任一预算失败都关闭socket，不能把歧义frame交给后台；合法abandon命中当前pending就释放，已terminal/已abandon/从未存在的ID按同generation bounded no-op处理，不创建状态。ping由worker直接生成、pong只结算当前liveness deadline，二者绝不桥接到page/background。offscreen page只把`inboundItemId`、保持源码字符的bounded business/abandon source string、原始byteLength、connectionGeneration和scanner提取的transport identity通过**为该context建立的exact runtime Port**交给service worker。

page主动`runtime.connect`，后台顶层listener验证sender extension id、精确packaged offscreen URL、无tab sender，并把`port.sender.documentId`与当前`runtime.getContexts({contextTypes:["OFFSCREEN_DOCUMENT"], documentUrls:[exactUrl]})`返回的documentId精确匹配；content/side-panel/popup即使猜到Port name也拒绝。page不注册通用`runtime.onMessage`业务入口，只接受一个固定、无业务载荷、无Key/descriptor的`transport.bridge.reconnect`唤醒通知；它唯一允许的结果是page在**当前没有live exact Port且没有connect handshake在途**时singleflight发起上述Port握手，迟到/重复wake在已有Port或pending connect时是bounded no-op，绝不能创建第二个Port。无Port期间background只保留一个`bridgeWakePending` singleflight，后续settings变化仅替换最新desired descriptor，不重复发送wake；wake完成/失败/超时后由同一个reconciler决定是否创建context或等待下一平台唤醒，不能形成另一条消息洪泛。该窄通知解决idle Port已断开时后台无法推新revision的问题，不能承载frame、配置值、authority事实或response，也不能替代Port sender/documentId门。Chrome runtime messaging是JSON值通道，不假装零拷贝ArrayBuffer；Key/frame字符串会有平台复制，因此两侧都不得日志或长期缓存。后台收到Port frame后先要求`inboundItemId`在该connectionGeneration/exact Port的current incoming集合中唯一，再重新按UTF-8编码source string，要求实际byte length等于声明值、独立运行完整strict scanner，并要求其中的transport identity与transport-only提取值完全相同，不能把side metadata当可信替代。full scan成功还不等于可以释放source：后台必须先按canonical source-equivalent bytes和generated typed-expansion系数取得admitted-command/auth/route目标reservation，再复制后续需要的闭合typed值；复制重叠期source与target两边都计费。目标预算不足时不得建立business operation，必须在仍持source reservation时生成有界立即错误或关闭socket。只有目标owned value或立即错误response已经安全入预算，才为该inboundItemId排入下述`inbound_release`；同一route的business response不得越过其release ACK。schema/authority未ready等不保留command副本的路径也必须释放。command frame才冻结`TransportRouteContext{connectionGeneration, relayRequestId, exactOffscreenPort}`并进入hydration/auth/dispatch；目标admitted reservation持续到typed command/plan/handler不再需要该值，route abandon本身不cancel operation，因而不能把断开route误当成归还业务内存的充分条件。`route.abandon`只CAS删除同context、清除尚未post的该route response并使旧handler后续输出丢弃，没有context时幂等no-op，绝不进入Command Registry或operation transition。已经post给exact worker的frame无法撤回，但只能落到原socket并由已删route的relay丢弃，绝不能改投。socket或Port关闭后只能丢弃，旧handler不得改投“当前Port/OPEN socket”。该context不上wire、不持久化，也不参与Key/operation identity。service worker strict scanner即使WASM startup probe失败也必须独立拒绝decoded duplicate key、孤立surrogate、深度/节点/字段/token超限和尾随值，并把JSON number保留为lossless token直到具体schema做安全整数/有限float/规范形式裁决；不能先变成IEEE-754再把已舍入值送validator。offscreen transport-only scanner、后台full scanner与native/WASM canonical fixtures共享相应outer corpus。

`Port.postMessage()`和浏览器WebSocket隐藏队列都不能当无限sink。background→page的exact Port对**全部outbound item共用一个全局在途slot**，item闭合为`runtime_descriptor | inbound_release | business_response`；page只桥接。单槽只能禁止同时在途，不能防止旧item的重复ACK在下一item已占槽后误释放它，因此后台还为该exact Port从1单调分配不回绕的canonical u64 `bridgeItemId`，每个outbound item都必须携带。`inbound_release`固定只含`bridgeItemId + connectionGeneration + inboundItemId`，禁止source、Key、command、relayRequestId或自由details；worker只在exact generation/current source reservation命中时释放。descriptor有generated固定小型字节上限，后台最多保留一份最新desired canonical replacement，多个settings revision在发送前只合并到最新值，绝不逐项排队。worker严格验证并接纳descriptor为desired事实后，经page返回closed `{kind:"transport.bridge.descriptor_received", bridgeItemId, revision}`；只有ID/revision都命中当前slot才释放。这只确认收妥，不等于restart类point已经applied，后者仍用独立的`descriptor_applied`状态事件报告。bootstrap descriptor收妥前不发送inbound release或business item；这段bootstrap时间内worker也不得接收business WebSocket frame，避免产生无法释放的source reservation。

accepted/progress/terminal/read frame先占`build.extension.maximum_outbound_response_source_bytes`总预算；worker同步完成closed outer复核、binary encode以及send/drop决定后，经page在同一exact Port返回唯一business ACK `{kind:"transport.bridge.outbound_ack", bridgeItemId}`。它没有relayRequestId、status、业务载荷或其他字段；`bridgeItemId`只是Port-local相关序号，不进入被编码的WebSocket business frame。worker处理`inbound_release`、释放exact source reservation后回closed `{kind:"transport.bridge.inbound_released", bridgeItemId, inboundItemId}`；后台只有收到这项exact ACK才允许同route business response进入候选。三种ACK只在同一exact Port且与当前pending `bridgeItemId + kind`（descriptor再加revision，release再加inboundItemId）精确匹配时归还slot/预算；duplicate、附加字段、错误ID/kind/revision、已释放inbound ID或无pending ACK关闭Port/socket。这样A的迟到重复ACK在B已占槽后会因ID不匹配关闭bridge，而不会误确认B。旧Port断开后其ACK绝不迁到新Port；任一counter耗尽时关闭对应socket/context，绝不wrap。page→background的descriptor applied事件同样只允许当前已收妥revision、单调且至多一个reconcile在途；倒退/跳过未知desired关闭bridge，不能用事件流建立第二个队列。

后台未交给Port的business队列也按route状态而非任意frame历史计数：每个active route至多保留一个未发送accepted和一个terminal，progress最多一份且新值覆盖旧值；terminal出现时删除尚未发送progress。`inbound_release`队列由当前generation尚未release的incoming item一一派生，数量/bytes同时受inflight source count与aggregate source reservation约束，不能凭空创建；同一inbound ID只允许一个current release。全局item count因此由active route与incoming source上限机械派生，byte预算不能被大量微小对象绕过。任何已经post的item不得被后项越过；同route release必须先于其business response得到ACK。bootstrap descriptor之后，descriptor、release与business三类中只要两类以上pending，就按生成的固定轮转次序公平选择，不能让连续settings revision、入口flood或response flood永久饿死另一类；descriptor自身仍只保留最新desired。

后台post任一outbound item时同时冻结其`bridgeItemId`与`transport.outbound_bridge_ack_timeout_ms`单调deadline；超时即使总byte预算尚未满也要使该exact Port/全部TransportRouteContext失效，disconnect并请求销毁对应offscreen context，使socket最终关闭，不能靠“队列有界”长期保留Key/result/descriptor。worker侧每个inbound source从首次bridge post起另受`transport.offscreen_bridge_timeout_ms`约束；background release即使尚在公平队列中也不能延长该冻结期限，任一期限先到都关闭socket/Port并一次性归还全部该generation逻辑reservation。page/worker恢复后发现旧Port或旧slot只能丢弃；relay侧application-idle deadline仍是卡死context的独立最终上界。其余待发business frame留在上述有界route-state队列，progress可合并/丢弃，accepted/terminal/read无法入预算时关闭该socket并丢弃transport response context，绝不丢durable operation truth或把secret转交另一route；settings侧永远只有当前desired canonical descriptor，不形成revision spool。worker在每次business send前checked验证`socket.bufferedAmount + frameBytes + generatedControlHeadroom <= build.extension.maximum_websocket_buffered_amount_bytes`；超限时progress可丢并ACK，accepted/terminal/read则关闭socket且不调用send。`bufferedAmount`只覆盖浏览器报告的application queue，不伪称控制内核/OS全部副本；逻辑source预算还必须乘生成的实现扩张系数，二者共同只给插件可控制内存设界。一次性secret在任一失败路径立即删除产品引用、可变byte buffer尽力清零且永不改投；不可变JS string、Chrome messaging/WebSocket和OS内部副本无法作密码学擦除保证。

### extension → WASM：`extension-wasm-v1`

只传validated command values、resolved facts、transition/effect request和typed receipt bytes。它不含Key明文、InstanceRef、request route、页面对象或Zig裸指针。buffer有明确alloc/free或单调用arena合同。

### 响应与事件

extension回relay的每个frame固定为：

```json
{
  "profile": "relay-extension-json-v1",
  "relayRequestId": "rr1.27",
  "frameClass": "terminal",
  "message": {
    "kind": "completed",
    "messageSchemaVersion": 1,
    "stableCommandId": "system.describe.v1",
    "commandSchemaVersion": 1,
    "resultSchemaVersion": 1,
    "effectEvidence": "NotApplicable",
    "result": {
      "activeCapabilityIds": [
        "platform.extension.alarms",
        "platform.extension.indexeddb_strict",
        "platform.extension.offscreen_transport_worker",
        "platform.extension.packaged_wasm",
        "platform.extension.service_worker",
        "platform.extension.storage_session",
        "platform.extension.webcrypto",
        "platform.transport.loopback_websocket"
      ],
      "activeCommandIds": ["system.describe.v1"],
      "buildProfile": "chromium-full-v1",
      "commandProtocolDigest": "sha256-v1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      "effectiveGlobalCapabilityIds": [
        "platform.extension.alarms",
        "platform.extension.indexeddb_strict",
        "platform.extension.offscreen_transport_worker",
        "platform.extension.service_worker",
        "platform.extension.storage_session",
        "platform.extension.webcrypto",
        "platform.transport.loopback_websocket"
      ],
      "registryCatalogDigest": "sha256-v1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      "resolvedBuildArtifactDigest": "sha256-v1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      "transportCompatibilityDigest": "sha256-v1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    }
  }
}
```

transport outer `frameClass`闭合为`accepted | progress | terminal`，唯一owner是`protocol/transport`：它只告诉relay路由是否必须保留、该frame是否可在背压时丢弃，不携带business phase或effect结论。映射固定为business `accepted → accepted`、`progress → progress`、`completed/error → terminal`；extension/client/skill用command descriptor机械验证该映射，relay只验证outer枚举并把`message`当opaque bounded object。这样relay可以在terminal后删route、只丢progress，却不需要链接Command/Error目录、读取`message.kind`或比较phaseVersion。

business `message.kind`闭合为`accepted | progress | completed | error`。纯read和已在一个transaction完成的internal mutation可直接completed/error；normal operation只有accepted record strict complete后才能发accepted，之后可发有界progress，terminal record strict complete后才发completed/error。公共business envelope由`protocol/command` descriptor拥有，逐命令payload schema由Command Registry拥有：[命令合同](commands.md)中的矩阵要求已解析message固定携带`messageSchemaVersion + stableCommandId + commandSchemaVersion + effectEvidence`；只有已有durable operation record的消息才携带`operationId + phaseVersion`。resolved但未记账的error必须属于该命令`preLedgerErrorIds`并省略operation/phase；progress必须有已声明`progressSchemaVersion`，typed terminal receipt必须有`receiptSchemaVersion`，存在result才带`resultSchemaVersion`。尚未解析stableCommandId的boundary error改带`boundaryMessageSchemaVersion`并省略command/result/progress/receipt/operation/phase字段。business error的`errorId + numeric code`必须精确匹配Error Registry，只有显式detail schema mapping才允许details；transport错误没有这个numeric code。上面的WASM不在effective子集只用来说明诊断形状，不声称当前存在这个运行artifact；offscreen能力同时在active/effective集合中则是因为该response正通过它抵达。

relay只把`relayRequestId`换回对应`clientRequestId`，并在Agent响应外层附自己的delivery evidence/producer surface；不得修改business phase、把accepted写成completed，或把本地等待超时伪造成extension terminal。例如：

```json
{
  "profile": "agent-relay-json-v1",
  "clientRequestId": "cr1.B5m8P2s6V9x3A7d1F4h0jQ",
  "routedInstance": {
    "relayEpoch": "m0n2p4q6r8s1t3u5v7w9xA",
    "instanceNumber": "12"
  },
  "delivery": "Delivered",
  "frameClass": "terminal",
  "message": {
    "kind": "completed",
    "messageSchemaVersion": 1,
    "stableCommandId": "system.describe.v1",
    "commandSchemaVersion": 1,
    "resultSchemaVersion": 1,
    "effectEvidence": "NotApplicable",
    "result": {
      "activeCapabilityIds": [
        "platform.extension.alarms",
        "platform.extension.indexeddb_strict",
        "platform.extension.offscreen_transport_worker",
        "platform.extension.packaged_wasm",
        "platform.extension.service_worker",
        "platform.extension.storage_session",
        "platform.extension.webcrypto",
        "platform.transport.loopback_websocket"
      ],
      "activeCommandIds": ["system.describe.v1"],
      "buildProfile": "chromium-full-v1",
      "commandProtocolDigest": "sha256-v1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      "effectiveGlobalCapabilityIds": [
        "platform.extension.alarms",
        "platform.extension.indexeddb_strict",
        "platform.extension.offscreen_transport_worker",
        "platform.extension.service_worker",
        "platform.extension.storage_session",
        "platform.extension.webcrypto",
        "platform.transport.loopback_websocket"
      ],
      "registryCatalogDigest": "sha256-v1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      "resolvedBuildArtifactDigest": "sha256-v1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      "transportCompatibilityDigest": "sha256-v1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    }
  }
}
```

`routedInstance`由relay在选socket时冻结并在所有该route的Agent响应中回显，即使请求因当时恰有一个实例而省略target。未选到socket的请求立即以transport error结束，不建立route且字段absent。它不得进入extension frame。该值只说明这次本地路由；socket断开后立即stale，不能映射重连实例。

同一路由最多一个transport `frameClass=terminal`；relay转发后立即删除route，之后相同relayRequestId的frame一律丢弃。business phaseVersion的重复/倒退检查属于extension生成器与client decoder，relay不读取它；纯read没有phaseVersion。client wait deadline到达后，relay返回自己的`WAIT_TIMEOUT`与已有delivery evidence、删除route并best-effort发`route.abandon`；这不生成extension `message.kind=error`、不cancel operation。之后迟到terminal被丢弃，调用方用相同正确实例的`operations.get`查询。若operation已先以`EFFECT_UNCERTAIN`发送一个terminal，之后的late evidence只更新ledger并供新的查询读取，绝不在旧route发送第二个terminal。

`frameClass=progress`是唯一可丢/可合并观察，不是receipt；relay/client outbound buffer达到硬上限时先丢它，仍无法安全写accepted/terminal就关闭该client route并按已有证据报告/保留delivery，绝不建立无界spool。operation的durable truth仍在extension ledger。outer class与opaque business kind不一致是client侧protocol failure并必须关闭连接；不能让错误extension用class伪造业务结论。

## 4. InstanceRef完全属于relay

relay每次进程启动在generated有限attempt内生成至少128-bit CSPRNG非零`relayEpoch`；primitive异常或耗尽直接拒绝启动，不用时间/counter fallback。`instanceNumber`为从1开始的u64单调计数。完整规则见[权威与引用](authority-and-refs.md)。

- 一条完成extension role握手的socket恰好一个实例；重复hello不再分配。
- 断线立即删除；重连新number。relay restart新epoch，旧ref全部`STALE_INSTANCE`。
- number只作显示，路由必须携带完整结构化ref；不得拼接成易歧义字符串。
- counter达到上限时拒绝新实例，绝不wrap/reuse。
- extension从未生成、接收、保存或解释instance编号。

InstanceRef故意没有跨断线连续性。多实例重连后relay不能识别哪个新socket是旧实例，client也不得靠连接顺序、相同build/capability描述或相同Key自动重发effectful operation。wrong-instance返回的对象专用错误（例如`OPERATION_NOT_FOUND`）不证明其他实例没有effect，也不授权重做；明文profile不得为“识别”向每个实例喷洒bearer Key。浏览器profile/磁盘被外部复制还可能克隆Key record、authority realm与未来transport私钥，使两个current socket都能通过同一credential/proof；本系统无法把复制后的两个独立ledger重新变成全局幂等域。client检测到多个proof匹配必须报告歧义并要求显式InstanceRef，绝不向全部实例广播同一OperationId。操作者应为复制出的profile执行明确reset/rotate；这仍不把InstanceRef或transport proof升级成业务身份。

编号必须在relay生成，因为只有relay同时观察本进程的全部extension sockets、负责枚举顺序并拥有relayEpoch。单个extension只看见自己的一条出站连接，既不能保证本地全局唯一，也不知道relay何时重启；若让extension生成/持久化编号，就会把纯路由引用错误升级成稳定安装身份或产生跨relay碰撞。relay本地分配可让socket断开与引用失效成为同一个原子事实，同时保证编号永远不进入Key业务。

## 5. delivery与deadline

relay只维护易失wait/route表，不持久spool、Key、command、result、receipt或operation ledger。

relay/native socket codec在完整message分配/重组前执行可观察的frame/message/header局部硬上限；relay多连接侧还必须先取得上述global raw-input reservation，不能只靠局部上限乘socket数得到一个未核对的隐含内存峰值。Chromium WebSocket API把`message.data`交给JS时已经完成浏览器内部重组、可能的解压与allocation，扩展无法撤销或测量这一层；extension设置`binaryType=arraybuffer`并在UTF-8 decode、JSON parse、复制或送WASM前先检查最终`byteLength`。可信relay不协商compression、不fragment应用message且绝不发送超限message；恶意同OS假relay仍可迫使Chromium做一次平台层allocation，这是当前本地TCB边界。

结果inline/chunk连同最坏JSON envelope及base64url膨胀必须严格小于build message limit。业务采集上限可以更大，但只能由extension写owner-bound Artifact，再用有界`artifacts.read(offset,length)`返回base64url chunk；relay不拆分、拼接或暂存大结果。

| 时点 | 可返回delivery evidence | 规则 |
|---|---|---|
| 请求准入时没有可精确选择的current目标socket | KnownNotDelivered | 立即返回`EXTENSION_UNAVAILABLE/TARGET_INSTANCE_REQUIRED/STALE_INSTANCE`之一；不分配route、不保存Key/command、不等待未来socket |
| 已选socket，但写入/断线/deadline时无extension response且无法证明frame未进入 | DeliveryUnknown | 不自动retry；effectful调用者只能在已知正确实例查询 |
| 收到该exact socket/relayRequestId的任何合法extension business frame | Delivered | 包括boundary error、read completed/error和durable accepted/progress/terminal；deadline只终止后续等待，不cancel operation |
| response返回前client/relay断线 | Delivered或DeliveryUnknown | 按已有证据；绝不降成KnownNotDelivered |

纯read可由调用者根据Command Registry的`effectKind=none`显式重发；relay本身不自动重试任何command。effectful请求只有同一正确extension realm中的相同OperationId能去重；目标实例不确定时不得“试一遍看看”。

## 6. extension offscreen连接状态机

```text
DISCONNECTED
  -> CONNECTING(connectionGeneration, deadline)
  -> HANDSHAKING
  -> OPEN
  -> CLOSING
  -> DISCONNECTED
```

- dedicated worker状态机singleflight；任何时刻最多一个当前connect attempt/socket。offscreen document每个普通profile最多一个，后台用`runtime.getContexts()`与singleflight create promise确保不会并发创建；当前incognito模式延期，不能让split profile意外共享Key realm。每个worker boot先用CSPRNG建立transport generation domain；缺少secure random、transport-only scanner或预算投影时不得connect。
- timer、socket open/close/error/message和worker↔page回调都携带connectionGeneration；旧generation回调不能改变当前状态。`route.abandon`也只命中同generation/relayRequestId并仅释放response route。service worker的alarm只负责确认offscreen context存在/重建，不直接触发第二个socket attempt。
- offscreen page以`WORKERS`理由创建并实际spawn packaged dedicated worker；不借`AUDIO_PLAYBACK`、静音媒体或伪造DOM用途保活。Chrome官方只给非AUDIO理由“无理由特定lifetime上限”，并不承诺设备休眠、浏览器退出或user-agent回收时的10秒墙钟SLA。
- 后台只有在artifact/schema/storage hydration达到`authorityReady`后才创建/启用transport context。`authorityReady`不包含security wall clock是否当前可信；clock fault不关闭socket，正确secret请求得到`CLOCK_UNTRUSTED`。运行中因IDB versionchange/integrity/storage错误撤下authorityReady时，后台先关闭业务入口并通知exact offscreen Port关闭当前socket，使InstanceRef失效；完成恢复后重建context/连接。Port通知丢失时，旧context即使短暂保持socket，后台也只做bounded outer/source检查后立即返回`LEDGER_NOT_READY/KnownNoEffect`或关闭route；绝不把原始frame、Key、command或params挂到hydration promise上排队，不能越过authority或形成第二条secret滞留路径。
- 固定`extension_transport_route_v1` activation descriptor显式要求`platform.extension.service_worker + platform.extension.offscreen_transport_worker + platform.extension.storage_session + platform.extension.alarms + platform.extension.webcrypto + platform.extension.indexeddb_strict + platform.transport.loopback_websocket`全部active且本次对应probe effective，并另要求`artifactIntegrityReady && authorityReady`后才首次启用。offscreen capability自身的probe必须覆盖worker-context CSPRNG、transport-only scanner和WebSocket，而不能借service-worker WebCrypto probe暗推；任一静态要求缺失就不创建offscreen transport。descriptor是transport模块的闭合声明，Capability消费者必须双向登记，不能因为WebSocket constructor存在就把半条route标active。
- 后台建立exact runtime Port后，把offscreen真实消费的resolved retry/connect/incoming-bridge/keepalive facts及revision作为完整闭合descriptor发送给offscreen。`transport.offscreen_bridge_timeout_ms`同时冻结每条incoming source从worker首次post到exact release的最大生命周期；`transport.outbound_bridge_ack_timeout_ms`只由background outbound coordinator消费并在每次post时冻结，不为了“整齐”复制到worker。Port上的第一份outbound item必须是带fresh `bridgeItemId`的bootstrap descriptor；以后只接受严格递增revision的整份replacement，不接受partial patch、倒退或第二套default。设置提交只先产生desired revision；有Port时后台至多保留最新canonical replacement并等待全局outbound slot，无Port时只发无载荷`transport.bridge.reconnect`通知，待新Port完成相同验证后再发送。worker先回精确`descriptor_received{bridgeItemId,revision}`释放slot，再按每个point的updateClass和安全边界幂等reconcile，完成后回报精确applied revision；后台此后才推进其消费点的applied，background-only点则由本地consumer成功安装后推进自己的applied。需要restart且存在pending route时可保持desired≠applied直到安全关闭/结算，不能为了回显成功暗中改当前socket。offscreen不能自行读取RuntimeFacts或维护另一套default。
- hydration完成后立即尝试一次。活着的worker只使用`performance.now()`语义的单调时基：每次attempt开始冻结`attemptStartedMonotonic`并设`nextAttemptMonotonic = attemptStartedMonotonic + retry_interval_ms`；wall clock和securityTimeFloor完全不参与transport cadence。offscreen page可把诊断摘要经Port交后台写session，但该投影不是timer owner。若attempt在下一cadence点仍未结束，singleflight不重叠，结束时已经overdue就立即开始下一次。OPEN断开则从disconnect时刻建立下一cadence；context重建没有可信单调continuity，直接生成fresh generation并立即attempt。
- offscreen worker可运行、没有attempt在途且到达nextAttemptAt时名义每10000ms尝试。快速失败不会变成紧循环，慢attempt也不会额外再等完整10秒。无指数backoff、次数上限、熔断、静默放弃或relay.stop联动。
- context被user agent销毁时，startup/installed/alarm/其他后台唤醒负责重建并立即尝试；Chrome alarm最小周期≥30秒且可能任意延迟，只作粗恢复。service worker自身回收但offscreen/worker仍在、且当前没有未terminal business route时，不中断已有socket或10秒timer。exact Port断开时若pending route或尚未release的inbound source非空，立即关闭socket并清易失表，使relay按已有delivery evidence结算；不能保留一批永远无法回到旧Port的route再迁给新后台。若两者都为空，则保持socket；下一条relay business frame到达时最多暂存**这一条**已计入aggregate byte预算且带fresh inboundItemId的frame，singleflight重连后台Port并等待closed bootstrap/hydration handshake，期间第二条business frame或duplicate ID直接关闭socket。无法在该source冻结的generated bridge deadline内完成background full scan与exact release也关闭socket，使InstanceRef失效而不是无界缓存Key/frame。connection-local `transport.ping/pong`由worker本地处理，不占business bridge slot。

上一条“idle Port断开仍保留socket”只适用于不依赖已丢background易失密钥的profile，或已证明每请求独立解封且持久transport private material仍由新background安全恢复的profile。长会话protected profile在exact background Port/realm断开时即使route为空也必须关socket；offscreen不能因为TCP仍开着就接管或缓存session key。selected profile的这一分支必须是生成的固定恢复规则并进入compatibility digest，不能由运行时猜测。
- transport cadence不是鉴权时钟，不保存`lastAttemptWallMs`，也不根据wall-clock前跳/回拨做安全推理。worker存活时由单调timer处理overdue；context被销毁后没有可证明的elapsed continuity，恢复规则固定为立即attempt，而不是相信session中的OPEN/CONNECTING/nextAttempt值。
- 不声明浏览器/设备休眠、浏览器退出或offscreen context被回收期间的10秒墙钟上限；声明的是可运行transport worker内的10秒cadence和无限恢复意图。

当前候选keepalive为每20秒dedicated worker发送上述`transport.ping`、relay在同一socket立即返回exact `transport.pong`；浏览器WebSocket API不能主动发协议层ping frame。任一时刻只允许一个outstanding ping，pong deadline候选45秒；到下一个interval仍未收到时不叠加第二个ping，deadline到达就关闭当前generation并回到无限retry。relay也用90秒候选application-idle hard deadline移除不再运行JS scheduler却仍保持TCP的假在线实例，且拒绝快于1秒候选下限的application ping；RFC层Ping/Pong或browser network-stack活性不能刷新它。合法runtime keepalive范围必须机械落在该上下界内。它们服务于transport-worker liveness和保持context实际活跃，不能混为authority readiness证据。P3必须用packed extension覆盖ping/pong closed shape、过快/缺失/错误ID/字段、relay与extension两侧deadline、service worker回收而offscreen socket继续、offscreen销毁后alarm重建和旧Port响应丢弃。[Offscreen API](https://developer.chrome.com/docs/extensions/reference/api/offscreen) · [生命周期](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle) · [Alarms](https://developer.chrome.com/docs/extensions/reference/api/alarms)。

## 7. 生命周期与错误面

- relay显式启动后持续运行。收到合法native `kind=relay.stop`后，唯一relay coordinator原子进入`STOPPING`：停止accept/新route，best-effort写一个local `stopping` ACK，然后关闭client/extension sockets、清空易失instance/route表并退出。它不等待business terminal、不持久化stopped标记，也不向extension转发stop。
- native client socket没有业务session/lease含义。没有in-flight route或local request后超过generated idle timeout，relay可以关闭该socket并精确归还connection slot；client下次直接重连，不改变Key、operation或companion进程寿命。持有空闲socket不能永久消耗全部native role容量。
- skill/client启动流程以完整握手而不是进程名或端口占用作为唯一ready证据：先direct-connect固定endpoint并验证server-first hello；未请求自动启动时，失败只能报告`CLIENT_COMPANION_UNREACHABLE`而不能断言进程不存在。允许启动时才以固定绝对路径、固定参数和平台detached/hidden方式启动relay；launcher syscall/路径/签名或child明确配置失败为`CLIENT_COMPANION_START_FAILED`。启动不把父进程、stdin或首次client socket变成lease：兼容relay在启动者退出后继续，直到显式`relay.stop`、OS/process failure或用户终止。
- spawn开始同时冻结`build.client.relay_startup_convergence_timeout_ms`单调总deadline。每个client startup coordinator任何时刻最多一个probe socket/handshake在途；probe start间隔至少为`build.client.relay_startup_probe_interval_ms`，且下一probe只能在前一probe已结束、总期限仍有余量后开始。快速connection-refused因此不会紧循环，黑洞handshake也不会每100ms叠加一批socket。每次handshake deadline为`min(build.transport.handshake_timeout_ms, totalRemaining)`，不能让最后一次attempt越过总期限。多个独立client可各有一个probe，relay自己的pending-handshake总门仍给它们设全局界。任何完整但不兼容的HTTP/WebSocket/server hello立即`TRANSPORT_PROTOCOL_MISMATCH`；连接拒绝或hello前关闭可继续等待并发赢家完成listen。own child的退出证据可以记录，但`address in use`输家不使兼容赢家失败。总期限到仍无合法hello返回`RELAY_STARTUP_TIMEOUT`，不猜“port conflict”。整个收敛期不发送Key、不扫/fallback端口、不生成第二配置、不杀未知进程。
- `relay.stop`不revoke Key、不release occupation、不cancel扩展operation。由于当前可信本地组件模型不建设本地权限，任何通过native role门的同OS用户进程都可stop；这是明确的本机availability边界。
- extension/浏览器退出会断socket并使本地InstanceRef失效；relay不推断业务结算。
- relay restart不恢复route/wait，不重发command；extension ledger仍是唯一事实。
- 未请求自动启动时，连接失败可由skill/client呈现`CLIENT_COMPANION_UNREACHABLE`；不存在或尚未ready的relay不能在wire上发送该错误。启动失败/超时同样只由持有launcher事实的client产生。
- bind被占用时relay进程显式失败，不能把占用事实本身当现成服务、不能fallback端口；startup coordinator只在上述同端点、有间隔且受总deadline截断的fresh hello中确认并复用真正兼容的赢家。收到不兼容hello立即停止而不是继续等它变身；client校验合法hello前不发送Key。listener必须使用上一节的exclusive/non-inheritable socket语义，不能靠`SO_REUSEPORT`让两个“赢家”随机分流。
- 一个relay coordinator/event loop（或语义等价的单一互斥owner）独占instance表、route表、relayRequest counter与STOPPING。`select instance + insert route + freeze socket generation`在同一临界区；每连接reader只提交事件，不自行修改owner表。
- protocol parse/error/logging永不回显完整frame。relay不加载业务Command/Error Registry，因此不能选择性判断params或response：请求的整个`auth`与`command`子树、extension响应的整个`message`子树一律按opaque-secret value处理，只允许记录各自byte length、结构计数、lossless parse成功/失败、transport request ID与route状态；不得记录content-derived hash/digest、method、header、JS源码、正文、一次性Key或任意child value。普通hash对低熵参数不是脱敏。extension到达已解析command后才可按生成schema做更细粒度的字段名/omission诊断，仍不记录secret值。
- 当前明文候选中，relay自己的Zig request/response frame buffer在完成forward/client write或失败后尽快显式清零并释放，不把Key、command或opaque business message复制进route metadata；WebSocket/OS/JS runtime内部复制无法作密码学清除保证，因此该候选仍把relay置于明文TCB，而不是端到端保密。受保护profile的relay buffer只能含bounded ciphertext与公开路由元数据；它仍尽快清理，但不能把“看不到明文”靠日志约定而非密码学descriptor实现。

## 8. 验收

必须覆盖：网页`new WebSocket()`正确/错误subprotocol、Origin/Host/DNS rebinding、错误path、假server hello/Accept、端口占用与bind→listen并发启动（含单client黑洞probe不重叠、多个client仍受relay总门）、IPv4/IPv6 wildcard拒绝；direct/代理/PAC、默认implicit bypass与`<-loopback>`取消负例、有无host grant、普通/专用`127/8`和预置Cookie/HSTS/HTTP/proxy auth下的effective proxy decision/request destination/header，以及错误listener的101/3xx/Set-Cookie/401/407等response effect和目标Chrome版本LNA WebSocket行为；明文候选还必须证明当前部署的DIRECT证据可持续、proxy/policy变化会撤下能力，否则只能限定deployment或先引入闭合的Key端到端application保护。受保护profile必须证明端点认证、transcript/replay/KDF/AEAD counter与rekey/close、Key verifier/storage兼容性、native/WebCrypto golden和redaction；应用保护只在native client与extension后台终止，relay/offscreen没有Key派生秘密或decrypt API。当前verifier-only记录本身不能被一句“使用Key材料”自动当作双向会话密钥，若需新增credential-equivalent派生值或把extension transport proof封装进同一个API Key token，必须先显式裁定并版本化Key record/token。还必须覆盖obs-fold/CTL/重复singleton/upgrade尾随字节；mask方向、RSV/opcode、control frame、非最短/溢出length和fragment状态机；总socket/pending handshake/header/deadline/global raw/forward/response及组合managed-memory耗尽与reservation原子转移；extension source→admitted-command→response的目标预算先占、copy重叠双计、归还无空窗以及全部可控bucket合计不超过`build.extension.maximum_managed_memory_bytes`；raw native frame fragment/assembly限额、合法relay不协商compression，以及extension只能在完整message后限额的能力负例；WebSocket默认Blob负例、同task切到ArrayBuffer与binary-only send；duplicate extension hello；零/一/多实例路由与operation retry显式pin；disconnect/reconnect/new epoch；service worker回收保持idle offscreen socket、pending Port或未release source断开关闭、重复/迟到bridge wake不建第二Port、offscreen/worker销毁与alarm重建、旧callback generation；inboundItemId从post到exact release、release-before-same-route-response、错误/重复release和timeout清预算；outbound bridge `bridgeItemId`三类item exact ACK、A重复ACK晚于B占槽、错误ID/kind/revision、counter耗尽、timeout/context teardown与descriptor/release/business公平；`route.abandon`在wait timeout/client disconnect/terminal交错中清未post response且只释放response route不cancel业务；ping/pong exact shape、单outstanding、错ID与两侧deadline；target字段剥离；extension拒绝instance字段；投递前deadline与投递后deadline；relay/client crash；10秒active cadence、overdue wake、alarm延迟；任何断线场景均不自动重放。

多实例矩阵还必须包含：明文profile禁止Key spraying；受保护profile的零/一/多proof匹配、wrong-key/wrong-endpoint、探测上限、protected request/session与exact current InstanceRef或socket challenge绑定、断线后的旧安全上下文失效；以及复制profile导致相同Key/proof/realm出现在两个实例时明确返回歧义、无first-wins、无broadcast和无跨ledger“全局幂等”假象。

protected生命周期矩阵还必须区分每请求密封与长会话：worker/Port回收、socket仍开、private material恢复失败、nonce/ephemeral重复、request/response跨route替换、旧socket challenge replay、transport key丢失/轮换及现有API Key token proof失配。每请求路线不得因“无会话”省掉transcript/replay与OperationId测试；长会话路线不得在background消失后让offscreen续命。
