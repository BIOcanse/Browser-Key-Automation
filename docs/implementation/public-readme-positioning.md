# GitHub 公开首页定位与竞品边界

更新：2026-09-01。本文件冻结根目录十种语言 README 的公开叙事、比较口径与事实边界。它面向维护者；访客应直接阅读对应语言的仓库 README。

## 目标读者与首屏结果

README 首先回答“它解决什么问题”，再进入架构、安装和内部交付状态：

1. 可信 Agent 或自动化程序可以接管用户已经在使用、已经登录的 Chromium 标签页。
2. 主路径使用扩展常规权限，不接入 CDP、WebDriver 或 `chrome.debugger`；完成浏览器正常安装与站点授权后，日常指令不触发调试连接确认或调试附加提示。
3. 一枚可配置权限与有效期的 Key 就是调用身份。扩展拥有鉴权、权限、引用、占据和浏览器操作，本地 App 保持薄而可替换。
4. 页面信息不是删除式“清洗”，而是完整信息编成唯一、可缓存、可按需展开的操作树，让 Agent 先看到干净的整体，再读取指定深度、区间或子树。
5. 跨标签页、Windows 原生 `.real` 点击、MHTML 保存、截图、Artifact 上传/下载与自包含演示打开是同一控制面中的直接能力。

公开首页不应先讲 Store Item ID、identity bootstrap、public key 同步或 InstanceRef owner。这些事实分别留在交付合同和架构章节。

## “无弹窗接管”的准确边界

允许的公开表述：

> 主路径不附加 Chromium 调试器，因此完成普通扩展设置后，日常控制不会出现 CDP/远程调试连接确认或调试附加提示。

必须同时保留的边界：

- 安装扩展、授予站点访问权仍会使用 Chromium 自己的正常权限流程。
- `js.execute` 仍要求用户一次性开启 **Allow User Scripts**。
- CDP/DevTools 可作为未来并行能力，但 Chromium 自己要求的调试确认不由本项目控制，也不能由本项目消除。
- 不使用“永不弹窗”“绕过 Chrome 安全确认”或“唯一能操作现有浏览器”等不准确表述。

## 比较对象与公平口径

README 只比较用户选择路线，不制作胜负榜：

| 路线 | 官方定位或现行连接方式 | README 中的公平结论 |
| --- | --- | --- |
| Playwright / Puppeteer / Selenium WebDriver | 成熟的浏览器测试与自动化框架；通常启动受自动化管理的浏览器，Playwright/Puppeteer 也能经 CDP 连接现有 Chromium | 更适合可复现测试、跨浏览器验证和 CI；本项目不试图替代它们 |
| Playwright MCP 扩展模式 | 能连接现有 Chrome/Edge 标签页并复用登录状态；可用 profile token 跳过其自身后续连接审批；底层通过 `chrome.debugger` 转发 Playwright/CDP | 是最接近的现有浏览器 MCP 路线；本项目的区别是主路径不附加调试器，并提供 Key 权限、持久操作树、占据和文件工作流 |
| Chrome DevTools MCP | 默认启动新 Chrome；连接用户当前 Chrome 时启用远程调试，Chrome 在每次调试会话请求时要求用户允许 | 更适合 Console、Network、Performance 等深度诊断；本项目面向低摩擦的日常页面操作 |
| Browser MCP | 扩展加本地 MCP，用户在当前标签页点 Connect；公开仓库不含可独立构建的完整扩展，因此底层输入路径未知 | 同样重视现有登录浏览器；本项目的差异是 Key 授权后可直接跨已授权标签页，并有持久选择式操作树 |
| Chrome MCP Server (`hangwin/mcp-chrome`) | 扩展加 native-messaging bridge，可跨标签页、上传文件；manifest 明确请求 `debugger` | 功能面广；本项目的区别是主路径不附加调试器、本地 App 更薄，并把页面保存/演示与 Key 权限做成同一合同 |
| Nanobrowser | 浏览器内置的多 Agent 产品，基于 Puppeteer/CDP，用户配置 LLM provider Key | 更适合开箱即用的集成 Agent UI；本项目是 provider-neutral 的 Key 控制面与 skill，不绑定某个 LLM 编排器 |

对比表优先写“最适合什么”与“控制路径”，不对未核验功能使用叉号，也不引用易过期的 Star、安装量或工具数量。

## 一手来源

- [Playwright BrowserType API](https://playwright.dev/docs/api/class-browsertype)：`connectOverCDP` 的连接边界与 Chromium 限制。
- [Playwright MCP](https://github.com/microsoft/playwright-mcp)：持久 profile、隔离运行与扩展模式。
- [Playwright Chrome Extension](https://github.com/microsoft/playwright/tree/main/packages/extension#readme)：现有标签页、登录状态、首次审批与 token 自动连接。
- [Playwright Extension manifest](https://github.com/microsoft/playwright/blob/main/packages/extension/manifest.json)：`debugger`、tabs 与 tabGroups 权限。
- [Puppeteer browser management](https://pptr.dev/guides/browser-management)：launch/connect 路线。
- [Selenium overview](https://www.selenium.dev/documentation/overview/)：WebDriver、IDE 与 Grid 的官方定位。
- [Chrome DevTools MCP auto-connect](https://developer.chrome.com/docs/devtools/agents/use-cases/auto-connect)：当前浏览器远程调试开关、每次连接确认与受控提示。
- [Browser MCP](https://browsermcp.io/)：扩展、本地 MCP 与现有登录浏览器的公开定位。
- [Chrome MCP Server](https://github.com/hangwin/mcp-chrome)：跨标签页、native-messaging bridge 与 debugger-backed 功能面；其 [WXT manifest 配置](https://github.com/hangwin/mcp-chrome/blob/main/app/chrome-extension/wxt.config.ts)给出实际权限。
- [Nanobrowser](https://github.com/nanobrowser/nanobrowser)：浏览器内多 Agent 与 LLM provider 模型。

第三方行为会变化。每次实质重写比较表时应复核上述官方页面；有冲突时，删除无法证明的比较项，不用推测补齐。

## 十种语言拓扑

十份 README 统一在产品定义后加入独立的“为什么使用 Browser Key Automation”H2，内部包含：

1. 主路径与提示边界。
2. 六项面向结果的差异点。
3. 同维度比较表。
4. “不是替代测试框架或 DevTools”的选择说明。

随后保留能力、架构、快速开始、常用流程、Key/权限/占据、平台边界、开发与文档章节。十份文件必须保持相同 H2/H3 数量、相同工具名与技术 token；自然语言按语义翻译，简体与繁体独立维护。

## 验收

- 首屏在维护状态前说清楚现有浏览器、无调试附加和 Key 控制面。
- 明确提到干净操作树、跨标签页、`.real`、保存/截图/Artifact/演示。
- 对比至少覆盖 Playwright、Puppeteer、Selenium、Playwright MCP、Chrome DevTools MCP、Browser MCP、Chrome MCP Server 与 Nanobrowser。
- 十份 README 不含完整 `bk1...` Key，不宣称未裁定许可证，所有本地链接存在。
- `npm run test:readme-i18n` 与仓库完整测试通过。
