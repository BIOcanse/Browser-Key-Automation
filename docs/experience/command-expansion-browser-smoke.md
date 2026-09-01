# 完整指令纵切：真实 Chromium 交互记录（2026-08-30）

本记录对应 `tests/extension-relay-smoke.mjs` 的可重复浏览器烟测。测试使用一次性 Chromium profile 与真实已构建扩展，通过正在运行的本地 relay 发指令；没有读取或修改用户个人浏览器 profile，也没有停止用户正在使用的 relay。测试 Chromium 来自本机 `chromium-1228`，扩展最低版本合同为 Chrome 138。

本文件保留页面信息树加入前那一批 36/35 registry 快照；当前 38/36 状态及新增交互见[页面信息树真实 Chromium 交互记录](page-tree-browser-smoke.md)。

## 观察顺序

1. 扩展加载后，offscreen transport 已连接到本机现有 relay。relay 为这个新 socket 分配新的单调实例号；扩展侧仍看不到 InstanceRef。测试选择启动后最新实例，不向其他已连接浏览器试发 Key，也不发送 `relay.stop`。
2. 在扩展管理页的受信上下文创建一枚拥有全部当前权限的 Regular Key。`system.describe` 返回 registry 中精确的 36 条 active command、35 个 active permission 和当前 capability 投影。
3. `tabs.list` 用 `afterTabId + limit` 取得两页不同 TabRef；超长 data URL/title 被 UTF-8 截断并带标志。`tabs.get` 能读取 live ref，关闭后同一 ref 返回 `TAB_REF_STALE`。
4. `page.dom.get(root=document)` 看到测试页的 `live DOM payload`，`page.text.get` 看到同一页面的可见正文；两者都是当前 live 页面观察，不被记录成原始 HTTP 文件或清洗结果。
5. `settings.get` 取得 `settings.v1` revision 与四个 Artifact 策略值；`settings.update` 以 expectedRevision 提交完整值后 revision 精确加一，第二次 get 与写回值一致。
6. 经 Agent 路由完成 `keys.create/get/list/reveal/update/revoke/reveal`：创建返回完整 `bk1` token；更新把权限从 `tabs.read` 改为 `system.read + tabs.read`；吊销后鉴权失效，但独立 `keys.reveal` 仍能再次看到同一个历史 token，符合管理页既定语义。
7. `page.dom.capture` 产生 `text/html;charset=utf-8` Artifact；`artifact.read` 解出的正文包含测试 payload，release 后同一引用返回 `ARTIFACT_NOT_FOUND`。
8. `page.resources.list` 发现页面实际引用的 `resource.txt`；`resource.fetch` 新发显式 GET，返回 HTTP 200，Artifact 解码为精确的 `resource-body`，随后释放。该结果没有被称作页面导航时的原始 response。
9. `page.archive.capture` 调用 Chromium Page Capture 得到 MHTML Artifact，首块可读且非空。直接把 API 返回的外部 Blob 或重新包装的 Blob 写 IndexedDB 都在真实复测中出现过 `STORAGE_UNAVAILABLE`；最终正文统一保存为独立 1 MiB ArrayBuffer chunks，metadata/chunks 同事务提交。MHTML 连续多轮通过，另用 1.1 MB response 跨 chunk 边界读取 64 bytes，结果与服务器源字节逐字节一致。
10. `frames.list` 同时返回主文档和真实同源 iframe 的 DocumentRef。主文档上依次执行 query/describe/setValue/focus/scroll/select/click；随后在 MAIN world 复核输入值为 `after`、select 值为 `b`、按钮计数为 `1`，证明不是只伪造动作回执。iframe 内 100 个长 descriptor 节点触发统一 49,152-byte inline 门：返回至少一个可用 NodeRef、`truncated=true`，序列化结果未越过预算。
11. `tabs.create` 创建 inactive `about:blank`；此时截图明确返回 `CAPABILITY_UNAVAILABLE {capabilityId=platform.extension.visible_tab_capture, reason=TARGET_TAB_NOT_VISIBLE}`，且没有暗中激活。随后 navigate/reload/activate 成功；重新激活核心页后 PNG 截图 Artifact 的前 8 字节为标准 PNG signature，读取后释放；新 tab close 后 ref 失效。
12. tab/global occupation 的首次占据、同 Key 重复占据、foreign 冲突、foreign 显式 release、global 对 tab effect 的阻断都按两步合同工作；纯 DOM 观察不被 occupation 当成读锁。
13. disposable profile 初始关闭 Chrome 的 Allow User Scripts。第一次 `js.execute` 精确返回 `CAPABILITY_UNAVAILABLE {capabilityId=platform.extension.user_scripts, reason=USER_SCRIPTS_NOT_ENABLED}`；通过 Chrome 自己的扩展详情开关启用后，MAIN 与 USER_SCRIPT 两个 world 均 fulfilled，且 USER_SCRIPT 看不到页面自有的 `window.pageOwnedValue`。
14. 对扩展自身的 `chrome-extension://.../admin/index.html` 发 `page.dom.get`，稳定返回 `CAPABILITY_UNAVAILABLE {capabilityId=platform.extension.scripting, reason=RESTRICTED_PAGE}`；host 权限预检另有单测覆盖 `HOST_ACCESS_UNAVAILABLE`。只有 `system.read` 的 Key 对 tabs/DOM/control/JS 均返回 `FORBIDDEN`；错误 secret 与已吊销调用 Key 均返回 `UNAUTHENTICATED`。这些业务判断全部发生在扩展，relay 没有读取权限表。

## 同轮管理 UI 观察

`tests/extension-key-smoke.mjs` 另用真实 Chromium 渲染管理页并验证工具栏入口、重复显示/隐藏和复制 Key、编辑、吊销确认、移动端重排。当前截图保存在：

- `out/test-artifacts/admin-ui-smoke.png`
- `out/test-artifacts/admin-ui-create-light.png`
- `out/test-artifacts/admin-ui-mobile.png`

桌面列表保持 API 控制台式信息密度；35 项权限在固定 footer 的创建对话框内独立滚动；移动端把每枚 Key 重排为卡片，没有横向溢出。

## 仍不由本记录证明的内容

- 没有测试或定义智能清洗算法。
- 没有启用 CDP/DevTools，也没有试图消除 Chrome 自己的调试确认。
- resources 是 DOM/Performance 发现集合，不是完整 HAR；MHTML/live DOM/显式 fetch 的来源语义保持分开。
- `captureVisibleTab` 在 tab 快速切换竞争中仍受 Chromium 可见页 API 的平台原子性边界约束；本实现不会为了规避该事实暗中切换 tab。
