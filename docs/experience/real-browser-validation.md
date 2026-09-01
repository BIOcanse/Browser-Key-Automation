# 真实个人浏览器体验验证

更新：2026-08-30。本文记录开发包安装后，Agent 通过正常扩展权限和 Key-only 协议直接使用真实个人 Chromium 浏览器时的逐步体验。它不使用测试 profile、批量调试页面或 CDP fallback。

## 目标与边界

- 用户在自己的真实 Chromium 浏览器中以开发者模式加载 unpacked 扩展。
- 本地 Zig relay 正常运行；扩展每 10 秒持续尝试连接，relay 为每条 extension socket 分配 InstanceRef。
- 用户在扩展管理页生成一个 Root Key，并只把该 Key 交给当前可信 Agent。
- Agent 只用 Key 调用当前七条扩展命令；relay 不鉴权、不保存 Key，也不成为业务身份。
- 第一轮只做观察、occupation acquire/release 和无副作用 JavaScript。任何会修改页面、提交表单、导航或关闭 tab 的验证，先在已明确的安全目标页上进行。
- 体验日志不记录 API Key；遇到账号、邮件、内部地址、token 或其他个人信息时，只记录验证结论和必要的脱敏摘要，不把整页内容复制进仓库。
- 含个人浏览器内容的原始样本放在 `F:\code\浏览器自动化插件\browser-samples`；仓库只保存脱敏的操作、结构和完整性记录。`page.dom.get` 的有界结果与借助 `js.execute` 分块转移的完整 live DOM 必须分别标注，不得把截断 preview 冒充全量样本。

## 拆分开发包布局

```text
browser-key-automation-extension-dev/
|-- manifest.json              # Chrome 直接选择这一层
|-- START-HERE.md
|-- SHA256SUMS.txt
`-- ...扩展运行文件

browser-key-automation-local-app-<platform>-dev/
|-- browser-key-relay[.exe]    # 当前平台 executable 直接位于根层
|-- START-HERE.md
|-- SHA256SUMS.txt
|-- client/
|   |-- browser-key-cli.mjs
|   `-- native-websocket.mjs
`-- protocol/transport-profile.json
```

extension 与本地 App 分别提供 ZIP。Chrome 不能直接加载 ZIP；解压 extension ZIP 后选择其解压目录本身，不再进入内部 `extension/`。

## 用户只需执行一次

1. 分别解压 extension 包与当前平台的本地 App 包。
2. 打开 `chrome://extensions`，开启开发者模式，选择“加载已解压的扩展”，定位到 extension 包的解压根目录；该目录直接包含 `manifest.json`。
3. 打开扩展详情页，确认扩展 ID 为 `dbbbehdkedibhielmkaoohbeebnbfjbo`。
4. 开启 Chrome 的 **Allow User Scripts / 允许用户脚本**，然后重新加载扩展；这是 `js.execute` 的浏览器级开关，扩展不会绕过，重载后的 InstanceRef 会变化。
5. 在工具栏或扩展菜单中点击 **Browser Key Automation**，由扩展 action 打开完整 Key 管理页；把默认的 Regular 明确切换为 Root 后生成 Key。Root 不保存权限快照，动态拥有当前全部 active 权限。管理页“后台已连接”不等于 relay 已连接；“详情 → 扩展程序选项”仅作为备用入口。
6. 从创建结果或列表的“显示/复制”操作取得 Root Key并交给当前 Agent。隐藏、刷新或关闭管理页后仍可再次显示；不要把 Key 写进本文、截图、命令行参数或公开日志。

relay 可在加载扩展前或后启动。若先加载扩展，它会保持每 10 秒重试，relay 启动后自动出现实例。

## Agent 直接交互顺序

以下顺序刻意从只读到有协调状态的操作，不把全部能力一次性混在一起：

1. `instances`：验证 relay 握手，记录当前实例数量和 relay-assigned InstanceRef。零实例时不发送 Key。
2. `system.describe`：验证 Root Key、扩展版本、七条 active command、六个 active permission 和 capability 集。
3. `tabs.list`：分页观察真实个人浏览器的 live tab 列表。先记录数量、当前 active tab 和页面类型；个人内容只做必要摘要。
4. `tabs.get`：选择一个安全的真实 tab，验证 TabRef 能精确命中同一 tab。
5. `page.dom.get`：读取该 tab 当前 live DOM，记录标题、URL、HTML preview 是否截断，以及与人眼页面是否一致。
6. `js.execute USER_SCRIPT`：执行只读表达式，观察 DOM 可见、页面 JS global 隔离。
7. `js.execute MAIN`：执行只读表达式，观察页面 world 中的 title/location/少量状态；不修改页面。
8. `control.acquire tab`：用 Root Key 占据该 tab，再重复 acquire 验证同 Key 幂等。
9. `control.release tab`：显式解除占据，验证 `released` 与 previous owner；不使用 takeover/force/合并指令。
10. 根据前九步的真实体验再决定下一条功能或 UI 改进，不以测试脚本的便利性代替真实使用感受。

若 relay 返回多个实例而调用方未明确选择，客户端必须列出实例并停止，不能广播 Key 或默认选择第一个。

## 逐步体验日志

状态：首次 combined 包安装暴露了真实层级问题；现已按 Smart Preload 的 extension/App 层级完成拆分、根层与成品链路验证。Windows 本地 App 已从独立包隐藏启动并保持监听，等待独立 extension 包安装并提供 Root Key。

| 时间 | 步骤 | 目标 | 实际看到的结果 | 交互体验 | 问题/后续 |
|---|---|---|---|---|---|
| 2026-08-29 | 首版安装前 | combined 开发包 | 当时的 unpacked 目录与 ZIP 已生成；27 个包内文件哈希复算、PE/ELF 格式和成品 CLI route 回环通过 | 自动测试通过，但没有消除“用户应该选择哪一层”的安装歧义 | 此结构已被拆分包取代，仅保留为历史证据 |
| 2026-08-29 | 首次 Load unpacked | 用户选择了当时的 combined 包顶层 `browser-key-automation-dev/`，Chrome 显示“清单文件缺失或不可读取，无法加载清单” | Chrome 的报错正确；交付层级本身使用户容易选错，不应要求用户继续寻找内部子目录 | 停止使用 combined 包，改为 extension ZIP 解压根层直接含 `manifest.json` |
| 2026-08-29 | 用户纠正交付结构 | 用户指出应参考预加载插件，分别给浏览器扩展和本地 App | 纠正成立；Smart Preload 的实际发布包也让 extension ZIP 根层直接含 manifest、App ZIP 根层直接含 executable | combined 包停止作为入口，重建三个独立平台产物 |
| 2026-08-29 | 拆分包构建与根层验证 | extension、Windows App、Linux App 分别构建 | extension 根层/ZIP 根层直接含 `manifest.json`；两个 App 根层/ZIP 根层直接含对应 executable；22/5/5 项独立清单、ZIP 摘要、PE/ELF 格式均通过 | 三个制品的名称、根层和说明可以直接分流，不再要求用户理解内部工程布局 | 旧 combined 制品已移出交付根并保留在测试归档中 |
| 2026-08-29 | Windows App 成品链路 | 使用 Windows App 包根层 relay 和包内 CLI 做完整 smoke | 0/1/2 实例选择、current/stale、成功 call、业务拒绝、断线后 delivery unknown、Key 脱敏与 `relay.stop` 全部通过 | 本地 App 解压后无需回到源码树即可完成使用链路 | 等待与真实个人 Chrome extension socket 对接 |
| 2026-08-30 | 首次扩展 UI 入口 | 用户加载扩展后没有看到可用于获取和管理 Key 的正常界面入口 | admin 页面实际已在包内且 `options_page` 已声明，但 manifest 没有 `action`；自动化 smoke 直接拼内部 URL，绕过了用户入口 | 这是产品与测试缺陷，不要求用户记忆内部 URL；增加工具栏 action，点击后打开完整管理页并补入口回归 |
| 2026-08-30 | Key 管理页产品化 | 真实安装暴露旧页面是工程表单，且关闭后不能再查看 Key | 重做为 API 控制台式列表与对话框；新 Key 可反复显示/隐藏/复制，create 丢响应可返回同一已提交 token，旧 verifier-only Key 可显式补存；真实 Chromium 冒烟覆盖完整流程，截图在 `out/test-artifacts/` | 管理入口、重复显示和旧记录迁移已闭合；下一步由用户在个人浏览器重载新开发包并提供 Key 后开始七条命令的真实体验 |
| 2026-08-30 | 真实 relay 与 Key 入口 | Windows 成品 relay 重新隐藏启动后，产品 CLI 看到一个由 relay 编号的扩展实例；用户给予的 Root Key 通过 `system.describe` 鉴权 | 扩展版本、7 条 active command、6 个 active permission 与 Chromium capability 正常返回；Key 只从剪贴板进入临时环境变量，未进入参数、文档或样本 | Key-only 入口与扩展侧鉴权已在用户的真实浏览器成立 |
| 2026-08-30 | `tabs.list` 真实个人会话 | 枚举到 8 个真实 tab，包含媒体首页、登录后 Web App、学习系统、开发站点、Chrome 扩展页和本扩展管理页 | 可清楚看到 active/complete/unloaded，且未加载 tab 没有被读取操作暗中唤醒 | 列表语义符合“观察不产生页面副作用”；文档不记录个人页面正文 |
| 2026-08-30 | `tabs.get` 精确目标 | 对 B 站首页的当前 TabRef 调用 get | 返回 `{tab}` 内的 TabRef、URL、windowId 与 list item 完全相同，status 为 complete，并包含 audible/discarded/autoDiscardable/muted | 消费端必须按合同读取 `result.tab`；首次验证脚本误按扁平 item 读取后立即纠正，不冒充产品故障 |
| 2026-08-30 | tab/global occupation 闭环 | 对同一 tab 与 global 各做两次 acquire、两次 release；只记录 owner 是否相等，不记录 KeyId | 两种 scope 均是：首次 `alreadyOwned:false`，第二次 `true`；首次 release 为 true 且 previous owner 匹配，第二次对空位为 false | 幂等和显式解除语义与裁定一致；`finally` 补偿路径存在，测试结束时 tab/global 都已解除 |
| 2026-08-30 | B 站首页 DOM/JS 最小探针 | 用最新 TabRef 连续执行 `page.dom.get`、`js.execute USER_SCRIPT`、`js.execute MAIN`，每步后重新枚举并比较 generation | DOM 读取成功，返回 43,967 个 JavaScript 字符且 `htmlTruncated:true`；两个 JS world 都在 Chromium API 层返回 `CAPABILITY_UNAVAILABLE`；页面一直是 `complete`，三次调用前后 TabRef generation 都未变 | 已排除鉴权、stale ref、页面导航和单一 world 问题；与安装文档一致，当前最小阻塞是 Chrome **Allow User Scripts / 允许用户脚本** 未对该扩展生效。扩展不降级或绕过这个浏览器开关 |
| 2026-08-30 | JS 能力可诊断性 | 对照 `system.describe` 与真实 `js.execute` 失败形状 | describe 的 active capability IDs 包含 `platform.extension.user_scripts`，而两个 world 的顶层错误只有 `CAPABILITY_UNAVAILABLE`，没有 capability 名或开关指引 | active capability 表达的是当前 command catalog 依赖，不是运行时 readiness。这是已证实的交互摩擦：外部 Agent 无法仅从返回值区分 User Scripts 开关、受限 URL 或其他 Chromium API 失败；暂只记录，未擅自扩展协议 |
| 2026-08-30 | 开启 User Scripts 后重载 | 用户完成 Chrome 开关和扩展重载 | relay 实例从 `1` 变为 `2`，旧 socket 消失；Key 仍有效；`USER_SCRIPT` 和 `MAIN` 探针均 `fulfilled`、未截断 | 开关诊断确认；重载后必须重新枚举 InstanceRef/TabRef，不复用旧引用 |
| 2026-08-30 | 全量样本矩阵 | B 站首页、ChatGPT、Gmail、MDN 文章和 B 站视频页 | 5 份 live DOM/visible text 完成分块、字节数和 SHA-256 复核；完整 DOM 从 157,082 到 4,942,765 bytes | Gmail 只读，视频页静音且暂停；脱敏结构分析见[真实样本分析](real-browser-sample-analysis.md) |
| 2026-08-30 | 页面导航与恢复 | 尝试新 tab，再用已采样 B 站 tab 临时导航 | `window.open` 和 `<a target=_blank>` 都被 Chromium 弹窗策略阻止，tab 数未变；`location.replace` 可靠完成 Gmail→MDN→视频页→B 站首页 | 测试后标签总数仍为 7，B 站首页 status 为 complete；已确认显式 `tabs.create/navigate` 是有证据的候选，但未擅自激活 |

## 早期 preview 样本

样本根目录为 `F:\code\浏览器自动化插件\browser-samples`。下面两份是 User Scripts 开启前保留的 `preview-only` 证据；它们不是全量页面。开启后的 5 份 full 矩阵和完整指标见[真实样本分析](real-browser-sample-analysis.md)。

| 样本 | 目录 | 文件字节 | SHA-256 | 结构观察 |
|---|---|---:|---|---|
| B 站首页 | `2026-08-30T14-37-04-149Z-bilibili-home` | 44,579 | `9521a243974ba04a88160575e19b73c9d3266f31fce6f6ab1ea740ee0048dd11` | preview 在 `</head>` 和 `<body>` 之前就截断；前段已出现 17 个 script、3 个 style，其中已闭合 script/style 占 33,058 个字符 |
| ChatGPT 首页 | `2026-08-30T14-37-04-462Z-chatgpt-home` | 44,389 | `bb7263aee42a6840e7674adb7cbf6378454ade4c19175ccf409592c5c8b577ac` | preview 同样未进入 body；前段有 83 个 link、3 个 style，已闭合 style 占 22,749 个字符；不记录任何会话标题或正文 |

对页面操作树的直接证据是：普通 HTML 从头定长截断会优先保留脚本、CSS、preload 和其他 head 资源，可能完全丢掉主体。这些样本验证“不要将输入字节顺序等同于信息优先级”；现行 `page.tree.open/expand/view.get` 让完整可观察内容从 rootRef 按分支到达，且不另造 selection。

### 开发包前置直接交互记录

这部分使用真实 Windows Zig relay 与产品 CLI，但 extension socket 仍是测试替身；它只记录 companion 的直接交互，不冒充真实个人浏览器体验。

| 日期 | 步骤 | 实际看到的结果 | 结论 |
|---|---|---|---|
| 2026-08-29 | `instances` 短连接 | relay hello、role ready 和一个 relay-assigned InstanceRef 正常返回；此时没有读取 Key | 无 Key 的实例发现路径成立 |
| 2026-08-29 | 第一版客户端退出 | CLI 直接销毁 TCP socket 后，Windows Zig 0.16 I/O 报 `CONNECTION_RESET` 并中止 relay | 客户端退出必须走 masked WebSocket close frame 和正常 FIN |
| 2026-08-29 | 第一版 `call` | `instances` 成功，但 `call` 立即得到 `delivery: unknown`，替身 extension 没收到 route | 异步 `try/finally` 返回 Promise 前必须 `await`；否则 finally 会提前关闭 socket |
| 2026-08-29 | 修正后完整序列 | `instances`、成功 `call`、扩展业务拒绝、无 Key 拒绝、`relay.stop` 依次通过；Key 只在 fake extension 收到的 route 内出现，CLI stdout/stderr 均未出现 | 产品 CLI 的当前最小闭环成立，进入组包门 |
| 2026-08-29 | 最终复核反例 | Upgrade 超时/畸形响应均在有界时间内关闭 socket；假扩展故意在成功结果和错误详情回传 Key 时，CLI 最终只输出 `[REDACTED_API_KEY]`；0/1/2 实例、current/stale 与 forward 后断线均符合闭合语义 | 两个真实使用阻断关闭，实例选择和 delivery unknown 有运行证据 |
| 2026-08-29 | 启动首版 combined 成品 relay | 当时包内 Windows ReleaseSafe relay 隐藏启动，监听 `127.0.0.1:32189`；首个无 Key `instances` 返回当前 epoch 和空列表 | 该旧 relay 随后已用 CLI 正常停止，旧包归档；不再作为当前等待实例 |
| 2026-08-29 | 启动拆分后的 Windows 本地 App | 从 `browser-key-automation-local-app-windows-x86_64-dev/` 根层隐藏启动 ReleaseSafe executable，实际 PID 为 10068，监听 `127.0.0.1:32189` | 进程保持运行；启动目标就是本地 App 包根，不依赖旧 combined 路径 |
| 2026-08-29 | 用同包 CLI 查询当前实例 | 第一次因执行命令的工作目录已经在 App 根、却又叠加 `out/...` 相对路径而在本机文件解析阶段停止；改用包内 CLI 绝对路径后立即返回一个 relay epoch 和 `instances: []` | 错误发生在读取 Key 前且未影响 App；空实例符合真实扩展尚未成功加载，App 继续等待 extension socket |

详细记录采用下面的闭合格式：

```text
步骤：
指令：
目标摘要：            # InstanceRef/TabRef 可记；API Key 不记
实际输出摘要：
与人眼页面对照：
等待时间与反馈：
是否需要猜测下一步：
发现的问题：
结论：
```

## 当前验收门

- 独立 extension 包内 manifest、生成 catalog 和源码构建产物必须来自同一次构建；App 不得混入扩展安装根。
- Windows/Linux relay 均用 ReleaseSafe 构建；包内文件提供 SHA-256 清单。
- CLI 在发送任何 Key 前必须验证 exact relay hello/profile/protocol，并先取得 current InstanceRef。
- CLI 不在参数、stdout、stderr 或错误对象中回显 Key。
- 真实浏览器阶段的结果以本文日志为准；现有自动化 smoke 只保留回归门，不再冒充个人浏览器体验。
