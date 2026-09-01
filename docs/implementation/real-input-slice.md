# `dom.click.real` 实现切片

2026-08-31。状态：Windows 首版已实现并通过隔离 Chromium 可信点击验收；Linux 明确不声明本能力。用户要求补上 `.real`；本切片把此前实测设计收敛为一个可调用指令，不扩成桌面宏系统。逐步失败/修正和最终原始输出见[实现交互记录](../experience/real-input-implementation-2026-08-31.md)。

## 最简但无损的行为

Agent 仍给扩展已经签发的 `NodeRef`。扩展验证 Key、独立权限、占据、精确文档和节点；确认本地 App 当前连接声明原生点击能力后，选中目标标签页、请求其 Chromium 窗口聚焦、按参数滚动，并在页面当前可见视口内选择一个确实命中目标的点。为把 Chromium `windowId` 无猜测地绑定到 Windows `HWND`，扩展为本次请求临时写入一个随机页面标题标记；App 只接受恰好一个带该标记的 Chromium 顶层窗口及其唯一内容区。点击完成或失败后扩展立即恢复原标题。本地 App 随后投递一次 Windows 窗口消息点击。结果只说明输入已投递，不说明网站业务已经完成。

扩展仍是 Key、权限、NodeRef、文档和占据的唯一 owner；App 仍不鉴权、不保存 Key/NodeRef/DOM，也不生成浏览器实例以外的新业务身份。普通 `dom.click` 不变且不会自动升级。

## Agent 接口

```json
{
  "method": "dom.click.real",
  "schemaVersion": 1,
  "params": {
    "nodeRef": "nr1.…",
    "scrollIntoView": true,
    "timeoutMs": 10000
  }
}
```

- `scrollIntoView` 省略时为 `true`；只做一次立即滚动，不等待动画、不修改样式。
- `timeoutMs` 省略时为 10000，最大 60000；这是准备、App 等待和响应共用的一个总期限。
- 首版固定左键单击。选中目标标签页与请求目标浏览器窗口聚焦是固定且公开的准备动作，不再用一个含糊的 `activate` 参数混合多种语义。聚焦请求不改变窗口位置，但 Windows/Chromium 仍可能改变前台、Z 序、页面焦点或 capture。
- 成功：`{ "nodeRef": "…", "status": "input_sent" }`。后续跳转或业务结果由 Agent 使用 `page.wait` / 页面树读取。

新增权限 `dom.click.real`，与 `dom.click`、`js.execute` 并列且互不蕴含。Root 按既定动态规则自动获得它；Regular Key 必须显式授予。

## 首版支持边界

- Windows App：使用已实测的定向窗口消息后端；不移动系统鼠标，不使用 CDP Input，不恢复焦点/滚动状态，也不自动重试。
- Linux App：继续提供全部原有能力；握手不声明本指令的原生后端，调用在任何页面副作用前返回 `CAPABILITY_UNAVAILABLE`。X11/Wayland 只有真实平台验收后才声明支持，交叉编译不冒充已完成。
- 首版只接受主文档里的 NodeRef。子 frame 缺少从 Chromium frame identity 到原生内容区的无猜测映射时，返回 `NATIVE_INPUT_FAILED` 的 `frame_not_supported`，不点击一个推测位置。
- 页面点必须有正面积、在当前可见视口内、非 disabled，并由 `elementFromPoint`（含开放 shadow root 的有界向下命中）确认属于目标或其内部节点。被 DOM 覆盖、隐藏、断连或文档变化均不投递。
- App 不把普通页面标题、窗口尺寸或 Chromium `windowId` 当作原生窗口身份。扩展使用每次随机、只在当前精确文档短暂存在的标题标记；App 要求标记只命中一个 `Chrome_WidgetWin_1`，再要求其下与 CSS 视口比例一致的可见 `Chrome_RenderWidgetHostHWND` 也唯一。无法唯一匹配、尺寸不一致或几何在投递前变化即失败；不写死标题栏高度、DPI 或调试样本坐标。页面若并发改写标题，恢复只在标记仍存在时执行，绝不覆盖页面的新标题。

## 内部协议与错误

仍复用 extension WebSocket。新 App 在 `role.ready` 中声明 `native.input.click.v1`；旧 App 或未实现平台不声明，扩展因此能在激活/滚动前失败。扩展发出的 `native.input.click` 带本次外层 `routeId` 和一次性 `requestId`；relay 只接受当前 extension 连接、当前仍 pending 且属于该实例的 route。client role 没有原生输入入口。

App 对所有连接的实际原生投递使用一个短 mutex；等待后重新检查本次剩余期限。扩展在投递前重新验证 Key、占据、TabRef/DocumentRef/NodeRef 和命中点。断线、超时或未知结果不自动补点。

新增 `NATIVE_INPUT_FAILED`：details 为稳定的 `reason`、`phase=prepare|input`、`clickState=not_sent|unknown`。`not_sent` 只表示没有投递窗口点击；此前的标签选择、聚焦请求或滚动可能已经发生。down 已接受但 up 未确认时必须为 `unknown`。

## 文件与验收

- `real-input-service.ts`：扩展侧一次点击编排；`dom-service.ts` 只提供精确 NodeRef 页面点。
- `native-input-protocol.ts`、transport controller/offscreen/worker：同一连接上的窄子请求，不建立新服务。
- `native_input.zig` / `native_input/windows.zig`：App 公共请求边界与 Windows 窗口消息实现；`server.zig` 只接线和关联外层 route。
- registry/生成器：1 条 command、1 个 permission、1 个 capability、1 个 error、3 个 Freedom Point。

验收必须覆盖：闭合 schema/defaults、独立权限、旧 App/非 Windows 无页面副作用、foreign occupation、主文档命中/遮挡/disabled/滚动/stale、同一页面 `dom.click` 为 untrusted 而 `.real` 为 trusted、窗口匹配失败不误点、超时/断线不自动重发、Windows 与 Linux 分包。所有真实输入只在隔离 Chromium 的本地夹具中执行，不操作个人浏览器或正在运行的个人 App。
