# 扩展侧 API Key 鉴权 v0.8

状态：Key-only 边界、受信 admin 管理面以及 Agent 侧 `keys.list/get/create/reveal/update/revoke` 均已实现。本文同时保留较早的 recovery container、rotate、security time、operation ledger 与 protected transport 候选；这些候选不能覆盖当前 registry、[Key 管理实现](../implementation/key-management-ui.md)和[当前裁定](../decisions.md)。外部业务只认 Key；扩展 UI 是浏览器内恢复面，不是第二种 Agent 身份。

## 1. 使用和权威域

用户在扩展界面点击创建 → 选择权限与有效期 → 显示或复制完整 Key → 交给 Agent/自动化程序 → 每次请求携带 Key。完整 Key 保存在这个扩展的本地数据库中，之后可在受信管理页再次显示。

- 一个扩展origin的IndexedDB是一个独立Key authority realm。Key不跨浏览器profile/扩展安装自动共享。
- 持同一 Key 的全部 Agent、进程和连接就是同一业务主体，共享权限、一般动作FIFO和occupation。
- relay只做transport路由；它不查权限、不签permit、不保存Key库，也不因启停改变业务状态。当前JSON明文只是pending候选，不是身份模型不变量；若P3选择受保护application profile，加解密与最终Key授权都在extension后台终止，offscreen/relay只能转发bounded outer metadata与opaque payload。外部仍只交付一枚API Key，不新增配对码、session token或第二credential。
- 不把 Key兑换成session token，不加登录、配对、来源白名单、签发层级或连接lease。
- 任意Key请求一旦通过权限、target、control与capability检查，就直接执行，不再弹插件逐指令确认。Root的区别是拥有全部声明permission，不是另一个确认工作流。

## 2. Key格式与记录

当前明文profile候选的Key采用规范形式：

```text
bk1.<base64url-16-byte-KeyId>.<base64url-32-byte-secret>
```

`bk1`不是用户冻结的 wire 格式。当前 KeyRecord 已同时保存 verifier 与完整 bearer，鉴权只使用 verifier，完整 token 只允许受信 admin 显式读取。若一般 Chromium 部署需要受保护 profile，P3 可评估把验证 extension transport 端点所需的公开 proof/绑定材料封装进**同一枚 API Key**，而不是让调用方另管一份安装身份；extension transport 私钥仍只留 extension 后台，offscreen/relay 不得获得。该路线必须版本化 token/record 并明确旧 Key 迁移，不能把 `secretVerifier.digest` 临时当会话密钥。token 内 proof 还必须解决 relay 多实例路由：只允许向有界 current InstanceRef 发送不含 bearer 的 transport 探测，恰好一个 proof 匹配后才发送加密 Key；零/多匹配都不执行。外部复制 profile 可能复制 private key、Key records 和 authority realm，多个匹配必须显式选择，不能由 proof 把两个 ledger 伪装成同一全局 owner。

MV3生命周期使crypto状态模型成为独立阻断项。优先评估每请求独立密封：版本化transport private material作为与Key verifier分离的extension后台secret持久事实，每个request有fresh nonce/ephemeral material和closed transcript，新service worker可在hydration后逐请求解封，offscreen仍无密钥。若使用易失长会话，则background Port/realm一断必须关socket并重握手，不能让offscreen续持session。两种路线各自闭合KDF/AEAD、request/response binding、replay、nonce/counter、forward-secrecy声明、redaction和native/WebCrypto golden。transport private material的生成、存储格式、non-extractability能力、版本、备份/复制边界、丢失/轮换和full reset关系也必须裁定；一旦public proof变化，旧token无法自动改写，必须显式rotate/reissue相应API Key，绝不静默降级明文。

KeyId和secret都由扩展CSPRNG生成。KeyId非秘密、从不主动复用；live/retained记录范围内严格查重，旧tombstone安全GC后依靠128-bit随机碰撞安全，不伪称无限存储下的数学绝不碰撞。KeyId候选的nonzero/namespace碰撞重取受中心合同的有限generation attempts约束，耗尽或CSPRNG API异常在写record/effect前fail closed；绝不退化到时间/counter/Math.random。secret有256-bit熵，其质量来自平台CSPRNG信任边界而不是运行样本“证明”。扩展持久化记录：

```text
keyId, displayName
keyKind                    # root | regular；创建后不可原地变更
storageClass               # ordinary | recovery；创建后不可变；recovery只由admin container分配
secretVerifier             # {version, salt, digest}; sensitive, not bearer secret
storedApiKey               # 完整 bearer；只供受信 admin reveal，不用于鉴权
permissions                # regular Key的稳定permissionId集合
expiresAt                  # null是显式不过期
enabled, createdAt
status                     # active | revoked；revoked不可恢复为active
revokedAt                  # active时null；revoked后保留
recordRevision             # 任意record变更；UI/API CAS
credentialRevision         # secret/verifier轮换
authorizationRevision      # permission/enabled/expiry等执行资格变化
controlEligibilityRevision # 只有occupation持续资格变化；供旧占据永久失效
```

`sha256-v1` verifier对独立domain separator及长度前缀的KeyId、16-byte随机salt、secret做SHA-256；高熵secret不使用可猜口令路线。未知verifier版本fail closed，摘要用常量时间比较。未来更换算法不能从旧verifier反推出新verifier；必须保留受支持旧reader，并在一次成功提供原secret的认证transaction中升级，或要求显式rotate。不能把keyId、短token或构建bit位当secret。

malformed Key、未知/已revoked KeyId、错误secret和不支持的verifier对未认证调用者统一公开为`UNAUTHENTICATED`，不回显哪一段正确；只有active记录的secret验证成功后才可返回`KEY_EXPIRED`或`KEY_DISABLED`等自身状态。固定格式解析后，unknown/revoked路径使用扩展meta中的dummy salt/verifier完成同一轮有界SHA-256与固定长度比较，避免明显的KeyId存在性时差；dummy不授予任何权限。Key lookup、frame大小和并发同样有界，不能靠不存在Key制造昂贵密码工作。

active且secret正确后，新command admission先要求security clock可安全推进/比较；失败固定`CLOCK_UNTRUSTED`。随后状态优先级为：`enabled=false → KEY_DISABLED`，否则`effectiveNow >= expiresAt → KEY_EXPIRED`，否则继续permission/capability检查；同一事实不能因handler不同返回不同错误。`expiresAt`采用半开边界，到点即失效。该优先级只适用于effect前准入/派发：已有fence或已完成工作的live response在最终披露复核遇到clock fault时必须用`RESULT_WITHHELD`保留当前phase/effect evidence，不能倒退成`CLOCK_UNTRUSTED/KnownNoEffect`。

Root持久化为`keyKind=root`，不保存“当前全部权限”的快照。`storageClass`只决定容量/恢复container归属，不参与permission求值、Key身份或队列；ordinary也可以是Root，recovery必须是Root。对当前resolved artifact中每个**`status=active`**的已声明permission atom，Root求值为true；未来版本新激活的atom也自动为true。pending/retired声明不进入运行时permission universe、不能被授予或借Root变成可调用能力。当前authoring没有`grantable`第二状态，不能从handler、UI或capability暗推。v1 permission expression只允许正向单调`allOf/anyOf`组合，并要求每个active Key command在全true向量下成立，不允许用`not/deny/非Root`把Root排除。schema、own/any上下文分支、参数/目标、occupation、当前Capability/Platform和Chrome自身限制仍全部执行。regular Key只保存稳定permissionId，冷启动时投影为当前构建bitset；未知/退役权限显式显示但不扩大，旧ID也不得复用成不同语义。

轮换secret保留KeyId，只递增recordRevision与credentialRevision并立即使旧secret失效；它不撤销该Key已经accepted的operation或occupation。权限、enabled、expiry等变化递增authorizationRevision；displayName只递增recordRevision。另有窄的`controlEligibilityRevision`：enabled/status/expiry变化，或permission更新实际改变该Key的`control.acquire`资格时才推进；添加无关permission不会无故释放occupation。`enabled=false`是可逆暂停，但每次暂停/恢复都推进该revision并永久使此前occupation generation失效。

revision只在canonical事实实际改变时推进；提交与当前值相同的patch返回no-op receipt，不制造虚假authorizationRevision并取消队列。secret rotate即使生成结果偶然不可区分也始终是credential变化。

Key domain另有realm-scoped `KeyCollectionRevision`，任何`keys.list`可见的create/update/revoke/GC事实改变都在同一strict transaction推进；no-op patch不推进。list按canonical KeyId keyset分页，第一页返回revision，后续页必须带相同expected revision和after KeyId；变化就`REVISION_CONFLICT`并从头读，不在后台保留cursor或把全表装入JS。secret/verifier始终不进入item，单页同时受item count与encoded byte上限。

`keys.revoke`是不可逆 mutation：当前实现于同一 strict transaction 把 status 改为 revoked、清除 secret verifier/salt、写 revokedAt，并推进 record/credential/authorization/control-eligibility revision。`storedApiKey`不参与鉴权，作为本机 admin 历史事实继续保留，因此用户仍可在管理页显示；普通 update 不能恢复 active 状态。未来若加入物理删除/压缩 tombstone，必须把删除 token 的语义做成独立、明确的管理动作，不能借 revoke 暗中删除用户仍期望可查看的 Key。

## 3. secret交付与恢复

扩展在 extension-origin IndexedDB 的 Key record 中保存 verifier 与完整 `storedApiKey`。鉴权只读 verifier；完整 Key 不进入 URL、content、日志、diagnostic、plan/digest、operation ledger、relay spool、storage.sync、错误回显或普通 Agent response。`keys.list` 永不返回 verifier 或 token，只返回 `secretAvailable`；完整 token 只由受信 admin route 的显式 `keys.reveal` 返回给当前管理页。

当前 admin `keys.create` 的 secret 交付为：

1. 生成Key与verifier。
2. 同一 strict transaction durable 提交包含 verifier 与完整 token 的 Key record，以及不含 token 的 AdminMutation receipt。
3. 当前 live completion 返回完整 Key；UI 可隐藏它，之后再以 `keys.reveal` 读取同一 token。
4. 如果提交成功但响应丢失，同一 AdminMutationId 和相同 intent 从已提交 record 返回逐字节相同 token，不重生成、不建立第二条 Key。
5. 旧 verifier-only record 的 token 不能从 verifier 反推。管理页显示 `secretAvailable:false`，用户可显式输入手中原始 Key；后台验证 KeyId/verifier 后用 `keys.attachSecret` 原子补存。普通认证和 Agent 调用不得隐式迁移。

Admin create 的并发/重试由 AdminMutationId 和 intent digest 收敛：相同 identity 只提交一条 Key，重复请求读取那条已提交 record 的 exact token；不同 intent 固定 `ADMIN_MUTATION_CONFLICT`，不披露已存在 token。现行 Agent 侧 `keys.create` 也使用 registry 声明的可重复 mutation 并返回已保存的完整 token，`keys.reveal` 可在独立权限下再次读取；精确 schema 与错误以当前 registry 为准。尚未实现的 rotate 必须另行闭合，不能沿用旧的一次性 recipient 假设或临时广播 token。

## 4. 两个严格分开的管理入口

本节中的 Agent 侧 `keys.list/get/create/reveal/update/revoke`、trusted admin Port、ordinary Key、重复 reveal、legacy attach 与不可逆 revoke 已实现。Root recovery container、容量/GC、full authority reset 以及下文依赖它们的流程仍是未实现候选。

外部API的`keys.*`始终先验证调用Key及对应permission expression。Agent create固定产生`storageClass=ordinary`，不能请求或update成recovery。创建/更新regular Key不建立issuer层级，但**每个新增permission atom都必须也是调用Key当前求值为true的atom**；删除atom、缩短权限或revoke不要求调用者拥有被删除atom。这样`keys.create.regular`/`keys.update`不能洗出调用者未被授予的`keys.create.root`、`control.release.any`等能力。创建Root另需显式`keys.create.root`，普通`keys.create.regular`不隐含；`keyKind`与`storageClass`均不可用update原地改变，需由对应创建面建立新record。该特权可明确授予regular Key，不硬编码成“只有现有Root”。

extension admin UI是本扩展origin内的out-of-band本机恢复面：

- 即使全部Root丢失/到期，也能创建替代Root、处理orphan Root、查看/解除occupation和进行显式修复。系统管理的逻辑容量保留一个不可被普通API消耗的**Root recovery container**；其状态闭合为`empty | active`，active时恰好承载一个`storageClass=recovery, keyKind=root`的普通鉴权Key record。它不计入ordinary Key配额，但走完全相同的Key验证、Root permission、expiry与revoke规则，绝不是admin调用时的隐藏万能Key。
- ordinary容量计算包含`storageClass=ordinary`的active record和仍在retention内的revoked tombstone；tombstone只在GC完成后释放容量，“最终可GC”不能被实现成撤销后立即不计数。recovery container及其最小admin receipt/recovery-tombstone headroom另行保留，达到ordinary上限只拒绝普通create，不能把“恢复Root”悄悄改成必须full reset。
- 未来 recovery container 若落地，应复用当前“create transaction 同时保存 verifier 与完整 token、相同 AdminMutationId 返回同一已提交 token”的 admin 语义，不再设计一次性 secret rotate 作为丢响应补救。显式 revoke 的 container/tombstone/headroom 仍需单独闭合。
- 旧 verifier-only record 不能从 verifier 恢复 token；用户只能显式补存自己仍持有且经 verifier 验证的原始 Key。
- UI route只接受预登记的本扩展popup/options/admin port和受信sender context。content、page、userScripts、外部extension message、relay无Key消息都不能到达。
- storage schema损坏或迁移失败时fail closed，显示只读诊断和明确的repair/reset范围；不得静默创建permissive Root或丢弃effect fence。
- UI调用注册为`boundary=extension_admin, auth=trusted_extension_context`的窄方法，不进入relay command dispatcher。UI先从受信后台只读取得`minimumAcceptedAdminTimestampMs`；该值至少覆盖storage-domain `securityTimeFloorMs`与admin reject-before安全前沿。每次用户手势在首次mutation发送前以`max(Date.now(), minimumAcceptedAdminTimestampMs)`加16-byte随机量生成`am1...` AdminMutationId，响应不确定时只能重发同一ID。后台的过旧/过未来检查相对同一个`effectiveNow=max(wallClockNow, securityTimeFloorMs)`，不能一边给UI未来floor、一边又按回拨后的裸墙钟拒绝。扩展按绝对dedupe window保存accepted identity/intent/最小receipt且容量不足先拒绝新mutation；收到确定窗口外拒绝后UI必须burn该ID，future拒绝在没有tombstone时不伪称永久记忆。AuthorityCoordinator验证sender/port和intent digest，并在同一个IndexedDB transaction提交domain事实与admin receipt。它不是Key、OperationId、caller identity，也不参与per-Key FIFO或occupation owner。

这条 UI 路径表示浏览器用户直接管理自己安装的扩展，不进入 Agent 的业务身份模型。当前 ordinary Root create 若在 record 提交后丢失 UI 响应，同一 AdminMutationId 会返回已提交 record 中的同一 token；不建立 orphan、不生成第二条 Key。未来 recovery container 仍须保留这个幂等语义。

repair若保留任何现有Key，就必须保留operation identity tombstone、rejectBefore水位和effect fence；禁止“只清幂等记录但Key继续有效”。需要丢弃这些安全事实时只能做明确的full authority reset：先撤下command ready并关闭当前transport；一个strict IDB transaction退役旧authority realm、建立新realm、写runtime-continuity invalidation fact与admin receipt，使全部旧Key立即不可认证。所有DispatchToken/receipt callback冻结旧AuthorityRealmGeneration；reset事务先赢后，旧callback必须因current realm不匹配而丢弃，绝不能在新realm创建或更新operation/artifact记录。`storage.session`不在IDB transaction中，不能谎称同事务轮换ExtensionRuntimeEpoch；commit后由reconciler生成fresh epoch并把新epoch/realm/build/target状态作为单一闭合`runtimeProjectionV1`值写入、完整readback，完成target/control sweep后才重新ready。若worker在两步间崩溃，bootstrap从realm/session不匹配继续生成fresh epoch，绝不恢复旧epoch。reset receipt durable后，UI再以新的AdminMutationId单独创建全新KeyId/secret。旧Key随后无法让旧OperationId重新执行。UI必须明确说明：reset只能切断未来授权，不能回滚或证明已经fenced的页面/网络/JS effect已停止；丢弃ledger意味着这些旧effect不再可查询。

full authority reset的闭合范围是Keys、realm-scoped operation reject/counters、control、artifacts、AuthorityRealmGeneration与runtime target projection；它保留当前构建、canonical RuntimeFacts、跨realm admin dedupe receipts、**storage-domain单调securityTimeFloorMs**及全域logical storage usage。新realm建立自己的operationRejectBefore初值，但不得回写或降低storage-domain time floor。线性化IDB事务只轮换AuthorityRealmGeneration、记录旧realm retired/runtime-continuity invalidation并写admin receipt；所有读取/派发先要求current realm，因此旧Key/operation/artifact立刻不可认证、不可查询、不可派发。fresh ExtensionRuntimeEpoch是事务后的fail-closed reconcile，不是虚构的跨API原子写。旧realm的大量records/chunks随后按durable GC cursor有界删除，但在每个删除batch真正提交前仍计入ledger/artifact/aggregate storage预算；reset只保证最小recovery headroom，不凭逻辑不可见返还一套新大容量。不能为追求物理“一次清空”制造巨型事务；GC中断不恢复旧realm可见性，也不释放未删bytes。会自擦AdminMutationId domain的factory reset响应不确定语义当前没有闭合，v1延期；清除全部扩展数据只能由浏览器外平台动作完成，不能被authority recovery暗中捎带。

浏览器用户仍可在扩展之外卸载扩展或清除其站点/存储数据；扩展无法把这种平台动作做成IDB事务。下次启动若只看到全新空存储，就建立**未配置、无Key、command plane关闭**的新realm并要求admin UI显式创建Root，绝不自动产生permissive credential。旧Key必然不可认证，但已经发生的旧effect与丢失ledger无法恢复；UI必须把“fresh install或外部清除后空realm”作为可见状态而非假装正常迁移。

## 5. 每次请求与effect线性化

认证链为：

```text
parse bounded envelope
→ 提取KeyId，读取verifier/salt/credentialRevision
→ 在IDB transaction外用WebCrypto计算candidate digest
→ authority transaction重读Key并要求active、credentialRevision/verifier未变，再常量时间比较
→ 在同一strict transaction读取并单调推进securityTimeFloorMs
→ 用effectiveNow=max(wallClockNow, securityTimeFloorMs)检查enabled/expiry/authorizationRevision
→ 查Command Registry的精确permission expression
→ 解析当前build/capability/host/target
→ 形成intentDigest与冻结ResolvedPlan
→ occupation检查与per-Key admission
→ dispatch前在authority gate按最新Key/control/target revision复核
→ durable dispatch fence
→ 同一authority turn发起browser effect
```

- Key authorization修改、撤销与dispatch fence由扩展同一authority mutation gate及重叠IDB stores排序；自然到期在每次dispatch按当前时间检查。
- `securityTimeFloorMs`只增不减；任何**已经被扩展观察并strict提交**的较晚时间都不能因系统时钟回拨而让过期Key恢复。每次认证准入和dispatch复核都使用该floor，必要的floor推进必须strict complete后才授权。位于派生安全域内的较晚wall time会被信任并推进floor；纯本地系统无法区分真实长时间离线和仍在该域内的错误前跳，因此不声称存在魔法“大幅跳变检测”，也不会自动调低floor或复活旧Key。若机器在扩展从未观察到较晚时间前就被离线回拨，本地同样无法证明真实世界时间；v1明确接受本机时钟信任边界，不伪称抗管理员篡改。
- security time与所有protocol timestamp固定在13位数值域`1000000000000..9999999999999`。configurator只从active integer Freedom Point上显式`contributesToSecurityTimeHorizon=true`的`maximumInteger`，以及版本化descriptor中同样显式列出的固定duration contribution，派生`maximumRequiredSecurityHorizonMs`和可提交安全上界；不得扫描point名称/prose，也不得读取pending default。AdminMutationId dedupe、operation dedupe/result/late window和artifact retention各有自己的声明，不暗中共用。fresh storage至少使用下界。wall clock高于安全上界、非有限或checked-add溢出时不把坏值写入floor，而是进入typed clock fault。transport与authority storage保持在线；错误secret仍只得到`UNAUTHENTICATED`，正确secret的新业务请求在command/operation admission前得到`CLOCK_UNTRUSTED/KnownNoEffect`。已accepted但未fence的operation可用该code写durable KnownNoEffect terminal；已fenced operation仍允许匹配callback用最后合法floor和显式clock-quality提交receipt，clock fault只暂停依赖wall比较的deadline/expiry/GC。其live正文披露失败用`RESULT_WITHHELD`保留phase。受信admin可读取最后合法floor与诊断；坏wall value未提交，平台时钟恢复到安全域后可继续。不能让一次14位或过近上界的系统时间永久生成协议无法编码的状态，也不能通过wrap/clamp悄悄授权。
- revoke先线性化：未派发operation terminal为`KnownNoEffect`，不调用浏览器。
- fence先线性化：effect可能发生；随后revoke只阻止新effect和结果正文披露，不伪装成回滚。
- 已越过fence的receipt/unknown仍保存。普通owner Key失效后不能查询正文；有显式`.any`权限的Key或extension admin UI可按窄管理合同查看必要状态。
- 如果允许Key自撤销，已认证的原live调用只可返回该mutation的最小durable receipt；之后该Key不能再查询。
- Chrome host permission在扩展authority之外。调用前复核并依赖Chrome在API调用时执行权限；已交给Chrome后再撤权仍按receipt/unknown结算。

`system.status.minimumAcceptedOperationTimestampMs`是拥有`system.read`的Agent可选预取，绝不是mutation/effect Key的强制父权限。每条已认证operation route在精确identity lookup确认查无record后，才用当前单调security time校验ID窗口；越界用versioned `OPERATION_ID_OUT_OF_WINDOW` detail返回`past|future`及当前min/max，调用方据此创建新ID。扩展不代生成或替换OperationId，不降低floor，也不让同一旧ID因事实变化复活；没有`system.read`但有某effect权限的Key仍可独立完成该effect协议。

Key到期/禁用/撤销或controlEligibilityRevision变化，使此前occupation立即在冲突判定上永久无效，并调度残留清理；OccupationId冻结取得时revision，因此恢复相同控制权限也不会使旧record复活。任何authorizationRevision变化都使冻结旧revision的queued operation KnownNoEffect，避免权限先撤后恢复在runner尚未观察时漏过；无关permission变化虽会保守取消queued plan，但不会无故释放occupation。该Key已开始effect不删除、不重放。

## 6. permission是并列声明

Command Registry内有独立`permissionDeclarations`，命令只能引用已声明permission；命令引用本身不能自动创建permission。典型权限：

```text
system.read
keys.read / keys.create.regular / keys.create.root / keys.update / keys.revoke
settings.read / settings.update
tabs.read / tabs.write
page.dom.read
dom.query / dom.action
js.execute
resource.fetch
control.acquire / control.release.own / control.release.any
operations.read.own / operations.read.any
operations.cancel.own / operations.cancel.any
artifacts.read.own / artifacts.read.any / artifacts.release.own / artifacts.release.any
debug.connect / debug.read / debug.use
```

own/any是显式上下文表达式，不是Root隐藏旁路。语义统一为：目标owner是调用Key时接受`anyOf(.own, .any)`，foreign owner只接受`.any`并要求显式targetKeyId；因此`.any`不会荒谬地排除自己的对象，而`.own`不能扩大到foreign。`control.release`、`operations.get/cancel`和artifact接口逐次检查owner；foreign lookup返回与不存在一致的公开错误，除非请求明确使用`.any`权限和ownerKeyId。

`js.execute`与DOM、当前DOM读取、`resource.fetch`等权限并列。允许JS时脚本可能自行点击或fetch，这是权限配置的已知含义；系统不分析脚本、不自动勾选其他权限、也不让其他API的deny规则暗中限制JS。

## 7. 存储与秘密卫生

Key、runtime facts、control和operation位于extension-origin IndexedDB。content script的web storage/IndexedDB属于宿主页面origin，不能直接打开扩展数据库；popup/options虽然属于扩展origin，产品代码也只经后台admin port访问，不自行打开第二写连接。

critical mutation使用覆盖所需object stores的单个`readwrite` transaction，显式`{durability: "strict"}`并等待complete：例如`keys.create`同时写Key record和不含secret的completed operation receipt；transaction abort就是KnownNoEffect。Key更新使用`expectedRecordRevision`，事务内读当前record、校验、按字段推进credential/authorization/control-eligibility revision、写canonical事实与receipt。涉及controlEligibilityRevision时，同一事务还使匹配旧revision的ControlState无效或留下可机械判定为无效的revision fence。service worker被终止时未complete transaction按abort处理。

WebCrypto不放进活动IDB transaction；先根据读到的salt计算candidate digest，再在准入transaction重读status、credentialRevision/verifier并固定长度比较。轮换或revoke发生在两步之间时请求只会fail closed，不能拿旧digest越过新credential。自然到期与OperationId时钟检查共用meta store的单调security time，不各自维护可能分叉的时间真相。

manifest只在真实session consumer存在时由Capability Registry加入`storage`，并在启动记录`navigator.storage.persisted()/persist()/estimate()`及实际IDB strict write probe。database open/upgrade blocked、schema/integrity失败或必需strict transaction不能提交时fail closed；persist未获准本身只报告平台驱逐风险，不能伪造成当前存储故障。全部extension数据被平台清空时按新空realm/无Key处理，旧Key不再可认证，因此不自动重做旧effect。`unlimitedStorage`不是默认依赖，只有独立capability与容量证据闭合后才可加入。`storage.session`只存RuntimeEpoch/transport/target缓存，显式保持`TRUSTED_CONTEXTS`；不用`storage.sync`保存任何业务或secret。

协议schema把`auth.apiKey`、新建secret和verifier标为secret字段。verifier只存在Key object store，不复制进operation receipt/digest。合法/非法frame、parse error、trace、CLI参数、crash breadcrumb和Error Registry diagnostic都按schema先脱敏，不能记录原始envelope。业务schema只在extension/client可用；薄relay把整个`auth`和`command`子树视为不可记录值，不能因不知道某个header/JS/body敏感性就记录它。CLI/skill默认从stdin、受限凭证文件或系统凭证存储取Key，不把Key放命令行argv。

## 8. 验收

同Key跨来源同主体；跨扩展域不是同Key；Root marker不漂移；regular权限独立；JS不触发permission closure；到期/禁用/revoke在fence前阻止effect；fence后如实unknown/receipt；storage对content不可读；页面消息不能进admin route；create响应丢失不落盘/重生成secret；全部Root丢失可由extension UI恢复；日志和错误始终脱敏。
