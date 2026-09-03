# Browser Key Automation

[English](README.md) | 简体中文 | [繁體中文](README.zh-TW.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Deutsch](README.de.md) | [Français](README.fr.md) | [Español](README.es.md) | [Português (Brasil)](README.pt-BR.md) | [Русский](README.ru.md)

Browser Key Automation 把你正在使用的 Chromium 浏览器变成面向可信 Agent 和自动化程序、由 Key 划定权限的控制面。扩展只需安装一次；创建 Key 后，获授权客户端无需另开自动化浏览器，就能随时跨越现有的已登录标签页工作。

主路径使用普通扩展 API，不接入 CDP、WebDriver、远程调试开关或 `chrome.debugger`。Chromium 仍负责扩展安装、站点访问和一次性的 **Allow User Scripts** 设置；完成这些正常设置后，日常浏览器指令不会附加调试器，也不会出现 Chrome 的调试连接确认或警告条。

## 为什么选择 Browser Key Automation

- **无缝操作眼前这一个浏览器。** 随时列出、新建、选择、导航、刷新和关闭标签页，同时保留用户真实的登录状态、Cookie、扩展和手动到达的页面状态。
- **把完整网页变成 Agent 看得懂的干净视图。** 缓存的 canonical 操作树始终保留整体结构，只展开请求的分支；每枚 Key 的展开状态会保留到文档变化，并可一次性读取指定深度、区间或子树而不改变缓存状态。
- **用 Key 划定信任，而不是暴露调试端口。** Root/Regular Key 具有明确权限、有效期、再次显示、禁用和吊销控制。同一 Key 的调用串行，不同 Key 可以互不干扰地工作。
- **一个后缀切换到原生点击。** Windows 上的 `dom.click.real` 会把扩展取得的元素几何信息交给本地 App，在网页拒绝合成 DOM 激活时发送操作系统级左键点击；目标仍必须存活、可见、可用且未被遮挡。
- **文件是一等能力。** 一键保存 MHTML、截取可见视口、把资源取为有界 Artifact 并落盘、上传自包含 HTML，再无需本地 Web 服务直接在浏览器打开演示。
- **为可信多客户端协作准备。** Key 可占据标签页或全局以避免脏状态；其他有权 Key 必须先显式解除原占据，再自行占据。

### 使用路线对比

连接模型核对于 2026-09-01。这里比较常规使用路线，不比较理论功能上限。

| 路线 | 能否使用现有已登录 Chromium | 常规控制路径 | 最适合 |
| --- | --- | --- | --- |
| **Browser Key Automation** | 可以，可跨任意已授权标签页 | 普通扩展 API + Key 鉴权；本地 App 补充路由、文件与可选 `.real` 点击 | 无需附加调试器的长期可信 Agent 控制、选择式缓存树和一体化文件流程 |
| [Playwright](https://playwright.dev/docs/api/class-browsertype)、[Puppeteer](https://pptr.dev/guides/browser-management)、[Selenium](https://www.selenium.dev/documentation/overview/) | 常规路线创建自动化会话，也都存在连接现有 Chromium 的方式 | Playwright/CDP、Puppeteer/CDP 或 WebDriver | 确定性测试、跨浏览器验证、CI，以及成熟的定位与调试生态 |
| [Playwright MCP 扩展](https://github.com/microsoft/playwright/tree/main/packages/extension#readme) | 可以；profile token 可取消其自身后续连接审批 | 通过声明 Chrome `debugger` 权限的扩展转发 Playwright | 在选定现有标签页上使用 Playwright 动作与 accessibility snapshot |
| [Chrome DevTools MCP](https://developer.chrome.com/docs/devtools/agents/use-cases/auto-connect) | 可以，但要先开启远程调试或暴露调试端点 | DevTools/CDP；Chrome 的 auto-connect 路线每次调试会话都要求用户允许 | Console、Network、Performance、内存等深度 DevTools 诊断 |
| [Browser MCP](https://browsermcp.io/) | 可以，但要由用户先连接当前标签页 | 扩展 + 本地 MCP，作用于显式连接的工作标签页 | 面向一个已选现有标签页的精简 MCP 能力面 |
| [Chrome MCP Server](https://github.com/hangwin/mcp-chrome) | 可以，可跨标签页 | 扩展 + native-messaging bridge；manifest 在普通扩展权限外还请求 `debugger` | 丰富的跨标签页 MCP、网络捕获、下载与文件上传工具 |
| [Nanobrowser](https://github.com/nanobrowser/nanobrowser) | 可以 | 基于 Puppeteer/CDP 的浏览器内集成 Agent，用户提供 LLM provider Key | 一体化多 Agent UI，而不是与 provider 无关的浏览器控制面 |

Browser Key Automation 不替代 Playwright/Selenium 测试套件，也不替代 DevTools 深度诊断。它填补的是另一块：低摩擦、可配置权限地控制人正在使用的浏览器，并提供足够干净的结构和文件能力，让 Agent 完成实际任务。

> 发布方式：[GitHub Releases](https://github.com/BIOcanse/Browser-Key-Automation/releases/latest) 提供适用于 Chrome/Chromium 138 及以上版本的已解压扩展包和独立本地 App；Chrome 应用商店采用单独的发布流程。每个 Release 固定只有两个下载项：`browser-key-automation-extension-v0.0.0.3.zip` 与 `browser-key-automation-local-app-v0.0.0.3.zip`。

## 当前能力

- 在本地管理页创建、显示、复制、更新、禁用和吊销 Root/Regular Key。完整 Key 保存后仍可再次显示，不采用只展示一次的限制。
- 枚举标签页，并使用绑定当前运行期的 `TabRef`、`DocumentRef`、`NodeRef`、`TreeRef` 和 `ArtifactRef`，而不是裸浏览器 ID。
- 浏览缓存的页面操作树。展开状态按 Key 保存；只要页面文档没有刷新或替换，切到其他页面再回来仍会保留。
- 在不展开树的情况下查找节点；一次性读取指定层级、同父区间或子树；读取有界 live DOM、描述节点并执行 DOM 操作。
- 浏览器开启 **允许用户脚本** 后，在明确的 `USER_SCRIPT` 或 `MAIN` world 中执行 JavaScript。
- 等待导航、`interactive`、`complete`、DOM 或文本条件。
- 将当前网页保存为 MHTML、获取经过校验的视口截图、传输有界 Artifact，以及不启动本地 HTTP 服务直接打开自包含 HTML 演示。
- 通过 `dom.click.real` 发送显式 Windows 原生左键点击；它拥有独立于普通 `dom.click` 的权限。
- 让某个 Key 占据标签页或全局。其他有权 Key 必须先显式解除原占据，再自行占据。

精确方法、schema、权限和错误以 Command Registry 为准。`system.describe` 会返回当前构建和调用 Key 的实际有效权限。

## 快速开始

### 环境要求

- Chrome 或兼容的 Chromium 浏览器，138 及以上版本
- Windows x86_64 或 Linux x86_64 本地 App
- 包内 CLI 需要 Node.js 20 及以上版本

### 1. 下载扩展和 App

从[最新 Release](https://github.com/BIOcanse/Browser-Key-Automation/releases/latest) 下载两个 ZIP，分别解压到独立目录。

- 扩展: `browser-key-automation-extension-v0.0.0.3.zip`
- 本地 App: `browser-key-automation-local-app-v0.0.0.3.zip`

App ZIP 内含 `windows-x86_64/`、`linux-x86_64/`、CLI 和 Agent skill，无需自行编译。

### 2. 加载扩展

1. 完整解压扩展包。
2. 打开 `chrome://extensions`，开启开发者模式，点击 **加载已解压的扩展程序**。
3. 选择根目录直接含 `manifest.json` 的解压目录。
4. 在扩展详情页开启 **允许用户脚本 / Allow User Scripts**，然后重新加载扩展。这个由浏览器管理的开关只对 `js.execute` 必需；不开启时 Key 管理、DOM 和页面树仍可使用。
5. 从工具栏打开 **Browser Key Automation**。可信全权控制可创建 Root Key；需要缩小范围时创建只含必要权限的 Regular Key。

首次安装会打开本地说明页；普通更新和重新加载不会反复弹出。

### 3. 启动本地 App

解压 GitHub Release 的 App 包，并保持当前平台的 relay 运行：

```text
# Windows
.\windows-x86_64\browser-key-relay.exe

# Linux
chmod +x ./linux-x86_64/browser-key-relay
./linux-x86_64/browser-key-relay
```

默认端点为 `127.0.0.1:32189`。App 不可用时，扩展会按当前配置的名义 10 秒间隔持续重连，直到连接成功。固定端点已有兼容 App 时不要再启动第二份。

### 4. 连接 CLI

在解压后的本地 App 目录执行：

```text
node client/browser-key-cli.mjs instances
```

该命令不需要 Key。返回 0 个实例表示扩展尚未连接；存在多个实例时必须选择明确且仍有效的 `relayEpoch/instanceNumber`，不得把 bearer Key 逐个尝试。

Key 只通过环境变量提供，不能放入 argv：

```powershell
# PowerShell
$env:BKA_API_KEY = "bk1.<key-id>.<secret>"
node .\client\browser-key-cli.mjs call --method system.describe --schema-version 1 --params-json "{}"
```

```bash
# Bash
export BKA_API_KEY='bk1.<key-id>.<secret>'
node client/browser-key-cli.mjs call --method system.describe --schema-version 1 --params-json '{}'
```

CLI 会先重新枚举实例，再读取 Key。若结果的 delivery 为 `unknown`，它就确实未知；不得自动重试有副作用的指令。

## 常用流程

- 页面发现：`tabs.list` → `page.tree.open` → `page.tree.find` 或 `page.tree.expand.v2` → `page.tree.view.get`。
- 页面同步：使用 `page.wait`；省略 timeout 时为 10 秒，条件已经满足则立即返回。
- 保存网页：`node client/browser-key-cli.mjs page-save --tab-ref <TabRef> --output ./page.mhtml`。
- 获取视口截图：`node client/browser-key-cli.mjs page-shot --tab-ref <TabRef> --output ./page.png`。
- 打开演示：`node client/browser-key-cli.mjs demo-open ./demo.html`。
- 调用不熟悉的指令前先看 `skills/browser-key-automation/references/commands.registry.json`。交付包中的 Agent skill 带有同一份生成引用。

### 元素图片与显式调试

`page.screenshot.element` 让 Agent 直接用已有 NodeRef 查看 Canvas、图表或容器：包括可见子元素，按已支持的形状裁剪，等比居中放进指定尺寸的透明 PNG。不需要自己算屏幕坐标，也不附加调试器。

```text
node client/browser-key-cli.mjs element-shot --node-ref <NodeRef> --width 800 --height 600 --output ./element.png
```

需要深入排查时，使用 `debugger.attach` → `debugger.send` → `debugger.events.get` → `debugger.detach`。独立的 `debugger` 权限提供 CDP 命令和事件；Chrome 自身的调试确认或警告仍然保留。日常扩展操作继续走原来的通道。

元素截图只取已激活标签页的当前视口，不自动滚动或重建隐藏内容。支持的形状、顶层文档范围、元素局部区域、大型 CDP 结果与失败处理见 [Agent 使用说明](skills/browser-key-automation/references/debugger-and-element-capture.md).

### 原生 `.real` 点击

`dom.click.real` 是显式且独立于 `dom.click` 的能力。Windows 上，它会请求 Chromium 激活目标标签页并聚焦对应浏览器窗口，验证引用元素仍然存在、可见、可用且未被遮挡，然后让本地 App 向匹配的 Chromium 内容窗口发送一次原生左击。

`{ "status": "input_sent" }` 只表示一组输入已被接受，不表示网站业务目标已经完成；之后应重新观察页面。未知或失败的原生输入绝不能自动重放。Linux App 当前不声明 `native.input.click.v1`，因此扩展会在任何页面准备动作之前拒绝 `.real`。

## Key、权限与占据

- Key 是唯一外部身份。Agent 品牌、进程、账号、socket 和 App 实例都不是额外鉴权身份。
- Root 动态拥有全部 active 权限；Regular 只拥有显式勾选的权限。
- JavaScript、普通 DOM 操作、原生 `.real` 输入、网络访问和显式 `debugger` 调试是并列权限；授予一个不会暗中授予其他项。
- 同 Key 指令在当前扩展运行期内串行。不同 Key 有独立 lane，但它们对同一网页产生的效果仍可能竞态。
- 占据归 Key 所有。没有隐藏 takeover、force 或 replace：必须先 release，再 acquire。
- 完整 Key 保存在扩展内部。受信管理页以及被单独授予 `keys.create` 或 `keys.reveal` 的调用方可以取得它；普通列表和诊断不含完整 Key。CLI 只从 `BKA_API_KEY` 或显式指定的环境变量读取。

高权限 Key 等同于本地浏览器控制凭证，只应交给可信 Agent 或自动化程序。Key 的技术权限永远不能替代用户对支付、发帖、发送消息、修改账号、删除数据等重要操作的授权。

## 浏览器与平台边界

Chromium 仍然拥有 host access、受限页面、file URL 访问、**允许用户脚本** 开关、扩展启停和 DevTools 调试确认。Root 无法绕过这些浏览器边界。

Windows/Linux App 都提供路由和文件落地；Windows 额外声明当前原生点击后端，Linux 暂不声明。无痕模式和其他 Chromium 衍生浏览器必须按各自 profile 与策略实际验证。

Agent 接入：[Browser Key Automation skill](skills/browser-key-automation/SKILL.md)。

本项目由作者维护，不接受外部贡献或 Pull Request。
