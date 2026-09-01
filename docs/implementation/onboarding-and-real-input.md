# 安装引导与 .real 机制边界

2026-08-31。本批落地安装引导和用户脚本权限提示；下文 `.real` 部分是实施前可行性审查。Windows 产品实现随后已经完成，当前合同见[原生点击实现切片](real-input-slice.md)，最终证据见[实现交互记录](../experience/real-input-implementation-2026-08-31.md)。

## 最简行为

首次安装时，扩展打开自己的介绍/设置页。页面说明扩展、Key 与本地 App 的分工，提示用户在浏览器详情中开启“允许用户脚本”，提供打开详情、重新检测和进入 Key 管理的入口。普通更新、重载、浏览器启动不重复弹介绍页；管理页始终能重新打开说明。

说明页和 Key 管理页用同一个只读 API 检查用户脚本能力；不执行测试脚本、不创建 Key、不改变设置、不启动 App。点击重新检测重新加载当前页面，刷新 Chrome 对该脚本上下文的 API 可用性。浏览器开关由用户操作，插件不能代开。启用后需要重载扩展的情况明确提示。

`js.execute` 沿用现有鉴权/能力检查，未启用时返回现有 `CAPABILITY_UNAVAILABLE / USER_SCRIPTS_NOT_ENABLED`，在正式 details 中附 `setupInstructions`；不只修改不会出现在协议里的 Error.message。不把该开关变成 DOM、页面树或 Key 管理的全局门。Root 权限也不能替代浏览器开关。

## 代码归属

- `src/background/admin-entry.ts` / `src/background.ts`：首次安装入口，保留工具栏进入 Key 管理的行为。
- `src/shared/user-scripts.ts`：UI 与业务复用的只读能力检查和开启提示，无持久状态。
- `src/admin/setup.ts`：两页共用的状态与操作区。
- `static/admin/welcome.html` / `index.html` / `admin.css`：介绍页及现有页面的就近提示，沿用当前视觉样式。
- `src/background/browser-service.ts`：复用检查并返回既有类型化错误。
- 既有扩展构建、隔离 Chromium 测试、安装说明和项目配套 skill 同步接入。新增单测检查首次安装/更新边界及 API 不可用、同步抛错、Promise 拒绝。

不改 App 协议、Key 模型、权限集合、占据规则或自由点归属。浏览器安装事件与用户主动按钮不是新的后台自动配置机制。

## .real：本批次仅讨论（后续已实现）

用户提出显式后缀 `dom.click.real`：扩展取得目标及页面相对位置，本地 App 将其映射到正确浏览器窗口，再执行系统输入。隐藏、被遮挡或实际不可点击的控件仍不能凭空点到。普通 `dom.click` 不偷偷回退为系统点击；`.real` 的原生适配后续另行落实。

判断必须区分 DOM 派发、Chromium 调试输入和操作系统输入。API 的 isTrusted、坐标映射、前台/遮挡和平台授权边界以一手资料及后续实测为准；不保证“网页绝对识别不出”，不把 SendMessage/PostMessage 一律叫作可靠真实输入。尚未决定平台实现或修改 relay 为输入执行器。

资料审查结论：方案可行。建议扩展继续拥有 Key 鉴权、目标和占据，App 后续仅增原生输入适配；独立授予 `dom.click.real`，普通 click 不暗中回退。最短流程是：扩展确认当前节点及可命中点 → App 确认对应内容区并映射屏幕坐标 → 发出输入 → 如需确认业务结果，再观察页面。不要用固定标题栏高度猜内容区，不把系统输入成功等于网站业务成功。

可核验依据和实施边界：

- DOM `isTrusted` 是不可伪造的只读属性；脚本 dispatchEvent 及 HTMLElement.click() 的 click 不可信。由此推断换 MAIN/USER_SCRIPT world 不能解决信任判断。调用页面自身业务函数可能对某个页面有效，但不等价于可信 DOM 点击，也不作为 `.real`。见 [DOM Standard](https://dom.spec.whatwg.org/#dom-event-istrusted)。
- [CDP Input.dispatchMouseEvent](https://chromedevtools.github.io/devtools-protocol/tot/Input/#method-dispatchMouseEvent) 是浏览器输入通道，不是页面 dispatchEvent；普通扩展 attach 的提示来自 [Chromium debugger 实现](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/browser/extensions/api/debugger/debugger_api.cc)，不是插件能关掉的确认。
- [Windows SendInput](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput) 进入系统输入流，受完整性级别约束；[PostMessage](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-postmessagew) 只投递窗口消息，是否适合目标 Chromium 的后台点击需实测，不能预先视作等价通道。
- [X11 XTEST](https://www.x.org/releases/X11R7.5/doc/man/man3/XTestFakeKeyEvent.3.html) 可模拟设备事件；[Wayland 常用 RemoteDesktop portal](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.RemoteDesktop.html) 涉及桌面授权，不能承诺所有 Linux 会话都免确认。
- [CSSOM View](https://drafts.csswg.org/cssom-view/) 的矩形/命中用 CSS 坐标，需正确处理 iframe、缩放、transform 与原生内容区位置；Windows 还需统一 DPI/多屏坐标。没有可命中区域、被挡住或禁用的控件不能凭空点击；透明但仍参与命中的元素另当别论。

后续决定实施时，先用本地小页面对照 DOM click 与原生输入的目标、pointer/mouse/click 事件、isTrusted 和页面实际变化，再确定最简适配。这里没有写入新的产品命令或承诺 PostMessage、Wayland、后台输入已验证。

## 验收与记录

已完成：56 项 Node 用例通过；新 profile 首次安装自行打开介绍页，未启用提示、按钮打开本扩展详情、真实开关开启后刷新说明页检测通过，既有 Key 与 JS 流程回归通过。更新不弹由安装原因分支单测验证。独占 Chromium/profile/relay 测试不接触个人浏览器或已有 App。

Windows/Linux 分离包与扩展包均已生成，文件/ZIP 摘要、解压根目录和新 UI 模块齐全性校验通过；Linux 仅交叉构建。逐步记录、截图、测试结果及下载入口见[安装引导交互记录](../experience/onboarding-2026-08-31.md)。在这个安装引导批次结束时 `.real` 尚未实现；后续状态不得从本句推断，应读取本文开头链接的现行实现。
