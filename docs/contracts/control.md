# 每 Key 队列与 occupation 合同 v0.8

> 状态：本文件保留被暂停的完整 Operation/OccupationId 模型作为历史设计资产。当前 active occupation 以[浏览器核心能力纵切](../implementation/core-browser-slice.md)和[裁定记录](../decisions.md)为准：只有 acquire/release、无 OccupationId/lease/own-any/隐式 takeover，状态位于当前浏览器 session。

日期：2026-08-29。occupation用于可信合作者避免脏状态；它不是敌对租户隔离、页面事务、连接lease或浏览器context隔离。

它只门控**本扩展经Key dispatcher派发的受控命令**；浏览器用户、页面自身脚本、服务器推送、其他扩展和Chromium UI仍可改变tab。任何receipt都不能把occupation描述为浏览器被锁住。

## 1. 主体与范围

- 唯一主体是扩展鉴权后的KeyId。Agent、进程、socket、InstanceRef和调用来源不参与队列或occupation。
- `scope=tab`绑定完整TabRef；`scope=global`覆盖当前ExtensionRuntimeEpoch中的全部可控制tab。
- 无occupation时允许普通动作直接执行，不强制先acquire。
- 同Key可以同时拥有global和若干tab occupation。释放global不清同Key独立tab occupation；反之亦然。
- tab导航保留tab occupation但使旧DocumentRef/NodeRef失效；tab关闭清理对应occupation。
- `tabs.onReplaced`或target registry无法证明连续性时旧TabRef occupation失效；不会把旧锁迁移到新tab ID。
- 浏览器重启/reload产生新ExtensionRuntimeEpoch，全部occupation失效。

OccupationId的结构、generation和owner见[中心合同](authority-and-refs.md)。

## 2. 冲突谓词

对Key K、目标tab T的普通受控动作：

```text
conflict =
  存在 owner != K 的有效 global occupation
  或存在 owner != K 且 target == T 的有效 tab occupation
```

global acquire要求不存在任何其他Key的有效global/tab occupation；tab acquire要求不存在其他Key的global或同tab occupation。同Key已有同scope/target时幂等返回原OccupationId，不新建generation。

失效Key的occupation永远不构成conflict。判断器每次检查owner Key当前status/enabled/expiry，以及ControlState record内部冻结的`ownerControlEligibilityRevision`是否仍等于当前revision；任一不满足就立即当作空闲。该内部revision不向调用方披露；不相等是永久generation失效，后续恢复相同control permission也不会复活旧占据，因此storage清理崩溃不会留下脏锁或“先失效后复活”。无关permission、secret rotation和displayName不推进该窄revision，不影响occupation。清理若不在当前strict transaction内原子覆盖，就必须冻结完整OccupationId + eligibility revision并compare-and-clear；按scope盲删会让迟到sweeper误伤后来更高generation的新owner，固定禁止。

## 3. 两条命令

v1对Agent只提供`control.acquire`与`control.release`。不提供`control.status`：同Key重复acquire返回现有OccupationId，其他Key冲突返回有界`conflicts[]`中的当前OccupationId，已经足够完成“观察→逐个独立release→独立acquire”。扩展admin UI可通过自己的受信恢复面观察ControlState，但不会把该入口变成无Key Agent命令。

### `control.acquire`

short-mutation，必须有自己的OperationId。空闲时建立新occupation；同Key重复请求幂等返回现有ID；成功receipt同时返回目标上在该occupation线性化前已经fenced的in-flight/uncertain计数，只有另有`operations.read.own/any`时才附对应ID/摘要，明确“已占据”不等于“页面已静止”。其他Key冲突时，完整business error envelope由Error Registry提供`errorId + numeric code + effectEvidence`；尚未登记该error数值的当前planned command只冻结以下command-specific details形状：

```json
{
  "conflicts": [
    {
      "occupationId": {
        "extensionRuntimeEpoch": "Q3h5V2t8N0p4R6s9U1w7xA",
        "scope": "tab",
        "targetTabRef": {
          "extensionRuntimeEpoch": "Q3h5V2t8N0p4R6s9U1w7xA",
          "chromeTabId": 42,
          "tabGeneration": "3"
        },
        "ownerKeyId": "K4m7P2s5V8x1A3d6F9h0jQ",
        "generation": "8"
      }
    }
  ]
}
```

发生冲突时acquire只返回冲突；不得根据`force/takeover/replace`参数release，也不得由SDK/skill暗中组合。

global acquire可能同时撞上很多tab occupation。conflicts按稳定scope/TabRef顺序最多返回registry上限，并带`truncated=true`；调用方可逐项release后用**新OperationId**再次acquire取得下一批。每轮都读取当时事实，不提供公开controlRevision或隐藏snapshot/lock，也不能发送超frame响应。超过per-Key/total occupation容量的新acquire在mutation前`LIMIT_EXCEEDED/KnownNoEffect`。

### `control.release`

short-mutation，必须有自己的OperationId和完整`expectedOccupationId`。当前owner相同时权限表达式为`anyOf(control.release.own, control.release.any)`；不同owner只接受`control.release.any`。也就是`.any`确实覆盖任意owner，`.own`只是较窄授权。Root自然拥有两atom但仍走同一表达式，不走隐藏旁路。

expected ID与当前事实不完全相同时返回`CONTROL_CHANGED/KnownNoEffect`，不会清“现在占着的任何人”。成功只把该occupation清为空闲，不自动变成调用Key所有，不等待或撤销旧effect；receipt同样列出仍可能晚到的preexisting effect计数，并只在operations权限允许时披露ID/摘要。

调用者要接管时严格执行：收到conflict → 有权限则发release → 等待release durable receipt → 另发acquire。期间第三个Key成功acquire时，最后一步如实再次冲突；系统不重试、不覆盖。

## 4. 队列与短lane

一般effectful动作`QueueKey=KeyId`。每Key admission gate按coordinator建立reservation并durable acceptance的先后为normal lane分配`normalSequence={ExtensionRuntimeEpoch,perKeyCounter}`；多个socket没有可信全局“先到”时标，并发credential检查也可能完成于不同顺序，所以并发提交只保证串行、不承诺网络发送顺序。调用方需要A先于B时必须先观察A的durable accepted/terminal再发送B。`queue_counters`中的per-Key high-water与accepted operation在同一strict transaction递增/提交，counter不得回绕。下一条同Keynormal operation在上一条accepted durable前不能越过。更重要的是，normal runner只允许最小未terminal sequence进入dispatch：前序必须先成为completed、failed、canceled或effect-uncertain等terminal状态，后序才可写dispatch fence。fence后等待无上限的adapter必须由command冻结的deadline结算为terminal uncertain/canceled evidence，否则一个挂起页面脚本会永久堵塞该Key。`EFFECT_UNCERTAIN`为调度terminal但不证明外部effect停止，所以极端情况下旧effect仍会与后序重叠；这是可观测降级，不谎称实际世界严格串行。service worker恢复时从当前epoch的operation records重建严格FIFO、从high-water继续编号；即使旧tombstone已GC也不复用sequence。short lane没有normalSequence，其顺序只由authority revision和各自durable receipt证明。

每个command的typed receipt必须定义自己的完成边界：`dom.click`完成通常只证明动作适配器已调用/返回，不证明由点击触发的导航、异步任务或网络已经静止；`tabs.navigate`也不能自动等同整页业务完成。需要额外条件时调用方显式使用登记后的wait/read命令，FIFO不暗加network-idle。

不同Key有独立runner，不存在扩展侧跨Key长动作FIFO。该独立只指调度：

- K1导航可以使K2旧NodeRef失效。
- K1 MAIN脚本可以阻塞共享renderer。
- 两个Key在无occupation时操作同tab会看到真实竞态。

系统不能宣称页面状态、renderer资源或外部effect互不干扰。需要稳定排他条件的调用方必须显式acquire。

纯read/observation不分配normalSequence，可与同Key尚在运行的effect并发并观察中间状态；“同Key一般动作串行”不等于隐式read barrier。调用方需要after-action观察时必须等目标operation terminal后再发read，不能只依赖同socket发送顺序。

short lane白名单由Command Registry逐项声明：

- short-read：`system.*`、`keys.list/get`、`settings.get`、`operations.get`、`artifacts.read`。
- short-mutation：`control.acquire/release`、`keys.create/update/revoke`、`settings.update`、`operations.cancel`、`artifacts.release`。

每个mutation自身仍进入operation ledger。short lane可以故意超越同Key普通动作，因此同一socket帧顺序不产生跨lane happens-before；需要顺序时等前一个durable receipt。

一个扩展级authority mutation gate只串行有界元数据临界段和必要storage fence，不跨等待浏览器effect完成。它负责让Key mutation、occupation mutation、dispatch reservation/fence和cancel得到唯一winner。公平预算必须限制连续short work，防止buggy客户端反向饿死普通runner。

occupation权威是IndexedDB中带ExtensionRuntimeEpoch的versioned ControlState；session只有缓存。每个global/TabRef control entry即使空闲也保留generation high-water，release不得回退；u64达到上限时该entry拒绝新acquire。acquire/release在同一个strict readwrite transaction中检查expected control revision、更新ControlState并写completed operation receipt。transaction abort则两边都未提交、KnownNoEffect；新浏览器runtime忽略旧epoch ControlState。这里没有浏览器effect，也不需要补做WAL。

Command Registry必须为每个命令给出闭合`controlPolicy`，不能从method前缀猜。v1谓词固定为：

```text
none(K)             = false
global_only(K)      = 存在 owner != K 的有效 global occupation
target_tab(K, T)    = 存在 owner != K 的有效 global occupation
                      或存在 owner != K 且 target == T 的有效 tab occupation
target_tabs(K, Ts)  = 存在 owner != K 的有效 global occupation
                      或存在 owner != K 且 target ∈ Ts 的有效 tab occupation
all_occupations(K)  = 存在任意 owner != K 的有效 global/tab occupation
```

`global_only`用于没有既有tab目标且不会间接改变某个现有tab状态的effect，如extension-origin `resource.fetch`；它不会被无关tab occupation阻塞。`tabs.activate`必须在fresh plan中解析目标tab与当时current-active TabRef并使用`target_tabs`；任一generation/active-set revision变化都在fence前失败，而不是悄悄换目标。`tabs.create`与`tabs.close`当前不再预设为`all_occupations`：前者必须先显式锚定目标window并固定active语义，后者必须先闭合active tab及隐式successor副作用；优先拆成一个method一个固定policy，未闭合就保持pending。用所有occupation粗锁会让无关tab的foreign owner阻断本可独立的动作，不能用“更保守”掩盖缺失target模型。`control.acquire(scope=global)`仍要求不存在任何其他Key的global/tab occupation，但它是用户显式请求全局占据的独立mutation规则。不得把`all_occupations`偷塞进`global_only`或从method名推导。v1 occupation不是读锁，纯DOM/tab observation不受占据阻塞但仍逐次鉴权；若以后要读隔离，必须显式改registry policy和测试。任何命令缺少策略都不能active。

## 5. 派发线性化

普通动作到队头后，在authority gate内检查：

```text
operation phase == ACCEPTED_QUEUED
Key仍有效且permission仍满足
ResolvedPlan依赖revision仍有效
TabRef/DocumentRef/NodeRef generation仍有效
expected control revision/occupation条件仍满足
browser capability/host grant在可观测范围仍满足
```

失败就在同一operation record持久化`FAILED_KNOWN_NO_EFFECT`。通过则先持久化`DISPATCH_FENCED`，成功后在同一continuation、任何新await前同步调用browser/content adapter。release/revoke在fence前赢就阻止effect；fence先赢则effect可能继续。

occupation因此是admission gate，不是持续排他证明。acquire/release receipt必须报告目标上已知的preexisting fenced/uncertain计数；release成功后，旧owner已经fenced的effect可以晚到并与新owner动作重叠，不能写成已停止。当前方案不引入draining/wait-for-quiescence，因为那会改变已定的简单两指令语义。

## 6. cancel、deadline与失效

- `operations.cancel`和dispatch竞争phaseVersion。queued时cancel可KnownNoEffect；fence后只能cancel_requested/best-effort，不能保证外部effect停止。
- caller/relay断线、deadline到期或软件退出都不隐式cancel扩展已接受operation。
- Key到期/禁用/revoke：未派发operation失败；occupation在判定上立即失效；已fenced operation保留receipt/unknown。
- target导航/关闭或host permission撤销：未派发KnownNoEffect，旧ref/bridge generation失效；Chrome已接受的调用不声称回滚。
- browser restart、extension reload/update、target/session连续性丢失或marker容量触发轮换：新RuntimeEpoch；旧queued`RUNTIME_CONTINUITY_LOST/KnownNoEffect`，旧fenced无receipt进入`EFFECT_UNCERTAIN`并对外`RESULT_UNKNOWN`，completed receipt保留。仅同一live后台执行内主动轮换且原exact callback仍存在时可收窄旧ledger；worker执行已经丢失就立即擦除token，不等待deadline、不重新占队或重放。

## 7. 最小状态向量

| 当前事实 | 请求 | 必须结果 |
|---|---|---|
| 空闲T | A动作 | A的FIFO正常派发，不隐式占据 |
| A占据T | B动作/acquire T | CONTROL_OCCUPIED，返回有界`conflicts[]`；若A同时有global与T occupation，两项都返回 |
| A占据T | B动作U | 不受T occupation影响 |
| A global | B任意受控动作/acquire | 冲突 |
| A tab T | B acquire global | 冲突；逐项release后才能另发acquire |
| A占据T | 有`release.any`的B release exact ID | T空闲，不变成B所有 |
| B release后C先acquire | B acquire | 再次冲突，不重试/替换 |
| A重复acquire同目标 | A acquire | 返回原OccupationId |
| 迟到旧OccupationId | release | CONTROL_CHANGED/KnownNoEffect |
| owner Key失效但残留record | B acquire | 残留不构成冲突并被清理 |
| 旧effect已fenced后release | 新owner acquire/action | 允许，但报告旧in-flight/unknown；不承诺隔离 |
| Root直接acquire别人占据 | acquire | 与普通Key相同冲突；必须另发release |

## 8. 验收门

必须用确定性scheduler覆盖：同Key多socket并发admission；same/different operation intent；release/acquire/第三Key交错；revoke-before-fence与fence-before-revoke；cancel/dispatch双winner；short flood公平；导航/关闭/host撤权；worker/browser restart；旧OccupationId；两个Key共享tab的真实竞态。任何测试都不得把“不同Key调度独立”错误提升为页面effect隔离。
