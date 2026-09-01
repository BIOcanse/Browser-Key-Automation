# 项目进度

更新：2026-08-31。当前阶段：浏览器核心、页面操作树、多级等待、一键保存/截图、自包含 HTML 演示、20 语言 UI 及 Windows `dom.click.real` 已实现。当前 registry 含 46 条 active command、40 个 active permission、57 个 active Freedom Point。Key、串行、occupation、Artifact 和薄 relay 的业务归属未改变。

## 当前实现批次

- GitHub Release 两资产交付已落地：保留扩展、Windows App、Linux App 三个独立开发中间包，再由薄聚合层生成 `browser-key-automation-extension-v0.0.0.1.zip` 与 `browser-key-automation-local-app-v0.0.0.1.zip`。扩展 ZIP 根部直接含 `manifest.json`；App ZIP 将 PE/ELF relay 分置 `windows-x86_64/`、`linux-x86_64/`，公共 CLI、协议与 Agent skill 只放一份。聚合前逐项验证中间包内部 SHA 与跨平台公共文件一致性，聚合后再验证 69/15 个文件、PE/ELF、exact-Origin、CLI help、ZIP 根层、临时解压和内外 SHA；Release 页面只上传这两个 ZIP，不上传旁文件。完整 81 项 Node、10 项 Zig 与三个开发分包 69/14/14 校验均通过。见[两资产交付合同](implementation/github-release-delivery.md)。
- Chrome Web Store 工具链已实现但发布工作继续暂停：用户已确认候选 B 的最终现代极简图标，使用 `#2563EB`/白色开放框与 Key，不含渐变、发光、阴影或“AI 蓝紫”；白色主体经光学校正消除头重脚轻。128 主稿和 16 工具栏基准稿分别生成 128 与 16/32/48 RGBA PNG；显式渲染连续两次产生相同 SHA-256，图标资产测试覆盖两色限制、精确尺寸、透明边缘、居中边界、实色占比与白色视觉质量中心。完整 `npm run test:unit` 的 81 项 Node 与 Zig relay 测试通过，源码、扩展构建目录和本地 Web Store 打包目录的四档 PNG 逐项一致。首传 ZIP 仍不上传 Dashboard、不放 GitHub Release、也不提交审核；只有用户明确恢复后，才继续 Item ID/public key、Zig App exact-Origin 门禁同步和递增版本流程。详见[图标设计](design/icon-design.md)与[交付切片](implementation/chrome-web-store-delivery.md)。
- 仓库入口文档已按本机 Smart Preload 的已验证模式整理：默认 `README.md` 为英文，另有简体、繁体、日、韩、德、法、西、巴葡、俄语，共十份完整且互相可切换的 README；安装、Key、页面树、等待/保存/截图/演示、Windows `.real`、Linux 边界、拆分包和开发验证保持同一章节拓扑。新增 `docs/README.md` 说明文档权威顺序与阅读路径，修正 registry README 和当前进度中的旧数量/旧 `.real` 状态，并用 `test:readme-i18n` 校验文件集合、语言栏、关键合同、链接和 Key 泄露。仓库当前没有已裁定许可证，因此没有复制参考项目的许可证声明。
- `.real` Windows 首版已交付：按[实现切片](implementation/real-input-slice.md)只增加 `dom.click.real` 及独立权限，扩展继续负责 Key/NodeRef/占据/页面命中，本地 App 只执行一次 route-owned 原生点击。临时随机标题标记闭合 Chromium windowId→HWND 身份，匹配传播轮询与响应余量均为实际消费的 Freedom Point。隔离 Chromium 最终观察为 `input_sent / trusted=1 / untrusted=1 / titleRestored=true`，且完整扩展—relay 后续回归通过；原始输出见[实现交互记录](experience/real-input-implementation-2026-08-31.md)。Linux 在真实后端完成前明确不声明能力；普通 `dom.click`、个人浏览器和运行中的个人 App 不变。
- UI 精简与 20 语言已交付：简体/繁体独立，支持跟随浏览器或无刷新持久切换、阿拉伯语 RTL、日期/数量本地化及 Chrome 原生 locale。管理页删去重复说明/成功提示/权限长描述，安装页只保留三步和必需的 User Scripts 指引；移动端头部及 Key 卡片由真实截图修正。语言 registry、生成器和 `ui.locale.default` Freedom Point 已接入 build identity 与分包。72 项 Node、10 项 Zig、隔离 Chromium 完整 Key/UI 流程及三个独立分包校验通过；截图与原始引导样本在 `out/ui-i18n-2026-08-31/`，现行包仍位于 `out/browser-key-automation-*-dev(.zip)`。只改界面与生成链，不扩浏览器/App/协议能力；见[实现与验收](implementation/ui-i18n.md)。
- 一键截图与自包含 HTML 演示已交付，范围见[本轮实现合同](implementation/quick-screenshot-and-demo.md)。`page-shot/saveScreenshot` 复用截图与校验落盘；`demo-open/openDemo` 按 Key 分块上传 Artifact，完整校验后在沙箱展示。新增 4 条指令、2 个独立权限和 4 个实际消费的自由点，不新增 HTTP 服务或 Zig relay 业务。68 项 Node、10 项 Zig、四路隔离烟测及三个分包校验通过；真实 Chromium 22 步已验证 83,442 字节提交、脚本/按钮/滑块、PNG/JPEG、刷新、原标签更新和编码错误提示。交付目录为 `out/quick-shot-demo-2026-08-31/`，最终验收和原始样本见[交互记录](experience/quick-shot-demo-2026-08-31.md)。未重启或重载个人 App/浏览器；`.real` 不属于本批。
- `.real` 原生输入前置实测完成：Windows/Chrome 151 的 31 项首轮、逐条消息/NOACTIVATE、扩展 API 与外部进程前台补测均保留原始数据。该历史批次当时只新增实验工具/文档；随后已按本页首条完成产品实现。见[完整实测与概念报告](experience/native-input-2026-08-31.md)。
- `.real` 的实施前方案保留在[扩展定位、App 真实点击方案](design/real-input.md)；其中“仅文档/待接入”属于当时阶段，现行实现和验收以[实现切片](implementation/real-input-slice.md)为准。
- 安装引导已交付：首次安装自动打开介绍页，管理页复用只读 User Scripts 检查；未启用的 JS 指令在正式错误 details 中带 setupInstructions，文档/skill 同步。56 项 Node、隔离 Chrome 安装/真实开关操作及扩展—relay 回归通过，新分包在 `out/onboarding-2026-08-31/`。未修改或重启个人 App。该批次只完成 `.real` 可行性审查；后续产品实现已经完成，现状以本节首条、[原生点击实现切片](implementation/real-input-slice.md)和[最终交互记录](experience/real-input-implementation-2026-08-31.md)为准。安装批次范围见[当时合同](implementation/onboarding-and-real-input.md)，截图与逐步结果见[当时交互记录](experience/onboarding-2026-08-31.md)。
- 使用闭环已交付：`page.wait` 多级等待默认 10 秒、已满足立即提示；`page.tree.find` 不改变展开状态；DOM 无效目标/禁用控件检查及 contenteditable 纯文本输入；CLI `page-save` / `artifact-save` 返回真实校验后的本地文件。默认参数从 registry 一次展开，CLI transport 改为同源生成。Node 53 项、Zig 10 项及隔离 Chromium 回归通过；33 步原始交互和实际 MHTML 已保留。范围见[本轮短合同](implementation/usability-wait-save-slice.md)，分包、自由点审查和每一步结果见[交互与交付记录](experience/usability-wait-save-2026-08-31.md)。新包在 `out/usability-2026-08-31/`；未自动重启个人 PID 46104 或重载浏览器。以下 2026-08-30 及更早记录保持其历史语境。
- 已按用户明确要求切换修复版 App 并重启：旧 PID 24896 经 CLI 正常退出，从 `out/review-fixes-2026-08-30/browser-key-automation-local-app-windows-x86_64-dev/` 启动 PID 46104，exe 哈希与交付值一致。首次等待 10 秒检查已自动连回新 relay epoch 的实例 `/1`；原 Key、同一页面 root 与两条展开 TreeRef/路径保留，再空置 45,007 ms 也通过。13 条原始返回另存私密样本目录；见[App 重启复测](experience/page-tree-idle-recovery.md#8-按用户指示切换修复版-app-并重启通过)。修复版 App 保持运行，未刷新浏览器或更改 Key，旧包目录仍保留。
- 用户再次重载后的真实复测通过：固定实例 `/6`，已有 B 站页面空置 45,008 ms 后，原 root view/HTML expand 成功，39 行及展开 TreeRef/路径不变；旧 TabRef 失效后显式重新列出标签页，reopen 仍复用同一 root。13 条原始返回另存私密样本目录；见[重载后逐步记录](experience/page-tree-idle-recovery.md#7-审查修复交付后用户再次重载的真实复测)。该次检查时本地 App 尚未更新，后续已按上条完成重启。
- 2026-08-30 审查 R1–R12 已修复，记录见[本批修复记录](implementation/review-fixes-2026-08-30.md)。Node 31 个不同用例、Zig 10 项及独立 Chromium 全部 39 命令通过；Windows/Linux 与扩展分包在 `out/review-fixes-2026-08-30/`。不重做架构、不打断个人实例。另保留一次 MHTML 偶发 STORAGE_UNAVAILABLE 未定位事项，随后两轮复测通过但未宣称已修复。
- 精确接口、权限、结果和排除项已冻结在[浏览器核心指令扩展纵切](implementation/command-expansion-slice.md)，不再用旧 planned 阶段阻塞实际落地。
- Registry/生成器、Manifest、IndexedDB schema、Chromium adapter 和 dispatcher 在该批次闭合；当时 registry 的 39/39 active method 均由真实扩展—本地 App 烟测发出。后续新增指令后的当前总数以本页顶部和 registry 为准。DOM 固定动作另由 MAIN world 复核页面实际状态，Artifact 对 DOM、显式 GET、MHTML、PNG 四类真实结果完成读取与释放。
- 页面树的实现合同见[页面操作树实现切片](implementation/page-information-tree-slice.md)；现行逐层/区间/子树原始交互见[逐层真实示例](experience/page-tree-layer-by-layer-example.md)。旧 v1 selection 烟测保留为历史运行证据，不描述现行 API。
- 逐步可见结果、首次 MHTML Blob 偏差及修正记录在[完整指令真实 Chromium 交互记录](experience/command-expansion-browser-smoke.md)。
- 可变 inline 列表统一消费 `command.inline.maximum_result_json_bytes=49152`，在加入下一项前按 UTF-8 JSON 总字节停止；DOM descriptor 当前 rebuild 默认 256 字符，并由生成器证明单项最坏 JSON escape 仍能装入同一预算。
- Artifact 正文统一按 1 MiB ArrayBuffer chunk 落入独立 IndexedDB store；metadata/chunks 同事务可见，36,000-byte read 最多加载两个 chunk。真实烟测另取 1.1 MB response 并在 chunk 边界前 16 bytes 开始读取 64 bytes，返回与源字节逐字节一致。

## 已冻结产品事实

- 外部业务只看Key，不建模Agent/软件/进程/来源/连接；扩展是Key与业务状态owner。
- 任何已授权Key请求通过完整检查后免插件逐指令确认；Root对当前resolved artifact全部`status=active` permission atom为true，未来新激活项自动加入，pending/retired不进入运行向量；Chrome自身权限、开关、受限页面与调试确认不旁路。
- JS与DOM/当前DOM/resource/debug等入口并列授权，不做permission closure。
- 同Key一般动作串行，不同Key调度独立；共享tab的页面effect不承诺隔离。
- tab/global occupation按Key；冲突必须独立release成功后再独立acquire；无force/takeover/replace/隐藏组合。
- Chromium-only；Windows/Linux薄relay；通用Agent用skill，自家Agent原生插件接同一协议。
- 未连接时由packaged offscreen `WORKERS` document的dedicated worker执行名义10秒无限retry，数值是首个Freedom Point；alarms只重建context。InstanceRef完全由relay每socket生成。
- Zig纯核心/WASM + TypeScript/JS Chromium适配；当前 canonical 树采集与 view 投影在可注入文档侧 TypeScript/JS 完成，保持以后按证据迁移纯计算模块的边界。

## v0.9真实纵切

- Key 格式为 `bk1.<16-byte KeyId>.<32-byte secret>`；扩展 IndexedDB 同时保存 salted SHA-256 verifier 与完整 `storedApiKey`，业务鉴权只用 verifier。Root 动态拥有全部 active permission，Regular 从当前 40 个 active atom 中显式选择。
- admin create/list/reveal/attachSecret/update/revoke 使用 strict IndexedDB transaction、closed trusted Port 和 AdminMutationId。未知 create 结果把同一非秘密意图留在 sessionStorage，刷新后原样重试会返回同一个已提交 token，不创建第二条记录。管理页已重做为 API 控制台式列表与对话框，支持重复显示/隐藏/复制、搜索、筛选、编辑、停用、确认吊销以及旧 verifier-only Key 的显式补存。
- Zig relay 完成受限 RFC6455、路径/子协议/精确固定 Origin/Host/role 门、binary-only frame、连接实例表和有界 route table；relay 独占生成 `relayEpoch + instanceNumber`，扩展收不到 InstanceRef。固定 Origin 由 manifest 公钥计算并生成给 Zig，禁止首次连接学习。
- packaged offscreen dedicated worker 主动连接 `127.0.0.1:32189`，断线按 Freedom Point 的 10000 ms 固定间隔无限重试；每次 relay 进程启动生成新 epoch。
- native client 已用 Key 调通 `system.describe.v1`；错误 secret、revoke、disable、expiry 与 permission 均在扩展侧裁决，relay 不参与授权。
- `tabs.list.v1` 已简化为 `afterTabId + limit` 的无状态 live keyset page；仍受 100 items、49152 inline bytes、2048 UTF-8 bytes/字段三个 Freedom Point 约束，截断有显式布尔标志。
- `tabs.get.v1` 使用扩展签发的 `tr1.<runtimeEpoch>.<tabId>.<generation>` TabRef。runtime epoch 由 trusted `storage.session` 保存；关闭/替换、worker 连续性不可证明或 epoch 不同都 fail closed 为 `TAB_REF_STALE`。
- `control.acquire/release.v1` 已实现 Key-owned tab/global occupation；foreign acquire 只返回冲突，调用方必须单独 release 后再 acquire。内部 session 状态按 runtime tab 身份关联 owner，worker 回收后新 generation 不能绕过旧占据，remove/replace 会清项。`page.dom.get.v1` 通过固定 `scripting` 函数读取 live DOM；`js.execute.v1` 通过 `userScripts` 在显式 `USER_SCRIPT | MAIN` world 执行完整源码，四项权限互不蕴含。
- Command/Capability/Error/Freedom registry 现在生成 TypeScript catalog，并反查 active 引用、source consumer 路径和 manifest permission 精确投影；运行时 active 列表不再手写。
- 产品 CLI 位于 `apps/client/src`：每次先精确校验 relay hello，再无 Key 枚举 current InstanceRef；目标唯一或显式命中后才从环境变量读取 Key。多实例拒绝默认选择，发送后超时标记 delivery unknown 且不自动重试，客户端输出不回显 Key。
- 开发包已经按 Smart Preload 的交付层级拆开：`out/browser-key-automation-extension-dev.zip` 解压根目录直接含 `manifest.json`；Windows/Linux 本地 App 分别位于 `out/browser-key-automation-local-app-windows-x86_64-dev.zip` 与 `out/browser-key-automation-local-app-linux-x86_64-dev.zip`，解压根目录直接含对应 ReleaseSafe relay、CLI、协议、配套 `browser-key-automation` skill 和就近启动说明。skill 的 command/Freedom references 由现行 registry 同步生成。三个包独立生成 SHA-256 清单与 ZIP 摘要；旧 combined 包不再是安装入口。
- 打包器现在使用 staging + directory swap；若 Windows relay 正从旧解压目录运行而使目录锁定，新 unpacked build 发布到带内容摘要的并列目录，三个标准 ZIP 路径仍照常重建。无需为更新开发包先停止正在使用的 relay，也不会向它发送 `relay.stop`。
- 真实个人 Chrome 已用用户的 Root Key 连通 relay-assigned 实例；`system.describe`、`tabs.list/get`、`page.dom.get`、tab/global `control.acquire/release` 和 `js.execute USER_SCRIPT/MAIN` 均已通过真实交互。占据测试后均显式解除。Chrome User Scripts 开关开启并重载后，relay 实例从 `1` 变为 `2`，两个 JS world 均 `fulfilled`；旧 InstanceRef/TabRef 未复用。
- 私密样本已放入 `F:\code\浏览器自动化插件\browser-samples`：保留两份早期截断 preview，并已补齐 B 站首页、ChatGPT、Gmail、MDN 文章和 B 站视频页 5 份 full live DOM/visible text。所有 full 文件的字节数和 SHA-256 复算通过，完整 Browser Key 形状扫描为 0；脱敏结论见[真实样本分析](experience/real-browser-sample-analysis.md)。
- 5/5 页面的 `<body>` 都在标准 `page.dom.get` preview 截断点之后，因此除 `page.dom.capture + Artifact` 外，现已落地独立页面操作树：完整可观察内容从 rootRef 达到；初始 view 是严格 Document 第 0 层，Agent 通过 TreeRef 展开分支，不再存在 selection 或第二套重要性节点。
- 真实个人 B 站首页已按现行 operation tree 从第 0 层下钻到第 15 层标题 link：第 1 层包含其他扩展注入属性/节点，BODY 实际位于 `[1,6]`；第 8 层宽容器一次暴露推荐卡聚合 label，第 12 层出现封面 link，第 14/15 层出现 heading/标题 link。level/range/subtree 与跨 ChatGPT 页面再返回的 root/展开缓存均通过；脱敏记录见[真实个人浏览器页面树验证](experience/real-browser-page-tree-validation.md)，私密原始 MAIN subtree 样本在 `F:\code\浏览器自动化插件\browser-samples`，完整 Key 形状扫描为 0。
- 管理页空置后失效的根因已修复：MV3 service worker 结束会断开 admin Port，旧客户端此前永久拒绝后续请求。现在只把断开时 pending 标为结果未知，不重放旧 mutation；下一笔新请求按需创建新 Port，不用 heartbeat。自动 Chromium smoke 强制关闭 service worker 后，在同一页面、不 reload 的情况下点击刷新成功重启 worker、重连并读取列表，页面 sentinel 保持不变；用户真实个人 Chrome 随后也直接观察到“已断开”，同页点击列表刷新约 1.2 秒变为绿色“已连接”，原有 1 条 Key 保持不变。扩展开发包已重建并通过 29 项清单校验。
- 树空置修复：真实 B 站页面修复前两次 45 秒空置后，旧 TreeRef/TabRef 失效，但新 TabRef reopen 复用同一 root 和展开状态。已把树路由从 worker 内存移到 trusted session，保留页面唯一缓存与精确 Document 目标校验，不改选择算法或旧 TabRef 生命周期。独立 Chromium 强制回收后原子节点 expand/原 root view 成功且状态保留，真正刷新后两者 stale；runtime-core 6 项（含审查补充的存储写失败/清理交错）、Key-core 7 项、两套真实 Chromium smoke 与开发包校验通过。用户随后提供新 Key，真实个人浏览器更新后复测也通过：45,015 ms 空置后原 root view/HTML expand 成功，39 行和两条展开路径保留，旧 TabRef 按既定规则失效。13 次新原始返回保存在 `D:\ALL THINGS\Document\BrowserKeyAutomation\browser-samples\2026-08-31T01-13-49-049Z-tree-idle`，哈希已复算、Key 形状扫描为 0；没有混入仓库/开发包。[逐步交互与修复记录](experience/page-tree-idle-recovery.md)。本轮仅验证和更新记录，产品代码和开发包未再修改。

## v0.7 设计历史（非现行实现）

以下 v0.7/v0.8 记录包含后来简化、延期或放弃的候选，不能作为现行功能或强制待办；当前能力以本文件前部、registry 和现行实现切片为准。

- 对v0.6全部14份活动文档做“先假定为错”的独立证伪：identity/ref、MV3、cross-doc、registry、operation/control/restart、Key/transport/page boundary六条主线。
- 主审逐条接受或拒绝报告建议，形成[审计裁决](audits/2026-08-28-falsification.md)。明确拒绝relay必须端到端不可见Key、10秒不能是Freedom Point、stable extension route identity、atomic takeover和提前清洗。
- 新增[权威与引用中心合同](contracts/authority-and-refs.md)，分离Key/Operation、Runtime/Tab/Document/Node、Occupation/Artifact、relay Instance和transport request的owner/namespace/lifetime。
- 重建operation：高熵带时间ID、有限绝对dedupe window、单调rejectBefore防时钟回拨、per-Key同步reservation、IndexedDB strict accepted/fence/receipt、intent/resolved双digest、cancel和unknown不重放。
- 当时曾设计 exact OccupationId、authority revision 与失效 Key 清理；该候选已被当前无 OccupationId、显式 foreign release 的极简可信协作模型覆盖，只保留 short lane 和 future dispatch gate 两项结论。
- 将三registry改为Freedom/Command/Error/Capability四份；permission declarations独立，manifest由平台基础设施与command依赖共同生成。
- 收紧MV3：IndexedDB跨store事务作为业务权威、storage.session TRUSTED_CONTEXTS、统一hydration barrier、RuntimeEpoch、active cadence而非墙钟SLA、userScripts/host capability probe。
- 把传输拆为agent-relay、relay-extension、extension-wasm三个profile；增加numeric loopback、role/path/subprotocol/Origin门、server-first hello和delivery evidence。
- 选择`keys.create`一次性secret的最小恢复语义；Root持久化为keyKind而非permission snapshot。
- 二次反证补上不可逆revoke+verifier清除、单调security time、authorization/control双revision、AdminMutationId由UI预生成和full reset分步恢复。
- 将“同Key串行”闭合为accepted high-water与terminal-before-next-fence；GC不复用sequence，timeout/uncertain不谎称旧effect停止。
- 拆开frame/inline/采集上限：大结果先做逻辑reservation，artifact与receipt同事务，opaque ArtifactId在留存期内跨browser restart。
- 补齐command schemaVersion、accepted/progress/terminal response envelope、routedInstance回显、read结果撤权复核和phase-sensitive error evidence。
- 推翻NodeRef全局LRU：未过期connected ref不被别的查询驱逐，容量满明确失败；target连续性无法证明时轮换RuntimeEpoch。
- 将清洗和PageIR旧稿移动到`docs/historical/v0.2/`，活动目录、命令和实施树不再引用其模型。
- 个人`coding-guidance`已核对包含用户要求：不把用户陈述当废话；先理解其成立理由，有具体反证再提出。
- 当时没有创建源码/registry/manifest/skill/插件，没有启动进程或操作浏览器。

## v0.8 设计历史：五次反证纠正

- 已创建四份authoring registry草案，但反证确认所有`active` consumer均不存在，因此全部降为pending、consumer清空；Command Registry补上闭合`schemaDeclarations`。
- P0由“零effect却真实连WebSocket”的矛盾路线改为纯build/static bootstrap：无network、storage、alarm、Key或command route。
- 阶段改为P0 build、P1 authority、P2 Key、P3 relay + 带Key的`system.describe`、P4 operation与无TabRef真实纵切、P5 target/control/read、P6 effect；P4的ControlState和synthetic adapter仅为内部验证，不对外伪造能力。
- 中心合同逐一确定AuthorityRealmGeneration、ExtensionRuntimeEpoch、OperationId、Tab/Document/ContentRealm、ArtifactStagingToken、DispatchToken、contentRequestId、connectionGeneration、TransportRouteContext与InstanceRef的owner/generator/invalidator。
- Root改为当前resolved artifact中每个`status=active`的已声明permission atom为true，未来新激活项自动加入；pending/retired不进运行向量，也不是跳过整个表达式。Command authoring当前没有也不暗推`grantable`第二状态；regular管理调用新增atom不能超过调用Key自身逐atom权限，堵住权限洗高。
- Key tombstone改为依赖闭合后的有界GC，并给admin Root恢复保留独立容量；factory reset因自擦去重域而在v1延期。
- relay收窄为`forward | instances.list | relay.stop`，只验证transport shape/bounds/target；bind与path/subprotocol分离，packed Origin禁止首次学习，waitTimeout越界禁止clamp。
- control Agent面只保留acquire/release；精确冻结`none/global_only/target_tab/global acquire`冲突谓词。
- TypeScript改为NodeNext无bundler路线；删除指向尚不存在源码/测试的伪构建脚本。
- 大结果从“全部chunks塞进一个事务”改为不可见staging分块 + 小型原子metadata/receipt commit，保留可见性原子性并避免MV3巨型事务。
- Command authoring补齐common business envelope owner、progress/receipt/ephemeral-result/error-detail schema、一次性secret唯一live recipient与pre-ledger error分类；incoming schema错误不再能抹掉post-fence effect。
- Capability Registry补上bootstrap WebCrypto、explicit strict IndexedDB、alarms与offscreen transport worker等原先只存在于prose或错误宿主中的owner；P3 route闭合service-worker/offscreen-worker/storage.session/alarms/WebSocket组合。
- strict JSON从“双方都校验”落实为不依赖WASM的generated TS scanner + native/WASM共同golden；保留lossless number token，不能用普通`JSON.parse`掩盖decoded duplicate key或IEEE-754舍入。
- Root恢复从含糊的“slot/record”收紧为`empty | active` recovery container；ordinary active与retained tombstone都计配额，recovery revoke原子写独立tombstone并释放承载位。
- OperationId/AdminMutationId先查retained identity、再对absent ID做时间准入；operation route自身返回typed min/max，`system.status`只作可选预取。Delivered窗口外拒绝后client burn；past由单调前沿持续拒绝，future不落tombstone就不伪称永久记忆。13位时间域再减去全部checked-add声明上界形成安全提交域，域外进入clock fault而不污染floor。
- DocumentRef新增extension-owned active-incarnation generation，关闭同documentId经prerender/BFCache再次active而复活旧ref的路径；TabRef retired high-water保留到RuntimeEpoch结束，防tab数字复用。
- Artifact metadata闭合`staging_open/committed/orphaned/released_tombstone`；writer/final commit/terminal close共用phase和writeUntil CAS，终态不能留下仍可增长的staging。
- relay增加从TCP/HTTP pending handshake开始的总socket/header/deadline门，以及native connection、per-client、total、per-extension route、全局buffer与extension auth pool的分层硬上限；网页半握手、多个client或fake relay不能绕出无界状态。
- own/any语义统一：自己的对象接受`.own OR .any`，foreign只接受`.any`和显式targetKeyId；Root不再靠同时拥有两atom掩盖反直觉分支。
- Capability条目删除八份重复的profile Chromium floor；固定`chromium-full-v1` descriptor成为`minimum_chrome_version`的唯一owner，未来API独立下限必须另名并有一手证据。
- authority未ready时不再保留所谓“有界队列”的原始frame、Key或params；只做有界outer/source检查，然后返回`LEDGER_NOT_READY`或关闭route。
- DispatchToken、artifact writer与receipt CAS全部冻结AuthorityRealmGeneration；full reset先赢后，旧realm回调只能丢弃，不能命中新realm记录。
- idle offscreen Port断开后增加固定无业务载荷`transport.bridge.reconnect` wake；page必须主动重建exact Port，background再发送完整递增descriptor，consumer确认前不得把desired误报为applied。
- 浏览器桥超时只允许一条已纳入aggregate budget的frame；artifact read chunk明确是普通inline阈值之外的streaming例外，但base64url膨胀后的整帧仍受message上限。
- raw WebSocket闭合HTTP upgrade、Accept/subprotocol、mask方向、RSV/opcode、control frame、canonical length、fragment与close语义；第三方库也必须通过同一negative corpus。
- 原先只在prose出现的keepalive补成transport descriptor内exact connection-local `transport.ping/pong` shape：canonical u64 pingId、单outstanding、小型控制预算，worker本地消费且不进入background业务Port。
- WebSocket opening request的`credentials=include`推翻“server-first保护全部凭证”；更进一步，当前`ws://`明文候选经代理后连hello之后的bearer Key/命令/结果也可见。P3必须覆盖direct/代理/PAC、默认implicit bypass/`<-loopback>`负例、普通/专用`127/8`、host grant、Cookie/HSTS/HTTP/proxy auth、LNA WebSocket提示及错误101/3xx/Set-Cookie/401/407 response。opening request的托管secret、状态污染或未闭合交互始终阻断；application confidentiality则按所选profile裁决，明文必须有持续DIRECT证据，一般部署否则先用Key端到端保护。
- 并发启动时`address in use`不等于relay ready；每个client startup coordinator只有一个probe在途，前一结束且最小start间隔到达后才在固定endpoint和有界单调总期限内做下一fresh hello，以容纳bind→listen竞态又避免黑洞握手叠加socket。不兼容立即失败，不发Key、不杀未知进程、不扫端口或fallback。
- generated SDK/skill不得内部隐藏生成OperationId并立即发送；caller必须在首个network byte前持有exact ID。CSPRNG probe只证明API/shape/failure，nonzero/namespace碰撞重取有有限attempt，熵质量明示为Chromium/OS信任边界。
- P4外部纵切改用真实`keys.list/get/create/update/revoke`、`settings.get/update`与`operations.get`；synthetic effect永不进入产品registry，`operations.cancel`等真实可取消normal command出现后再active，control route在P5真实TabRef后才开放。
- `127.0.0.1:32189`从误写的冻结值恢复为pending候选；P3可在两平台与浏览器凭证隔离证据后resolve一个专用numeric `127/8` endpoint。native direct-connect忽略proxy/PAC/credential环境，listener使用exclusive/non-inheritable语义。
- relay侧新增application-idle deadline，extension侧保留pong deadline；RFC Ping/Pong不能伪装JS worker活性。资源上限只证明状态/内存有界，敌对网页或同OS进程仍能造成有界availability denial。
- relay的per-socket header/message上限再加global raw-input reservation；所有pending HTTP/role与message assembly bytes在append前计入，不能让局部上限乘socket数形成未验证峰值。
- 上述global raw门仍不是relay总内存证明：新增`build.relay.maximum_managed_memory_bytes`候选，把raw/forward/response、转移copy、socket/route/parser/control开销做checked sum；buffer换owner必须先取得目标预算、并存双计后再释放旧reservation。
- browser WebSocket默认Blob被列为负例：worker在构造器返回同一task切ArrayBuffer并只收发binary。incoming source、background admitted command、outbound source、WebSocket `bufferedAmount`和扩展自有copy/parser/WASM/route/control分别计费；background full scan后先取得目标reservation、copy重叠双计，才exact release `inboundItemId`。全部可控bucket再合计进入`build.extension.maximum_managed_memory_bytes`，同route response不得越过release。outbound exact Port让descriptor/release/response共用一个slot，每项仍用Port-local单调`bridgeItemId`相关，防旧重复ACK误确认下一项；三类item各自有派生count、timeout和公平调度。
- WASM不再被当作managed-memory公式里的含糊“固定开销”：新增64 KiB page对齐的`build.extension.maximum_wasm_linear_memory_bytes`候选，最终binary/imported Memory必须带相同maximum并通过边界`memory.grow`负例。
- authority hydration不再把“cursor分批”误作总heap上界：只常驻有界索引/runnable摘要，完整plan按需加载；P4/P5真实表首次激活时必须同步加入record/index/batch/active-handler count+byte Freedom consumer，当前不预造无consumer slot。
- 该轮曾提出 OccupationId + eligibility revision + compare-and-clear；当前实现明确不采用这套机制，也不自动清理失效 Key。现行 `CONTROL_OCCUPIED` 返回单个 exact 冲突，协作者用独立 release 清除。
- relay明文不再被误列为用户冻结事实。一次P3实验室DIRECT矩阵也不能冻结运行时可变proxy/PAC：明文候选只限能持续证明DIRECT且变化会关socket的deployment；一般Chromium若无这种runtime证据，P3先闭合protected application profile。第四轮进一步确认“由Key材料”不是完整设计：当前verifier-only record不能自动成为会话密钥；推荐把extension endpoint proof封装进同一API Key token，crypto只在native client/extension后台终止，offscreen/relay无decrypt能力。任何credential-equivalent持久化必须另行裁定，opening request/LNA仍单独过门。
- v1 generic adapter没有跨service-worker回执恢复能力；bootstrap看到无本次live continuation的fence就在ready前立即`EFFECT_UNCERTAIN`、清DispatchToken/敏感plan并关闭staging，不能因wall clock fault永久堵住同Key FIFO。
- RuntimeEpoch复用只针对可证明的普通worker recycle；browser restart/disable/reload/update依`storage.session`官方清空语义与顶层startup/install信号失效旧projection，packed目标若出现假连续就fail closed。
- 多实例识别撤下“向每个InstanceRef发送bearer Key做只读探测”：明文profile无明确目标就fail closed；protected profile只可先做无bearer的有界proof探测，唯一匹配后才发送加密Key。复制浏览器profile可能复制Key/realm/private proof，多个匹配必须报告歧义，不能broadcast或虚构跨ledger幂等。
- 新增规划中的`page.archive.capture`，用Chrome `pageCapture`取得当前tab MHTML并写owner-bound Artifact；明确它不是最初HTTP response。accepted先做Artifact逻辑reservation，返回后按Blob size和bounded slice物化；Chrome在API返回前已构造完整Blob、且URL/DocumentRef不变不能证明内容静止，两者均不伪造成扩展可控保证。
- 撤回`tabs.create/close=all_occupations`粗锁候选；它会让无关tab占据破坏不同Key独立。P6必须先闭合目标window、active/inactive与successor副作用，未闭合就保持pending。
- protected profile再闭合MV3 crypto寿命：后台持长会话密钥却让idle offscreen socket跨worker存活是矛盾的。优先评估每请求独立密封与后台持久transport private material；若用长会话则Port/realm一断必须关socket。proof/private key丢失或轮换要求显式Key rotate/reissue，不能从verifier改写旧token或降级明文。
- protected加密层不能绕过内存门：新增计划中的decrypted-application byte bucket与独立transport-crypto并发池；wire膨胀、ciphertext→plaintext→typed command及response反向转换全部先reserve目标、重叠计费，错误proof/tag精确归还且不占Key auth队列。
- P5 content plane补全总量门：DOM采用增量byte/node/depth builder，selector不再以`querySelectorAll`先物化无界NodeList；background在投递前预留content request/reply source及最坏新增NodeRef全局lease，per-realm+global容量同时成立，Port/realm失效释放。浏览器DOM/selector/structured-clone内部成本仍是availability边界。
- `keys.list`与`tabs/frames.list`撤下全量结果假设，统一用collection revision + keyset after、items/encoded-bytes双门；集合变化显式冲突并从头读，不建后台cursor/session、不用offset、不先全量加载。
- operation ledger从软上限改为每phase canonical record/index字节同事务记账；Artifact与ledger使用storage-domain而非per-realm容量。full reset后的旧records/chunks在真实GC batch提交前继续计费，连续reset不能获得新大配额；逻辑账本与IndexedDB物理quota明确分开。
- 完整裁决记录在[2026-08-29反证](audits/2026-08-29-owner-phase-falsification.md)。

## 当前文档权威顺序

1. [裁定记录](decisions.md)中的用户冻结事实。
2. 当前 registry 与[完整指令实现](implementation/command-expansion-slice.md)、[页面树实现](implementation/page-information-tree-slice.md)、[本次修复记录](implementation/review-fixes-2026-08-30.md)。
3. 已对齐现状的 [Freedom Point](design/freedom-points.md) 与页面操作树设计。
4. 较早 contracts/架构/实施计划中的候选不能覆盖用户后续裁定或冒充已经落地；冲突以当前切片和证据明确标记。
5. `docs/historical/**`仅供追溯，机器检查与实施默认排除。

## 下一步

1. `page.tree.open / expand / view.get` 核心已经落地；继续以真实个人页面样本观察折叠摘要是否易读，但不在没有用户新裁定时加入 selection、collapse 或隐藏 reset。
2. 清洗/智能选择算法仍按用户要求后置，开始该阶段时再使用已保存的真实样本独立设计；它不能删除 canonical tree 信息或改变操作引用。
3. CDP/DevTools 保持可选并行能力，不作为主路径，也不尝试绕过 Chromium 自身调试确认。

## 验证状态

最新验证：三份 TypeScript 配置与生成器通过；Node 31 个不同用例、Zig 10 项通过；`tools/test-isolated.mjs all` 在独立端口通过 protocol/client/admin/extension-relay 四项，完整树仍为 65 行、23 次新展开，并明确验证 worker 回收后旧树引用可用、真正刷新后 stale。最终 UI 文案修改另经独立 admin smoke 通过。三份包分别复算 29/9/9 个文件并解压验证 ZIP。旧测试复用 32189 的问题已改为独占 fixture，四个 smoke 禁止直接运行；未为测试停止个人实例。MHTML 偶发失败及 Linux/packed 未验收边界见本批记录。此前个人 B 站交互属于历史验收，不冒充本轮重测；仓库仍无 git metadata。
