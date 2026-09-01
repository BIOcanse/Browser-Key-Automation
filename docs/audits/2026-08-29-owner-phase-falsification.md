# 2026-08-29 全域 owner / phase / activation 反证

状态：第四轮跨边界反证已完成文档与authoring草案纠正；运行时代码仍暂停。方法是把除用户冻结事实以外的每一项工程推导先视为错误，要求它给出唯一owner、生成者、失效者、阶段前置和可机械验证的consumer；此前各轮“已纠正”的结论也不享受默认正确待遇。

## 1. 没有被重新解释的用户事实

- 外部业务只认Key；扩展生成、保存、配置并鉴权Key。
- 授权通过后不再弹插件逐指令确认；Chromium自己的权限/开关/受限页/调试确认不旁路。
- JS、DOM、页面读取、资源、设置与debug是并列permission入口，不做闭包。
- 同Key一般动作串行；不同Key没有共同的隐式动作FIFO。
- tab/global occupation归Key；foreign占据必须先独立release成功，再独立acquire，没有takeover/force/replace。
- extension主动连接本地relay；未连上按名义10秒无限重试，无backoff、次数上限或放弃。10秒是首个Freedom Point。
- 一个成功extension socket在relay中是一个实例；InstanceRef完全由relay生成，extension不知道它。
- Chromium-only；Windows/Linux薄Zig relay；纯核心可用Zig/WASM，浏览器I/O留在JS；清洗等待用户说明。

审计对象是这些事实之上的工程放置，不把用户陈述降格成待质疑的噪声。

## 2. 被推翻或收紧的假设

| 先假定错误的对象 | 反证结果 | 采用的纠正 |
|---|---|---|
| registry中的`active`是真能力 | 所有consumer字符串都指向不存在的源码/构建节点，也没有反向门 | 四份registry全部改为pending且consumer为空；声明、实现、resolved activation、external route分开 |
| P0是零副作用纵切 | P0既说零effect又真实创建loopback WebSocket；同时缺Key、authority、握手、deadline、alarms和keepalive | P0改为build/static bootstrap；不联网、不读storage、不启command；第一条外部纵切移到P3 |
| relay可放在浏览器effect之后 | 在没有真实route/disconnect/wrong-instance证据时，前面阶段只能做内循环自证 | phase改为P0 build → P1 authority → P2 Key → P3 relay + `system.describe` → P4 operation与无TabRef真实纵切 → P5 target/control/read → P6 effect；P4只内部验证ControlState |
| `system.describe`必须依赖WASM | WASM失败时诊断命令反而不可用，形成诊断依赖环 | 由generated TypeScript实现静态描述；WASM startup self-test只是capability事实 |
| Command Registry已有闭合schema | params/result只写了悬空字符串，dispatch precondition也没有声明来源 | 增加`schemaDeclarations`最小闭合IDL；删除未声明precondition；command仍pending |
| key-required命令可隐含公共auth错误 | `system.describe`的allowed集合没有未认证、禁用、过期、权限拒绝、hydration或storage错误，实际producer会越过registry | 顶层`boundaryErrorIds`显式覆盖尚未解析命令的错误；每个`allowedErrorIds`闭合解析后的整条pipeline，不再维护隐藏公共集合 |
| Root“跳过permission expression” | 该说法可能误读为跳过未知atom、否定条件或结构验证 | Root只使当前resolved artifact中`status=active`的permission atom为true；原表达式和所有非权限边界仍求值 |
| regular管理权限不会提升 | `keys.create.regular`若可任意授atom，可先授`keys.create.root`再造Root | regular新增每个atom不得超过调用Key当前逐atom真值；删除/revoke可收窄；Root自然覆盖全部声明atom |
| 永久Key tombstone没有代价 | 有限容量加永久tombstone可耗尽Root恢复与普通管理 | 系统不主动复用KeyId；tombstone在依赖/窗口闭合后有界GC；恢复Root保留独立容量位 |
| 一个recovery slot可保证任何情况下恢复 | 逻辑配额不能战胜浏览器quota缩减、磁盘满或存储损坏 | 同时保留系统管理的最小写入headroom；外部物理失败仍fail closed并进入GC/诊断 |
| factory reset可沿用普通admin去重 | reset会擦除证明自身只执行一次的domain，响应丢失后语义不闭合 | v1延期factory reset；full authority reset保留admin dedupe domain |
| AdminMutationId直接使用UI墙钟 | 安全时钟前跳后再回拨会让新恢复ID全部显得过旧，封死本机admin面 | UI先读后台timestamp floor，再以`max(Date.now(), floor)+random`在首次mutation前生成 |
| owner等于token生成者 | caller重投、全局枚举和生命周期裁决需要不同视野 | 中心表分开owner/generator/storage/namespace/invalidator；生成位置按用途决定 |
| extension或relay可生成OperationId | 代生成后caller无法在首次响应丢失时重投相同逻辑operation | OperationId只由caller首次发送前生成；extension只登记、碰撞和到期裁决；relay完全不解释 |
| Chromium tab/document ID可直接当公开ref | tabId复用、document/port替换与runtime断裂无法由裸ID表达 | TabRef/DocumentRef由后台target registry签发；Chromium ID只是输入证据 |
| content可生成自己的realm authority | content只能看单document，且页面环境不应发放后台可信route | 后台验证exact port/document后生成ContentRealmToken；content只拥有该token下的slot/generation表 |
| DispatchToken可交给content做回执 | 页面/content拿到权威token会混合执行面与receipt权威；worker丢route后也无法安全恢复 | token只由后台在fence生成并留后台；content只见contentRequestId；后台易失表映射，丢失后按uncertain结算 |
| 迟到handler可写“当前socket” | reconnect、offscreen重建或service worker回收后旧请求可能误投到新Port/socket或另一实例 | 每个请求冻结`connectionGeneration + relayRequestId + exactSocketHandle + exactOffscreenPort`；任一换代后只丢弃 |
| generation/revision写个数字即可 | 多处未声明issuer、namespace、持久化和wrap行为 | 计数型u64不回绕，耗尽fail closed/轮换上层epoch；高熵generation至少128-bit；revision不成为权限或身份 |
| u64 generation可直接用JSON number | 长期计数越过JS安全整数后会静默改值并命中错误ref | tab/node/occupation/instance/phase等u64统一无前导零十进制字符串；小型Chrome ID/slot才用有界number |
| relay需要完整业务命令面 | `relay.describe/status`重复hello/instances且会诱导relay理解业务Error/Command Registry | native local kind闭合为`instances.list \| relay.stop`；业务仅`forward`；local kind不进extension registry |
| relay/client错误与业务Error共用registry | 会让relay加载业务目录，并能伪造extension phase/effect错误 | transport profile拥有固定外层`transportError`；Error Registry只覆盖extension/storage/platform pipeline |
| storage/capability错误永远KnownNoEffect | receipt持久化或平台调用失败可能发生在browser effect fence之后，不能把已发生effect抹掉 | `STORAGE_UNAVAILABLE`与`CAPABILITY_UNAVAILABLE`标为PhaseSensitive；具体response按operation phase携带evidence |
| 发送前撤权复用普通auth错误 | `FORBIDDEN/KEY_EXPIRED/UNAUTHENTICATED`的初始准入语义是KnownNoEffect，复用会抹掉已fenced effect或泄露具体状态 | 新增PhaseSensitive `RESULT_WITHHELD`，只给最小phase/effect evidence，不给正文 |
| relay应预校验method/Key/OperationId | 会复制extension业务schema并把本地层升级成第二authority | relay只验证transport shape/bounds/target；auth和command是opaque bounded values |
| 1MB frame上限足以限制JSON | 深嵌套、重复key和大量小节点仍可制造parser/validator歧义或资源峰值 | relay与extension都独立拒绝重复key，并共享byte/depth/node/field/string闭合上限；整数词法验证 |
| loopback endpoint是一个自由对象 | path/subprotocol与host/port混在一个可改point，会让协议版本被运行设置改写 | Freedom Point只保存单一IPv4 bind；path/subprotocol是版本化transport profile常量 |
| extension Origin可首次连接学习 | 本地错误/恶意peer可把自身固化成后续allowlist | exact packed Origin必须来自固定打包/签名证据或显式dev profile；未知时fail closed |
| `waitTimeoutMs`可以clamp | silent clamp改变caller明确等待合同并制造不可见默认 | 超界严格拒绝；它只控制relay等待，不进入extension或cancel operation |
| `control.status`/公开revision是必要指令 | 用户只要求占据与解除；conflict/repeat已经返回OccupationId | Agent v1只保留`control.acquire/release`；admin UI可窄查看内部状态，不新增无Key业务route |
| `global_only`含义可由名称猜 | 不同文档对tab occupation是否冲突存在歧义 | `global_only`只冲突foreign global；`target_tab`冲突foreign global或same-tab；global acquire仍冲突任何foreign global/tab |
| TS无bundler却用Bundler解析 | 编译规则会接受部署时无法解析的import | 改为NodeNext，未来相对ESM import必须写`.js`后缀 |
| 一个WebWorker tsconfig可覆盖整个extension树 | admin/content/user-script需要DOM globals，和worker lib混用会掩盖realm错误或产生冲突 | 当前config只含background/generated；各execution realm在其阶段建立独立TS project |
| 当前机器路径/Node 25是项目合同 | 会把本机CommonAssets布局和一次验证版本硬编码进可移植Windows/Linux工程 | 路径与主机版本只进执行证据；项目锁影响产物的Zig/TS版本，Node支持范围等真实脚本后测试 |
| “按relativePath哈希”天然跨平台 | Windows分隔符、drive、BOM/CRLF、目录枚举和时间戳会让同一事实产生不同digest | 路径固定portable ASCII root-relative `/`并拒绝平台歧义，文本UTF-8无BOM/LF，排除机器路径/时间；native target triple显式入build fact |
| 文件内容hash已完整描述native artifact | Linux执行位、文件类型和symlink目标会改变运行结果但不改变regular-file bytes | seal清单加入fileKind/executableFlag/length并禁止未声明symlink/junction payload |
| Windows/Linux relay与extension应有同一artifact digest | 三类组件文件和target triple天然不同，强求相等会拒绝合法组合或稀释digest含义 | 组件各有artifact digest；transport握手比较共同`transportCompatibilityDigest`或显式兼容表 |
| transport digest应包含全部命令目录 | 每加extension命令都会迫使薄Windows/Linux relay重建，反向让relay依赖业务 | 拆出`commandProtocolDigest`给extension/client/skill；relay只记录/回显，不解析或匹配自身 |
| payload可以内嵌自己的最终artifact digest | 含digest的binary/JS再参与同一hash会形成真正的自引用，简单“排除字段”对编译产物无效 | payload不嵌自身digest；独立`artifact.seal.json`保存digest/清单且不参与自身hash，启动验证后再报告 |
| package脚本可以先指向未来文件 | 脚本名字会制造“可build/test”的假证据 | 删除不存在目标的build/test脚本，只保留TypeScript工具版本检查；目标落地时同提交恢复脚本 |
| IndexedDB默认需要`unlimitedStorage` | IndexedDB本身不以该权限为前置，提前申请会扩大manifest且掩盖真实容量策略 | 默认不申请；只有独立capability、容量证据和真实consumer闭合后才加入 |
| capability里的138是API引入版本，或改名后可在每项重复 | 多个条目统一填138只表达产品profile floor，既不能证明各API何时出现，又制造八个可漂移authoring源 | 从Capability条目删除该字段；固定`chromium-full-v1` descriptor唯一拥有profile floor并生成manifest minimum。独立API版本要求以后用带一手证据的另名字段 |
| 大artifact必须把所有chunks与receipt塞进一个事务 | 大结果会形成长而脆弱的MV3事务，失败面和内存峰值反而扩大 | 不可见staging分批写；final小事务提交committed metadata + receipt；孤儿块不可读且有界GC |
| full reset必须物理一次删完旧realm | 大量operation/artifact会把恢复动作变成巨型事务并可能永久blocked | 小事务原子轮换current realm并标记retired；旧数据立即不可见，物理删除按durable cursor有界续跑 |
| retry point可用`1..u32 max` | 1ms允许busy loop，u32上界超过常见有符号timer范围 | 默认10000保持不变；暂定工程安全范围1000..2147483647，P3以真实timer/probe验证 |
| Freedom文档尾部仍让`system.describe/retry`先于Key贯通 | 这会绕回已推翻的半transport路线，并与P1 authority→P2 Key→P3外部纵切直接冲突 | 改为P0只贯通静态build事实；P3才同时激活relay、retry、skill与带Key命令 |
| Freedom元模型写`scalar/structured`而JSON使用具体kind | 配置器若照文档和registry分别实现，会出现两套判别式与不可验证的转换 | authoring kind以`integer/string/loopback_bind/...`闭合集合为准；候选表同步实际类型 |
| transport使用三种未定义artifact digest别名 | `relayArtifactDigest/componentArtifactDigest/artifact digest`会让wire schema和比较对象漂移 | wire统一字段名`resolvedBuildArtifactDigest`，用component descriptor区分relay/extension/client，组件间永不比较相等 |
| bootstrap可在打开/验证authority前创建RuntimeEpoch | 该epoch可能先写入session，随后才发现schema、build或存储连续性不成立，造成generation owner倒置 | 先验component seal与IDB authority/build事实；session只提供candidate，验证后才恢复或生成fresh RuntimeEpoch |
| artifact staging复用DispatchToken | terminal要求擦除DispatchToken，但大chunk仍需跨事务保留物化代际；两种lifetime直接冲突 | 增加后台内部ArtifactStagingToken；只约束staging manifest，commit/GC后失权，不参与effect receipt |
| JSON示例可解析就等于合同有效 | 示例中的`realm-7`和`owner-key-id`不满足已声明的定长base64url token/KeyId格式 | 示例改为满足16-byte canonical base64url的值；后续门要从parse升级为schema fixture |
| DOM动作可把DocumentRef与NodeRef拆成两个看似完整字段 | 中心合同定义NodeRef内含DocumentRef；拆开后可能组合来自不同document的片段，或让validator出现两套形状 | 示例只传完整NodeRef；target/control从其中解析，不接受平行document片段 |
| NodeRef“返回expiresAt”但identity没有该字段 | 若把墙钟expiry临时塞进ref，content单调时钟、后台时钟和caller时钟会形成三套有效性判断 | identity保持document/realm/slot/generation；TTL只冻结在realm entry，响应最多给非权威remaining-TTL提示 |
| relay把所有JSON number都当无符号transport整数 | 会提前拒绝业务中的负数/小数/指数，或经float重编码改变opaque command，使薄relay成为第二schema owner | 只对relay-owned envelope字段使用无符号规范；command number lossless保留，具体类型/range由extension裁决 |
| Root逐atom为true但expression可含否定节点 | `not(x)`会让最高Key在全true时反而失去命令，违反Root拥有全部插件操作permission的冻结事实 | v1 permission grammar限定正向单调allOf/anyOf；每条active Key command必须通过Root全true向量门 |
| 单个Root恢复slot配“丢响应后撤销重建” | 已提交的orphan一旦revoke会留下tombstone占住唯一保留容量，恢复路径自我封死 | 改为`empty \| active` recovery container；丢响应只原地rotate。显式revoke先预留独立tombstone/receipt，再原子释放container承载位 |
| full authority reset可连security time一起归零 | admin dedupe跨realm保留时会产生时间域分叉，墙钟回拨还可能重新放宽新Key/ID窗口 | securityTimeFloor是extension storage-domain事实并跨full reset单调；只有operation reject水位按realm重建 |
| UI按time floor造ID、后台却可按裸墙钟判future | 时钟前跳再回拨后，后台会拒绝自己要求UI生成的timestamp，恢复面仍被封死 | minimumAccepted值与后台past/future检查共享同一storage-domain effective time |
| full reset可在一个事务轮换realm和RuntimeEpoch | realm在IndexedDB、RuntimeEpoch在`chrome.storage.session`，浏览器没有跨两者的事务；崩溃会制造假原子性 | IDB事务只退役/新建realm并写continuity invalidation+receipt；fresh epoch随后fail-closed reconcile，未完成前不ready |
| `storage.persist()`拒绝等于IDB不可用 | 该API只说明未获得免驱逐保证；直接关机混淆风险事实与当前读写能力，并可能让正常profile永远不可用 | 记录persist/estimate为capability evidence；open/schema/integrity/strict写失败才fail closed，平台全量清除按无Key新realm处理 |
| P0“网络零调用”连包内WASM/seal读取也禁止 | packed worker通常需通过自身`chrome-extension://` URL加载这些bytes；字面零fetch会让P0目标不可实现 | 只禁止外部/loopback scheme；包内读取用精确scheme/path allowlist并单独审计 |
| P0省略`connect-src`就等于禁止外连 | Chromium默认extension CSP主要约束script/object，不能把缺少连接directive当成网络deny证据 | P0显式生成`connect-src 'self'`；P3只在此基础上追加唯一numeric loopback来源 |
| build capability profile存在但manifest没有反向版本投影 | profile floor会只留在registry/描述里，无法阻止不支持的packed target，也形成第二个手写默认 | P0从`chromium-full-v1`唯一生成`minimum_chrome_version: 138`并做manifest反向门 |
| worker可验证package没有额外文件 | extension runtime没有枚举自身CRX目录的API；只按seal fetch无法发现未列出的payload | build/package门做精确目录集合闭包；worker只验证seal及全部已声明文件，不夸大可观察性 |
| `WebAssembly.validate`成功就激活packaged WASM | validate只证明模块字节语法，不能证明CSP加载、instantiate、ABI或导出能调用 | runtime probe改为packed instantiate + ABI/version + deterministic self-test export；validate只作前置fixture |
| capability probe只写API/constructor存在 | 方法存在不能证明module worker、TRUSTED_CONTEXTS round-trip或真实role握手/liveness成立，未来会制造伪active | 每个probe都命名其必须完成的packed/round-trip/self-test证据，不允许存在性检查单独激活 |
| relay可按业务schema选择性redact command | relay刻意不加载Command Registry，无法识别Authorization、表单、JS/body等敏感child；选择性日志必然漏值，普通hash也会泄露低熵参数 | relay把auth+command整个子树视为opaque-secret，只记长度/结构/request ID/route；细粒度诊断留给extension |
| artifact chunk只按ArtifactId/index写 | late旧回调可在final commit后覆盖同key chunk，metadata已committed却正文发生变化 | chunk key加入ArtifactStagingToken；每批CAS staging state，commit冻结read generation并永久关闭该generation写权 |
| strict JSON合同要求field/string/token上限但配置表缺项 | P3实现只能散落常量，relay/extension还可能使用不同预算，破坏Freedom Point与transport digest | 补planned object-fields/key/string/number-token build points及交叉关系；真实parser消费前仍不active |
| duplicate key只比较原始转义文本 | `"a"`与`"\u0061"`会绕过重复检测并在后续parser折叠成同一字段，relay/extension可能解释不同 | key先JSON-unescape为scalar序列再exact比较；拒绝孤立surrogate，不做Unicode规范化/case folding |
| transport request ID只是任意bounded string | 各client会产生不同Unicode/日志/长度语义，示例占位也无法成为schema fixture | client固定`cr1`+16-byte base64url随机；relay固定`rr1`+u64十进制，仍不成为业务identity |
| `code`有时是业务整数、有时是字符串ID | client无法区分registry code与transport常量，示例也不能做schema fixture | business固定`errorId + numeric code`精确pair；transport仅用profile-local `transportError.errorId` |
| P3后`connect-src`永远只有self+loopback | 这会让规划中的extension-origin `resource.fetch`即使有host permission也被自身CSP阻断 | P6 network capability激活时才追加显式http/https data来源；P0/P3仍严格不提前放宽 |
| 纯DOM read可在缺bridge时程序化补注入 | 注入是浏览器effect，响应丢失后既无OperationId也无fence；“通常幂等”不能让它变成read | read缺bridge即typed unavailable；未来补桥只作为独立effectful command登记 |
| `dom.query`作为read可每次新建NodeRef | 响应丢失/重试会持续吃slot，容量失败还可能留下半批ref，使read具有不可去重的资源effect | realm内按DOM node intern且不续期；整批预检后同步提交，失败零新增 |
| `debug.connect/disconnect/status`共用一个effect分类 | status会被误当normal effect，或connect反被实现成read式隐藏prompt；一行多语义无法生成严格registry | connect/disconnect与status/targets拆开；未来每个debug命令逐项登记effect/permission/capability |
| tabs动作只看显式target | activate会使旧active tab失活，create(active=true)/close(active)还会间接改其他tab；可绕过foreign tab occupation | 先增加`target_tabs`并曾把无法闭合的create/close暂放`all_occupations`；本轮又反证后者会阻断无关Key，最终裁决为activate冻结两tab，create/close在window/active语义闭合前保持pending，见表末 |
| `requiresOperationId` boolean足以描述幂等 | Agent effect用OperationId，受信admin mutation用AdminMutationId；`false`无法区分pure read与另一个durable ledger | 改为`idempotencyKind = none \| operation_id \| admin_mutation_id`，并对boundary/effect/queue做组合门 |
| `boundaryErrorIds`只需parser error | unknown method之前仍会遇到hydration/storage/auth错误；若先返回COMMAND_NOT_FOUND还会向wrong Key泄露catalog | 闭合boundary错误集；固定strict parse→hydration/storage→credential/status→command resolve顺序 |
| WASM self-test失败就不置整体build ready | 会封死不依赖WASM的`system.describe`，与“WASM失败时仍可诊断”直接冲突 | 拆成`artifactIntegrityReady`与startup capability probe；release验收要求probe通过，运行时失败只关闭依赖route |
| `activeCapabilityIds`可同时表示实现与当前可用 | 已编入consumer/probe与本次startup probe成功是两个事实，混用无法诊断 | `system.describe`同时返回activeCapabilityIds与effectiveGlobalCapabilityIds；target-specific仍走`system.capabilities` |
| artifact chunk只key带staging token就不可变 | 同token/index的late writer仍可在final前覆写旧bytes，而不改manifest形状 | chunk write必须metadata+chunks同事务、index write-once；只有相同bytes重投no-op；manifest同事务追加，commit/reader校验digest |
| handshake前“不接受任何application frame” | server-first hello本身就是WebSocket application data，字面合同禁止自己的握手 | 改为HTTP upgrade后只允许闭合transport handshake frame；role完成前禁止forward/local/business frame |
| 只有durable accepted ACK能证明Delivered | 纯read completed、auth/boundary error和事务内部mutation terminal都不会先accepted，却显然证明frame已达extension | exact socket/request ID上的任何合法extension business frame均使delivery=Delivered；无response的已选socket路线保守unknown |
| transport fixture可用`tabs.list`请求配`accepted + OperationId`响应 | 纯read不建operation；换成尚未登记的`tabs.reload`也不能成为当前schema fixture | 主示例统一为当前唯一已声明的`system.describe`与completed result；effect accepted形状等首个真实effect command登记时再生成 |
| loopback只声明CSP就足以生成manifest | API permission、host permission和CSP是三个不同机制；官方fetch文档要求host permission，WebSocket教程却未明说，不能猜 | Capability schema显式增加`manifestHostPermissions`空集候选；P3 packed正/负例决定激活，不在manifest template暗加 |
| relay可链接一个包含三profile与全部stable Error/capability的`protocol` | 物理链接会让“relay不读业务registry”只剩口头承诺 | 拆`protocol/canonical`、`protocol/transport`、`protocol/command`；relay只链前两者且command subtree保持opaque |
| Freedom文档的`defaultValue/valueContract`与JSON tagged fields可以之后再对齐 | configurator开工时必然产生两套元schema；候选表还用`scalar/structured`伪装具体kind | 文档改为与JSON同形的flat tagged fields，非当前payload必须null/空；表格标明family/kind，未发布structured kind明示future |
| P1/P3平台依赖可留在prose | `alarms`、strict IndexedDB、bootstrap WebCrypto与offscreen transport宿主没有Capability声明，manifest和route会靠手写常量补洞 | 增加对应pending capability；P3 route descriptor闭合service-worker/offscreen-worker/storage-session/alarms/WebSocket组合，authority/artifact ready另作门 |
| 普通`JSON.parse`加validator等于strict JSON | duplicate decoded key在parse时已被覆盖；WASM失败诊断又不能依赖WASM parser | P0加入独立generated TS strict scanner，与native/WASM共用golden；WebCrypto known-answer后验证seal，不能用未验证WASM验证自己 |
| `SCHEMA_INVALID`可覆盖任意schema失败 | adapter/result/receipt在fence后失败时复用KnownNoEffect会抹掉可能已发生effect | 1000号错误只准incoming envelope/params pre-admission；其余走phase-sensitive `INTERNAL_ERROR`或专门typed error |
| allowed error ID已闭合error payload | progress与command-specific/boundary error details没有schema owner，handler仍能临时返回自由JSON | Command declaration加入`progressSchema/errorDetailSchemas`，顶层加入boundary detail mapping；公共business envelope归`protocol/command` descriptor |
| 所有business message都可带统一phaseVersion | pure read没有ledger phase，伪造0会把读取错误接入operation状态机；operation frame反而缺明确identity字段 | response矩阵固定：read无OperationId/phase，operation带OperationId+phaseVersion，admin用AdminMutationId；schema version按payload条件携带 |
| intent/plan digest可进入查询与诊断 | JS源码、表单值、header等低熵内容hash可被`.any`查询者或日志离线枚举 | digest只留extension内部做dedupe/完整性；operations.get返回typed identity结论，不披露内容digest，日志只留长度/字段名/omission |
| security time只要单调就不会封死Agent | 时钟异常前跳再回拨后，caller按本机时间生成的全部OperationId会永久过旧 | absent identity越界返回versioned `OPERATION_ID_OUT_OF_WINDOW`及`past\|future`、min/max；caller换新ID，extension仍不代生成或降低floor |
| effect前强制读取system.status只是一个方便的时间同步步骤 | 这会把`system.read`偷偷变成所有mutation/effect权限的父权限，破坏权限原子的独立性；无read权限的合法effect Key无法前进 | operation route直接返回窗口外typed detail；`system.status`只作可选预取，negative fixture覆盖“有effect atom、无system.read” |
| future OperationId可以“不建record但永远拒绝” | 时间推进后同一timestamp会进入合法窗口；有限系统若不留tombstone就无法知道它曾被拒绝 | error只证明本次KnownNoEffect；Delivered后client burn，past靠单调前沿持续拒绝，future/DeliveryUnknown仍以同一ID代表同一逻辑operation |
| “异常大幅前跳”可由纯本地clock自动识别 | 浏览器长期未运行与机器错误前跳在重启后没有可证明差别；含糊阈值会制造第二套未登记策略 | 位于派生安全域的观察值明确受信；全部active checked-add上界派生安全上界，域外不提交并返回CLOCK_UNTRUSTED |
| service worker的setTimeout + alarms实现了持续10秒retry | 未连接时没有WebSocket流量保活，MV3 worker约30秒可休眠且alarm最小周期约30秒；现合同实际只做到“偶尔醒来” | P3增加`offscreen` capability；用真实`WORKERS`理由的packaged offscreen document + dedicated worker拥有socket/timer，alarms只负责销毁后的重建 |
| role完成后的连接上限足以保护relay | 网页可建立大量停在HTTP upgrade或role hello前的socket，永远不进入client/instance计数 | 从accept开始计总socket/pending handshake，限制header bytes/fields与deadline；成功时原子转role计数，另加全局outbound buffer上限 |
| retired target marker“保留到RuntimeEpoch结束”天然有界 | 长期开着的浏览器可不断创建/关闭tab与document；若无count/byte门，session projection持续增长，若LRU则旧ref会复活 | 增加tab/document marker、target子预算与runtime整值预算；整份预编码并与session quota校验。retired历史超限轮换epoch，active集合超限显式unavailable |
| recovery record的“槽”天然可重复使用 | 普通active/tombstone计数未定义，revoke recovery Key后container与旧tombstone可能再次混为一个容量对象 | ordinary active+retained tombstone计数；recovery container闭合`empty \| active`，revoke预留独立tombstone/receipt后原子释放承载位 |
| chunk不可覆盖已闭合所有artifact race | operation先terminal而metadata仍staging时，迟到writer可继续增加孤儿chunks并耗尽容量 | 状态改为staging_open/committed/orphaned/released_tombstone；writer/commit/terminal close共触发metadata并检查phase/writeUntil |
| 所有旧realm物理GC必须阻塞hydration | 逻辑已隔离的大量chunks会让启动永久等待，与full reset“小事务立即失效”冲突 | 只把安全相关phase sweep作为ready门；已由realm/epoch fence隔离的物理GC可ready后按cursor续跑 |
| transport digest只hash固定descriptor | 两端解析上限是build Freedom Point；若resolved值不进兼容域，相同digest可能使用不同parser预算 | descriptor显式列出会改变wire语义的point refs，digest覆盖其resolved值；endpoint与component私有事实仍排除 |
| per-client inflight上限足以让两端有界 | 多client可绕总表；全部route还可压到一个extension socket并并发做Key hash，fake relay也可绕relay限制 | 增加client数/total/per-extension current route与auth worker pool build points；零实例不建wait，正常超限KnownNotDelivered，fake relay越界关socket |
| Chromium documentId足以防旧DocumentRef复活 | 官方说明同一ID在prerender/active/cached间保持，BFCache恢复会再次active；旧operation可能穿过一次离开/返回 | DocumentRef加入extension-owned documentGeneration；只为active incarnation签发，离开active永久退休，再次active推进generation；port重建只换ContentRealmToken |
| tab关闭后可删除TabRef generation entry | 若Chromium后来复用同一数字，target registry从初值重建会让旧TabRef精确命中新tab | 每个chromeTabId的retired high-water保留到RuntimeEpoch结束；close/replaced只清正文不清marker，容量无法保留就轮换整个epoch |
| 同identity join天然兼容一次性secret | 如果把live completion广播给所有join route，同一个create会复制多份明文；若事后挑route又可能重显 | commit前按首次join顺序选唯一live recipient；发送失败不转交，其他joiner只得无secret receipt/不可恢复，仍只创建一个Key |
| resolved operation error一律带phase | permission/schema/storage等可能在durable identity之前失败；伪造phase会让client误以为可查询ledger，完全不记账又会让已失败ID稍后变成effect | 每命令声明preLedgerErrorIds子集；只有这些resolved error无operation/phase，其余precondition失败也写durable terminal record，同ID稳定返回 |
| OperationId先按当前年龄拒绝再查ledger | 在接收窗口边缘accepted的ID会很快变“过旧”，破坏它冻结的完整dedupeUntil和响应丢失查询 | strict intent后先查exact retained identity并比较；只有absent ID应用age/future/reject-before，AdminMutationId同理 |
| 13位timestamp格式自然覆盖任意系统时间 | wall clock进入14位或checked-add溢出时，若先推进floor，Admin/Agent再也造不出合法ID；wrap/clamp又会放宽expiry | 固定13位数值域与checked arithmetic；越界不提交floor并进入CLOCK_UNTRUSTED。authority/transport仍ready；新业务admission与未fence项KnownNoEffect，fenced receipt仍可提交，正文披露用RESULT_WITHHELD |
| `.any`只用于foreign、自己必须另有`.own` | 持有release/read/cancel.any却不能操作自己的对象，与any语义相反，还会让Root同时拥有两atom掩盖错误 | owner相同时接受`.own OR .any`，foreign只接受`.any`且显式targetKeyId；所有own/any命令生成同一上下文真值表 |
| recovery container可只在存储实现里识别 | Key record字段表没有storage class，容量与普通update只能靠object-store位置/handler暗分支 | 增加不可变`storageClass=ordinary \| recovery`；Agent只能建ordinary，recovery只由admin container建且必须Root，不参与权限/身份 |
| P0需一次验证“六个digest domain” | 当前P0只有catalog/transport/command/component artifact四域，runtime/operation无consumer；用fixture凑数又会伪激活 | P0只验四域；runtime facts与intent/plan到对应阶段再加golden；总章改称“摘要族”不假计数 |
| “P0可读取pending默认来得到确定transport digest” | pending按定义没有resolved consumer；让摘要例外会直接推翻activation语义，并让之后active值变化却沿用旧证据 | 当前全pending authoring只解析catalog。P0先给真实scanner/build limit补consumer、projection、fixture并active；digest只含descriptor显式引用的active值，required ref pending就失败 |
| `system.describe`只有TS描述器就能在WASM失败时工作 | Key仍需permission expression；若唯一policy evaluator在WASM，诊断仍死锁；若TS手写membership又产生第二套授权 | configurator从同一resolved expression生成TS/native/WASM evaluator；只允许`extension_generated + none effect + none idempotency`，当前仅该诊断命令，三端真值门一致 |
| relay保持business opaque但可读`message.kind/phaseVersion`删route | 一旦读取这些字段就必须链接或复制Command/Error状态机，薄relay边界失真 | transport descriptor新增外层`frameClass=accepted\|progress\|terminal`；relay只看class，message始终opaque；client/extension验证固定映射 |
| client wait结束后直接删relay route已经释放全部资源 | extension/offscreen不知道本地receiver消失，会长期保留TransportRouteContext并继续产生无人接收的progress/terminal，反复短wait可耗尽extension route预算 | relay向exact socket best-effort发transport-only`route.abandon`；只删除response context，绝不cancel operation/effect；丢信号则socket断开或原terminal路径最终释放 |
| 零实例可以在relay保存command等首个未来socket | 没有stable extension identity，未来第一个socket可能是另一profile/realm；spool还把relay升级成Key/command状态owner | 零实例立即EXTENSION_UNAVAILABLE/KnownNotDelivered，多实例省略target立即要求选择，stale立即拒绝；skill轮询instances.list后才首次发送 |
| 一个实例时省略target对所有调用都安全 | disconnect后新唯一socket可能属于另一realm；DeliveryUnknown operation若隐式改投会在另一authority重复effect | wire omission只表示“任选此刻唯一实例”；generated client对operation重投/查询及连续性敏感调用先list并显式pin，断线后不猜映射 |
| offscreen可像native parser一样限制WebSocket fragments/assembly | browser WebSocket API只暴露已重组/解压后的完整message，JS看不到fragment或协商结果，所谓重组前probe不可实现 | raw relay/native端执行fragment/assembly门；合法relay不协商compression且发单一binary message；extension仅在平台allocation后先限最终byteLength并承认同OS假server DoS边界 |
| offscreen只写“窄桥”就不会访问authority | offscreen worker仍拥有extension-origin Web API，可直接开IndexedDB/fetch；UI也与background同origin，prose无法阻止误import | 各realm独立TS project/import root；AST/import-graph禁止authority/storage/business imports和动态旁路，packed spy证明offscreen只用transport allowlist |
| hydration barrier可以把所有入口先排队 | 启动/迁移/storage故障期间原始frame、Key和params可无界累积，gate反而成为内存DoS与secret retention点 | listener只做bounded source/outer检查；未ready Agent返回LEDGER_NOT_READY，admin mutation禁用，unsolicited content/page拒绝；不把业务请求挂到hydration promise |
| RuntimeEpoch与target projection分key写也可称一次恢复 | `storage.session`没有跨key/IndexedDB事务保证；崩溃可能留下fresh epoch配旧markers | session用单一闭合`runtimeProjectionV1` schema unit，单key set完成+完整readback后发布；仍不宣称session事务/durability，missing/invalid重建。IDB realm先线性化，session后reconcile |
| target投影超限总可通过轮换RuntimeEpoch恢复 | retired历史可清，但若当前active tab/document集合本身超限，轮换后仍同样超限，会进入无限epoch churn | fresh projection若active集合仍超限，记录targetRegistryState=capacity_unavailable并停止签发ref；事实缩小/配置改变后再试，不立即重轮换 |
| `RUNTIME_CONTINUITY_LOST`可具体命名成browser restart | reload/update、session损坏、marker容量轮换和不可证明连续性都产生同一观察，错误名会伪造原因 | 统一RUNTIME_CONTINUITY_LOST；queued KnownNoEffect、fenced unknown、completed保留，具体诊断另列不确定cause facts |
| P4可同时开放Agent control route | `control.acquire(tab)`需要真实TabRef，但TabRef/发现直到P5才存在；用synthetic ref开放外部route就是伪能力 | P4只做ControlState pure transition与synthetic full-ref crash matrix；P5 target registry成立后才active acquire/release route |
| P4只有synthetic effect也算真实Agent operation纵切 | 不可路由fixture无法证明P3 transport上的OperationId、secret单recipient或response丢失；把它注册成命令又会制造假产品能力 | P4激活无TabRef的真实keys/settings mutation与operations.get；synthetic effect只做内部fence/crash门，cancel等有真实可取消normal command后再active |
| retry cadence可以用wall clock/session恢复nextAttemptAt | 回拨/前跳会改变节拍，context销毁后session也不能证明elapsed continuity，还会混入security clock | live worker只用performance.now语义；context重建生成fresh generation并立即attempt，session摘要不作timer owner |
| service worker Port断开时socket总能保留 | pending business route绑定旧exact Port，保留socket会让旧响应无处返回并诱导改投新Port | pending route非空即关socket；idle可保留，下一business frame最多缓存一条并限时重建Port，第二条或超时关socket |
| security horizon可从point名称/prose自动汇总 | 漏算会checked-add溢出，多算pending default又伪消费；Admin窗口还可能偷用operation设置 | Freedom entry新增exact boolean tag；只汇总active tagged finite maxima与descriptor显式duration contribution，Admin有独立候选窗口 |
| `BROWSER_RESTARTED`是旧operation的准确terminal | RuntimeEpoch轮换还有多种不可区分原因，返回该名会把推测写成事实 | 候选统一为RUNTIME_CONTINUITY_LOST；旧ledger按phase结算，诊断原因保持best-effort |
| result/artifact在accepted时就计算absolute expiry | 长时间排队会让结果一产生便已过期，改变“保留结果N毫秒”的直觉与合同 | accepted只冻结duration/policy；result terminal或artifact commit时以安全时间计算absolute expiry |
| `operations.cancel`可复用targetOperationId作为自己的ID | 同一Key identity会同时代表cancel记录和被取消记录，形成自指CAS/intent conflict | schema/admission在任何记录或mutation前要求两ID不同，失败SCHEMA_INVALID/KnownNoEffect |
| extension Origin只需文档写死 | unpacked path、release签名或换机可改变ID；把私钥塞registry又会制造严重secret资产 | build.extension.identity_profile派生expected ID/Origin并验证packed产物；只记录公钥身份/期望值，私钥永不入registry/artifact/log |
| package relative path只统一`/`就跨平台 | Windows大小写折叠、保留名、尾点/空格、symlink/junction可让同一seal在不同解包器指向不同集合 | artifact path闭合portable ASCII并拒绝case-fold collision、Windows保留/尾点空格、控制字符、`.`/`..`、反斜杠和链接 |
| 根tsconfig只列background却保留`src/**/*.d.ts` | 该glob会把未来admin/content/user-script的DOM ambient声明重新注入WebWorker编译域，使realm隔离只剩目录命名 | 当前glob收紧为background/generated；后续每个realm建立独立project/reference，禁止全树ambient兜底 |
| `build.browser.capability_profile`只有一个allowed value仍算Freedom Point | 当前没有可选策略，唯一值只是版本化平台身份；把所有固定build fact都叫自由点会让registry失去“哪里真能改”的意义 | 从Freedom Registry删除；`chromium-full-v1`先归Capability/Platform固定descriptor并反向生成minimum version。第二个真实profile出现时再引入选择点 |
| full authority reset只换current realm就足以隔离旧effect callback | 旧DispatchToken若只绑定OperationId/phase，迟到回执可能误命中新realm同形记录，或在GC后重建旧记录 | DispatchToken、artifact writer与receipt CAS同时冻结AuthorityRealmGeneration；callback transaction要求current realm相等且exact record已存在。reset先赢后旧callback只丢弃 |
| authority撤下时“有界排队”原始请求是安全的 | 即使数量有限也会多保留一份Key/command/params，并与统一hydration无队列合同冲突 | 只做bounded outer/source检查后立即`LEDGER_NOT_READY`或关闭route；不把原始业务值挂到hydration promise |
| idle Port断开后等下一条业务frame即可应用runtime setting | 后台此时没有通道推新revision；retry/keepalive可能长期继续使用旧值，desired却被误报applied | 只增加无业务载荷的`transport.bridge.reconnect`通知；page主动重建并通过exact documentId Port门后，后台整份推递增descriptor，consumer回报后才推进applied |
| bridge timeout候选写“绝不缓存frame” | transport恢复规则实际允许一条已计费frame等待新Port；零缓存与合同、验收都冲突 | 改成exact single-frame、aggregate-budget、bounded deadline；第二条/超时关socket并清除，无持久或多条spool |
| artifact read chunk必须小于ordinary inline result阈值 | 64 KiB ordinary阈值与256 KiB chunk候选会让resolver永远拒绝后者；两者用途不同 | chunk作为独立schema的streaming例外，不要求小于ordinary阈值，但按base64url膨胀和最坏envelope后仍须严格小于message上限 |
| 有header/fragment上限就足以约束原始WebSocket codec | 错误mask方向、RSV/opcode、fragmented control、非最短或溢出length、假Accept仍可造成协议分叉或在limit前分配 | RFC层字段成为固定不变量；P3对handshake与frame state machine做完整negative corpus，第三方库也必须证明配置而非只测连通 |
| `address in use`可以直接当“已有relay可用”，或一次fresh hello已覆盖启动竞态 | 并发赢家可能兼容、无关或仍处于bind→listen间隙；盲目信任会泄露Key，一次连接拒绝又会误杀正常收敛 | 启动后只在固定endpoint与有界单调总期限内做fresh hello；不兼容立即失败，兼容才复用。全程不发Key、不杀进程、不扫描/fallback |
| 写了“application ping/pong”就等于closed transport已有keepalive | 原profile只允许business response和`route.abandon`，ping/pong没有合法shape、方向、ID、预算或路由归属 | transport descriptor新增connection-local exact ping/pong、canonical u64 pingId、单outstanding和小型控制预算；worker本地消费，绝不进background/Command route |
| server-first hello可保证错误listener在Key前看不到任何凭证 | WebSocket opening request规范使用`credentials=include`；浏览器托管Cookie/HTTP auth若发送，发生在101和hello之前 | P3预置loopback凭证并覆盖host grant矩阵抓包；出现敏感header则WebSocket capability不激活，先证明header stripping或更换transport。relay事后拒绝不能撤回已发bytes |
| skill可在单次调用内部生成OperationId然后立即发送 | 若连接在任何response前丢失，caller从未得到ID，就无法按合同查询或重投同一逻辑operation | SDK/skill必须要求caller传入，或在首个network byte前先把ID交给caller；helper不进relay协议，DeliveryUnknown不换ID |
| CSPRNG probe可证明熵，碰撞重取可以无限循环 | 运行时样本无法证明熵；故障/注入的重复源会让无界collision loop挂死authority或relay | 熵质量明确是Chromium/OS信任边界；probe只验API/shape/failure。nonzero/namespace碰撞用有限build attempt，API异常或耗尽在effect前fail closed |
| Root对“全部已声明atom”为true可直接照字面实现 | pending/retired声明也属于“已声明”，会被错误放进runtime bitset、授予UI或Root求值，等于把未实现/已退役能力复活 | runtime permission universe严格是当前resolved artifact中`status=active`的atom；未来新激活项自动加入，pending/retired/unknown永不进入，stable retired ID不复用 |
| 文档写`active/grantable`就等于已有两个authoring状态 | Command permission declaration只有`status`，不存在`grantable`字段；实现若从命令引用、UI或capability暗推，会制造第五份权限事实并让Root/授予集合分叉 | v1唯一运行permission universe就是当前resolved artifact的`status=active` declarations；未来确需第二状态必须先版本化schema，不能靠prose创造 |
| `127.0.0.1:32189`已经是用户冻结值 | 用户只冻结10秒重试；普通loopback地址还与其他端口共享cookie host namespace，可能破坏浏览器凭证隔离 | bind仍是pending Freedom候选；P3比较Windows/Linux与普通/专用numeric `127/8`证据后resolve一个exact endpoint，仍禁止扫描/fallback |
| server-first的风险只在request header | WebSocket走Fetch的`credentials=include`；错误listener的Set-Cookie/auth challenge等response可在应用hello前改浏览器状态或触发交互，代理/PAC还可能改变真正request destination | P3改成direct/代理/PAC、普通/专用地址、host grant、cookie/HSTS/auth与101/3xx/401/407/状态header的双向矩阵；任一secret、偏离endpoint、状态或交互都阻止capability激活 |
| 浏览器WebSocket收到binary frame自然就是ArrayBuffer | 规范默认`binaryType=blob`，可能先形成Blob/磁盘spool并绕开我们写的ArrayBuffer source门 | 构造器返回的同一task立即设ArrayBuffer；每条incoming精确检查，outgoing只用UTF-8 binary bytes；默认Blob是P3负例 |
| 一个outbound Port slot加总byte上限已闭合整条background→offscreen背压 | page/worker若不ACK，队列虽有界却会永久保留Key/result与route；runtime descriptor若另走无界消息流，快速settings更新仍能绕过；无exact ACK shape也无法做duplicate/stale负例 | 先把descriptor/response收进同Port单slot、latest desired与统一ACK deadline；后续继续反证又加入缺失的inbound release，最终闭合为descriptor/release/response三类 |
| raw source byte总和就是extension实际内存上界 | UTF-16字符串、Port序列化、re-encode和parser对象都会扩张；浏览器内部copy还不受插件allocator控制 | 扩展自有allocation按生成的最坏扩张系数反向计入各realm预算；Chromium内部copy明确是availability边界，不再把逻辑bytes冒充全部物理内存 |
| 有总socket/pending/header上限就能宣称网页不能“耗尽”relay | 有限槽位仍可全部被敌对连接占满；上限只把故障从无界内存变成有界拒绝服务，不提供公平性 | 长期验收改为证明bounded state/memory；明确网页/同OS进程仍可造成有界availability denial，不做不可拒绝服务承诺 |
| worker丢pending表后让durable fence等到effect deadline即可 | v1没有任何跨worker receipt route；clock fault又会暂停wall deadline，使该Key normal FIFO永久卡死，同时长期保留DispatchToken和敏感plan | bootstrap在ready前把没有本次live continuation的fence立即strict转`EFFECT_UNCERTAIN`，清token/plan、关闭staging且绝不重放；只有同一live执行的timeout callback可用late window |
| operation identity写成`(KeyId, OperationId)`在所有层都足够 | full authority reset后内部存储与回调必须与旧realm完全隔离；只写二元组会让文档实现者漏掉realm namespace | 外部仍只见Key+OperationId，内部完整identity明确为`(AuthorityRealmGeneration, KeyId, OperationId)` |
| `storage.session`中有完整projection就足以证明跨所有启动连续 | 该存储只承诺worker生命周期内存态，并明确在browser restart/disable/reload/update清空；若目标实现异常保留，静默复用会复活旧runtime refs | 以官方清空合同、顶层startup/install信号和packed矩阵共同作能力证据；异常残留/假连续fail closed并轮换，不猜测 |
| “同Key串行”自然等于多个socket按网络发送先后执行 | 多socket没有扩展可证明的全局到达时标，credential检查又并发；把某个callback完成顺序叫网络顺序会制造不可测试保证 | FIFO只冻结coordinator durable admission顺序；并发仍串行但先后未指定，调用方需先观察A durable accepted/terminal再发送B建立因果 |
| 所有`EFFECT_UNCERTAIN`都可保留DispatchToken等late窗口 | worker-loss路径已经没有callback/pending route；一般留存语句若再保留token会与bootstrap清理互相推翻，甚至让旧回调猜phase | 仅同一live执行的timeout-uncertain写`lateEvidenceAllowed=true`并区分dispatch/current uncertain phase；worker-loss同事务清token、置false，late只丢弃 |
| 单outbound slot意味着business ACK无需相关ID | A的ACK可以重复排入page→background方向；background收到首个ACK后已经post B，迟到的第二个A ACK仅凭“当前kind=business”会错误释放B | 每个exact Port由background分配不回绕`bridgeItemId`，item与ACK都携带；descriptor再匹配revision。迟到/重复/错ID关闭bridge，绝不确认下一项 |
| outbound只限source bytes就等于对象数也有界 | 很多微小progress/response对象可在byte上限内制造巨大queue元数据；descriptor和business还可互相饿死 | 队列按active route closed state派生count：每route最多unsent accepted+terminal，progress单值合并；descriptor/business都有pending时固定交替，latest desired仍coalesce |
| startup probe interval自然意味着probe不会重叠 | 若错误服务接受TCP后黑洞，每个handshake可活5秒；把100ms只当start cadence会让单client在10秒内叠加约50个socket | 每个startup coordinator严格singleflight；下一probe要求前一结束且最小start间隔到达，每次再被总deadline截断。多个client仍由relay全局门限界定 |
| 无载荷bridge wake天然不会创建重复Port | background singleflight不能阻止已排队的迟到wake在page已有Port后到达；若page每次都connect会形成第二条bridge | page也有connect singleflight；已有live Port或handshake在途时wake是bounded no-op，后台仍只接受精确documentId/current Port |
| WebSocket最终连到正确relay就证明代理无害 | `ws://`没有端到端TLS；透明代理可转发正确hello后继续看到bearer Key、命令和结果。Chromium虽对`127/8`默认隐式bypass，但`<-loopback>`可取消 | P3必须证明effective proxy decision为DIRECT并以instrumented proxy验证看不到application bytes；无法观察/排除重路由的profile不激活，不能静默把普通代理加入TCB |
| loopback WebSocket不会产生新的Chrome确认 | Chrome 147已把WebSocket纳入Local Network Access限制；extension-origin是否豁免、提示是否记忆及无限retry会否重复触发都不能从旧版本/网页样例推断 | P3跨目标版本实测LNA行为；存在未预先闭合的prompt/block就报告interaction/capability unavailable，不能让10秒retry制造反复浏览器提示 |
| relay只把request的auth/command视作opaque secret就够了 | response message可含新Key、页面正文、Cookie类数据或JS结果；relay不链接Command Registry，根本无法选择性识别 | extension `message`整棵子树同样opaque-secret，不记value/hash/method；request/response buffer在forward/write结束后尽力清零，route metadata不复制 |
| socket数与per-message上限分别有限就足以证明relay raw-input bucket | 160个连接可同时保留各自接近message上限的fragment assembly；数学上虽有限，峰值却是未经配置器核对的乘积，局部“通过”仍可压垮进程 | 增加global raw-input byte reservation，HTTP/role/message bytes在append前原子计入并精确归还；这只闭合raw bucket，下一条继续反证组合总内存 |
| global raw/forward/response各自小于allocator就等于组合内存已闭合 | 三个64 MiB bucket、转移时双份copy及socket/parser metadata可以同时存在；逐项比较同一个allocator上界会让总和超卖，先释放旧bucket又产生无owner窗口 | 增加`build.relay.maximum_managed_memory_bytes`；生成器用checked sum覆盖全部同时存活bucket/固定开销。buffer转移先取得目标reservation，copy并存双计，最后归还旧owner |
| offscreen source写“直到background明确释放”就已经有内存所有权协议 | 原Port合同只有background→worker的descriptor/response ACK，没有任何source release frame；worker既不能安全归还aggregate reservation，也可能永久持有Key/frame预算 | worker逐source生成`inboundItemId`并冻结post→release总deadline；background full scan/copy后经共享outbound slot发exact release，worker回`bridgeItemId + inboundItemId` ACK；同route response不得越过，超时关socket并清整代预算 |
| occupation失效后“异步清理”可以按scope删除 | cleanup读取旧失效record后若暂停，新Key可在同scope建立更高generation；旧任务恢复盲删会把新occupation一并清掉 | 当前事务可原子覆盖；否则sweeper冻结完整OccupationId和eligibility revision，在strict transaction compare-and-clear。tab close/Key expiry等一律如此，迟到cleanup只no-op |
| 普通动作冲突只需返回一个OccupationId | 同一Key允许同时拥有global与目标tab occupation；另一Key的target action会同时撞两项，只返回一个会让一次release后再次得到隐藏冲突，且与acquire的`conflicts[]` schema分叉 | 所有`CONTROL_OCCUPIED` producer统一使用bounded `conflicts[] + truncated`；逐项独立release后再acquire，仍不新增status/takeover命令 |
| P3实验室证明DIRECT后即可让所有用户的明文profile永久active | 系统代理、PAC和enterprise policy是部署期可变事实，`<-loopback>`可取消默认bypass；静态矩阵不能证明未来socket仍未经过可读明文的代理 | 明文候选只限当前deployment可持续证明DIRECT且变化会失效socket的profile；一般Chromium若无runtime证据，P3先闭合版本化protected application profile。relay仍不做Key授权，opening request/LNA另过门；下一轮又继续反证其密钥来源，见表末 |
| relay明文看见Key属于用户冻结事实 | 用户冻结的是“业务只认Key、鉴权在extension、relay不成为业务owner”，并未要求relay必须看到明文；把派生实现写进冻结区会阻止更安全且不改身份模型的路线 | README/裁定移除明文冻结；transport representation留在P3工程门，端到端保护也只能以Key为凭据且extension作最终授权 |
| background完成full scan后即可先release source、之后再慢慢排auth/dispatch | source bucket虽归还，typed command/Key/params却已进入另一批没有aggregate byte owner的JS对象；大量合法frame可逐个“释放原文”后把内存搬到未计费队列，且copy瞬间有双份峰值 | 新增`build.extension.maximum_admitted_command_bytes_total`与`build.extension.maximum_managed_memory_bytes`候选；先取得目标reservation、copy重叠双计、再exact release。目标值保留到plan/handler不再需要，route abandon不能冒充operation结束 |
| 写“由Key材料端到端保护”就等于protected profile已经闭合 | 当前Key record只持久化salted verifier，既没有已认证extension endpoint proof，也没有可直接使用的双向session secret；若把verifier临时当AEAD key，会悄悄改变at-rest凭据模型，若把crypto放offscreen/relay又制造第二Key owner | P3把密钥来源、endpoint authentication、transcript/replay/KDF/AEAD/rekey与verifier兼容列为阻断门。推荐把公开extension transport proof封装进同一API Key token、私钥与decrypt留extension后台；任何credential-equivalent存储必须另行裁定，不能靠prose默认 |
| extension总内存公式里写了WASM就等于WASM有上界 | 未声明maximum的linear memory可以持续`memory.grow`；TS常量、arena reset和单次buffer limit都不能限制module整体页数 | 新增`build.extension.maximum_wasm_linear_memory_bytes`候选，要求64 KiB对齐并由最终binary/imported Memory maximum及边界growth fixture反向证明；该maximum进入extension组合预算 |
| IndexedDB cursor分批就保证hydration内存有界 | 每批虽小，但若把每条Key/operation/control记录继续加入永久JS Map，累计仍等于整张表；磁盘quota也不是heap budget | bootstrap只常驻有界索引/runnable摘要，完整plan按需加载；P4/P5有真实consumer时同步加入record count、index bytes、batch bytes和active-handler预算，缺声明前route保持pending |
| `pageCapture.saveAsMHTML`得到的就是“原始网页文件” | API封装的是调用时当前tab及资源的MHTML；它不保留最初导航response逐字节事实，也不证明页面脚本、DOM或子资源没有变化 | 新增独立`page.archive.capture`规划并明确MHTML语义；与live DOM、新`resource.fetch`及显式已捕获response四分，任何一条都不得冒充另一条 |
| 对Page Capture返回Blob“流式写入”就约束了完整采集内存 | Chrome在Promise完成前已经构造并返回完整Blob；扩展只能在拿到后检查size并约束自己的chunk/copy，无法预阻止浏览器内部峰值 | accepted前取得最大Artifact逻辑reservation；Blob返回后先验size，再用bounded slice逐块写staging，禁止whole-Blob arrayBuffer/base64。Chrome Blob/internal chunk单列availability边界，不混进extension allocator证明 |
| capture前后URL/DocumentRef相同就能写`possiblyChanged=false` | 页面可在不导航、不换documentId的情况下修改DOM、样式、canvas、图片及缓存资源；occupation也只阻止本插件其他Key的新派发 | receipt固定`contentStability=not_proven`，另列实际观察到的target/URL变化；不得把“没观察到代际变化”升级成内容静止证明 |
| 多实例可逐个发送带Key的`system.status/tabs.list`来识别正确实例 | wrong extension在鉴权失败前已经看到整枚bearer Key；只读命令不会让credential spraying变安全，relay也无权把结果变成稳定映射 | 当前明文profile无明确InstanceRef选择时fail closed；禁止自动Key spraying。`instances.list`继续只给非秘密本地路由描述 |
| 把endpoint proof塞进单一API Key token就自动解决protected profile | token能认证端点，不会自动告诉client当前多个relay InstanceRef中哪一个持有对应private key；若直接选第一个或逐个发送bearer，仍会错路由/泄露 | protected descriptor增加transport-only无bearer有界探测：唯一proof匹配后才建立绑定exact current InstanceRef的易失session并发送加密Key；零/多匹配都不执行，断线重新探测 |
| 高熵KeyId/realm/proof使两个实例不可能相同 | 完整浏览器profile可被磁盘/虚拟机快照逐字复制，连Key、ledger、realm和private key一起克隆；随机碰撞论证不适用于状态复制 | 把profile clone列为外部复制边界；多个proof匹配报告歧义、禁止broadcast/first-wins，不声称跨副本全局幂等。重新唯一化需操作者显式reset/rotate |
| `tabs.create/close`统一用`all_occupations`最安全 | K1只占据无关tab A也会阻止K2在其他window操作，直接破坏“不同Key互不打扰”；粗锁还掩盖create的隐式current-window与close active tab的successor副作用 | 撤回该候选。P6先显式锚定window/active refs或拆固定语义method，再逐项登记controlPolicy；未闭合保持pending，不以全局阻断代替target模型 |
| protected会话密钥只在background，同时idle Port断开后socket可继续 | MV3 service worker回收会销毁易失会话；offscreen若接管密钥就成为第二secret owner，若继续收ciphertext又无法解密，三项不能同时成立 | 优先评估每请求独立密封与后台持久transport private material；若用长会话，background Port/realm丢失即关socket/InstanceRef并重握手。两种模式进入固定descriptor和回收矩阵 |
| transport public proof可以随时轮换且不影响已有Key | proof被封装在只显示一次的API Key token中；extension只有verifier，无法把旧token原地改成新proof。private key丢失/轮换会让仍有效bearer无法建立protected channel | P3必须版本化transport key lifecycle、loss/rotation/full-reset关系；proof变化要求显式rotate/reissue API Key，不能恢复旧token或自动fallback明文 |
| protected frame只要限制ciphertext bytes就不会绕过extension内存门 | background解封时ciphertext、decoded bytes、AEAD plaintext、strict parser对象和typed command可同时存在；response也有plaintext+ciphertext重叠，非法tag还可占满异步crypto | 增加profile-specific decrypted-application byte bucket与transport-crypto并发池；decrypt/encrypt前先reserve目标，全部重叠计入managed-memory，wire膨胀由descriptor checked relation闭合，失败精确归还且不进Key auth池 |
| `dom.maximum_query_results`会阻止query占用大量renderer内存 | `querySelectorAll`会先构造完整静态NodeList，再由代码取前N；结果上限来得太晚，DOM序列化也可能先建整棵对象再截断 | P5要求显式有界遍历+逐元素`matches`与增量byte/node/depth builder；selector引擎和单个DOM字符串内部成本列availability边界，不伪装可抢占 |
| 每个content realm有4096个NodeRef就代表总量有界且合理 | active document数量可很大；局部上限乘realm数可形成上亿entry，且没有中央capacity owner | 增加`dom.maximum_node_refs_total`与background per-realm lease；query前reserve最坏新增、reply结算actual reuse/new、Port/realm失效释放，降额不驱逐现有 |
| background只限制收到的content reply即可约束跨realm复制 | content已在renderer构造对象并交给runtime messaging，后台检查发生得太晚；许多并发reply还能同时占platform/JS copy | 增加content request总并发与aggregate source-byte lease，投递前发预算给content builder；各侧可控副本重叠进managed-memory，Chromium structured clone单列平台边界 |
| `keys.list/tabs.list`可以一次返回全量，反正各自总记录数有限 | 1024个Key含permission，或数千Tab/Frame都可越过inline/message/heap；“有限”不等于适合单frame。offset又会在并发mutation时跳项/重复 | 所有可能超inline的business list改用collection revision + keyset page + items/bytes双门；变化显式冲突重启，无server cursor/session且不先全量加载 |
| 写了`operations.maximum_ledger_bytes`就等于ledger实际有预算 | accepted plan和不同phase record没有canonical size/delta owner；pending count×最大plan可远超总字节，terminal shrink/abort又可能提前返还 | 增加单record build max、generated canonical sizer与storage-domain ledger usage；每次record transition同事务checked更新new-old，commit后才释放，物理IDB放大另列quota边界 |
| full authority reset后旧realm不可见，所以可把ledger/artifact usage立即归零 | 旧records/chunks仍占磁盘且GC分批；连续reset+新写入可反复绕过每realm上限，把“逻辑小事务”变成无界物理堆积 | ledger/artifact/aggregate logical账本改属storage domain；旧realm转retired-pending-GC继续计费，每个物理删除batch同事务释放。reset只保留最小恢复headroom，不发新大配额 |

## 3. InstanceRef为何必须在relay生成

该结论经同样的反证保留：只有relay同时看见本进程全部extension sockets、拥有relayEpoch、枚举表和断线事件。extension只看自己的一条出站socket，不知道relay何时重启，也无法分配relay局部全局序号。让extension生成会把易失route ref错误升级成安装身份，并使断线失效与route表删除不再是一个owner内的原子事实。

因此`InstanceRef={relayEpoch, instanceNumber}`在完成extension role握手后由relay唯一coordinator分配；断线删除，重连新number，restart新epoch。它不上extension wire、不进Key、operation、WASM、IndexedDB或稳定profile身份。

## 4. 仍需实验而非产品裁定

- packed Chromium中extension WebSocket的精确Origin/Host/request destination，以及固定签名与dev profile如何生成allowlist；direct/代理/PAC与双向credential/state矩阵一起验证。
- 一般部署若采用protected application profile，需实测并裁定单一API Key token中的extension endpoint proof、verifier-only record兼容、native client↔extension后台handshake/AEAD golden；relay/offscreen只见opaque payload。还必须验证无bearer的多实例proof探测、零/一/多匹配、session断线及复制profile产生重复proof/realm的歧义路径。
- offscreen `WORKERS` document/dedicated worker的WebSocket、service worker回收、offscreen销毁、alarm重建和设备休眠真实时序；不能把可运行context的10秒名义cadence写成跨冻结墙钟SLA。
- IndexedDB strict durability、quota、versionchange、storage.session官方清空语义、startup/install信号与worker/browser/reload continuity的packed行为。
- userScripts、host/file/incognito/restricted URL在目标Chromium衍生浏览器中的能力矩阵。
- pageCapture的manifest/target限制、MHTML内容边界、undefined/异常、超大Blob、worker丢失与bounded slice写入；浏览器完整Blob峰值明确不作extension可控保证。
- Zig/WASM CSP、ABI、内存、冷启动与结果预算。

实验失败只能修改合法Freedom Point、Capability事实或实现路线，不能引入来源身份、自动takeover、effect重放、Origin学习或提前清洗。

## 5. 恢复实现前的门

1. 活动文档不再出现旧phase、伪active consumer、`control.status/read`、`relay.describe/status`或extension生成InstanceRef。
2. 四份registry严格JSON可解析、全部pending、stable ID有序、schema/permission/capability/error引用闭合。
3. P0 manifest合同明确零network/storage/business route；P1才激活authority所需storage/session，P3才激活retry/loopback/alarms/transport。
4. `tsconfig`与无bundler路线一致；不存在的build/test目标不作为验证证据。
5. 本审计只纠正文档与authoring草案，不把尚未运行的Zig、WASM、Chromium或Windows/Linux测试写成通过。
