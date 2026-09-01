# 审查问题修复批次（2026-08-30）

状态：R1–R12 已修复，单元/独立 Chromium 集成/分包验证已通过。用户授权范围是 [R1–R12 审查发现](../audits/2026-08-30-skill-review.md)。本批保持既有架构和 39 条指令，不加入来源身份、合并接管、隐藏业务重放、第二份页面树或操作台账。验证中另见一次未定位的 MHTML 偶发错误，见下方完成边界。

## 最简行为与归属

- relay 关闭实例时，先禁止再向它写入，再使已有等待请求失败；客户端结束一次调用后必须有限时间内关闭自己的连接。
- 连接/应用握手必须有等待边界；失败回到原先固定 10 秒重试。只重连，不重发已经送出的业务操作。
- resource.fetch 自己持有网络取消与清理责任；超时或超量取消读取，结束同 Key 本次执行，不由客户端补救。
- Key service 先识别同一 mutation 的已提交结果；真正的新修改在同一事务内读取目标、核对 revision、执行现有权限上限。外层命令鉴权保持不变。
- Artifact 过期删除提交后再返回不存在错误，不在同一事务里删除又回滚。
- 页面仍唯一保存树和按 Key 的展开状态；session 仅保存路由。只删除已确认失效的路由，不能清掉其他请求新建立的 live 引用或未刷新页面。树区间从指定父级/起点读取，不扫描无关前缀、不改变展开状态；长 doctype 使用现有长值分块。
- 诊断只保存状态摘要，不保存完整业务请求、Key 或页面内容。

树路由回收的具体路径：每次树请求先从 session 读取同文档已记录的候选引用，页面在现有 prune 后核验这些候选，内部回包附带已失效者，后台仅删除该集合。单次候选上限由现有 `maximum_refs_per_document + maximum_view_items` 派生，超过页面 live 引用上限，保证历史残留分批推进；不维护 GC cursor/tombstone。失败后 session 中未删除的候选会再次被核验。导航在现有短路由队列内读取 getAllFrames 的当前精确文档集合，只清已消失的文档；拟注册路由也在同一队列内核对当前 Document，拒绝迟到的旧文档结果。未知元数据不视为文档已消失。

回归用 `fake-indexeddb` 作为仅开发依赖，运行生产事务包装器验证提交/回滚，而不是重写一份假事务逻辑；不随开发包分发。Windows 构建/测试使用 `tools/run-noninteractive.ps1` 让子进程继承无原生错误对话框模式。

## 当前具体边界

- 新增两个实际消费的 build Freedom Point：`transport.handshake_timeout_ms=10000`（一次连接至应用 ready 的等待上限）、`command.resource.fetch.timeout_ms=30000`（GET 至 body 完成的等待上限）。与重试间隔分开，不宣称热设置；现有命令参数/schemaVersion 不变。失败使用现有能力/投递错误，不声称副作用已撤销。
- Native socket 复用现有 250 ms 关闭宽限后销毁逻辑；严格拒绝非零 RSV 和非法 UTF-8，不增加压缩/分帧支持。
- 不删除已公开/持久化但暂未消费的 revision 字段；它们不是本轮缺陷修复所必需。view 只做一次归一化，但必须放在页面注入入口：本次真实 Chromium 实测，后台传入的 `{maximumLevel:null,range:null,subtree:null}` 到页面时变成 `{}`，不能把后台归一化误当成跨 API 边界保证。合成 harness 已加入该转换反例。
- 原审查文档作为历史证据保留，修复结果记在本文件；现行 Key、relay、Freedom、README 文档去除错误断言。

## 文件与验证

按已有 owner 修改 `apps/relay/src/server.zig`、client native WebSocket、extension transport/offscreen、background Key/Artifact/capture/page-tree；Freedom 声明进入 `registries/` 并由现有生成器投影。回归放入 `tests/` 对应模块；不把审查探针当作生产代码。

先执行模块回归、类型/生成检查，再在隔离浏览器/relay 环境做集成测试。用户真实浏览器与已运行 relay 不受测试启动/停止影响。开发包仍分扩展、Windows App、Linux App；打包遇到正在运行的 App 必须沿用旁路发布，不能杀用户进程。

集成测试入口 `tools/test-isolated.mjs` 在 `out/test-artifacts` 创建独占 fixture，复制当前产物/测试和 relay 源码，只在副本把 loopback bind 改为临时端口并重编 relay；client、manifest/CSP、worker 和 relay 必须使用同一端口，不向产品增加运行时端口扫描或身份。四个旧 smoke 入口要求 fixture 标记，禁止直接复用 32189。清理只关闭测试自己启动的进程，不使用 process-tree kill。开发包本轮发布到新的输出子目录，不替换用户正加载的扩展目录。

## 修复验收

| 原发现 | 本轮修复及反例 |
|---|---|
| R1 树路由积累 | 64 次同页替换后页面/session 均维持 2 条；删除失败重试、并发新 Key 引用保留、旧主/子文档清理、新子文档保留、迟到旧文档拒绝、未知元数据保留；历史 backlog `22 → 18 → 14 → 10 → 6 → 2` 分批排空。 |
| R2 客户端不退出 | 自有 allowHalfOpen TCP fixture 保持对端不关闭；业务读超时后子进程在有限时间内退出，仍报告 unknown，不重放。 |
| R3 relay 收尾竞态 | unregister/writer 同步先于最终 failInstance；隔离 relay 回归验证已投递请求收到 EXTENSION_DISCONNECTED、随后旧实例写入收到 STALE_INSTANCE。精确并发窗口依据锁顺序证明，不冒充压力复现。 |
| R4 尾部区间 | 直接读取第 20,000–20,004 个兄弟；collapsed/另一 Key/maxLevel/subtree 组合不隐式展开；真实下一项才触发 truncated，并返回 nextIndexPath。 |
| R5 握手不重连 | connecting、无 hello、无 ready 都受期限约束；error 没有 close 回调也会重试；stop 清 timer，旧回调不能污染新连接。复审发现的浏览器 close(1002) 异常也已修正为允许的 close(1000)。 |
| R6 抓取不收尾 | deadline 主动 abort；已知长度超限、流超限、reader error 均清理；成功后撤销 timer；结果仍由现有 Artifact owner 提交。 |
| R7 Key 重放 | 目标后来移除权限后，相同已提交 mutation 仍返回原结果；新越权授予、改 Root 和不同 intent 仍拒绝。 |
| R8 诊断缓存 Key | offscreen 只保留 kind；真实请求/response 仍完整转发且带原 connectionGeneration。 |
| R9 过期 Artifact | 过期 metadata/chunks 的删除先提交，再返回 NOT_FOUND；foreign owner 不读取，真正事务失败仍回滚。 |
| R10 doctype | 长标识值可显式展开并完整重组，含 surrogate pair 边界。 |
| R11 帧解析 | 非零 RSV、非法 UTF-8 明确拒绝。 |
| R12 事实漂移 | Key/relay/README/UI 提示对齐现状；Freedom 旧候选移入 historical，当前文档只描述真实 consumer、settings.v1 和生成器，不补建旧候选。 |

正式 Node 测试最终整组 31/31 通过。Zig 模块测试 10/10 通过。background/admin/transport 三配置由最终 extension build 严格编译通过；两个生成器也通过。

独立复审：core reviewer 检查传输/Key/Artifact 收尾，提出并促成 close-code 修复；tree reviewer 完成 11,760 组区间差分、额外 10 个 doctype 与分批 backlog 比较。其合成环境没覆盖 Chromium 参数转换，真实 E2E 揭露后由主实现修复，并加入正式 harness。复审报告位于 `.codex/subagent-results/20260830-review-fixes/`，不随开发包分发。

## 实际交互与原始文件

最终完整独立运行：[results.json](../../out/test-artifacts/isolated-dMIF7U/results.json)，私有 relay `127.0.0.1:64182`，Chromium `chromium-1228`，从未复用个人 relay。protocol、client、admin、extension-relay 四项均 exit 0。

1. App 未启动时扩展继续尝试；启动测试 App 后约 10,027 ms 连通，relay 分配实例 1。
2. 管理页实际显示两条测试 Key：一条可用、一条已吊销，值默认遮挡，行内有显示/复制按钮；顶部状态绿色“已连接”。创建/重复 mutation/reveal/补存/吊销及 worker 回收后的同页重连均通过。
3. 树首次 get 是 doctype/HTML 两行，第 0 层不会展开。显式展开 HTML/BODY 后，下层节点出现；最终走到 65 行、23 次新展开，长文本和 attribute 完整重组。
4. 子 frame 切换、另一 Key 独立展开、同父区间和子树视图均通过。主动停止测试 worker 后，直接使用原 BODY TreeRef expand、原 root view 成功；真正刷新才使旧引用 stale。
5. 全部 39 条命令经实际扩展/relay 发出；DOM 固定动作有页面状态复核，HTTP GET/MHTML/PNG 通过 Artifact 读取和释放。

原始记录，不包含真实用户 Key 或个人网页：

- [逐层实际 request/response](../../out/test-artifacts/isolated-dMIF7U/out/test-artifacts/page-tree-actual-interaction.json)
- [worker 回收前后实际 request/response](../../out/test-artifacts/isolated-dMIF7U/out/test-artifacts/page-tree-worker-restart.json)
- [完整链路日志](../../out/test-artifacts/isolated-dMIF7U/extension-relay.log)
- [最终 UI 专项结果](../../out/test-artifacts/isolated-nsxNJm/results.json)
- [最终管理页截图](../../out/test-artifacts/isolated-nsxNJm/out/test-artifacts/admin-ui-smoke.png)

UI 文案在最终完整 E2E 后单独纠正了“Agent 响应不含 Key”误述；没有改变页面逻辑。随后在 `isolated-nsxNJm` 再次通过真实 UI smoke，并核对截图：普通列表不含完整 Key、获准 create/reveal 会返回完整 Key。

## 开发包与完成边界

Windows/Linux x86_64 ReleaseSafe 均构建成功。三个包发布到新的 `out/review-fixes-2026-08-30/`，不覆盖个人浏览器当前加载路径，不停止运行中的 App。

- [扩展 ZIP](../../out/review-fixes-2026-08-30/browser-key-automation-extension-dev.zip)：解压根部直接有 manifest.json；29 个文件清单通过。
- [Windows App ZIP](../../out/review-fixes-2026-08-30/browser-key-automation-local-app-windows-x86_64-dev.zip)：PE + CLI + skill，9 项清单通过。
- [Linux App ZIP](../../out/review-fixes-2026-08-30/browser-key-automation-local-app-linux-x86_64-dev.zip)：ELF + CLI + skill，9 项清单通过。

最终 SHA-256（ZIP）分别为 `953be4246842bd25c24fcc5ec348e9c55c14ee1bd2d2fb8c070d52ed3f065233`、`334d151c20418bd3f1b251254fa38e8c0f59de5bd5387fd51ccb01dbbac8c8f4`、`4b9de00a700eb53501ee7dafb9c08e664735cc2866b8cf3619ee7176f424aca9`。每个 ZIP 已解压复算清单，根目录/平台/skill registry 一致性通过。

最终独立交付复核也通过：28 个扩展产物与包一致；23 个非 endpoint JS 与完整 E2E fixture 逐字节一致，endpoint 文件只差测试端口；两份 HTML 与最终 UI fixture 一致；App 中 client/relay 分别与源码/cross 输出一致。正式包仍使用 32189，未混入临时诊断、测试依赖或缓存。[交付复核报告与逐文件哈希](../../.codex/subagent-results/20260830-review-fixes/review-package/report.md)。

更新扩展时覆盖原解压目录后在 Chrome 点重新加载即可；不要先卸载，以免删除本地 Key 数据。本地 App 由用户选择空闲时退出旧进程再启动新版；本轮没有自动替换运行实例。

未冒充完成的内容：

- `isolated-8a7Bhv` 首次到 MHTML 时出现一次 `STORAGE_UNAVAILABLE`，原日志保留在该目录 `extension-relay.log`。同源码加仅测试诊断后原样复测成功，最终全新独立 E2E 再次成功；未捕获原始 DOMException 原因，不能称此偶发现象已经修复，也没有加入自动重试掩盖它。
- Linux 仅交叉构建/ELF/包验证，没有 Linux 运行验收；没有 packed 扩展发布验收或个人浏览器新版本复测。
- 本轮未做清洗/智能选择、额外原生 Agent 集成或 CDP 功能。没有增添业务指令/身份/权限；新增仅为两个实际使用的 build deadline、测试隔离入口和 fake-indexeddb 开发测试依赖。
