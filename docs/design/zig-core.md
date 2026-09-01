# Zig核心、WASM与Chromium适配 v0.8

日期：2026-08-29。选择Zig是为了积累可复用资产和让纯逻辑边界稳定，不是因为当前Agent请求频率会造成TypeScript性能问题。运行时代码暂停，尚未创建Zig源码或验证WASM。

## 1. 承载原则

- Zig负责registry配置器、闭合协议值、权限/控制/operation纯判定、引用验证、限额和deterministic transition。
- Zig纯核心编译为包内WebAssembly；同一模块可编译native用于单元/模糊/模型测试。
- Chromium API、MV3 service-worker生命周期、offscreen document/dedicated transport worker、IndexedDB/`chrome.storage.session`、DOM/content、userScripts、UI和WebSocket由TypeScript编写并编译成扩展JS。
- Windows/Linux relay用Zig native，共享codec/生成descriptor，但不链接业务state owner。
- extension service worker application是唯一业务owner；offscreen worker只拥有socket/timer/易失route。“Zig主导”不允许WASM、offscreen、JS和relay各存一份Key/queue/occupation/ledger。
- Cleaner/PageIR 没有模块、目录、接口或 placeholder；页面 operation tree 由浏览器侧 TS/JS 建立，现行代码不含 priority selection。只有树编排或摘要出现真实性能/复用证据时才评估把纯计算迁移到 Zig/WASM。

Zig可编译freestanding WebAssembly；Chromium扩展加载包内WASM需要manifest CSP生成物。它们是待实测能力，不是已完成事实。[Zig WebAssembly](https://ziglang.org/documentation/0.16.0/#WebAssembly) · [Chrome extension CSP](https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy)

## 2. 模块边界

| 模块 | Zig责任 | JS/宿主责任 |
|---|---|---|
| `configurator` | 严格解析四registry、resolve、交叉校验、emit、completeness | 构建系统提供输入并原子发布artifact |
| `protocol/canonical` | strict JSON value/canonical bytes/digest基础；不含业务目录 | WebSocket/frame与WASM buffer搬运 |
| `protocol/transport` | agent-relay/relay-extension的版本化envelope、role、limit、transportError、delivery、`frameClass`与`route.abandon` schema | OS/WebSocket I/O；relay只链接该子模块与canonical |
| `protocol/command` | 公共business message envelope及Command/permission/extension Error/capability业务投影与extension-wasm value schema | extension/client/skill/WASM使用；relay不链接 |
| `policy` | permission expression、Root逐atom真值、Key snapshot决策；为`backend=extension_generated`的无effect诊断命令发射同源TS求值器 | WebCrypto验证bearer secret、读取最新Key record |
| `capability` | static/dynamic descriptor合并、不可用原因 | 调Chrome API/permissions做真实probe |
| `refs` | Tab/Document/Node/Occupation generation与opaque ArtifactId规则 | 维护Chrome tab/document/content realm实际映射 |
| `control` | conflict、acquire/release transition、lazy invalid-owner规则 | authority gate、session持久化与事件清理 |
| `operations` | intent/plan canonicalization、phase machine、cancel、receipt/error transition | admission reservation、storage fence、per-Key runner、browser effect调用 |
| `settings` | runtime fact schema、normalize、preview、CAS transition | storage/UI/API commit与通知 |
| `extension adapters` | — | service-worker bootstrap/authority/dispatch/storage、offscreen transport bridge/worker、Chromium/DOM/userScripts/UI |
| `companion relay` | transport-only native codec/descriptor、role handshake、InstanceRef表、request route | OS listener、process lifecycle；不链接Command/permission/extension Error投影 |

Key secret明文不需要穿过WASM。TypeScript trusted context用WebCrypto验证后，只把`KeySnapshot{keyId,keyKind,status,permissions,expiresAt,recordRevision,authorizationRevision,controlEligibilityRevision}`传给纯policy；Zig仍决定权限表达式，JS不能手写第二套policy。若P3选择受保护application profile，解封/AEAD终点同样只能在native client与extension后台trusted context；offscreen worker可使用生成的outer/ciphertext scanner，却不得导入Key store、transport private key或decrypt API。每请求密封路线可让新background恢复独立request所需的版本化private material；长会话路线则在background realm丢失时必须关socket。具体密码学可由经过golden验证的包内WASM/TS primitive辅助，但Key授权与crypto状态owner仍留后台，不能因“Zig实现crypto”把WASM或relay升级成第二authority。

唯一bootstrap例外不是权限旁路：configurator把同一个resolved permission expression发射成Zig/WASM evaluator和generated TypeScript evaluator。TS版本只可服务同时满足`backend=extension_generated && effectKind=none && idempotencyKind=none`的命令；当前只有`system.describe`。构建用穷举/属性fixture证明regular permission bitset、Root全true向量、未知atom与错误expression在TS/native/WASM三端结论一致。任何手写`if (system.read)`、WASM失败时默认放行或把其他命令塞进该路径都使completeness失败。

## 3. extension↔WASM合同

`extension-wasm-v1`使用有界JSON bytes作为第一版ABI，先求可审计和跨native/WASM golden一致。只有benchmark证明必要时才新增版本化binary profile；不能改变Command/Operation语义。

边界输入只包含：

```text
resolved build descriptors and runtime facts
validated command values
KeySnapshot（无secret/verifier）
authority snapshot/revisions
target/ref snapshots
current operation record
adapter capability facts
```

边界输出只包含：

```text
typed decision / rejection
state transition or change set
effect request descriptor
receipt validation / terminal transition
```

WASM不能直接调用Chrome、写storage、维护socket、缓存authoritative ledger或返回裸指针作为外部ref。JS owner以expected revision验证transition、持久化后才执行下一步。

buffer使用配对`alloc/free`或每调用arena reset；进入WASM前所有长度先检查再分配。最终WASM module或宿主导入的`WebAssembly.Memory`必须声明由`build.extension.maximum_wasm_linear_memory_bytes`生成的硬maximum，构建检查其64 KiB page换算、初始值、最终binary limit和`memory.grow`越界失败；只有TS常量而module仍可无界增长不算闭合。该线性内存maximum还进入extension managed-memory组合预算。浏览器WebSocket已分配的ArrayBuffer不在WASM/TS控制范围，不能伪称零allocation。incoming request在admission前的invalid UTF-8/JSON/params才可映射`SCHEMA_INVALID/KnownNoEffect`；WASM trap、OOM以及ResolvedPlan、adapter result、receipt或outgoing value验证失败都转换为phase-sensitive注册错误。effect evidence严格取决于当前durable phase：fence前可以KnownNoEffect，`DISPATCH_FENCED`后只能保守EffectMayHaveOccurred/uncertain，除非typed adapter证据证明未调用。不能用`unreachable`隐藏外部可触发失败，也不能让核心故障把已经fenced的effect改写成未发生。

TS边界decoder不用`Object.assign`/对象展开把不受信JSON或页面结果合并进领域对象；schema按own-property逐字段复制到null-prototype/typed值，未知字段拒绝。`__proto__`、`constructor`、`prototype`没有魔法旁路，若schema未声明就与其他未知字段一样失败。UI渲染DOM/page/error文本只用text channel，不把它插入`innerHTML`。

## 4. authority coordinator

service worker内只有一个`AuthorityCoordinator`，但不会把所有浏览器effect全局串行：

- per-Key admission gate同步reserve operation identity并依次持久accepted record。
- per-Key normal runner只等待本Key前一normal operation。
- global short authority gate串行Key/settings/control/cancel与dispatch fence的有界元数据线性化。
- browser/content调用在fence durable后的同一JS continuation同步发起，然后立即释放gate；DispatchToken同时冻结AuthorityRealmGeneration，不持锁等待effect完成。
- fairness budget让short与normal都能推进。

Zig`operations/control/policy`根据一个不可变snapshot返回transition；TypeScript coordinator是唯一应用者。所有IndexedDB transaction与browser await边界都有明确phase，不能依赖JS单线程来假装原子。

## 5. 持久化

初始化顺序固定：

1. 顶层注册所有event listener；先做各plane的exact source与bounded outer检查。hydration未ready时不建立无界等待队列：Agent route返回`LEDGER_NOT_READY/KnownNoEffect`，admin mutation控件保持关闭并只开放闭合bootstrap诊断，content/page unsolicited消息直接拒绝。唯一共享对象是singleflight hydration promise，不把原始frame、Key或业务params挂在它上面。
2. generated TypeScript bootstrap先用自己实现并与native/WASM golden对齐的bounded strict JSON scanner读取seal，使用service-worker WebCrypto SHA-256 known-answer通过后的primitive验证包内component清单并置`artifactIntegrityReady`；不能先`JSON.parse`后假装检测过duplicate key，也不能依赖尚未instantiate的WASM解析自己。WebCrypto CSPRNG另只验证API availability、输出shape和异常fail-closed，不能用输出样本声称证明熵；所有nonzero/namespace碰撞重取受generated有限attempt门约束，绝不fallback到时间/counter/Math.random。再独立instantiate/ABI/self-test WASM并写startup capability fact。WASM probe失败只使依赖它的route unavailable，不阻断同一TS strict parser与generated诊断描述器。随后把storage.session访问级别固定为`TRUSTED_CONTEXTS`；此时只读取candidate，不生成或提交RuntimeEpoch。
3. 打开extension-origin IndexedDB；处理versionchange/blocked，完成schema migration，并把持久schema/build事实与已验证的当前`resolvedBuildArtifactDigest`比较。
4. hydrate authority meta、runtime facts和Key/operation/control的**有界索引投影**；只有这些事实成立后才验证session candidate并恢复/创建ExtensionRuntimeEpoch，再按bounded cursor读取该epoch中影响当前安全裁决的记录。不得把全部Key record、完整ResolvedPlan、receipt正文或artifact manifest读进JS heap后称为“已hydrate”。candidate缺失、build不匹配或连续性不可证就以有限CSPRNG generation attempts生成fresh epoch；失败保持command plane关闭。P4/P5首次激活相应表前必须加入真实consumer驱动的record-count、index-byte与单次load预算；目前不为尚无consumer的Key/operation/control slot伪造Freedom declaration。
5. 只同步完成影响安全裁决的current/old runtime phase结算、当前queue/index核对与target/transport projection重建，随后才置`authorityReady=true`。runnable记录的完整plan只在获得active-handler/admitted-command目标reservation后按需加载，用完归还；durable queued/tombstone正文留在IndexedDB。bootstrap发现v1 generic adapter留下的`DISPATCH_FENCED/CANCEL_REQUESTED`时，旧live continuation已经不存在，必须立即strict结算`EFFECT_UNCERTAIN`、清DispatchToken/敏感plan并关闭staging，而不是等wall deadline；这一步以bounded cursor可重入，全部影响ready的批次完成前不ready。它只表示artifact/schema/storage/hydration成立，`securityClockState`另行裁决并不因fault关闭transport。已由realm/epoch fence逻辑失效且不会再被当前读取命中的旧realm records/chunks，可在ready后按durable cursor继续有界物理GC；不得把不影响可见性的海量删除重新变成启动硬门。只有当前resolved build中已经active且各自capabilityRequirements满足的route才随之开放；P1没有Agent route，P3才由后台创建offscreen transport context并登记dispatcher。`system.describe`由generated TS描述器和同源permission evaluator实现且不要求WASM，可返回active/effective-global capability集合。

IndexedDB object stores至少为：

```text
meta               # schema/build digest, operationRejectBeforeMs, integrity facts
keys
runtime_facts
operations         # self-contained plan/phase/digests/receipt/tombstone
queue_counters     # (runtimeEpoch, KeyId) normal sequence high-water
admin_mutations    # extension_admin-only recovery receipts; never Agent protocol
control_state      # keyed by runtime epoch
artifacts          # small metadata: staging_open | committed | orphaned | released_tombstone
artifact_chunks    # keyed by ArtifactId/ArtifactStagingToken/chunkIndex; write-once, readable only through committed metadata's frozen generation
transport_crypto   # only when selected protected profile requires persistent private material; background-only version/proof/lifecycle, never Key policy or offscreen access
```

`transport_crypto`不是P1/P2无条件创建的业务store；只有P3选中的protected descriptor确实采用持久transport private material时，才随版本化IDB migration、capability和反向访问门一起加入。每请求密封可使用它；易失长会话仍只在background内存并在realm丢失时关socket。plaintext profile不得留下一个无人消费的secret store。

`meta`至少还含内部authority realm generation、storage-domain单调`securityTimeFloorMs`、realm-scoped operationRejectBeforeMs、runtime-continuity invalidation fact、migration/retired-realm GC cursor、storage-domain logical usage账本和desired/applied runtime revision。full authority reset用小型IDB事务建立新realm、标记旧realm retired并使全部旧Key和ArtifactRef在逻辑上失效，物理records/chunks随后有界GC；旧ledger/artifact/meta bytes在对应删除batch提交前继续分类计入domain usage，reset绝不返还一套新大配额。它保留未过期admin dedupe tombstone并绝不降低storage-domain time floor。DispatchToken、artifact writer和receipt callback都冻结旧realm，任何callback transaction先要求current realm精确相同且exact旧record存在；reset先赢后只能丢弃，禁止把late evidence写入新realm或重建已GC记录。`storage.session`不参与该事务：command plane保持关闭，reconciler写入绑定新realm/build的fresh RuntimeEpoch后再ready。realm generation不进入relay路由或稳定实例schema。

meta还保存realm-scoped `KeyCollectionRevision`，target projection保存runtime-scoped `TargetCollectionRevision`；各自在list-visible事实真正改变时与domain mutation/整值projection同一线性化点推进且不回绕。`keys.list`用IDB key range，`tabs/frames.list`用有界target index，均以expected revision + keyset after读取，不先全量加载或创建server cursor；页面之间revision变化显式要求重启。

- critical `readwrite` transaction全部显式`{durability: "strict"}`并等待complete；Chrome 121+默认relaxed不能用于accepted/fence/receipt/Key/control/GC。
- Key/settings/control/artifact等内部mutation在一个跨store transaction中同时写domain事实和completed operation receipt；abort就是KnownNoEffect，不需要WAL。`artifacts.release`只在该事务把metadata标为`released_tombstone`并立即使chunks不可读，物理chunk由有界GC另删，避免把大删除塞进authority事务。
- browser effect的accepted、dispatch fence和receipt是三次独立strict transaction；fence complete前绝不调用adapter。
- IDB transaction作用域内只await由该transaction产生的IDB request，不穿插network/Chrome API/timer，防止transaction自动inactive。
- 只有transaction complete后才更新对外可见cache。数据库corruption、upgrade blocked、schema/integrity失败或必需strict transaction因quota/存储故障不能提交时fail closed；单纯`persist()`未获准只记录驱逐风险，不属于当前不可用证据。
- 打开的database收到`versionchange`时立即关闭handle、撤下command ready并重新进入hydration；不能继续用旧schema接受operation。旧command/receipt的稳定envelope decoder至少保留到所有旧dedupe窗口结束，退役effect handler则不保留。
- 启动记录`navigator.storage.persisted()/persist()/estimate()`、实际IDB open与bounded strict write probe。persist未获准表示仍有平台驱逐风险，必须在runtime capability/诊断中如实呈现，但不等同当前IDB不可用；真正撤下command ready的是open/schema/integrity失败或必需strict transaction无法提交。若平台后来清空整个extension database，下次启动按外部清数据边界进入无Key新realm，不能让旧Key重做。`unlimitedStorage`只有在独立Capability声明、用户可见manifest影响和真实容量证据同时存在时才加入，不是IndexedDB默认依赖。
- operations建立ownerKeyId/OperationId、runtimeEpoch/phase、dedupeUntil等明确index。migration与影响当前裁决的phase sweep采用meta cursor + 有界strict transaction批次，全部安全门完成前保持hydration gate；每批count/bytes和内存索引总count/bytes都必须由P4真实Freedom consumer闭合，不能因IndexedDB cursor本身分批就让累积JS Map无上限。已经被realm/epoch fence逻辑隔离的旧数据物理GC同样有cursor，但可在ready后续跑；worker中断不恢复其可见性，也不为追求删完而开巨型transaction。
- normal accepted transaction同时写operation与对应`queue_counters` high-water；counter缺失/回退/回绕均fail closed，不能通过扫描已GC记录猜下一个值。queue/runnable状态本身仍只从operation store派生，high-water不是第二份队列。
- operation每次写入用generated canonical sizer计算record+index logical bytes并与record同事务更新storage-domain ledger usage；单record/总量分别过门，terminal压缩commit后才释放。artifact-producing accepted transaction同时记`reservedResultBytes`并推进storage-domain逻辑reservation；不可见`staging_open/orphaned`及retired-realm pending-GC chunks也计入总量。final commit把reservation转换为committed usage；无staging的cancel/pre-fence failure直接释放，已有staging的失败在关写事务中转换为`orphanStagingBytes`，GC删除chunks后才同事务释放。hydration从current+retired operation/committed/staging_open/orphaned records按bounded cursor重算并核对meta总量，不信任漂移cache；物理quota失败仍按phase fail closed/uncertain。
- ControlState为空闲时仍保存每个scope/TabRef的occupation generation high-water；release只清current occupation。tab关闭可清理绑定已退休完整TabRef的control/document正文，但target registry必须保留该chromeTabId的tabGeneration high-water到整个RuntimeEpoch结束，防止数字复用使旧ref复活；global control entry同样不回退。

nonterminal operation保存恢复执行所需完整ResolvedPlan；terminal receipt transaction同时擦除JS source、表单值、请求body/header等敏感payload，只留内部digest、自描述receipt和去重元数据。大结果chunks先分批写入绑定operation/phase/ArtifactStagingToken且不可读的`staging_open`；该物化token与DispatchToken分离。每批chunk事务共同触发metadata/chunks store，CAS同一open state、operation phase/write deadline与新index（同bytes重投才no-op），并同事务更新有界manifest；旧回调不得原地覆盖既有chunk。最终小事务同时触发operations/metadata，验证当前operation仍允许该phase结果以及token/manifest count/bytes/root digest后，提交committed metadata、冻结read generation和operation引用。operation转入不再接受late result的terminal或期限结束时，同一strict transition把metadata改为orphaned并关闭写权；不能让operation先terminal而staging仍可扩张。之后state阻止任何late writer，reader逐chunk核对冻结length/digest；事务abort则metadata/receipt都不可见，orphaned chunks有界GC。

`storage.session`：

- 一个闭合的`runtimeProjectionV1`值作为单一schema unit写入ExtensionRuntimeEpoch、绑定的AuthorityRealmGeneration/build digest、tab/document retired markers、target状态和offscreen transport诊断摘要；禁止把epoch与projection拆成多个可撕裂key后宣称跨key原子。这里也不宣称`storage.session`有事务/断电durability：写前规范编码并检查整值/target子预算，`set`完成后完整readback相等才发布；下次bootstrap只接受完整旧值或完整新值，missing/invalid一律轮换。live nextAttemptAt/connectionGeneration只由offscreen worker拥有，session里的值不能当socket事实。occupation只可缓存，IndexedDB ControlState才是恢复权威。若retired历史使target投影超限，fresh epoch可清历史；若当前active target集合本身仍不适配，则写入新epoch与显式`targetRegistryState=capacity_unavailable`且不签发任何ref，等待事实缩小/配置改变后重建，绝不反复轮换。映射缺失、部分损坏或连续性不可证时同样不猜generation或逐项LRU。
- 不复制另一套authoritative queue；worker回收时从IndexedDB index和有界runnable projection重建，不能把“从records重建”实现成加载整个ledger正文。
- browser restart/reload清空后生成新epoch，先sweep旧records再ready。

NodeRef table存在对应content realm并受document/generation/TTL约束；只复用expired/disconnected slot并推进generation，容量满不LRU驱逐仍有效ref。background另拥有全局NodeRef capacity lease账本：query投递前reserve最坏新增、reply按actual reuse/new结算，Port/realm失效释放整realm，late reply不能复活额度。content request还需在投递前取得总并发与reply source-byte预算；builder在renderer内增量受限，各侧可控copy计入aggregate，Chromium DOM/selector/structured-clone内部allocation单列availability边界。background只保存必要route/projection。Artifact store owner-bound且有硬上限，用高熵opaque ArtifactId跨browser restart保持尚未到期的不可变结果。relay InstanceRef永远不进入extension database/WASM。新RuntimeEpoch忽略旧ControlState并在sweep后清理，因此occupation虽持久化也不会跨浏览器运行继续生效。content script的IndexedDB属于宿主页面origin，不能打开extension-origin数据库；UI也只经后台port写入。

“不打开authority store”必须是构建事实而非代码约定。background、offscreen page、offscreen worker、admin UI、content与user-script使用独立TS project/import root；offscreen两层只能import生成的transport scanner/descriptor与窄bridge，UI/content只能import各自消息schema，任何realm反向import`authority-coordinator/storage/policy/dispatch`、动态import未列包内模块、直接使用IndexedDB或业务Chrome API都由AST/import-graph门拒绝。packed负向spy还要证明offscreen只调用Worker/WebSocket/timer/WebCrypto/TextEncoder/Decoder与page侧`chrome.runtime`桥，不能因这些context技术上具有Web API就成为第二owner。

## 6. effect协议

JS调用浏览器前必须满足：

```text
RAM reservation
→ accepted record durable
→ runner turn
→ Zig fresh-precondition transition
→ dispatch fence durable
→ same continuation invokes adapter
→ adapter observation/result
→ Zig receipt transition
→ phase + receipt durable
→ external completed response
```

任何effect adapter必须在Capability Registry声明“调用尚未发出”的可证明错误边界。fence之后默认`EffectMayHaveOccurred`；没有receipt就是unknown且不自动retry。固定DOM动作、tabs API、network、userScripts和debug各有typed receipt，不能用一个`success: true`掩盖证据不同。每个normal runner在前序terminal前不得fence后序；冻结deadline到达时把仍无receipt的fenced项持久化为uncertain，随后才释放同Key FIFO。

runtime settings采用desired/applied revision reconciler：domain transaction只提交canonical RuntimeFacts与operation receipt；timer/socket/cache等consumer在commit后按revision幂等应用。offscreen Port存在时只推严格递增revision的完整descriptor；Port缺失时后台只用无业务载荷的reconnect通知促使page主动建Port，不能把设置值或Key塞进广播消息。consumer明确回报后才推进applied，崩溃恢复继续未完成reconcile，不能把外部资源操作塞进IDB transaction或谎报已应用。

effectful handler在crash-injection matrix通过前不能标active。读取handler不得偷偷请求Chrome permission、连接debugger、重导航或做fallback。

## 7. refs与热路径

外部/持久身份使用稳定字符串或结构化ref；构建内投影使用enum/index/bitset。只有实际复用slot的Node等表使用slot + generation；Artifact使用不复用的高熵opaque ID：

- public没有OperationRef。
- NodeRef capability-neutral，不绑定Key。
- ArtifactRef/operation result owner-bound。
- KeyId不被系统主动复用，不是slot generation；保留记录有界GC后靠高熵随机与当前记录碰撞检查防复用，不承诺无限tombstone。
- InstanceRef只在relay native表。

运行时不解析registry字符串；command stable ID在边界一次映射为生成index。算法使用显式while、stack/queue、visited set和硬上限，不递归遍历不受信DOM/JSON。先benchmark再决定SoA、packed bits或binary ABI。当前低频Agent workload接受critical IDB strict transaction的额外延迟；优化可以调整index/批次/结果布局，不能隐藏降级fence durability。

## 8. 建议源码布局

```text
apps/
  extension/
    tsconfig.background.json
    tsconfig.offscreen-page.json
    tsconfig.offscreen-worker.json
    tsconfig.admin.json
    tsconfig.content.json
    tsconfig.user-scripts.json
    src/background/
      bootstrap.ts authority-coordinator.ts dispatch.ts storage.ts relay-bridge.ts
    src/offscreen/
      transport.html transport-page.ts transport-worker.ts
    src/content/
      bridge.ts document-realm.ts node-refs.ts actions.ts
    src/user-scripts/
      execute.ts
    src/ui/
      admin/ keys/ control/ settings/
    src/generated/
    wasm/
  companion/
    src/main.zig listener.zig handshake.zig instances.zig routing.zig
modules/
  configurator/
  protocol/canonical/
  protocol/transport/
  protocol/command/
  policy/
  capability/
  refs/
  control/
  operations/
  settings/
adapters/
  extension-wasm/
integrations/
  skill/
  agent-native/
registries/
  freedom.registry.json
  commands.registry.json
  errors.registry.json
  capabilities.registry.json
generated/
contracts/
tests/
  registry/ protocol/ policy/ control/ operations/ extension/ companion/
docs/
```

早期暂停阶段不创建 placeholder 的约束仍有效，但运行时纵切现已落地；`system.describe`、浏览器核心和页面信息树都有真实 consumer。Cleaner 目录仍不在当前树中。

## 9. 验收层次

1. native Zig：registry/canonical digest、permission真值表、refs、control、operation模型/模糊测试。
2. native、WASM与generated TS：相同permission/strict-value fixtures逐字节或逐decision一致；WASM另验alloc/free、trap/OOM/limit。
3. extension unit：authority gate确定性scheduler、storage fake、hydration、sender/channel负例。
4. packed Chromium：WASM CSP、worker recycle/restart、host/userScripts/content bridge、effect crash points。
5. relay：Windows/Linux真实运行、网页Origin攻击、InstanceRef lifecycle、delivery evidence。
6. end-to-end：多Key、多socket、多实例、disconnect、wrong-instance、unknown不重放。

交叉编译成功不等于Windows/Linux运行通过，普通网页mock不等于packed MV3生命周期通过。
