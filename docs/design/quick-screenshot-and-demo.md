# 快速网页截图与一键演示

日期：2026-08-31。状态：首版已实现，当前合同见[实现合同](../implementation/quick-screenshot-and-demo.md)，验证与样本见[交互记录](../experience/quick-shot-demo-2026-08-31.md)。下文保留实施前的讨论记录，“尚未实现”等表述只描述讨论当时。既定 Key、occupation、实例和薄 relay 架构不变。

## 实施前进度（历史）

- 浏览器核心、Key 管理、页面操作树、等待、一键 MHTML 保存及安装引导已交付；当前为 41 条 active command、37 个 permission、47 个 Freedom Point。
- `.real` 已完成 Windows Chromium 输入实测，尚未成为产品指令。定向消息存在后台可信点击成功样本，也存在浏览器自行激活的样本，不能承诺总是需要前台或总不抢前台。
- `page.screenshot.capture` 已用 `chrome.tabs.captureVisibleTab` 实现网页视口截图并生成 Artifact；`artifact-save` 已能将它校验后落盘。缺的是合成一次调用的截图入口，不是截图后端。
- 本地 HTML 上传与专用演示页尚未实现。本轮只检查资产、讨论方案，不重启个人 App 或操作个人浏览器。

## 最小使用体验

以下名称是建议，不是当前可运行的新命令。沿用现有 instance、Key 与调用上下文，示例省略这些共同参数。

```text
page-shot --tab-ref <TabRef> --output ./page.png
demo-open ./demo.html
demo-open ./demo.html --tab-ref <已有演示页的 TabRef>
```

第一条拿到真实图片文件；第二条提交本地文件内容并打开演示；第三条明确替换指定演示页。调用方无需手工编码、分块、读回 Artifact 或拼接页面地址。

自家 Agent 的原生插件与通用 Agent 的 skill/CLI 使用同一工作流。原生插件可把截图文件呈现为图片，不让 Agent 阅读 base64。

## 快速截图：复用现成链路

1. 保留扩展侧 `page.screenshot.capture`，本地新增薄封装：截图 → 复用 `saveArtifact` → 返回路径、类型、字节数和校验信息。
2. 默认 PNG；JPEG 与质量参数可选，省略值由唯一 registry 声明，不在各调用端分别硬编码。建议 JPEG 默认质量 80。
3. 截取网页当前视口，不包括浏览器工具栏、桌面，也不隐式滚动拼接整页。
4. 沿用现有“目标已是所在窗口的当前标签”要求；目标未激活时明确提示。若以后提供自动选中选项，必须显式声明该动作并检查相应权限/占据，不暗带 OS 前台激活。
5. 复用现有 Artifact 下载、owner 检查及输出文件不覆盖语义；不额外增加 Windows 截图库或 CDP 依赖。

Chrome 对该 API 有每秒 2 次调用限制；本方案是单次快速截图，不是录屏。尚未测量一键封装的实际延迟，也未验证所有最小化/后台窗口情形。[Chrome 截图 API](https://developer.chrome.com/docs/extensions/reference/api/tabs#method-captureVisibleTab)

## 一键演示：文件内容进入扩展，展示仍由浏览器完成

自然语言流程：本地调用端读 HTML → 通过现有 App/relay 传内容 → 扩展按 Key 鉴权并保存 → 打开自己的展示页。演示中的按钮、表单和脚本交互由浏览器正常运行。

- 首版建议只接收自包含 HTML：CSS、JS 与必要图片等资源放在文件内。不是仅显示静态文本，也不要求另起开发服务器。
- 不启动第二个本地服务，不增加 HTTP 文件路由；Zig relay 继续只转发。读调用方本地文件是 client 的职责，不把路径误当成浏览器或另一台机器可访问的文件。
- 文件输入复用扩展 Artifact 的 owner、存储、哈希、容量及留存规则；新增完成提交所需的输入能力，不另造演示文件仓库或通用项目托管平台。
- 现有传输整帧上限为 65,536 字节，且包含 JSON 包装。一次用户调用可以包含多次有界传输；按传输预算分块，不能把 1 MiB 的 Artifact 存储块直接塞进 WebSocket。全部接收并校验后才打开，传输失败不显示半份演示。
- 扩展侧建议新增 `demo.open`，接收已完成的 Artifact 引用及可选目标 TabRef；本地 `demo-open` 封装提交和打开。返回既有 `TabRef + Artifact`，不新增 DemoId。
- 默认新建并选中演示标签；不默认抢 OS 前台。若需要将浏览器窗口带到前台展示，应作为独立可控参数，不混同标签激活。
- 显式传入 TabRef 时只更新该演示页，不替换普通个人网页。更新仍走既有 Key 权限、按 Key 串行与标签 occupation；不能借演示入口解除别人的占据。
- 原始文件不移动、不删除；扩展副本沿用 Artifact 留存。只要副本仍有效，刷新展示页可以重新读取；过期后提示重新提交，不默默重放或建立永久发布记录。

### 浏览器执行上下文

普通 MV3 扩展页不能直接执行提交 HTML 的内联脚本。因此建议一个固定外层展示页，加一个 manifest 声明的 sandbox 页面承载 HTML；外层负责取得演示内容，sandbox 负责展示和运行脚本。演示内容不取得 Key、扩展 API 或管理页访问权。这是浏览器页面结构，不是新增服务。[扩展 CSP](https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy)、[sandbox 页面](https://developer.chrome.com/docs/extensions/reference/manifest/sandbox)

该路线尚待最小真实浏览器验证，不将可行性研究当成交付。现有通用 DOM/页面树入口会拒绝 `chrome-extension:` 页面；“可以展示并由人交互”不等于已经兼容全部 Agent 页面指令。若需要 Agent 在演示页内直接查树、点击，再明确接入范围，不顺带扩大本次首版。

## 自由点与代码落点

只给真实可变行为设置自由点：截图默认格式/JPEG 质量、演示默认选中行为；文件大小、留存和传输限制优先复用对应现有权威。固定 Chromium API 限制和协议规则不伪装成可随意调整的运行设置。

建议修改/新增位置如下，落地时按实际职责调整，不预造空模块：

```text
apps/client/src/main.mjs                   一键入口与原生调用封装
apps/client/src/artifact-files.mjs         复用截图落盘；文件输入按实际体量拆分
apps/extension/src/background/
  capture-service.ts                      复用截图实现
  artifact-service.ts                     复用存储，补演示所需的文件输入
  demo-service.ts                         授权后的演示打开/更新编排（新增）
apps/extension/src/demo/                   外层加载及 sandbox 展示逻辑（新增）
apps/extension/static/demo/                对应的固定 HTML（新增）
registries/                               指令、权限与默认值的唯一声明
```

manifest 和生成物沿既有生成/打包链路更新；skill 同步真实入口与限制。不向 Zig relay 放 Key 鉴权、演示业务或页面服务。

## 建议落地顺序与验收

1. 先补截图一键封装：真实 PNG/JPEG、输出拒绝覆盖、非当前标签提示、权限/占据行为；记录一次端到端耗时，但不预设速度承诺。
2. 用最小自包含 HTML 验证 sandbox 内联 JS、按钮交互、刷新恢复与该演示页的扩展 API 截图。当前 Manifest 权限能否覆盖最后一项必须实测，不能默认成立。
3. 再接一键文件提交：大于单帧的文件、原始字节/哈希一致、失败不打开、显式更新原演示 TabRef、占据冲突。记录逐步操作、原始 HTML 和截图样本。

本轮范围为“视口截图一键拿到文件 + 自包含 HTML 一键演示”。多文件目录、ZIP、构建工具、热更新监听、完整网站托管、整页截图和 `.real` 是独立能力，不作为这两项的前置条件。
