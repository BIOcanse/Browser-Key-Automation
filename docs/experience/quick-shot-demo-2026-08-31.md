# 一键截图与 HTML 演示：交付和真实交互

2026-08-31。结论：两个一键入口已完成，68 项 Node、10 项 Zig、四路隔离 Chromium/relay 烟测和三个分包校验通过。未操作个人浏览器、个人 Key 或现有 App。

## 拿来使用

- [扩展 ZIP](D:/Code/浏览器自动化插件/out/quick-shot-demo-2026-08-31/browser-key-automation-extension-dev.zip)：解压根目录直接含 manifest.json，加载这一层。
- [Windows App ZIP](D:/Code/浏览器自动化插件/out/quick-shot-demo-2026-08-31/browser-key-automation-local-app-windows-x86_64-dev.zip)。
- [Linux App ZIP](D:/Code/浏览器自动化插件/out/quick-shot-demo-2026-08-31/browser-key-automation-local-app-linux-x86_64-dev.zip)。

App 包内包含 CLI、配套 skill 和独立启动说明。不要混用旧 CLI；本轮没有代替用户停止旧 App。现有 Root 自动拥有新增权限；Regular Key 的演示功能需要在管理页补授 `artifact.write`、`demo.open`。截图使用既有 `page.screenshot.capture`、`artifact.read`。

```text
node client/browser-key-cli.mjs page-shot --tab-ref <TabRef> --output ./page.png
node client/browser-key-cli.mjs demo-open ./demo.html
node client/browser-key-cli.mjs demo-open ./updated.html --tab-ref <已有演示页TabRef>
```

沿用现有 Key 环境变量/实例参数。截图是网页当前视口，不是整页拼接或 Windows 截屏；目标需已是其窗口的当前标签。演示输入为 UTF-8 自包含 HTML，CSS/JS/必要资源内联，无新 HTTP 服务。直接函数 `saveScreenshot`、`openDemo` 与 CLI 共用同一实现。

## 原始样本与每步所见

使用独立 Chromium 1228 fixture、临时 Key、独占 relay 端口 55029，完整运行在 `out/test-artifacts/isolated-vl1eyz/`。以下文件是从该运行逐字节复制的样本，不是重画的 UI：

- [原始 HTML，83,442 字节](D:/Code/浏览器自动化插件/out/quick-shot-demo-2026-08-31/samples/一键演示原始样本.html)：末尾不可见注释用于证明传输超过单帧；可直接修改这个文件制作演示。
- [更新后的 HTML](D:/Code/浏览器自动化插件/out/quick-shot-demo-2026-08-31/samples/更新后的演示原始样本.html)。
- [22 步原始参数、返回和观察 JSON](D:/Code/浏览器自动化插件/out/quick-shot-demo-2026-08-31/samples/interaction-samples.json)：保留原运行路径、TabRef、ArtifactRef、字节数与哈希，不含测试 API Key。
- [UTF-16LE 失败输入](D:/Code/浏览器自动化插件/out/quick-shot-demo-2026-08-31/samples/不支持的UTF-16LE编码样本.html)：用于验证编码提示，不是受支持的演示输入。

| 原始步骤 | 操作与实际观察 |
| --- | --- |
| 1–3 | 一次 `demo-open` 提交 83 KB HTML。打开后看到大标题“一个 HTML，直接展示。”、两张白色卡片、“脚本已运行”、计数 0 和 40% 滑块；回传长度与 SHA-256 等于原始文件。沙箱 `chrome.runtime.connect` 不存在，读取父页面被阻止。 |
| 4–5 | 默认 `page-shot` 保存 PNG，758×426、27,485 字节。可见右侧滚动条与底部被视口裁切的卡片，证明没有冒充整页截图；文件哈希验证通过。 |
| 6–7 | 测试观察通道点击按钮、把滑块调到 75；看到计数 1、75% 和变长的绿色进度条。随后产品 `page-shot --format jpeg --quality 85` 保存 JPEG，32,525 字节。 |
| 8 | 把 PNG Artifact 当作 HTML 打开，返回 `DEMO_INPUT_INVALID / NOT_HTML`。 |
| 9 | 指定一个普通网页的 TabRef，返回 `DEMO_INPUT_INVALID / NOT_DEMO_TAB`，没有替换它。 |
| 10–11 | 刷新演示页，仍可从有效 Artifact 加载原文件，计数回到 0；保留的是文件内容，不是脚本内存状态。 |
| 12–13 | 用 `--tab-ref` 提交新版 HTML，标题变为“内容已更新，标签页不变。”；返回同一 TabRef，没有增加演示标签。 |
| 14–17 | 声明但未完成的上传不能打开；错误偏移返回 `OFFSET_MISMATCH`，未收齐的 commit 返回上传错误。没有展示半份文件。 |
| 18–20 | 释放新版 Artifact 后刷新，看到“演示文件不可用（ARTIFACT_NOT_FOUND）…请重新提交”，没有使用旧副本冒充成功。 |
| 21–22 | UTF-16LE 文件可原样传输并被浏览器接受导航，但展示页明确提示“演示文件必须使用 UTF-8 编码，请另存为 UTF-8 后重新提交。”命令返回不代表任意 HTML 必然渲染成功。 |

测试按钮/滑块时，CDP 仅用于独立测试观察与输入；展示、上传、打开和截图均走真实产品 CLI → App → 扩展。当前普通 DOM/树/`js.execute` 指令仍不支持扩展演示沙箱，没有将测试通道作为产品后门。

初次截图：

![首次打开：计数0，滑块40%](D:/Code/浏览器自动化插件/out/quick-shot-demo-2026-08-31/samples/01-初始演示.png)

交互后截图：

![交互后：计数1，滑块75%](D:/Code/浏览器自动化插件/out/quick-shot-demo-2026-08-31/samples/02-交互后演示.jpg)

本次完整 CLI 调用耗时：首次提交/打开 140 ms，PNG 截图落盘 108 ms，JPEG 截图落盘 100 ms，原标签更新 98 ms。截图时间包含捕获、读取、校验和本地保存；`demo-open` 计时结束于浏览器接受打开/更新，不包含任意脚本的完成时间。这是单次本机样本，不是性能保证。

## 验收、审查与自由点

- `npm run test:unit`：Node 7 + 56 + 5 = 68 项通过，Zig 10 项通过。完整运行退出 0，日志在[unit.stdout.log](D:/Code/浏览器自动化插件/out/quick-shot-demo-2026-08-31/verification/unit.stdout.log)。
- `node tools/test-isolated.mjs all`：protocol、client、extension、extension-relay 全部退出 0；保留[结果清单](D:/Code/浏览器自动化插件/out/quick-shot-demo-2026-08-31/verification/isolated-results.json)及[真实浏览器日志](D:/Code/浏览器自动化插件/out/quick-shot-demo-2026-08-31/verification/extension-relay.log)。既有等待、树缓存/展开、Key UI、断线恢复等回归一并运行。
- Windows x86_64 / Linux x86_64 ReleaseSafe 构建通过。`dev-package-smoke` 验证 ZIP 层级、扩展 39 个文件、每个 App 14 个文件的哈希、PE/ELF 头和新增 CLI/skill 静态文件。未在 Linux 桌面运行浏览器，不将交叉构建等同于 Linux 交互实测。
- 配套 `browser-key-automation` skill 验证通过。新增指令为 `artifact.upload.begin/append/commit`、`demo.open`；权限两项独立并列，当前合计 45 命令、39 权限。
- 四个新增自由点：上传块最大原始字节数 36,000、演示默认选中 true、截图默认 PNG、JPEG 默认质量 80。现有 Artifact 配额/过期/存储块和 65,536 字节帧预算继续复用；默认值只由 registry 展开，变更测试覆盖实际解析入口。当前共 51 个 active Freedom Point。
- 只读审查未确认 P0–P2 缺陷。修正了非法 Port 消息测试的微任务短路假阳性，补了有效第二块读取；明确 UTF-8 合同和实际错误提示。没有因审查引入第二套状态、鉴权或文件服务器。

保留失败证据：首轮 `isolated-zbvKwx` 的测试通过固定地址猜 sandbox frame，失败后改为读取实际 iframe 身份；`isolated-rQqoXt` 的测试在导航初期访问尚未出现的 documentElement，已修正观察等待的空值处理。两次均不以修改产品权限/浏览器限制来让测试通过。首次完整功能成功记录在 `isolated-cbFCwH`，最终全回归成功记录在 `isolated-vl1eyz`，失败日志仍在原目录。

本轮按 coding-guidance 保留扩展侧业务、薄 App 和自由点归属，按 skill 指导补齐可消费入口、真实观察和原始样本；没有增加 `.real`、目录托管、热更新服务、全页截图或自动占据/解除。
