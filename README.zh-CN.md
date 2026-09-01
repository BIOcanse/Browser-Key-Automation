# Browser Key Automation

[English](README.md) | 简体中文 | [繁體中文](README.zh-TW.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Deutsch](README.de.md) | [Français](README.fr.md) | [Español](README.es.md) | [Português (Brasil)](README.pt-BR.md) | [Русский](README.ru.md)

Browser Key Automation 让可信 Agent 或自动化程序通过 Manifest V3 扩展和一枚 API Key 操作已授权的本地 Chromium 浏览器。

扩展拥有 Key 鉴权、权限、浏览器引用、占据和浏览器操作；小型 Zig 本地 App 只负责本地路由、由 App 分配的浏览器 Instance 引用、文件落地，以及它明确声明的平台原生能力。

> 开发状态：当前已解压扩展开发包面向 Chrome/Chromium 138 及以上版本；它目前不是 Chrome 应用商店发布版。

Chrome Web Store 工作已暂停，等待正式图标设计。请使用 [GitHub Releases](https://github.com/BIOcanse/Browser-Key-Automation/releases)：每个 Release 固定只有两个下载项，`browser-key-automation-extension-v0.0.0.1.zip` 与 `browser-key-automation-local-app-v0.0.0.1.zip`。详见 [GitHub Release 交付合同](docs/implementation/github-release-delivery.md)。

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

## 架构

```text
Agent / 自动化程序
        |
        | BKA_API_KEY + 指令
        v
Windows 或 Linux Zig 本地 App
        |
        | 本地 loopback 路由 + App 分配的 InstanceRef
        v
MV3 offscreen transport
        |
        v
扩展 service worker
        |
        +-- Key 鉴权和权限
        +-- 占据与运行期引用
        +-- 标签页、页面树、DOM、JavaScript、Artifact
        `-- 可选的平台能力请求
```

扩展是唯一业务状态 owner。本地 App 不保存 Key 数据库，也不决定浏览器权限。每个成功连接的扩展由 App 分配 Instance 引用；扩展不会自行生成或持久化实例编号。

主路径使用普通扩展权限。CDP/DevTools 可以保持为并行可选能力，但 Chromium 自己的调试确认无法由本项目取消。

## 快速开始

### 环境要求

- Chrome 或兼容的 Chromium 浏览器，138 及以上版本
- Windows x86_64 或 Linux x86_64 本地 App
- 包内 CLI 需要 Node.js 20 及以上版本
- 只有从源码构建本地 App 时才需要 Zig

### 1. 构建拆分包

```text
npm ci
npm run build:dev-package
```

构建会产生三个互相独立的压缩包：

- `out/browser-key-automation-extension-dev.zip`
- `out/browser-key-automation-local-app-windows-x86_64-dev.zip`
- `out/browser-key-automation-local-app-linux-x86_64-dev.zip`

扩展和本地 App 刻意分开交付。每个包都有自己的 `START-HERE.md` 和 `SHA256SUMS.txt`。

`npm run build:github-release` 会把这些已经验证的中间包聚合成 GitHub 使用的两资产结构：一个扩展 ZIP，以及一个带 `windows-x86_64/`、`linux-x86_64/` relay 目录和单份公共 CLI、协议、Agent skill 的 App ZIP。

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

按平台拆分的 `-dev` App 中间包仍把 relay 放在压缩包根部；使用开发中间包时按其中的 `START-HERE.md` 操作。

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

### 原生 `.real` 点击

`dom.click.real` 是显式且独立于 `dom.click` 的能力。Windows 上，它会请求 Chromium 激活目标标签页并聚焦对应浏览器窗口，验证引用元素仍然存在、可见、可用且未被遮挡，然后让本地 App 向匹配的 Chromium 内容窗口发送一次原生左击。

`{ "status": "input_sent" }` 只表示一组输入已被接受，不表示网站业务目标已经完成；之后应重新观察页面。未知或失败的原生输入绝不能自动重放。Linux App 当前不声明 `native.input.click.v1`，因此扩展会在任何页面准备动作之前拒绝 `.real`。

## Key、权限与占据

- Key 是唯一外部身份。Agent 品牌、进程、账号、socket 和 App 实例都不是额外鉴权身份。
- Root 动态拥有全部 active 权限；Regular 只拥有显式勾选的权限。
- JavaScript、普通 DOM 操作、原生 `.real` 输入、网络访问和未来调试后端是并列权限；授予一个不会暗中授予其他项。
- 同 Key 指令在当前扩展运行期内串行。不同 Key 有独立 lane，但它们对同一网页产生的效果仍可能竞态。
- 占据归 Key 所有。没有隐藏 takeover、force 或 replace：必须先 release，再 acquire。
- 完整 Key 保存在扩展内部。受信管理页以及被单独授予 `keys.create` 或 `keys.reveal` 的调用方可以取得它；普通列表和诊断不含完整 Key。CLI 只从 `BKA_API_KEY` 或显式指定的环境变量读取。

高权限 Key 等同于本地浏览器控制凭证，只应交给可信 Agent 或自动化程序。Key 的技术权限永远不能替代用户对支付、发帖、发送消息、修改账号、删除数据等重要操作的授权。

## 浏览器与平台边界

Chromium 仍然拥有 host access、受限页面、file URL 访问、**允许用户脚本** 开关、扩展启停和 DevTools 调试确认。Root 无法绕过这些浏览器边界。

Windows/Linux App 都提供路由和文件落地；Windows 额外声明当前原生点击后端，Linux 暂不声明。无痕模式和其他 Chromium 衍生浏览器必须按各自 profile 与策略实际验证。

## 开发

| 指令 | 用途 |
|---|---|
| `npm run generate` | 生成命令、UI、传输、capability 与 Freedom Point 投影 |
| `npm run check:extension` | 重新生成并类型检查全部扩展 realm |
| `npm run build` | 构建扩展与当前平台 Zig App |
| `npm run test:unit` | 运行 UI、Key、runtime、WebSocket 与 Zig 单元测试 |
| `npm run test:runtime` | 运行单元测试以及隔离 relay/Chromium 集成测试 |
| `npm run build:dev-package` | 构建扩展和两个平台的 App 包 |
| `npm run build:github-release` | 构建 GitHub Releases 实际发布的两份 ZIP |
| `npm run build:chrome-web-store:first-upload` | 构建已暂停的身份引导产物；图标工作恢复前不要上传 |
| `npm run test:dev-package-smoke` | 验证压缩包层级、可执行文件、哈希和 skill 引用 |

隔离集成测试使用临时端口、profile 和 relay 进程，不得指向个人浏览器 profile 或已有个人 App 实例。

## 文档

- [文档索引](docs/README.md)
- [当前裁定](docs/decisions.md)
- [进度与已验证状态](docs/PROGRESS.md)
- [指令合同](docs/contracts/commands.md)
- [页面操作树](docs/design/page-information-tree.md)
- [Freedom Point](docs/design/freedom-points.md)
- [交付结构](docs/design/delivery-layout.md)
- [Agent skill](skills/browser-key-automation/SKILL.md)

旧 Cleaner/PageIR 候选只保留在 `docs/historical/`，不代表当前产品行为。
