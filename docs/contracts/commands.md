# 功能指令与 operation 合同 v0.9

日期：2026-08-30。命令从功能出发逐步补齐。当前浏览器核心合同见[浏览器核心指令扩展纵切](../implementation/command-expansion-slice.md)与[页面信息树实现切片](../implementation/page-information-tree-slice.md)：tabs、DOM、完整页面信息树、resources/fetch、MHTML/screenshot、Artifact、Key、settings 和 JS 均已进入 active registry。下文较早的 operation/receipt 完整架构仍是后续强化设计，不能覆盖当前纵切已经冻结的极简 Key lane、AdminMutationId 和直接 Chromium adapter 事实。

> 当前纵切的 API 真值以 `registries/commands.registry.json`、生成结果和上述实现合同为准。旧表里把这些同名命令写成 planned，或要求尚未实现的 Operation ledger 才能开放的段落，均不再作为本轮阻塞条件。

## 1. 一个语义目录，三个边界 profile

Command Registry包含三张独立表：`permissionDeclarations`、闭合的`schemaDeclarations`与`commandDeclarations`。permission和schema必须先显式声明；命令引用不会自动创建它们。schema declaration是受限、可生成Zig/TS validator的data-only IDL，不允许悬空schema字符串或在handler里维护第二份字段表。当前元schema允许`closed_object`及内建`string | sha256_v1_digest | sorted_unique_string_array | safe_integer_or_null | positive_integer | collection_revision | collection_revision_or_null | tab_ref | tab_summary_array | tab_detail`字段类型；collection/tab类型是首个Chromium tabs纵切的闭合投影，不是任意JSON逃生口。未知kind/type、重复或非规范字段顺序均拒绝。新类型必须先扩展configurator元schema与对应runtime/golden，不能在某个handler局部解释。每个command至少声明：

```text
stableCommandId, method, schemaVersion, boundary, authPolicy
paramsSchema, resultSchema, ephemeralResultSchema, permissionExpression
effectKind, queueClass, controlPolicy, targetKind
backend, capabilityRequirements, limitRefs
idempotencyKind, secretDeliveryPolicy, progressSchema, receiptSchema
allowedErrorIds, preLedgerErrorIds, errorDetailSchemas
dispatchPreconditions, resultMaterialization, externalExposure, status
```

`idempotencyKind`是闭合枚举`none | operation_id | admin_mutation_id`，不能用一个布尔值把两种不同ledger混为一谈。Agent侧mutation/effect必须是`operation_id`；受信`extension_admin` mutation必须是`admin_mutation_id`；只有无mutation/effect的read/status可用`none`。生成器同时验证boundary、effectKind、queueClass与该字段的合法组合，handler不能把ID藏进params后自行解释。

`secretDeliveryPolicy`闭合为`none | single_live_recipient`。普通命令必须是none且`ephemeralResultSchema=null`；一次性secret命令必须是mutation、声明稳定的无secret`resultSchema`/durable receipt、另声明只供首次live completion的`ephemeralResultSchema`，并使用single_live_recipient。生成器要求ephemeral schema中的secret字段有敏感标记且绝不进入retained decoder输出、progress、error details或artifact。handler不能用同一个optional `secret?`字段临时决定是否重显。

permission expression v1是只含已声明正向atom的单调闭合语法（`allOf/anyOf`及其嵌套）；不提供`not/noneOf/deny`或“非Root”atom。这样Root把当前resolved artifact中全部`status=active` atom置true时，每个active Key command都必须求值为true，符合“最高Key拥有插件全部已实现操作权限”；pending/retired atom不进入该向量，未来新激活atom则自动加入。当前permission declaration没有`grantable`第二状态，生成器不得从使用关系暗推。构建门为每条active命令跑这一向量。target、own/any参数分支、control、capability和Chromium限制不是permission否定式，仍在各自边界检查。

`status`只表示当前resolved artifact是否包含完整handler/validator/probe闭包；`externalExposure`独立闭合为`none | agent_relay | extension_admin`。extension command只有`status=active && externalExposure=agent_relay`才可进入Key dispatcher；admin boundary只能是`extension_admin`且受sender/port门。pending命令固定`externalExposure=none`。生成器不得从handler存在、boundary名称或skill文案推断route开放。

同一命令语义投影到三个不同profile，外层字段不能混用。所有command envelope都显式携带`method + schemaVersion`；二者映射到唯一stableCommandId，未知组合返回`COMMAND_NOT_FOUND`，不猜“最新版本”：

1. `agent-relay-json-v1`：`kind=forward`时携带clientRequestId、waitTimeoutMs、可选targetInstance、auth、command；`instances.list/relay.stop`是transport local kind，不是Command Registry命令。
2. `relay-extension-json-v1`：relayRequestId、auth、command；禁止全部instance/client字段。
3. `extension-wasm-v1`：纯值buffer、transition/effect request/receipt；没有Key明文、relay字段或Chromium对象。

完整transport envelope见[传输合同](transport.md)。业务effect identity只来自command中的OperationId，永远不复用clientRequestId/relayRequestId。

resolved-command与boundary business message的公共envelope不是handler手写结构，也不是第五份registry；唯一authoring owner是`modules/protocol/command`中的版本化command-protocol descriptor。configurator把它与每条命令自己的result/progress/receipt/error-detail schema投影到extension、client、skill和native/WASM fixture。闭合矩阵是：

| message类别 | 必需identity/version | 明确禁止 |
|---|---|---|
| 尚未解析命令的boundary error | `boundaryMessageSchemaVersion + errorId + numeric code + effectEvidence=KnownNoEffect`；只有顶层detail映射存在时才可带details | stableCommandId、command/result/progress/receipt schema version、OperationId、phaseVersion |
| 已解析的纯read completed/error | `messageSchemaVersion + stableCommandId + commandSchemaVersion + effectEvidence`；有result时带resultSchemaVersion | OperationId、phaseVersion、receipt/progress字段 |
| mutation/effect的resolved pre-ledger error | `messageSchemaVersion + stableCommandId + commandSchemaVersion + error + effectEvidence=KnownNoEffect`；error必须列在该命令`preLedgerErrorIds` | OperationId、phaseVersion、receipt；没有durable record就不能声称accepted/terminal |
| `operation_id`命令已有durable record后的accepted/progress/terminal | 上述resolved identity，加`operationId + phaseVersion`；progress必须带progressSchemaVersion，terminal typed receipt必须带receiptSchemaVersion | client/relay request ID、InstanceRef；`progressSchema=null`时任何progress |
| `admin_mutation_id`命令 | 同一固定内部envelope规则，但identity是AdminMutationId且永不进入relay profile | Key队列身份、OperationId、InstanceRef |

`phaseVersion`是operation record中的规范u64十进制字符串；同一route上的旧版/倒退frame拒绝。纯read没有ledger phase，不能为了统一形状伪造`phaseVersion=0`。`errorDetailSchemas`与顶层`boundaryErrorDetailSchemas`的entry形状固定为`{errorId, schemaId}`，按errorId排序、唯一且只能引用各自allowed/boundary集合和已声明closed schema；某error在允许集合中但没有映射时，`details`字段必须省略。公共error identity始终由Error Registry的`errorId + numeric code`精确pair给出，具体details不能靠自由JSON或异常字符串临时扩展。

relay不读取上述business envelope。`relay-extension-json-v1`另有由transport descriptor拥有的外层`frameClass=accepted|progress|terminal`，只供route保留/删除与背压策略；extension/client必须机械验证它与`message.kind`的固定映射，relay把整个`message`保持为opaque bounded value。business phaseVersion单调检查属于extension与client，不得为了让relay删route而把Command/Error协议链接进本地软件。

`preLedgerErrorIds`只对`operation_id/admin_mutation_id`命令有意义，必须是`allowedErrorIds`的排序子集；`idempotencyKind=none`时固定为空。它只列确实无法/不应建立当前identity record的resolved失败，例如OperationId本身不可解析/窗口外、同ID异intent、ledger尚未ready或连最小tombstone容量也无法预留。完成params canonicalization并有安全写入能力后，permission/target/control/capability等失败默认也写成该OperationId的durable terminal KnownNoEffect record；这样响应丢失或事实稍后变化时，同ID不会从“已失败”偷偷变成新effect。若某命令确需让特定precondition用同ID在事实变化后重新求值，必须把error显式列入preLedger集合并给negative fixture；不能由handler临时决定是否记账。retryCondition只说明何时值得再尝试，不自动决定复用同一ID；已有terminal record时必须使用新ID。

一次性secret selected recipient的completed message把`resultSchemaVersion`替换为`ephemeralResultSchemaVersion`并按ephemeral schema验证；同一operation的其他join/replay只用稳定result/receipt schema。两种shape都由同一command declaration和commandProtocolDigest生成，不允许根据route类型手写第二套JSON。

Command Registry顶层显式`boundaryErrorIds`覆盖尚未能解析到某个stableCommandId时仍可由extension产生的完整错误并集，包括外层`SCHEMA_INVALID`、hydration/storage/internal failure、Key的`UNAUTHENTICATED/KEY_DISABLED/KEY_EXPIRED`和认证后的`COMMAND_NOT_FOUND`。固定顺序是：先做bounded strict envelope parse；再过hydration/storage gate；再验证credential/status/expiry；最后才向已认证caller解析`method + schemaVersion`。因此“unknown method + wrong Key”不先泄露command catalog，也不会越过Error Registry。

解析到命令后，`allowedErrorIds`覆盖params schema、hydration、Key认证、permission、target/control/capability、handler到发送前披露复核的完整错误并集；不存在“所有Key命令都隐式允许”的隐藏auth错误表。params schema也可能产生`SCHEMA_INVALID`，因此同一error可同时出现在boundary与具体命令集合。该ID只允许incoming envelope/params在admission与effect前失败；ResolvedPlan、adapter result、typed receipt或outgoing response验证失败必须转成按当前phase取证的`INTERNAL_ERROR`或以后登记的phase-sensitive typed error，绝不能因“也是schema失败”谎报KnownNoEffect。纯transport/local错误只属于relay profile，不塞进extension command。`system.describe`不要求WASM capability本身成立，否则WASM失败时会失去诊断入口；它由generated TypeScript描述器实现，读取独立startup probe table，并用configurator从同一resolved permission expression发射的TS evaluator裁决`system.read`/Root。该路径只允许`backend=extension_generated && effectKind=none && idempotencyKind=none`，且regular bitset、Root全true与unknown atom必须在TS/native/WASM真值fixture中一致；禁止手写membership或WASM失败默认放行。`activeCapabilityIds`表示当前artifact有完整consumer/probe的声明，`effectiveGlobalCapabilityIds`只列当前全局startup probe成功的子集；目标相关能力仍由`system.capabilities`查询。

## 2. 调用规则

纯read/status command的`idempotencyKind=none`；outer request ID只关联本次响应。任何会改变扩展业务状态、页面、浏览器、网络或外部世界的Agent command都必须为`operation_id`并带[闭合格式](authority-and-refs.md)OperationId；受信admin mutation改用`admin_mutation_id`。所有带Key命令共有的auth gate可以在strict meta transaction中单调推进`securityTimeFloorMs`；这是显式、幂等的鉴权基础设施事实，不启动command handler、不产生browser effect，也不为read创建operation ledger。

generated client/skill的方便封装不得破坏caller ownership：mutation/effect调用要么显式接收caller传入的OperationId，要么先在独立本地步骤生成并把exact ID交给caller，再允许send。单个同步helper内部生成后立即写socket、只在响应里回显ID的路线禁止，因为零响应/断线会让唯一安全查询键丢失。本地ID helper不是relay command或业务身份，也不得在DeliveryUnknown后换ID。

read没有durable snapshot/幂等承诺，但有披露线性化：调用browser/content/IDB前验证Key与read permission，结果准备好后、发送首字节前再从authority gate复核status/expiry/authorizationRevision和owner/target disclosure。revoke/禁用/权限变更若先于最后复核，就丢弃已采集正文并返回`RESULT_WITHHELD`及该read的KnownNoEffect；最后复核先赢则该次已授权披露可以完成。数据库object read尽量把Key/owner/object放同一transaction，live DOM等外部观察则用两次复核。secret rotation不改变authorizationRevision，因此不追溯取消已经认证的live read。

operation terminal response也在发送result body前做披露复核。若effect已经fenced/completed但owner此时失效、失去结果权限，或security clock此刻无法安全裁决expiry，只返回最小`operationId + phase/effectEvidence + RESULT_WITHHELD`，不返回页面/网络/secret/artifact正文；不能在post-work路径改报`CLOCK_UNTRUSTED/KnownNoEffect`并抹掉真实phase。durable receipt仍保留，之后可由恢复到可裁决状态且有`.any`权限的Key/admin窄查询。撤权不能把已经发生的effect伪装成KnownNoEffect，secret rotation则不抑制同Key live response。`CLOCK_UNTRUSTED`只用于新command admission或已accepted但尚未fence的operation KnownNoEffect结算。

```json
{
  "method": "dom.click",
  "schemaVersion": 1,
  "operationId": "op1.1787965200000.2xL5eL7dP9QmR4sT6uV8wA",
  "params": {
    "node": {
      "document": {
        "tab": {
          "extensionRuntimeEpoch": "Q3h5V2t8N0p4R6s9U1w7xA",
          "chromeTabId": 42,
          "tabGeneration": "3"
        },
        "frameId": 0,
        "documentId": "doc-a",
        "documentGeneration": "5"
      },
      "contentRealmToken": "R7m2N5p8Q1s4T6v9W3y0zA",
      "slot": 18,
      "generation": "2"
    },
    "guard": {"role": "button", "accessibleName": "购买"}
  }
}
```

Key只在外层`auth.apiKey`传递。动作使用完整TabRef/DocumentRef/NodeRef；裸`tabId`、`snapshotId`、文本序号和“多匹配默认第一个”均由schema拒绝。没有occupation时也允许动作；存在别的Key冲突占据时派发失败。

## 3. v1功能目录

| 功能 | Command | effect / queue | 直接permission | 状态与边界 |
|---|---|---|---|---|
| 构建描述 | `system.describe` | none / short-read | `system.read` | planned；v1返回buildProfile、Agent可见的activeCommandIds、已实现activeCapabilityIds、全局startup probe成功的effectiveGlobalCapabilityIds、transportCompatibilityDigest、agent-relay commandProtocolDigest、registryCatalogDigest与当前extension的resolvedBuildArtifactDigest；不披露admin-only method目录 |
| 动态能力 | `system.capabilities` | none / short-read | `system.read` | planned；可带目标，返回当前build∩Key∩Chrome grant∩target/backend |
| 运行状态 | `system.status` | none / short-read | `system.read` | planned；hydration/runtime epoch/queue/control摘要和`minimumAcceptedOperationTimestampMs`，不含InstanceRef；该floor只供可选预取，operation route自身必须返回窗口外typed detail，不能把`system.read`变成effect的隐含权限 |
| Key读取 | `keys.list/get` | none / short-read | `keys.read` | planned；永不返回secret/verifier；list使用collection revision + keyset page，不建server cursor |
| Key变更 | `keys.create/update/revoke` | extension mutation / short-mutation | `keys.create.regular`或`keys.create.root`、`keys.update`、`keys.revoke` | planned；keyKind创建后不原地提升；create有一次性secret交付；rotate后补 |
| 设置读取 | `settings.get` | none / short-read | `settings.read` | planned；只读registered runtime facts |
| 设置更新 | `settings.update` | extension mutation / short-mutation | `settings.update` | planned；patch + expectedRevision + preview/canonical readback |
| tab发现 | `tabs.list/get`、`frames.list` | none / read | `tabs.read` | planned；返回完整TabRef/DocumentRef；list使用target revision + keyset page，集合变化显式重启 |
| tab动作 | `tabs.create/activate/close/navigate/back/forward/reload` | browser effect / normal | `tabs.write` | planned；逐命令声明间接目标/control；create必须显式锚定目标window（例如完整anchor TabRef或未来WindowRef）且active语义显式，不能使用“当前窗口”隐含默认；无activeTab/permission prompt隐藏fallback |
| 当前DOM | `page.dom.get` | observation / read | `page.dom.read` | planned；序列化当前DOM与明确runtime facts，不冒充导航原始响应 |
| 页面归档 | `page.archive.capture` | browser observation + artifact mutation / normal | `page.archive.capture` | planned for P6；调用`chrome.pageCapture.saveAsMHTML`生成当前tab的MHTML并物化owner-bound Artifact；需要显式`pageCapture` capability/manifest permission，不称为原始HTTP响应；浏览器先产生完整Blob是平台availability边界 |
| DOM定位 | `dom.query/describe` | observation / read | `dom.query` | planned；返回DocumentRef + NodeRef与多匹配事实 |
| DOM动作 | `dom.click/fill/select/check/focus/scroll/mutate` | page effect / normal | `dom.action` | planned；精确ref + guard；固定动作由包内content adapter执行 |
| 任意JS | `js.execute` | page effect / normal | `js.execute` | planned；显式USER_SCRIPT或MAIN；独立permission |
| 新网络请求 | `resource.fetch` | network effect / normal | `resource.fetch` | planned；是现在新发请求，明确credentials/cache/redirect/body limit |
| control | `control.acquire/release` | extension mutation / short | `control.acquire`、`control.release.own/any` | planned；冲突提供有界`conflicts[]`中的全部本批OccupationId、重复acquire返回原ID，release与acquire永远分开 |
| operation | `operations.get/cancel` | read或extension mutation / short | `operations.*.own/any` | planned；cancel本身有自己的OperationId与targetOperationId |
| artifact | `artifacts.read/release` | read或extension mutation / short | `artifacts.*.own/any` | planned；owner-bound，不开放任意本机文件 |
| 等待 | `page.wait` | page observation/effect / normal | 独立声明 | proposed；使用同一operation/progress/cancel，不造jobs身份 |
| 截图/下载 | 按具体功能登记 | browser effect / normal | 独立声明 | deferred；capability/manifest有真实消费者后启用 |
| 已捕获响应 | `network.response.get` | observation / read | 独立声明 | deferred；只读已由显式backend捕获的响应，不承诺历史原件 |
| 调试连接 | `debug.connect/disconnect` | browser debug effect / normal | `debug.connect`、`debug.use`按命令精确声明 | deferred；显式backend，connect的Chrome调试确认原样保留；disconnect不伪装read |
| 调试观察 | `debug.status/targets`及具体只读`debug.*` | observation / read | 独立`debug.read/use`声明 | deferred；不得因status偷偷connect；每个后续debug命令单独分类，不继承这一行 |
| 页面操作树 | `page.tree.open.v1 / expand.v2 / view.get.v1` | observation / short-read | `page.tree.read` | **active**；每个 live Document 唯一 canonical tree，展开状态按 Key，view 是一次性整体/层级/sibling range/subtree 投影；无 selection、重点区、collapse 或服务端 cursor |

relay本地只保留transport envelope的`instances.list`与`relay.stop`，不进入Command Registry、Key permission UI、extension dispatcher、WASM或业务Error Registry。`relay.describe/status`由server-first hello、连接结果和instances列表覆盖，不再提供。

任何可能超过ordinary inline result的`*.list`都必须在自己的schema中声明无状态keyset page，而不是返回全量数组、用offset跨可变集合，或在后台建立隐藏cursor/session。公共形状至少为`limit + after`，当前 `tabs.list.v1` 第一页显式提交`expectedCollectionRevision=null`并返回当前canonical revision；后续页必须回传该revision和上一页`nextAfter`。扩展按一次冻结的target snapshot要求revision未变、按稳定canonical key读取至items/byte任一上限，返回`items + collectionRevision + nextAfter|null`。revision变化固定`REVISION_CONFLICT/KnownNoEffect`，调用方从第一页重启；不承诺跨mutation snapshot，也不保留server-side page state。`after`是该集合闭合schema中的最后稳定key（例如KeyId或完整当前TabRef排序键），不是新身份、secret、权限或可复用到另一filter的cursor；filter/sort全部进入请求shape并由schema固定。单item字段自身也必须有上限，保证至少能返回一项或明确LIMIT_EXCEEDED。`instances.list`是relay本地、受native transport固定小上限约束的另一profile，不借用business分页合同。

任何可能返回`CONTROL_OCCUPIED`的命令都必须把该error映射到同一个已声明、版本化、bounded conflict-details schema；不仅`control.acquire`如此，普通target/global effect被占据阻止时也必须返回本批可供后续精确`control.release`使用的`conflicts[]`。同一个owner可同时持global与目标tab occupation，所以不能把普通动作的冲突错误偷缩成单个OccupationId；达到上限时显式`truncated=true`并逐批release。没有该schema declaration/mapping的命令不能active，不能临时返回自由形状details。

regular Key创建或更新另一个regular Key时，每个新增permission atom必须同时属于当前resolved artifact的`status=active`集合，并在调用Key上逐atom求值为true；删除atom、缩短权限或revoke不要求调用者拥有被删atom。Root使该集合中的全部atom自然为true，因此可以授予它们；pending/retired/unknown ID只能保留为不可用历史显示，不能新增。单调表达式保证所有active Key command在Root向量下为true，但Root仍不能制造未声明atom、命令、目标或平台能力。`keys.create.regular`不能借此授予调用者原本为false的`keys.create.root`后再绕出Root。

扩展管理页的恢复方法同样登记，但固定`boundary=extension_admin, auth=trusted_extension_context, idempotencyKind=admin_mutation_id`，只接受本扩展预登记admin port。它复用Key/settings/control pure transition，却不是relay可调用的无Key命令；受信admin页为每个用户手势生成的AdminMutationId只用于该平面的durable dedupe，不进入Agent协议、Key队列或occupation主体。

每个active command还必须显式登记`controlPolicy`：`none`、`global_only`、`target_tab`、`target_tabs`或`all_occupations`。当前已闭合候选为：Key/settings/operation/artifact metadata以及纯browser/page observation是`none`；可能产生服务器副作用的extension-origin `resource.fetch`是`global_only`；已有单一TabRef/DocumentRef的navigate/DOM/JS effect是`target_tab`；`tabs.activate`覆盖目标与fresh precheck观察到的同window当前active两个TabRef。撤回把`tabs.create`与`tabs.close`统一写成`all_occupations`的旧建议：它会让无关tab上的foreign occupation阻断本可独立的动作。两者在P6前必须先闭合目标window身份和active/inactive副作用，优先拆成固定语义method或要求显式anchor/expected-active refs；不能在handler里根据参数临时换policy，也不能靠Chrome的“当前窗口”、`active=true`默认或关闭active tab后的隐式successor选择改变合同。若尚未得到精确policy，命令保持pending，而不是用`all_occupations`掩盖缺失模型。纯读取仍要复核目标与host能力，但occupation在v1不是披露/读锁；若实测或用户裁定要求读隔离，应作为显式policy变更而非隐藏推导。不得由method名字、permission、queueClass或参数分支暗中推导control policy。

## 4. 当前DOM、网络响应与JS的准确含义

- `page.dom.get`读取调用时的live DOM序列化及显式请求的可观察属性，不是服务器原HTML，也不保证包含虚拟列表尚未materialize、closed shadow root、浏览器UI、无host grant frame或受限scheme内容。它是有界 preview，不冒充完整树。
- 现行 `page.tree.open/expand/view.get` 以精确 DocumentRef 为边界，把 Document/doctype/元素/全部 attributes/live form properties/文本/注释/CDATA/processing instruction/open ShadowRoot 编入唯一惰性树。同一文档重复 open 复用 rootRef；expand 只写调用 Key 的展开集合；view GET 不产生展开。长值显式展开为有序 `value_chunk`，sibling range 与 subtree 使用 canonical indexPath。导航/文档替换后旧 TreeRef 返回 `TARGET_REF_STALE`。closed ShadowRoot、内部 AX 树和未挂载数据在 limitations 中明确不可观察。
- `page.archive.capture`是普通扩展权限路线中“取得网页文件”的独立能力。[Chrome Page Capture](https://developer.chrome.com/docs/extensions/reference/api/pageCapture)把指定tab当前内容及其资源封装成MHTML，并要求manifest `pageCapture` permission。它不证明字节等于最初导航response、资源未被页面修改、所有网络历史均被保留，或MHTML能被当作安全可执行内容直接打开。
- 命令必须带OperationId和完整TabRef。accepted时先冻结`maximumResultBytes`并取得同额Artifact逻辑reservation，fresh precheck后只调用一次API；API返回`undefined`、抛错、target已失效或Blob超限均按已到达phase结算，绝不暗中refresh、重导航或重试capture。Chrome API会先返回一份完整`Blob`，调用前无法知道其最终大小，也无法由扩展阻止Chromium内部的临时内存/磁盘峰值；逻辑reservation只防本系统存储超卖，不是浏览器物理预分配。返回后先检查`Blob.size`，合格时用固定大小`Blob.slice(...).arrayBuffer()`或等价bounded reader逐块写`staging_open`，绝不对整份Blob调用`arrayBuffer()`、转base64或塞进JSON。每个extension-owned chunk/copy仍计入handler/artifact内存预算；Blob及浏览器提供chunk的内部副本明确列为availability边界。
- receipt记录capture开始/结束时实际观察到的TabRef/DocumentRef/URL与target/host-grant revision、API是否返回Blob、最终MHTML字节数/digest和ArtifactRef。URL或document generation未变也不能证明DOM、样式、图片、子资源或页面脚本在capture期间静止，因此稳定性字段固定使用闭合枚举，例如`contentStability="not_proven"`，另列`observedTargetChanged=true|false`；禁止用`possiblyChangedDuringCapture=false`表达没有能力证明的结论。该API不改变页面，v1 `controlPolicy=none`；调用方可另行占据tab来阻止其他Key的新派发，但occupation仍不能冻结页面自身。artifact写入使命令继续走normal operation/fence/receipt，而不是无ledger short-read。
- `resource.fetch`在扩展origin调用时新发网络请求；返回来源URL、重定向、时间、content type、截断、发起origin/backend与credentials/cache/partition限制，不能称为导航时原始响应，也不能承诺与页面自身`fetch`、导航cookie或网络分区完全一致。确需页面origin语义时由显式`js.execute`完成，或以后登记独立page-context命令。
- `network.response.get`只有在某个显式capture/debug backend已经记录该response时才存在；没有捕获就返回capability/not-found，不暗中重导航或重请求。
- `js.execute`与上述权限并列。脚本可以自行DOM操作或fetch，这是授予JS本身的含义；不静态分析代码，也不继承其他接口的deny。
- 默认world是USER_SCRIPT；MAIN必须显式。MAIN结果视为页面可影响数据，可以作为标注`untrusted_page_value`的receipt/artifact payload，但不能决定Key鉴权、operation phase/effect evidence、dispatch token或admin事实。userScripts messaging保持关闭。
- arbitrary code由固定wrapper执行；wrapper在返回Chrome API前把结果限制为闭合JSON-compatible值并按结果预算截断/拒绝，避免把明显超大字符串/对象直接跨context复制。Chromium仍可能在页面world执行和构造对象时分配内存，扩展不能作零allocation保证。
- `effectTimeoutMs`只能让ledger在deadline后结算uncertain，不能抢占一个同步死循环、已经注册的timer/listener或仍在运行的Promise；MAIN/USER_SCRIPT脚本可能长期阻塞renderer。receipt/status必须如实报告，不能把timeout写成脚本已终止。
- 固定DOM动作与bridge优先用包内代码和Chrome返回通道；页面`postMessage`不得成为通用method dispatcher或完成receipt权威。
- `page.dom.get/dom.query/describe`是纯read：目标document没有已验证静态bridge时返回typed capability/target错误，绝不在read内调用`chrome.scripting.executeScript`、刷新页面或自动导航。未来补bridge只能作为独立effectful命令登记，不能因“注入通常幂等”绕过OperationId/fence。
- `dom.query`允许的唯一内部可见投影是content realm的NodeRef interning。相同node/realm在TTL内返回同一ref且不续期；新refs同时受per-realm slot和background全局NodeRef lease约束，query投递前按最坏新增数reserve，content在同一同步turn整批提交并回报actual reuse/new，失败不留半批，Port/realm失效归还整realm额度。选择器匹配优先在`maximum_traversal_nodes`限制的显式迭代遍历中逐元素调用`matches`，禁止用`querySelectorAll`先物化任意大的静态NodeList再只取前N个；selector engine本身不可抢占的renderer成本需在receipt/capability边界说明。它不写durable business ledger、不改变DOM，也不能按Key建立不同slot副本；否则read重试会变成容量消耗操作。
- `dom.click/fill/select/...`是扩展content/page能力，不冒充浏览器级真实输入：脚本触发事件通常`isTrusted=false`，不能操作Chrome自身UI、消除文件选择器/用户手势要求或保证网站框架接受。typed receipt只说明DOM adapter观察到什么；需要更高层输入语义时只能显式选择debug backend并接受Chrome确认。
- 主build profile在安装/启用阶段声明广泛required host access；Agent/Root command永不调用`permissions.request`、借`activeTab`或隐藏打开UI取得临时授权。file URL、incognito、用户撤权和受限scheme仍由Chrome决定。
- `permissions.onAdded/onRemoved`推进host-grant revision；撤权使相关queued plan、DocumentRef/NodeRef、pending bridge与capability cache失效。Chrome已接受的调用仍按receipt/unknown结算。
- `js.execute`在每次dispatch前探测`userScripts.execute`方法、Allow User Scripts开关、目标host/frame/world；任一缺失返回`CAPABILITY_UNAVAILABLE`或`INTERACTION_REQUIRED`，不自动切debugger。
- chromium-full-v1当前只承诺普通profile；incognito target在Capability/Platform Registry中保持unavailable，直到spanning/split分别验证Key realm、IndexedDB、RuntimeEpoch、relay socket与host grant。file URL也只有用户开启对应Chrome开关并通过target probe才可用。

## 5. intent与冻结plan

第一次接受前计算两个不同摘要：

`intentDigest`包含由`method + schemaVersion`唯一解析的stableCommandId、command schema version、显式提供的params和明确的absent/null/default marker；使用registry定义的canonical encoding。它排除auth、Key secret、client/relay request ID、targetInstance、accepted order和当前可变默认。

完成strict params canonicalization后，扩展在当前realm对重复`(AuthorityRealmGeneration, authenticated KeyId, OperationId)`必须在对absent ID做age/reject-before准入前先查record并比较intentDigest；wire仍只携bearer Key与OperationId，不增加realm/KeyId字段：

- 相同：join pending reservation或返回原operation状态；即使ID时间段已越过新接收窗口、当前默认/设置已经变化，也在该record冻结的dedupeUntil内不重解析成新effect。
- 不同：`IDENTITY_CONFLICT`，不泄露原params，不产生第二effect。

首次接受再形成`ResolvedPlan`及`resolvedPlanDigest`，至少冻结：

```text
canonical command + explicit params + resolved defaults
TabRef/DocumentRef（含active-incarnation generation）/NodeRef/OccupationId generations
Key authorizationRevision and required permission expression
relevant runtime facts revision/digest
runtime capability/host-grant revision and selected backend
command/receipt schema versions
resolvedBuildArtifactDigest  # current extension component
```

accepted后不按新默认重建plan。Key的`authorizationRevision`必须与accepted plan完全相同；任何permission/enabled/expiry authz mutation都让旧queued plan terminal KnownNoEffect，即使后来恢复相同值，防止disable/re-enable或remove/add在runner检查前“穿过去”。displayName和secret rotation不推进该revision。其他dependency使用各自声明的精确规则：target generation必须相同，相关runtime/capability/control事实若revision变化则按冻结plan重新判定，仍满足才可继续。要尝试新授权/新plan必须使用新OperationId。

时间也分层：transport response deadline只停止本次client等待，不改operation；可选`dispatchDeadlineAt`属于command intent，若到fence前已过则`TIMEOUT/KnownNoEffect`；`effectTimeoutMs`的**duration与policy**在接受时冻结，写fence时再计算`effectDeadlineAt`，过期后按adapter证据completed/canceled或`EFFECT_UNCERTAIN`。result/artifact retention同样冻结duration/policy，却从terminal/commit时刻计算绝对期限，不能让排队较久的operation一完成就把正文判过期。worker/设备休眠期间不能准点计时，恢复时发现overdue立即结算；绝不把延迟包装成墙钟SLA或自动重做。

Canonical规则必须有golden vectors：未知/重复字段拒绝；schema内整数限制在明确范围，u64等超出JS安全整数的值用规范十进制字符串；float只允许有限值并把`-0`规范为`0`；对象键按UTF-8字节序；JSON escape先解码为Unicode scalar，拒绝孤立surrogate且不做会改变脚本/selector的NFC折叠；null/absent、显式default与省略default各有presence marker。省略与显式default可以有不同intent，但解析成相同resolved plan；这是有意区分“调用者说了什么”和“系统最终接受了什么”。

## 6. durable operation状态机

只有完成一次bounded credential验证的请求才能进入admission；无效/未知Key不能靠伪造KeyId占RAM reservation。认证可并发，在取得候选Key snapshot后，请求进入单一JS coordinator并在**admission的首个await前**同步建立per-Key RAM reservation；durable transaction仍重读credential/authorization revision，关闭验证到接受之间的轮换/revoke竞态。同identity并发请求只能join。下一条同Key普通operation不得开始durable admission，直到前一条accepted record已提交。这里的先后是coordinator建立reservation并durable commit的顺序：WebSocket只保证单socket帧交付顺序，多个socket的到达没有全局时标，并发auth完成也可能重排，所以系统不承诺“最早写入网络的OperationId先执行”。调用方需要A→B因果时先取得A的durable accepted/terminal事实再发送B。每条记录自包含ownerKeyId、OperationId、intent/resolved digests、完整ResolvedPlan、runtime epoch、queueClass、phaseVersion和receipt schema；只有normal lane另带`normalSequence={ExtensionRuntimeEpoch,perKeyCounter}`，short lane不借该序号伪造执行顺序。

normal sequence还约束dispatch，不只约束accept：runner只有在所有较小sequence已经terminal后才允许当前项进入fresh precheck/fence。adapter deadline到期后，fenced项必须进入`EFFECT_UNCERTAIN`或有证据的terminal状态再释放FIFO；不能因页面Promise、content reply或网络永不返回而永久堵住同Key。short lane仍可显式超越normal lane，因此调用方不能用socket帧顺序推断二者先后。

`CANCEL_REQUESTED`只是fenced operation上的非terminal标记，不自行释放normal FIFO；adapter证明停止/完成时写对应terminal receipt，否则冻结deadline到达后转为`EFFECT_UNCERTAIN`再放行后序。cancel命令自己的short-mutation receipt可以先完成，这不等于target operation已停止。

```text
ABSENT
  -> RESERVED_IN_MEMORY
  -> COMPLETED_INTERNAL_MUTATION(receipt, one strict transaction)
   | ACCEPTED_QUEUED (durable, KnownNoEffect)
       -> FAILED_KNOWN_NO_EFFECT(durable)
        | CANCELED_KNOWN_NO_EFFECT(durable)
        | DISPATCH_FENCED (durable, browser/page/network EffectMayHaveOccurred)
            -> CANCEL_REQUESTED (durable nonterminal marker; adapter may continue)
                 -> COMPLETED | TERMINAL_ERROR | EFFECT_UNCERTAIN
             | COMPLETED(receipt, durable)
             | TERMINAL_ERROR(typed receipt + evidence, durable)
             | EFFECT_UNCERTAIN(durable scheduling-terminal; late evidence may refine ledger only)
```

强制顺序：

1. accepted record durable后才ACK并让runner可见。
2. authority gate内复核Key/control/target/revisions。
3. dispatch fence成功durable后，在同一authority continuation、任何新的await前同步调用browser/content adapter并释放gate。fence写失败则绝不调用。
4. adapter返回后把phase + typed receipt作为同一版本化operation record提交。
5. completed record durable后才能发送completed或让`operations.get`看到。

AuthorityCoordinator在dispatch fence transition中生成高熵DispatchToken，并把`AuthorityRealmGeneration`、token、operation identity、phaseVersion、target generation和`lateReceiptUntil`一起冻结。token只存在于后台operation record和本次adapter闭包，绝不发给content/page、relay或Agent。content adapter使用另一个仅作路由的`contentRequestId`；后台pending表把exact bridge port + contentRequestId映射到对应DispatchToken。content只回传route ID与typed result，后台命中当前pending表后才用自己保存的token提交receipt。每次receipt/late-evidence transaction都必须要求current authority realm仍等于冻结realm、且该realm中的exact operation record已存在；full authority reset先线性化时，旧callback只能丢弃，不能在新realm更新、重建或创建任何record。普通RuntimeEpoch轮换不改变AuthorityRealmGeneration；只有仍处于**同一live后台执行、且exact adapter continuation/pending映射尚在**的回调，才可按下一段的late-evidence规则裁决。security clock在fence后变为untrusted不阻止这种匹配回调提交phase/receipt：transition使用最后一个合法security floor作为非递减记录时间并显式标记clock quality，不读取坏wall value、不推进expiry/deadline/GC。仍在同worker中的单调adapter timer可以结算；wall deadline在clock fault时暂停，不能用坏时间伪造effect结论，但这不适用于已经失去全部回执通道的旧worker fence。

fence写完但browser调用前崩溃也只能保守unknown，这是非事务浏览器effect的正确代价。v1没有可跨service-worker执行恢复的adapter receipt：bootstrap一旦发现`DISPATCH_FENCED`或`CANCEL_REQUESTED`记录，却不存在本次live执行创建的exact adapter continuation/pending映射，就在`authorityReady`前立即以strict transition推进为`EFFECT_UNCERTAIN/EffectMayHaveOccurred`，递增phaseVersion、擦除已不可使用的DispatchToken与敏感ResolvedPlan，并把关联`staging_open`转为`orphaned`；不能再等待wall deadline，更不能因`CLOCK_UNTRUSTED`把该Key FIFO永久卡住。旧content reply只能丢弃，不能根据OperationId自行恢复route。只有将来某个command显式登记并证明了durable external reconciliation，才能拥有另一种恢复策略；v1 generic adapter一律没有。

`EFFECT_UNCERTAIN`对normal FIFO和当前response route都是terminal，后序可继续。若timeout是在同一live后台执行内发生，且exact callback/pending映射仍存在，uncertain record额外保留`dispatchPhaseVersion`与当前`uncertainPhaseVersion`，并在`lateReceiptUntil`前只允许**ledger证据收窄**而不重新调度：late callback必须命中相同DispatchToken、operation identity、冻结的dispatchPhaseVersion、target generation，transaction再CAS当前record仍是该uncertainPhaseVersion且未越过窗口，才可用更高phaseVersion把uncertain改为completed或terminal-error typed receipt。不能用一句含糊的“匹配phaseVersion”把callback捕获的dispatch版本与transition后当前版本混为一值。该变化不重新占队、不撤销已经运行的后序、不触发重做，也绝不在已经收到uncertain terminal的旧transport route发送第二个terminal。worker执行丢失的bootstrap路径已经擦除token/continuation并标记`lateEvidenceAllowed=false`；窗口外、token不匹配或该标记为false都只丢弃并计脱敏诊断，永久保留uncertain最小证据。

`message.kind=error`不自动表示KnownNoEffect。JS在修改页面后throw、fetch在server收到请求后失败、DOM adapter部分执行后报错都进入`TERMINAL_ERROR/EffectMayHaveOccurred`；只有Capability Registry为具体API失败模式提供可测试的“调用未被接受”证据时，fence后error才可收窄为KnownNoEffect。异常文字不能自行决定evidence。

这里的durable指IndexedDB `readwrite` transaction显式`durability: "strict"`并收到complete；不使用Chrome 121+默认relaxed模式。它闭合worker/process/browser正常崩溃恢复，但不声称硬件断电或存储损坏绝不丢最后写入。检测到database/schema/integrity异常时command plane fail closed，绝不凭空把缺失fence当KnownNoEffect重做。

`operations.maximum_ledger_bytes`不是只在settings里展示的软值。每个accepted/phase/terminal record都用生成的canonical sizer计算正文与固定index overhead；单record先过build maximum，domain usage再在写record的同一strict transaction按`newBytes-oldBytes` checked更新。accepted容量不足在建record/effect前`LIMIT_EXCEEDED/KnownNoEffect`；terminal压缩只有commit后才释放差额，transaction abort不动账。该账本跨AuthorityRealmGeneration：full reset后的旧record在物理GC前仍占`retiredLedgerBytes`，不能靠轮换realm重新获得整套ledger容量。logical bytes不冒充IndexedDB实际磁盘页/WAL/压缩大小，平台quota仍可更早失败。

result body可以提前过期，但identity tombstone必须保留到该record的`dedupeUntil`。GC的`operationRejectBeforeMs`只能推进到连续安全前沿：不得跨过任何尚未越过自身冻结dedupeUntil的旧record。它在一个strict transaction中推进前沿并删除此前已到期tombstone；时钟回拨不得降低前沿。窗口外请求固定`OPERATION_ID_OUT_OF_WINDOW/KnownNoEffect`，versioned detail包含`reason=past|future`和当前最小/最大可接受timestamp。收到确定business error后调用方必须burn该ID并创建新ID；`past`由单调前沿持续拒绝，`future`在不建拒绝tombstone时只保证本次无effect，不能伪称服务器会永久记住任意future ID。DeliveryUnknown仍按同一逻辑operation重发原ID，不自动换ID。quota无法保证完整窗口时，在durable acceptance前`LIMIT_EXCEEDED/KnownNoEffect`，不能先effect再清tombstone。

完整ResolvedPlan只在nonterminal期间保留执行/恢复所需payload。进入terminal的同一strict receipt transaction必须把JS源码、表单值、请求body/header等敏感执行payload压缩掉，只保留identity、intent/resolved digest、stable command/schema、最小target摘要、effect evidence、receipt与dedupe/result时限。只有**同一live后台执行仍持有exact continuation**的timeout-uncertain record，才可在`lateReceiptUntil`前额外保留验证late callback所需的DispatchToken、dispatch/current phase、target generation与`lateEvidenceAllowed=true`；窗口结束立即擦除。bootstrap发现worker执行已丢失时在转uncertain的同一事务清token并写`lateEvidenceAllowed=false`，不能被这条一般留存规则重新保留；completed记录也立即擦除token。查询旧operation不重新加载或解释已删除payload；crash不能留下“terminal但长期保存完整secret-like params”的正常路径。

Command schema为字段声明diagnostic sensitivity；auth/Key secret、Authorization/Cookie类header、DOM fill值、JS源码、request body和页面正文默认不进入日志/error/trace。诊断只保留长度、稳定字段名和typed omission；低熵正文的普通hash同样可能被离线枚举，因此内部`intentDigest/resolvedPlanDigest`不进入日志、error、trace或通用诊断。不能因调用方没标`sensitive=true`就记录值。receipt若业务上必须返回页面/网络正文，按owner-bound result/artifact规则披露，不复制进通用diagnostic。

### 扩展内部mutation的原子提交

Key/settings/control/artifact/cancel等只改变扩展内部事实，不调用浏览器。authority gate在一个覆盖`operations`与相关domain object store的strict transaction中完成：验证duplicate/expected revision → 写domain事实 → 写同OperationId completed receipt → commit。transaction abort表示两边都未提交、KnownNoEffect；worker终止不会留下“occupation已变但receipt没写”的裂缝。

`artifacts.release`的domain事实是小型metadata状态切换：与completed receipt同事务把artifact标为`released_tombstone`，使所有chunks立即不可读；大批物理chunk由之后的有界GC删除并保持容量记账，不能在short authority lane同步遍历删除全部body。

`keys.create/rotate`在同一transaction写Key record/verifier和不含secret的receipt；明文只留在当前内存response。并发同identity joiner中，commit前按首次join顺序选一个仍存活的exact response route作为一次性recipient；最多该route收到secret，其他route只收到无secret结果。选中route发送失败后不转交、不重发。response丢失时ledger已有completed但只能返回`SECRET_NOT_RECOVERABLE`，绝不从verifier恢复或重生成。ControlState带ExtensionRuntimeEpoch，新runtime忽略旧占据；ArtifactId属于持久authority realm，普通browser restart后在留存期内仍可读取。

该事务路径不能用于tabs/DOM/JS/network/debug；那些非事务browser effect仍必须走accepted→dispatch fence→adapter→receipt，fence后未知绝不补做。

`operations.get`只在hydration完成后读取durable version或与其phaseVersion一致的cache，返回stable command/schema、queueClass、normalSequence（如有）、effectEvidence、receipt schema/version与当前phase。`intentDigest/resolvedPlanDigest`只作extension内部dedupe/plan完整性字段，不向owner或`.any`查询者、日志或relay披露；重复请求只得到“same intent / identity conflict”的typed结论，不得到可离线枚举敏感参数的内容hash。旧build退役command后仍靠稳定operation envelope、自描述receipt和保留至最长dedupe窗口的只读decoder查询，不调用旧effect handler重新解释；目标实例返回`OPERATION_NOT_FOUND`不等同KnownNotDelivered，也不证明其他实例没有该ledger。

## 7. cancel语义

`operations.cancel`是short-mutation，自己的OperationId与`params.targetOperationId`分开。默认owner-only；跨Key要求`targetKeyId`和显式`operations.cancel.any`。

cancel命令自己的OperationId必须与同一Key命名空间中的targetOperationId不同；相同值会让“正在创建的cancel record”同时成为被取消对象，形成自指CAS。schema/admission在任何record或domain mutation前固定拒绝为`SCHEMA_INVALID/KnownNoEffect`，不能靠执行顺序临时解释。

| target阶段 | cancel结果 |
|---|---|
| 不存在/无owner披露权限 | OPERATION_NOT_FOUND；不为未来ID创建cancel tombstone |
| accepted/queued，runner未赢得dispatch | CAS为CANCELED_KNOWN_NO_EFFECT |
| dispatch竞争中 | cancel与dispatch由authority gate/phaseVersion决定唯一winner |
| DISPATCH_FENCED已durable（无论实际调用是否来得及发生） | CANCEL_REQUESTED/EffectMayHaveOccurred；可best-effort abort，但不证明effect停止 |
| completed/failed/uncertain/canceled | 幂等返回当前状态，不重开 |

deadline、relay断线、client退出都不隐式cancel。页面中已注册timer/listener/network不能被扩展承诺完全终止。

“不存在时不建target cancel tombstone”意味着cancel不是未来operation的预约阻断：调用方只有在看到target的durable accepted/phase或查询到现存record后，才能把cancel成功解释为对该operation生效。若原调用仍只是DeliveryUnknown，自动策略是用同一正确实例和同一OperationId查询/重投以取得事实，不能先对absent ID cancel后假定一条仍在认证/传输中的旧frame不会随后被接受。cancel命令自己的OperationId仍按正常internal mutation合同写durable terminal receipt；表中的“不建tombstone”只指`targetOperationId`。

## 8. 大结果与artifact物化

transport frame上限、inline结果上限和各功能采集上限是三件事，必须有机械关系检查：`resource.maximum_response_bytes`等采集上限可以大于单frame，但超过inline阈值的body不能硬塞进JSON response。

- `resource.fetch`、`js.execute`及未来截图/下载等已经是operation的命令，可把大body写入owner-bound Artifact。大body先以绑定`operation identity + phaseVersion + ArtifactId + ArtifactStagingToken`的**不可见`staging_open` chunks**写入有界strict transactions；ArtifactStagingToken是内部物化generation，不复用只留后台的DispatchToken。chunk key包含token，每批事务同时打开metadata/chunks：先CAS metadata仍为同一`staging_open` generation、operation/phase仍可接收结果且未越过冻结`writeUntil`，再要求该`chunkIndex`尚不存在后写bytes，并在同事务追加其length/digest到有界manifest。同index重投只有在length/digest/bytes全相同时是no-op，任何不同内容固定拒绝；不跨browser await。这使已验证chunk在final commit前不可被同token旧回调原地改写。全部chunk与digest验证后，最后一个小型strict transaction同时触发operations/metadata/chunks accounting，要求operation仍允许该phase的late result且当前token/manifest的count/bytes/root digest精确匹配，再写`metadata.state=committed`、冻结read generation、operation terminal receipt/引用并把reservation转换为actual bytes。由于chunk writer、terminal close和final commit都触发同一metadata store并以operation phaseVersion作CAS，writer若先赢会改变manifest使commit重读，commit/close若先赢则后来writer看到非`staging_open`并失败。reader只承认committed metadata并逐chunk验证冻结的length/digest，因此不能出现receipt指向不完整artifact，也不能让迟到chunk覆盖正文。不得换新ArtifactId自动重做browser effect。
- operation进入不再接受late result的terminal、cancel/pre-fence失败，或`lateReceiptUntil`到期时，必须在同一strict transaction把关联metadata从`staging_open`改为`orphaned`、关闭写权并把reservation转换为orphan accounting；不能只改operation record后让迟到writer继续扩张孤儿正文。允许late receipt的uncertain状态可以暂时保持`staging_open`，但每次write/final commit都检查冻结期限，过期即拒绝并由sweeper执行同一close transition。GC只删除`orphaned` chunks；崩溃后由operation/metadata共同状态恢复，绝不把孤儿重新解释为committed。
- 可能物化大结果的ResolvedPlan冻结`maximumResultBytes`；accepted transaction在meta/operation中同时取得逻辑`reservedResultBytes`，与所有Key的pending reservation和现有committed/staging_open/orphaned总量比较。final commit transaction把reservation原子转换为committed artifact bytes；尚未写staging的cancel/pre-fence failure可直接释放。已经存在staging的失败必须在关写事务中把metadata转为orphaned并把额度转换为`orphanStagingBytes`，直到GC删除对应chunks后同事务释放，不能先减账后慢慢删物理数据。支持late result的uncertain记录保留reservation/staging额度到`lateReceiptUntil`；没有reservation就不得fence。它防止本系统并发超卖，但不是物理磁盘预分配，IDB/quota仍可能在effect后失败并导致uncertain。
- Artifact usage同样属于storage domain而非current authority realm。full reset使旧ArtifactRef立即不可读，但旧committed/staging/orphan/chunks在每批物理GC完成前转为`retiredArtifactBytes`并继续占`artifacts.maximum_total_bytes`与aggregate storage budget；不能因逻辑不可见就先返还。新realm仍可完成最小Root恢复，但大artifact reservation可能要等旧GC释放，这是有意的bounded storage语义。
- response只内联小结果；大结果返回ArtifactRef、media type、总字节数、content digest、truncated标记和留存期限。`artifacts.read`接受显式offset/length，单次chunk必须小于protocol frame预算；不允许一次read再次生成超大frame。
- `page.dom.get`在v1仍是无OperationId的live read，因此只能返回有界inline结果和明确truncated/coverage事实，不能暗中创建durable artifact。若需要一致的大DOM捕获，未来必须登记单独的artifact-producing operation，而不是让同一read根据大小偷偷改变effectKind。
- terminal operation receipt可比artifact正文留存更久；artifact metadata/tombstone至少保留到所有引用它的operation `resultRetentionUntil`，让调用方区分never existed与body expired。没有slot generation；过期不授权重新执行原effect。receipt正文也过期且无其他引用后才可删除artifact tombstone。

## 9. 结果、错误与披露

Error Registry只登记extension command pipeline的`producerSurface = extension | storage | platform`、公开code、retry条件、secret redaction与effectEvidence。client-local/relay错误属于版本化transport profile固定常量，不进入四registry，也不允许伪装成extension `message.kind=error`。transport delivery evidence和business effect evidence分开：

business `message.kind=error`的公共identity固定同时包含`errorId`字符串与Error Registry的numeric `code`，并要求该pair精确匹配当前/retained decoder；unknown或mismatched pair是schema/protocol failure，不能任选其一解释。numeric code退役不复用，errorId用于人读与生成client；command-specific `details`另有闭合schema。transport外层错误只使用其profile自己的`transportError.errorId`，没有business numeric code，避免两个命名空间同字段异义。

`SCHEMA_INVALID/KnownNoEffect`只覆盖incoming request在admission前的严格解析与params校验。任何effect fence后的adapter value、result、receipt或outgoing message不合法，都必须保留当前phase证据并使用`INTERNAL_ERROR`或专门登记的phase-sensitive错误；生成代码不得因为validator名字相同而复用1000号错误。

```text
delivery: KnownNotDelivered | DeliveryUnknown | Delivered
effect:   NotApplicable | KnownNoEffect | EffectMayHaveOccurred
```

本地连接失败时，skill/client只能合成`CLIENT_COMPANION_UNREACHABLE`，不能仅凭该事实断言进程根本没运行；不存在或尚未ready的relay不可能自己返回错误。固定launcher有明确失败证据时才用`CLIENT_COMPANION_START_FAILED`，有界收敛期没有兼容hello时用`RELAY_STARTUP_TIMEOUT`。socket business bytes可能已写后只能DeliveryUnknown，不能声称KnownNotDelivered。

transport profile的初始固定集合是`CLIENT_COMPANION_UNREACHABLE`、`CLIENT_COMPANION_START_FAILED`、`RELAY_STARTUP_TIMEOUT`（三者仅client合成）、`TRANSPORT_PROTOCOL_MISMATCH`、`TRANSPORT_SCHEMA_INVALID`、`REQUEST_ID_IN_USE`、`TARGET_INSTANCE_REQUIRED`、`STALE_INSTANCE`、`EXTENSION_UNAVAILABLE`、`ROUTE_DELIVERY_UNKNOWN`、`WAIT_TIMEOUT`、`RELAY_STOPPING`和`TRANSPORT_LIMIT_EXCEEDED`。它们的ID/字段随transport profile版本发布，退役ID不复用，但不是Key可见业务Error。

Extension Error Registry的候选集合是`SCHEMA_INVALID`、`COMMAND_NOT_FOUND`、`LEDGER_NOT_READY`、`STORAGE_UNAVAILABLE`、`CLOCK_UNTRUSTED`、`UNAUTHENTICATED`、`KEY_DISABLED`、`KEY_EXPIRED`、`KEY_NOT_FOUND`、`FORBIDDEN`、`CONTROL_OCCUPIED`、`CONTROL_CHANGED`、`REVISION_CONFLICT`、`IDENTITY_CONFLICT`、`OPERATION_NOT_FOUND`、`OPERATION_ID_OUT_OF_WINDOW`、`RESULT_WITHHELD`、`RESULT_EXPIRED`、`ARTIFACT_NOT_FOUND`、`CAPTURE_NOT_FOUND`、`SECRET_NOT_RECOVERABLE`、`RUNTIME_CONTINUITY_LOST`、`STALE_TARGET`、`CAPABILITY_UNAVAILABLE`、`INTERACTION_REQUIRED`、`TIMEOUT`、`RESULT_UNKNOWN`、`LIMIT_EXCEEDED`和`INTERNAL_ERROR`。RuntimeEpoch可因browser restart、extension reload/update、target projection容量轮换或不可证明的session连续性改变，故不能用会谎称唯一原因的`BROWSER_RESTARTED`。只有存在真实producer的条目才激活；退役编号不复用。`INTERNAL_ERROR`也必须按当前phase带evidence，不能默认KnownNoEffect。

对象错误映射固定：relay InstanceRef generation只在transport层产生`STALE_INSTANCE`；TabRef/DocumentRef/NodeRef→extension `STALE_TARGET`；OccupationId/revision→`CONTROL_CHANGED`；不存在或不可披露operation→`OPERATION_NOT_FOUND`；窗口外OperationId→`OPERATION_ID_OUT_OF_WINDOW`；已认证管理调用中的未知KeyId→`KEY_NOT_FOUND`；active但暂停的调用Key→`KEY_DISABLED`，revoked/错误secret仍是`UNAUTHENTICATED`；未知/不可披露ArtifactId→`ARTIFACT_NOT_FOUND`，已知artifact正文按政策过期/释放→`RESULT_EXPIRED`；显式capture backend从未记录目标response→`CAPTURE_NOT_FOUND`。不得用一个泛化`STALE_TARGET`或`INTERNAL_ERROR`覆盖不同对象。

operation、receipt和artifact默认owner-only。目标owner是调用Key时，权限分支接受对应`anyOf(.own, .any)`且targetKeyId可省略/必须等于自己；foreign owner必须显式带targetKeyId并逐次要求`.any`。foreign owner与不存在对无`.any`调用者返回相同公开结果，不泄露phase、digest、displayName或是否存在。

`RESULT_UNKNOWN`/EffectMayHaveOccurred的唯一安全自动动作是用同一正确realm查询同一OperationId；系统和skill都不自动创建新ID重试。操作者可以在理解可能重复effect后显式提交新的OperationId，但那是新的业务动作，不是旧operation恢复，receipt必须保留关联说明而不能声称exactly-once。

## 10. 不隐藏的行为

read/status、codec、cache、object allocation、transport reconnect和`control.acquire`不得暗中启动relay、请求Chrome权限、激活tab、连接debugger、切backend、release别人、刷新页面、重发operation或关闭其他owner。每个fallback若未来存在，必须是显式command或显式parameter并由Capability Registry登记。
