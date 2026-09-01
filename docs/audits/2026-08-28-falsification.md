# v0.6 全量证伪审计与 v0.7 裁决

日期：2026-08-28。审计对象是当时 14 份 Markdown；仓库没有源码、manifest、注册表或可运行扩展。P0/P1 表示合同在实现前存在逻辑阻断，不表示已经存在可利用漏洞。

> 本文是当日审计快照；其中“尚无registry”、P0顺序和当时静态计数已由[2026-08-29全域反证](2026-08-29-owner-phase-falsification.md)取代，不再代表当前状态。

## 审计方法

本轮不把现有方案当基线证明，而把每一项非用户冻结结论都当作待推翻假设。分别审查：身份/引用、MV3 生命周期、跨文档一致性、registry/Freedom Point、operation/queue/control/restart、Key/transport/page 边界。主审再次按 owner、namespace、lifetime、linearization、effect evidence 和平台能力逐项交叉裁决。

结果：用户冻结的产品边界可保留，但 v0.6 不能直接进入副作用实现。主要错误不是“Zig 还是 TS”，而是多个编号和 owner 混用、幂等保留承诺不可实现、浏览器 effect 前没有持久栅栏、动态能力与构建事实混为一体，以及把 MV3 定时器写成墙钟保证。

## 已接受并修正

| 问题 | v0.7 裁决 |
|---|---|
| 有界 tombstone + OperationId 永久不复用 | 改为带时间与128-bit nonce的闭合OperationId；accepted identity在窗口内不提前回收。absent past ID由单调前沿持续拒绝；future拒绝若不落tombstone只能证明本次KnownNoEffect，client收到确定错误后burn |
| 时钟回拨重开旧ID窗口 | 增加单调operationRejectBeforeMs；先durable推进水位再GC，时钟异常只能fail closed不能降低水位 |
| 同 Key 并发接受 | 每 Key admission gate；首个 await 前建立同步 reservation；durable accepted 后才 ACK/入 runner；重复请求 join 同一 reservation |
| effect 与崩溃 | `accepted durable → dispatch fence durable → 同一 authority turn 发起 browser call → receipt durable → 对外完成`；fence 后崩溃保守 unknown |
| `chrome.storage.local`无跨record事务 | 推翻主库存储选择：改用extension-origin IndexedDB；internal mutation跨object store原子提交，critical transaction显式strict；browser effect仍用独立write-ahead fence且禁止补做 |
| planDigest 漂移 | 拆为 intentDigest 与 resolvedPlanDigest；先按原始显式参数做重复身份比较，再冻结默认、目标、revision、backend和 build digest |
| Key/operation owner | operation identity 固定为当前扩展域中的 `(KeyId, OperationId)`；receipt/artifact逐次 owner 检查 |
| 公共 OperationRef | 删除；内部 slot/generation 不跨 extension↔WASM 边界 |
| 目标引用 | 引入 ExtensionRuntimeEpoch、TabRef、DocumentRef、NodeRef；禁止裸 tabId 和 snapshotId 动作定位 |
| occupation 迟到释放 | release 强制完整 expectedOccupationId；冲突响应直接提供当前 ID；仍然是 release 与 acquire 两条指令 |
| 不同 Key “独立” | 精确限定为扩展调度独立，不承诺共享 tab/renderer/page state 的效果隔离；需要稳定排他效果时显式 acquire |
| registry 自证明 | 四份权威声明：Freedom、Command（含独立 permission declarations）、Error、Capability/Platform；manifest还包含基础设施依赖 |
| Root 权限 | 持久化 `keyKind=root`，不是权限快照；每个已声明permission atom求值为true，但表达式结构、命令存在性、target/control/capability/Chrome边界仍照常检查 |
| 10 秒重试 | 保留为用户确认的 Freedom Point；含义改为 worker 可运行时的名义间隔，overdue 在下一次唤醒立即尝试，无 backoff/次数上限/放弃；不承诺跨休眠墙钟上界 |
| WebSocket keepalive | 20 秒只作待实测候选；30 秒以上 alarm 只作粗恢复，不能驱动 10 秒 SLA |
| storage | IndexedDB作为Key/settings/control/operation权威库并用strict transaction；storage.session只存RuntimeEpoch/可重建缓存且保持TRUSTED_CONTEXTS；所有入口过hydration barrier |
| userScripts | full-v1 推荐 Chrome 138 基线并逐目标 feature probe；USER_SCRIPT/MAIN 显式，消息默认关闭，不自动 fallback 到 CDP |
| localhost 网页冒充 | numeric loopback、分离 path/subprotocol/role、Host/Origin 门、server-first hello；它们是 transport hygiene，不参与业务授权 |
| `keys.create` 一次性 secret | 采用最小方案：明文只随首次 live completion 交付；ledger不存明文；响应丢失返回不可恢复，必须撤销 orphan Key 后用新 OperationId 创建 |

## 明确拒绝的审计建议

| 建议 | 拒绝原因 |
|---|---|
| relay 不能看见 Key，否则违反“本地软件不存在” | 错读用户边界。用户要求 relay 不拥有业务权限/状态，不要求当前方案做端到端密文；relay 明文转发是已接受的简单边界 |
| `retry_interval_ms=10000` 不能是 Freedom Point | 与用户明确裁定冲突。数值是首个确认自由点；无限重试与不退避才是不变量 |
| 为重连增加 extension 安装/profile 稳定 route identity | 会把扩展身份反向送入本地实例模型。保留纯本地、每 socket 的 InstanceRef，并诚实缩窄多实例断线后的自动定位承诺 |
| `acquire(force/takeover)` 或 release+acquire 原子组合 | 用户明确拒绝。任何高权限 Key 也必须先独立 release，再独立 acquire；中间竞争是真实结果 |
| occupation 等同持续页面隔离 | 扩展无法回滚已派发 JS/网络/页面动作。occupation 是未来派发 admission gate；release/status必须报告旧 in-flight/unknown |
| 现在确定清洗模型、PageIR或算法 | 用户明确延期。旧稿移入 historical，活动 registry/目录/接口不依赖它 |
| 为本地 endpoint 增加 Agent/process/business identity | 超出 Key-only 模型。当前只做网页/角色隔离；恶意同 OS 用户进程的密码学 endpoint 认证留作威胁模型扩大后的可选加固 |

## 二次全域反证发现

第一轮修正后没有把v0.7视为正确答案；再次从时钟、不可逆状态、队列完成性、大小边界、内部管理面和故障phase反推，继续推翻以下内容：

| 被推翻的隐含假设 | 修正后的合同 |
|---|---|
| `enabled`足以表达revoke | 增加不可逆`status=revoked`；revoke清verifier并保留KeyId tombstone，普通update/rotate不能恢复 |
| 每次看`Date.now()`即可执行expiry | meta保存strict、单调`securityTimeFloorMs`；时钟回拨不复活Key或旧OperationId，异常前跳fail closed |
| 同Keyaccepted顺序等于串行 | normal runner要求所有较小sequence terminal后才fence后序；前序deadline结算uncertain后才释放FIFO |
| sequence可永远从operation records重建 | tombstone GC后会回退复用；增加与accepted同事务的per-Key high-water，队列仍由operation records派生 |
| 全局rejectBefore可按当前dedupe设置直接推进 | 水位只能越过连续安全前沿；任何旧record自己的冻结dedupeUntil未到时都不能跨过 |
| 完整ResolvedPlan可跟tombstone保留同样久 | terminal receipt事务同步擦除JS、form、header/body等执行payload，只留digest/最小receipt/identity元数据 |
| 16 MiB采集结果能穿过1 MiB frame | 分离采集、inline、frame上限；大结果写owner-bound Artifact，artifact与receipt同事务，range read有界 |
| WASM trap一律KnownNoEffect | evidence按durable phase；fence后core/codec/trap默认uncertain，不能改写成未发生 |
| 后台收到admin消息后生成mutation ID就能去重 | AdminMutationId由受信UI按用户手势预先生成；丢响应重发同ID，后台校验intent并durable去重 |
| occupation只看owner当前enabled即可 | OccupationId冻结窄的ownerControlEligibilityRevision；控制资格变化使旧generation永久失效，恢复不复活，无关permission变化不释放 |
| tabGeneration缓存丢失后可猜测恢复 | Chrome tabId只保证browser session内唯一；target映射连续性无法证明时轮换RuntimeEpoch并整体失效旧ref |
| 持久Artifact绑定ExtensionRuntimeEpoch更安全 | 推翻：不可变结果应在留存期内跨browser restart；改用owner-bound opaque高熵ArtifactId，只有full authority reset/释放/到期才失效 |
| settings事务提交就等于timer/socket已应用 | RuntimeFacts区分desired/applied revision，consumer在commit后幂等reconcile并公开degraded/待应用状态 |
| 退役command删除全部旧decoder没有影响 | effect handler可删除，但稳定operation envelope/receipt decoder至少保留至最长旧dedupe窗口结束 |

这轮没有改变任何用户冻结事实，也没有恢复源码实施；它只把先前仍模糊的失败路径改成可注入、可判定的验收项。

## 仍需真实 Chromium 验证的事实

- Chrome/Chromium 138 与目标衍生浏览器的 `userScripts.execute`、Allow User Scripts 开关、USER_SCRIPT/MAIN world和 host permission 行为。
- packed offscreen dedicated worker WebSocket upgrade的实际Origin/Host字段，用于生成fail-closed allowlist。
- packed extension 中 20 秒 ping/pong是否持续保持 worker、alarm 恢复延迟、设备休眠/唤醒行为。
- IndexedDB strict transaction、quota/persistence、upgrade blocked/corruption、storage.session access和浏览器重启/extension reload sweep。
- required `<all_urls>`、file URL、incognito、受限页面及 Chromium 衍生浏览器差异。
- 包内 Zig WASM、extension CSP、内存所有权与冷启动开销。

这些是实验项，不再作为产品裁定题。验证失败时更新 Capability/Platform Registry 与 Freedom Point 当前值，不增加隐式 fallback、来源身份或浏览器确认旁路。

存储裁决依据Chrome官方说明：extension service worker可用IndexedDB且content script访问的是宿主页面origin存储；IndexedDB提供transactional primitives。[Extension storage and cookies](https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies) 同时，Chrome 121起IDB默认durability为relaxed，critical事务必须显式选择strict并等待complete。[IndexedDB durability](https://developer.chrome.com/blog/indexeddb-durability-mode-now-defaults-to-relaxed)

## 当前状态

v0.7 两轮审计都只修正文档。没有创建源码目录、registry 文件、manifest、skill、插件、relay 进程或清洗实现，也没有操作浏览器。活动文档最终静态门为14份Markdown、32个本地链接、36个围栏、8个JSON示例、20项必须语义和9项禁用旧概念，当前均零错误；这不替代任何真实Chromium/WASM/relay测试。恢复编码前必须先通过registry零副作用纵切和operation crash-injection门。
