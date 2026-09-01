# 等待、查找和一键保存：实际交互与交付

2026-08-31。本批已实现并通过隔离回归，未操作个人账号、未重启用户现有 App，也未替换已加载的扩展目录。下面是扩展命令返回和文件检查的观测，不把源码推演写成真实浏览器结果。

## 能直接用什么

`page.wait` 用 `until` 指定等待阶段：`committed`（导航已提交）、`domcontentloaded`、`complete`（默认）。还可显式等 URL、节点出现/消失/可见/启用或指定文字。省略 `timeoutMs` 为 10000；当前构建允许 1–60000。条件已经满足立即返回 `already_satisfied` 和提示，没有额外页面动作；页面 complete 不代替显式文字/节点条件。

一条命令保存网页，返回的不是只有 ArtifactRef，而是磁盘上可读取的 MHTML 单文件：

```text
node client/browser-key-cli.mjs page-save --tab-ref <TabRef> --output ./page.mhtml
```

Key 仍从环境变量取得，多实例显式加 `--instance`。也可调用相同实现的 `savePage({ tabRef, output })`；已有 Artifact 用 `artifact-save`。保存不自动等待页面、不覆盖同名文件、不重复采集、不隐式释放 Artifact。精确参数和限制见[配套 skill 的使用说明](../../skills/browser-key-automation/references/wait-and-save.md)。

`page.tree.find` 在原有完整规范树中查找，可以穿过折叠分支，但不改变任何 Key 的展开状态。结果仍使用原来的 indexPath / TreeRef / NodeRef；`from` 是包含起点的规范索引，截断时 `nextIndexPath` 指向首个未处理项。没有另建清洗树或重点区。

## 本次运行与原始文件

使用独占测试 Chromium、临时 profile 和本地 HTML 页面。relay 使用隔离端口 58037；测试页 HTTP 端口 60590。所有页面动作经实际扩展命令，HTTP 服务只控制响应何时到达以确定加载阶段。没有借用个人浏览器会话。

- [完整测试执行结果](D:/Code/浏览器自动化插件/out/test-artifacts/isolated-tEhcmE/results.json)：所有命令退出 0。
- [33 步原始请求参数及返回](D:/Code/浏览器自动化插件/out/test-artifacts/isolated-tEhcmE/out/test-artifacts/usability/interaction-samples.json)：不含鉴权信封或 Key；包含当次页面内容和临时引用。
- [真正保存出的网页](D:/Code/浏览器自动化插件/out/test-artifacts/isolated-tEhcmE/out/test-artifacts/usability/实际网页另存为.mhtml)：2402 bytes；不是重新拼装的示意 HTML。

MHTML SHA-256：`4efb42ac07c5c23802e21162569405b7746d09610fded276fe6cd0eb46225d93`。文件以 `From: <Saved by Blink>`、`MIME-Version: 1.0`、`multipart/related` 开始，HTML 内能找到修改后的纯文本、ready 状态和开放 Shadow DOM 模板。Artifact 返回的长度/哈希已与本地文件独立复算一致。

样本保存在上述隔离目录，没有随测试 profile 清理而删除。临时服务/页面已结束，记录中的引用是证据，不是可在个人实例复用的目标。

## 每一步实际看到什么

下表序号对应原始 JSON 的 sequence。耗时是这一次的观测，不是性能承诺。

| 步 | 操作 | 返回/观察重点 |
|---:|---|---|
| 1 | `tabs.create` | 打开非活动测试页，获得 TabRef。 |
| 2 | 默认 `page.wait` | `already_satisfied`，32 ms；省略超时解析为 10000，页面 complete。 |
| 3 | 再次默认等待 | 2 ms 返回 `already_satisfied`，明确提示无需等待或页面动作。 |
| 4 | `page.tree.open` | 获得当前 Document 对应的缓存 root。 |
| 5 | `page.tree.view.get` | 只见顶层 `[0]` doctype、`[1]` HTML；HTML 仍折叠。 |
| 6 | find `#shadow-action` | 找到 `Shadow-only action` 按钮，路径 `[1,1,0,6,1,0]`；host 没有普通 DOM 子节点也能进入开放 shadow root。 |
| 7 | find `#disabled` | 返回禁用按钮的真实 NodeRef。 |
| 8 | 点击禁用按钮 | `DOM_OPERATION_FAILED`，没有谎报点击生效。 |
| 9 | find `#editable` | 定位 contenteditable 节点。 |
| 10 | `dom.focus` 不写机械参数 | 成功；默认 preventScroll=true。 |
| 11 | `dom.scroll` 不写机械参数 | 成功；默认 auto / center / nearest。 |
| 12 | `dom.setValue` | 输入 `<b>真实纯文本</b>`，descriptor.text 正是这个字符串。 |
| 13 | `page.dom.get` | HTML 中是转义后的 `&lt;b&gt;真实纯文本&lt;/b&gt;`，不是偷偷插入粗体标签。 |
| 14 | find `#remove` | 找到会在点击时移除自己的按钮。 |
| 15 | 第一次点击 | 操作成功，页面脚本移除节点。 |
| 16 | 再点击同一 NodeRef | `TARGET_REF_STALE`；没有重新选择一个相似按钮。 |
| 17 | find `#late-button` | 找到异步内容触发按钮。 |
| 18 | 点击 | 页面开始延迟修改状态文字。 |
| 19 | wait text `#late-text` contains `ready` | `satisfied`，435 ms；虽然 Document 已 complete，仍等显式文字条件。 |
| 20 | wait present `#missing`，150 ms | `timed_out`，150 ms；提示不代表之前动作失败。 |
| 21 | 再取整体树视图 | 仍只有 `[0]`、`[1]`，展开标志不变。find 没有偷偷展开祖先。 |
| 22 | CLI `page-save` | 一次调用得到真正的 2402-byte MHTML，校验通过。 |
| 23 | 导航到延迟返回的 URL | 请求已发起，服务端暂不返回新页面。 |
| 24 | 默认 complete 等待，150 ms | `timed_out`，159 ms。旧 Document 虽 complete，但 navigationPending=true，不能算新页完成。 |
| 25 | 放行新页面后再等 | 6 ms 返回已满足；观测的是新 Document。 |
| 26 | 导航到阶段测试页 | HTML 到达；defer 脚本和图片暂不放行。 |
| 27 | wait committed | 1 ms 已满足；不要求 DOM 探测，此时不能把返回的占位 DCL=false 当成 DCL 判定。 |
| 28 | wait domcontentloaded，150 ms | 152 ms 超时；readyState=interactive，但 DCL 尚未发生。 |
| 29 | 放行 defer 脚本，再等 DCL | 1 ms 已满足；仍 interactive，DCL=true，图片还没完成。 |
| 30 | 重复等 DCL | 3 ms 已满足，没有再等下一轮事件。 |
| 31 | 等 complete，150 ms | 165 ms 超时；DCL=true 并不等于所有加载完成。 |
| 32 | 放行图片，再等 complete | 2 ms 已满足，readyState=complete。 |
| 33 | 重复默认等待 | 1 ms 已满足，没有刷新或再次加载。 |

步骤 3 的原始提示为 `Already satisfied: complete; no waiting or page action was needed.`。步骤 19 的页面定时器设为 200 ms，但实际条件观测用了 435 ms；后台页面调度和命令往返都会影响时间，不能把配置间隔当成严格墙钟保证。

阶段依据是 [Chrome webNavigation 的生命周期说明](https://developer.chrome.com/docs/extensions/reference/api/webNavigation) 和 [Document.readyState](https://developer.mozilla.org/en-US/docs/Web/API/Document/readyState)。实现用当前精确 Document 的状态/NavigationTiming 查询已发生阶段，不依赖订阅后才收到一次事件，因此不会漏掉调用之前已经完成的页面。complete 不是 SPA 数据就绪或 network-idle 的同义词。

## 架构与自由点检查的裁决

| 检查项 | 本批处理及证据 |
|---|---|
| 业务归属 | 扩展继续拥有 Key、权限、引用、占据、Artifact、等待和树；Zig relay 仅路由/分配实例。保存文件的组合在 CLI，不给 App 增加业务鉴权。 |
| 默认值唯一源 | Command schema 引用 Freedom Point，正式 parser 统一展开一次；显式值仍必须合法，不把 null 当成省略。 |
| 字符串/布尔自由点 | 生成器新增 typed 默认投影与类型/枚举检查，focus/scroll/默认等待阶段不再依赖 handler 内另一套默认。 |
| CLI 连接配置 | 移除 main/native-websocket 复制的 endpoint/profile 常量，二者都 import 同源 generated-config；Windows/Linux 包带齐依赖。 |
| 文件分块 | CLI 省略 maximumBytes，由扩展按既有 Artifact 读取上限展开；没有再写一份 36000。每块检查身份、长度、偏移、进度，最终验哈希。 |
| 真实改点实验 | 在隔离源副本改等待默认 7000、focus=false、scroll block=start、端口 32190。实际 parser 结果及 CLI/Zig 生成投影跟随改变；错误枚举与默认值类型被构建门拒绝。 |
| find 与性能预算 | 独立审查找到 childCount 误挡属性/开放 shadow/长值分块；已修正并补单测及真实 shadow 场景。原 textLabel 宽节点全量入栈改为逐节点帧遍历；十万子节点、label 预算 1 的测试，摘要读取子节点次数为 0。 |
| 控制/重试边界 | 保留同 Key 串行、独立 acquire/release、不隐式抢占。wait 只观察；保存只 capture 一次。失败不重放业务操作。 |

当前 41 条 active command、37 个 active permission、47 个 active Freedom Point。`page.wait` 是独立权限，旧 Regular Key 需显式授予；Root 自动覆盖当前全部 active 权限。`page.tree.find` 复用 `page.tree.read`。

自由点检查不等于证明全仓没有任何字面常量。consumer 路径检查尚不是完整语义反向扫描；历史 UI/算法常量没有被全部改造成运行设置，也没有为此引入配置平台。具体边界见[现行自由点说明](../design/freedom-points.md)。独立审查只给证据与报告，裁决、源码和测试修改均由主线程完成。

## 测试与包

- Node：`node --test tests/*.test.mjs`，53/53 通过。新单测覆盖等待固定期限/挂起探测、旧文档竞态、查找分页/折叠状态、DOM 前置检查、文件完整性/中断/同名竞争、真实默认参数消费。
- Zig：`zig build test --summary all`，10/10 通过。
- 隔离 Chromium：`node tools/test-isolated.mjs all`，协议、CLI、管理页、扩展—relay 全部退出 0；新场景为上述 33 步。原有 Key/占据、页面树及 worker 回收/真正刷新后的引用行为保持回归。
- Windows/Linux：ReleaseSafe x86_64 构建成功；Linux 仅交叉编译，未在 Linux 主机运行。
- 分包：`node tests/dev-package-smoke.mjs out/usability-2026-08-31` 通过，校验扩展 30 文件、两平台 App 各 12 文件、解压根目录、CLI 可导入执行及 ZIP/文件摘要。
- 项目配套 skill 的 quick_validate 通过；skill-creator 指导使一键函数和 CLI 说明复用真实实现及生成 registry，没有另写一份接口目录。

| 开发包 | ZIP SHA-256 |
|---|---|
| [扩展](D:/Code/浏览器自动化插件/out/usability-2026-08-31/browser-key-automation-extension-dev.zip) | `7e436e6f21f0e72b7fab1f71d8584bc33a4f611e5bdcaa2853d272eaa57df13d` |
| [Windows App + CLI + skill](D:/Code/浏览器自动化插件/out/usability-2026-08-31/browser-key-automation-local-app-windows-x86_64-dev.zip) | `c2d8da7bcf12cd06a84e945a000d497f7e5551226f76ca9b7dc29d90d97f94fb` |
| [Linux App + CLI + skill](D:/Code/浏览器自动化插件/out/usability-2026-08-31/browser-key-automation-local-app-linux-x86_64-dev.zip) | `010465e1e86840c8f2b9cc63c5bb5b2da61f3e88eed0a6c3cd468429d65f904c` |

对应扩展 buildId：`extension-19ddb6ec6047d7d8dccdea27`；relay buildId：`relay-68b3dfeaecc5b789b89222de`。buildId 是源码/配置构建标识，不是可执行文件哈希。扩展可由 `system.describe` 查看，App 可由新 CLI `instances` 查看 relayBuildId；应使用同包 CLI 和 App，旧 hello 没有新增字段，不做静默猜测兼容。

最后检查个人 relay 仍为 127.0.0.1:32189 的 PID 46104，未被隔离测试停止；本批未重载个人扩展。使用新能力需要更新扩展，并换用这批 App/CLI。新解压目录与旧包并存，未删除旧交付。

## 尚未宣称解决的事项

历史一次 MHTML `STORAGE_UNAVAILABLE` 偶发错误仍未定位；本批两次实际保存通过，不等于根因修复。MHTML 不保证所有动态资源离线可执行；文件发布需要支持同目录 hard link 的文件系统（本机 NTFS 已验证）。DOM 事件不是可信硬件输入，不保证所有富文本框架兼容。以上没有通过暗加 CDP、自动重试或新任务系统来掩盖。
