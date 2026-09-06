# Browser Key Automation

[English](README.md) | 简体中文 | [繁體中文](README.zh-TW.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Deutsch](README.de.md) | [Français](README.fr.md) | [Español](README.es.md) | [Português (Brasil)](README.pt-BR.md) | [Русский](README.ru.md)

**让 Agent 直接使用你正在用的浏览器。**

继续使用已经登录的 Chromium 标签页，按需阅读网页、执行操作，再把结果保存下来。日常指令走扩展权限：不用另开自动化浏览器，不自动附加调试器，也不增加插件自己的逐条确认。浏览器自身的权限提示仍然保留。

## 为什么用它

- **页面很大，视图可以很小。** 缓存的操作树保留整体结构，只展开需要的分支。切换标签页后，只要文档未变，展开状态仍在；层级、区间、子树是一次性视图选择，不是有损改写网页。
- **随时跨标签页工作。** 用明确的标签页引用阅读、导航和操作。按 Key 串行，配合标签页、窗口或全局占据，减少多个 Agent 协作时的状态冲突。
- **结果直接拿走。** 一条命令保存 MHTML、截取网页或 Canvas/图表元素、传输资源；提交 HTML 即可打开演示，不用另开本地网页服务。
- **输入方式各司其职。** DOM 操作、Windows 真实点击与键盘、独立的虚拟鼠标与键盘分别处理不同交互；需要深入排查时再启用 CDP。
- **看结果，不只看指令发出。** `ensure.run` 把条件、有限等待和准备、动作、可观察目标放在一起；结果未知就明确返回未知，不盲目重放不可重复动作。

## 开始使用

> 每次全新安装都会生成相同的**公开 Root 试用 Key**，具体值在 Agent skill 中。它不是私人凭据。个人浏览器请创建私人 Key、切换客户端，再撤销试用 Key；仅创建新 Key 不会使旧 Key 失效。升级不会补发或恢复它。

1. 需要 Chromium **138+**、Windows 或 Linux x64 App；CLI 需要 **Node.js 20+**。在[最新 Release](https://github.com/BIOcanse/Browser-Key-Automation/releases/latest)下载两个压缩包，分别解压。

   - `browser-key-automation-extension-v0.0.0.5.zip`
   - `browser-key-automation-local-app-v0.0.0.5.zip`

2. 在 `chrome://extensions` 开启开发者模式，加载根部含 `manifest.json` 的扩展目录。点击工具栏图标管理 Key。`js.execute` 需要在扩展详情开启 **Allow User Scripts / 允许用户脚本**；DOM 和树指令不需要此开关。

3. 按下方命令启动对应平台 App。Windows 的 `virtual-mouse-hook.dll` 须与程序放在一起。扩展未连接时约每 10 秒重试默认地址 `127.0.0.1:32189`。

```text
# Windows
.\windows-x86_64\browser-key-relay.exe

# Linux
chmod +x ./linux-x86_64/browser-key-relay
./linux-x86_64/browser-key-relay
```

4. 为 Agent 安装或加载包内 `skill/browser-key-automation/SKILL.md`。先枚举实例、选定浏览器，再通过环境变量 `BKA_API_KEY` 提供私人 Key，不放进命令行参数，也不拿同一个 Key 逐个试探实例。

```text
node client/browser-key-cli.mjs instances
node client/browser-key-cli.mjs call --method system.describe --schema-version 1 --params-json "{}"
```

## 从页面到结果

先用 `system.describe` 获取当前构建和有效权限。参数以[指令注册表](dev/skills/browser-key-automation/references/commands.registry.json)为准，不猜测引用格式或选择器。

| | API / CLI |
| --- | --- |
| 查看 → 选择 → 展开 | `tabs.list` → `page.tree.open` → `page.tree.find` / `page.tree.expand.v2` → `page.tree.view.get` |
| 等待页面条件 | `page.wait` · `ensure.run` |
| 保存网页 / 网页截图 / 元素截图 | `page-save` · `page-shot` · `element-shot` |
| 上传并展示 HTML | `demo-open` |
| DOM / 真实点击 | `dom.click` · `dom.click.real` |
| 准确文本 / 快捷键 / 释放按键 | `keyboard.type` · `keyboard.typeHuman` · `keyboard.press` · `keyboard.reset` |
| 虚拟鼠标 / 键盘 | `virtualMouse.*` · `virtualKeyboard.*` |
| 测量原生输入目标 | `input.calibrate` |
| 显式 CDP 会话 | `debugger.attach` → `debugger.send` → `debugger.events.get` → `debugger.detach` |

```text
node client/browser-key-cli.mjs page-save --tab-ref <TabRef> --output ./page.mhtml
node client/browser-key-cli.mjs element-shot --node-ref <NodeRef> --width 800 --height 600 --output ./element.png
node client/browser-key-cli.mjs demo-open ./demo.html
```

## Key 与输入边界

- Root 获得所有有效权限；Regular Key 可以按权限组快速配置，再展开细调，支持有效期、再次查看、禁用和撤销。JavaScript 与原生输入等权限相互独立。拥有 Key 不等于获得替用户支付、发布或删除的授权。
- 虚拟输入状态绑定 Key，跨标签页保留，使用前必须占据整个目标窗口。普通虚拟输入动作使用有效的 `input.calibrate` 校准；`ensure.run` 会检查并按需刷新。真实输入要求目标窗口在前台；虚拟输入不移动真实鼠标。
- Windows 提供原生输入；Linux 当前提供浏览器路由和文件流程，不提供原生键鼠后端。不支持最小化窗口；首次校准要求页面可测量，遮挡时复用已有校准有条件限制。多窗口首次校准、完整原生 HTML5/OLE 拖放仍有未解决场景。
- 元素截图读取当前可见视口并使用支持的形状遮罩，不补画隐藏内容。受限页面、站点访问、用户脚本开关由 Chrome 管理；显式 `debugger.attach` 保留浏览器调试提示。合成 DOM 事件和虚拟窗口消息不能绕过所有网站或系统输入限制。

## 适合什么场景

BKA 的重点是低摩擦接入个人浏览器、按需展开的页面树，以及连贯的操作与文件流程，不宣称全面替代测试框架或所有 DevTools 能力。

| | |
| --- | --- |
| [Playwright](https://playwright.dev/docs/intro) · [Selenium](https://www.selenium.dev/documentation/overview/) | 跨浏览器测试与 CI |
| [Puppeteer](https://pptr.dev/) | 可编程浏览器自动化 |
| [Playwright MCP](https://github.com/microsoft/playwright-mcp) | 提供无障碍快照的 Agent 工具 |
| [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp) | 深入浏览器诊断 |
| [Browser MCP](https://browsermcp.io/) · [Chrome MCP Server](https://github.com/hangwin/mcp-chrome) | 连接现有浏览器的 MCP 工具 |
| [Nanobrowser](https://github.com/nanobrowser/nanobrowser) | 浏览器内的 Agent 界面 |

## 指南与维护

[Agent skill](dev/skills/browser-key-automation/SKILL.md) · [Operation tree](dev/skills/browser-key-automation/references/operation-tree.md) · [Ensure](dev/skills/browser-key-automation/references/ensure-workflows.md) · [Virtual input](dev/skills/browser-key-automation/references/virtual-mouse.md) · [Capture & CDP](dev/skills/browser-key-automation/references/debugger-and-element-capture.md)

扩展 UI 支持 20 种语言，仓库指南有十个语言版本。[隐私说明](PRIVACY.md) · [开发目录](dev/README.md)。本项目由作者维护，不接受外部贡献或 Pull Request。
