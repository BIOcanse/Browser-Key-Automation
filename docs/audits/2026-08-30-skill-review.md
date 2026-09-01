# 2026-08-30 按编码指导进行的只读审查

结论：核心流程可用，上一轮的空置修复已经验证；但不能据此说整个插件验收完成。本轮发现若干生命周期、边界读取和重试结果问题，均可在既定架构内局部修正。没有发现需要重做架构的证据。

本轮只审查，没有修改产品源码、正式测试、配置或开发包，没有操作真实浏览器、读取真实 Key，或停止本地 App。新增的是本报告及 `.codex/subagent-results/20260830-skill-review/` 内的审查证据。

## 1. 优先修正

以下均为 P2：需要修正的实际行为或已有代码能构造的失败路径；不是假设敌对操作者的安全扩建需求。静态推导与实际复现明确分开。

| 编号 | 问题与具体影响 | 证据及最小方向 |
|---|---|---|
| R1 | **失效树路由持续积累。** 同一页面反复替换节点，页面中的旧 TreeRef 会删除，但 session 路由不会；对旧引用确认 stale 后仍不删除。主文档导航还遗漏旧子 frame 路由。 | 当前源码模拟 64 次替换：页面仅剩 2 个条目，session 已有 65 条；长期可能耗尽共享存储。让实际引用回收同步清理路由，主导航处理旧子文档；不另建树、不用 TTL/LRU 驱逐活引用。[页面清理](D:/Code/浏览器自动化插件/apps/extension/src/background/page-tree-service.ts:866)、[导航清理](D:/Code/浏览器自动化插件/apps/extension/src/background/page-tree-service.ts:199)。真实配额耗尽未测试。 |
| R2 | **CLI 超时后可能不能退出。** 业务响应超时后只发送关闭帧及 TCP FIN；如果对端不结束自己的发送侧，Node 仍持有连接。 | 隔离 TCP fixture：100 ms 读取超时，close 后 400 ms 仍有活动 socket。失败路径主动销毁，或给正常关闭一个短而明确的兜底期限；继续报告 unknown，不能自动重发。[native-websocket.mjs:188](D:/Code/浏览器自动化插件/apps/client/src/native-websocket.mjs:188)。 |
| R3 | **relay 断连清理存在漏掉请求的窗口。** 先 failInstance、后 unregister；两步之间实例仍可写入，新增 route 可能错过失败扫描而永远等待。 | 静态锁顺序反例，未实测网络竞态：fail 扫描结束 → 新 route 创建并写入成功 → unregister；已无后续响应或扫描。先撤下实例并同步写入者，再结算已有请求即可；不新增身份/代次系统。[server.zig:151](D:/Code/浏览器自动化插件/apps/relay/src/server.zig:151)、[等待点](D:/Code/浏览器自动化插件/apps/relay/src/server.zig:237)。 |
| R4 | **宽树的尾部区间无法正常分页。** range 只是输出过滤，仍从树开头扫描；前缀达到扫描上限后，缩小尾部区间也不能推进。 | 当前投影函数模拟：20,005 个文本兄弟，请求 `[0,20000]..[0,20005)`，得到空 items、truncated=true、nextIndexPath=null；同一路径 subtree 可以取到内容。直接定位同父区间起点、遵守已有展开状态，并返回可推进位置；不用服务端 cursor。[page-tree-service.ts:962](D:/Code/浏览器自动化插件/apps/extension/src/background/page-tree-service.ts:962)。 |
| R5 | **握手卡在中途时不会进入十秒重试。** WebSocket open，但 relay.hello 或 role.ready 迟迟不来，activeSocket 一直存在。 | 当前 worker 的 WebSocket/timer 模拟：停留 connecting，没有安排任何计时器。给连接/握手一个明确的失败边界，关闭后回到原有固定 10 秒重试；不改为退避，不加业务重放。[transport-worker.ts:103](D:/Code/浏览器自动化插件/apps/extension/src/transport-worker.ts:103)。正常 relay 是否发生过此停顿未测。 |
| R6 | **资源抓取没有主动结束等待与完整收尾。** 响应体不结束时，fetch 会拖住同 Key 队列；客户端等待超时不会终止它。Content-Length 直接超限时也没取消 body。 | 当前抓取源码配合受控流复现：未传 AbortSignal，未结束的流保持 pending；超限返回 LIMIT_EXCEEDED，但 cancel 未调用。抓取模块统一负责可配置等待上限、abort 与失败清理；不添加通用任务框架。这里不声称能超越 Chromium 自身生命周期一直运行。[capture-service.ts:62](D:/Code/浏览器自动化插件/apps/extension/src/background/capture-service.ts:62)、[读取点](D:/Code/浏览器自动化插件/apps/extension/src/background/capture-service.ts:71)。 |
| R7 | **已成功的 Key 更新重放可能误报 FORBIDDEN。** A 合法更新 B 并保留 B 原有但 A 没有的权限；之后管理员移除该权限；A 原样重放已提交 mutation，外层却按 B 的新状态将其判为越权新增。 | 当前服务内存诊断：第一次返回 revision 2，目标后来为 revision 3，相同 mutation 经 Agent 入口失败；内部 journal 能返回原 revision 2。先识别已提交重放，再对真正的新修改检查上限；保留命令鉴权与原有授予上限。[key-service.ts:330](D:/Code/浏览器自动化插件/apps/extension/src/background/key-service.ts:330)、[既有重放分支](D:/Code/浏览器自动化插件/apps/extension/src/background/key-service.ts:444)。 |
| R8 | **诊断状态保留了完整请求与 API Key。** offscreen 把 transport.inbound 原样放进全局诊断对象，处理完也不主动移除。 | 人工 Key 的内存模拟确认 credential 被缓存；没有读取真实 Key，也没有证据表明普通网页可访问它或数据已外传。诊断只保存连接状态等摘要，真实请求照常转发；不改变用户要求的管理页可反复查看 Key。[offscreen.ts:59](D:/Code/浏览器自动化插件/apps/extension/src/offscreen.ts:59)。 |

## 2. 次要修正与文档问题

这些列为 P3，不能挤占上述核心收尾。

| 编号 | 发现 | 最简处理 |
|---|---|---|
| R9 | 读取过期 Artifact 时，在事务内删除后又抛错；事务包装器 abort，将删除回滚。读取仍正确拒绝，但这次 lazy cleanup 没发生。 | 事务内返回过期结果、提交清理，再在事务外抛业务错误。无需定时 GC。以后创建 Artifact 的清理或显式 release 仍可删除，不是永久泄露。静态证据：[artifact-service.ts:242](D:/Code/浏览器自动化插件/apps/extension/src/background/artifact-service.ts:242)、[database.ts:101](D:/Code/浏览器自动化插件/apps/extension/src/background/database.ts:101)。 |
| R10 | 长 doctype 的 public/system 原值被截断，却没有 TreeRef/chunk 可以取回尾部。模拟 systemId 长 512，preview 仅 256，treeRef=null。 | 复用现有长值展开路径。它确实不符合完整树合同，但不影响普通短 HTML doctype，优先级低于区间读取。[page-tree-service.ts:605](D:/Code/浏览器自动化插件/apps/extension/src/background/page-tree-service.ts:605)。 |
| R11 | native WebSocket 接收器接受 RSV1 非零帧；非法 UTF-8 会被替换字符后继续 JSON.parse，与严格 profile 声明不符。 | 增加 RSV=0 检查、fatal UTF-8 解码和负例。内存帧模拟已复现；正常 Zig relay 不产生这些帧，不借此扩建压缩/分帧能力或攻击模型。[native-websocket.mjs:126](D:/Code/浏览器自动化插件/apps/client/src/native-websocket.mjs:126)。 |
| R12 | 现行文档混入旧事实：Key 文档仍称 Agent keys.* 延期、Agent 响应永不含 token；Freedom 文档仍写 own/any、RuntimeFacts/reconciler；relay 文档称扩展不接收 epoch，但现行 hello 携带它。README 的笼统 token 描述也需收窄。 | 以现行 registry 和当前纵切为准，隔离失效候选。授权 keys.create/reveal 返回 Key 是当前能力，不应收回；扩展收到 hello epoch 不等于拥有实例编号。不要为兑现旧文字补建旧系统。[Key 文档](D:/Code/浏览器自动化插件/docs/implementation/key-vertical-slice.md:9)、[Freedom 文档](D:/Code/浏览器自动化插件/docs/design/freedom-points.md:27)、[relay 文档](D:/Code/浏览器自动化插件/docs/implementation/relay-vertical-slice.md:9)。 |

## 3. 按 skill 做的必要性自检

用普通语言描述现有模型：**扩展保存和验证 Key，按 Key 串行派发；占据记录某个 Key 对 tab/global 的占用；页面保存唯一树及各 Key 的展开集合，session 只负责把引用送回准确文档；一次 get 只投影视图；Artifact 保存已提交文件；本地 relay 分配连接实例并转发。**

这套模型能解释当前核心能力，不需要来源身份、合并接管、隐藏重试、第二份页面树或大一统操作台账来解决本轮发现。session 路由不是重复缓存页面内容，其跨 worker 恢复职责应保留；应补的是失效回收。

可顺手简化、但不应独立发起重构的内容：

- view 可选字段在调用边界已归一化，注入函数又归一化一次；只保留生产边界的一次即可。
- 当前仓库未见 `authorizationRevision/controlEligibilityRevision` 参与运行决定，只有递增与返回；可审视是否还需要。它们已进入持久记录和公开结果，未确认外部消费者前不要贸然删除。`recordRevision` 的 CAS、`credentialRevision` 的异步鉴权复核则有明确必要性。
- 应删除诊断对象中的业务 payload，而不是给敏感诊断再做一层权限系统。

## 4. 本轮验证与完成边界

| 验证 | 结果 |
|---|---|
| background/admin/transport TypeScript noEmit | 3/3 通过 |
| Node 核心单测 | 16/16 通过（其中 native WebSocket 为 3 项，不重复计数） |
| Zig 模块单测 | 9/9 通过，由只读传输审查执行 |
| 源码与交付一致性 | 在审查目录隔离编译；24 个 JS 文件与 out/extension、扩展开发包逐个 SHA256 相同 |
| 分包、ZIP 解压与摘要 | 扩展 29 个文件，Windows/Linux App 各 9 个文件，全部通过 |
| 新反例 | 受控内存/临时 TCP fixture 验证，不使用真实身份；静态竞态另行标明 |
| 报告当前性 | 独立整理复核三份报告引用的 29 个源码/测试/文档/配置哈希，全部匹配当前文件 |

因此：主流程和最近的空置修复不是“没做完”；本轮指出的是现有测试尚未覆盖的边界。上述反例需要进入正式回归后再修正，测试全绿不能替代这些验收。

本轮未重跑真实 Chromium 全套 E2E、未验证真实 Linux 运行、未做 packed 发布验收。此前个人浏览器空置 45 秒的成功记录仍有效，但不是本轮重新测得。自动选择算法、更高层的自家 Agent 原生集成，也不能因为当前核心命令可用就宣称已经全部交付。

建议顺序：先闭合 R1–R6 的引用回收、区间读取和连接/请求收尾；随后修 R7–R8，补对应回归；R9–R12 在同一轮做局部修正和文档对齐。不先扩需求，不改 Key-only 和薄 relay 的既定架构。本轮未实施这些修正。

## 5. 证据文件

- [Key / 占据审查及复现](D:/Code/浏览器自动化插件/.codex/subagent-results/20260830-skill-review/key-control/report.md)
- [页面树审查及复现](D:/Code/浏览器自动化插件/.codex/subagent-results/20260830-skill-review/page-tree/report.md)
- [传输审查、Node/Zig 输出及复现](D:/Code/浏览器自动化插件/.codex/subagent-results/20260830-skill-review/transport/report.md)
- [主审交叉核验、Artifact/capture 证据](D:/Code/浏览器自动化插件/.codex/subagent-results/20260830-skill-review/primary/report.md)
- [三份子报告的去重摘要与当前性核对](D:/Code/浏览器自动化插件/.codex/subagent-results/20260830-skill-review/digest/digest.md)

各报告标明具体范围、模拟与实测区别、源码哈希、未覆盖项。报告内没有真实 Key 或私人网页正文。
