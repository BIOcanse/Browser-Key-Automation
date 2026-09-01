# 页面信息树真实 Chromium 交互记录

日期：2026-08-30。执行入口：`npm run test:extension-relay-smoke`。浏览器资产：本机 Playwright `chromium-1228`，MV3 unpacked 扩展经 offscreen worker 连接 Zig relay，再由 native client 按 relay Instance + Key 调用。本文记录当时 v1 的真实结果；其中 selection 后来已被用户裁定移除，原始证据不回写成新行为。

## 1. 首次看到的结果

测试页同时放入 header/nav、main/article、标题、长正文、输入框、按钮、select、图片、隐藏 section、注释、style、script、open ShadowRoot 和 iframe。

`page.tree.get` 首次返回 12 个 selection 项：第一项为 primary，selection 中直接包含主标题 `tree-primary-title`，也包含 role 为 `textbox` 且可直接操作的 NodeRef。header/nav 没有挤掉主内容。返回体低于 49152-byte inline 门。

这一步的体验与普通 DOM 前缀不同：Agent 首调已经看到主要区域、标题和可操作字段，同时拿到整棵文档的 rootRef；selection 没出现的源码、隐藏内容仍然存在。

## 2. 展开完整树

测试从 rootRef 用非递归队列持续调用 `page.tree.expand`，31 次请求遍历完该 fixture。实际看到并断言：

- doctype；
- `tree-comment-sentinel` 注释；
- style 内的 `tree-style-sentinel`；
- script 内的 `tree-script-sentinel`；
- hidden section 的 `tree-hidden-sentinel`；
- open ShadowRoot 及 `tree-shadow-sentinel`；
- 普通 DOM 元素、attributes、properties 和文本子项。

因此当时 v1 的 selection 没有改变底层信息可达性。展开顺序保持 attributes → live properties → open ShadowRoot → childNodes。

## 3. 长值没有被 preview 吃掉

fixture 使用 700 个 ASCII 字符组成的长 attribute，以及 700 个中文字符组成的长 text。首项只带 256-character preview 和 TreeRef；测试沿 value continuation 读取后，与原始字符串逐字符严格相等。

这里没有空白归一化、摘要或从 preview 猜原文。preview 只是文件管理器式目录信息，TreeRef 才是完整值入口。

## 4. frame、权限与失效

- `frames.list` 取得 iframe 的 DocumentRef 后，把它直接传给 `page.tree.get`；返回的 frameId/DocumentRef 精确匹配，并能选择出 iframe 内带 NodeRef 的 button。
- 只有 `system.read` 的 Key 调 `page.tree.get` 固定返回 `FORBIDDEN`。
- 对扩展自身 admin page 调用返回 `CAPABILITY_UNAVAILABLE / platform.extension.scripting / RESTRICTED_PAGE`。
- 主页面 reload 后先观察到新的 main DocumentRef，再用旧 rootRef 调 `page.tree.expand`，固定返回 `TARGET_REF_STALE`，没有落到新页面同位置。

## 5. relay 交互事实

本轮分别覆盖了 relay 由烟测启动和复用已运行 relay 两种路径。共享 relay 同时存在真实浏览器扩展时，测试不假设“实例只能是 1”或“编号必须为 1”；本次临时扩展是测试启动后新接入的连接，因此选择当次列表里由 relay 新签发的最高实例编号，并只向这个精确 Instance 发送临时 Key。若鉴权不匹配就直接失败，不向其他实例喷洒 bearer。最终复用运行中 relay 的记录实例编号为 `6`，relay 仍保持监听。

烟测还修正了两个与页面树无关、但会污染体验判断的旧假设：10 秒是相邻重连尝试节拍，不是 relay 启动后必须重新等满 10 秒；开始 MHTML 前明确等待目标 tab `status=complete`，不再靠连接延迟偶然掩盖加载竞态。

## 6. 结论

当前能力已经满足第一版核心体验：一次调用看到重点，沿 rootRef 能访问完整可观察 DOM 信息；选择算法可继续用真实个人页面调整，但不能以“更干净”为理由删除树分支。

## 7. 本轮开发包

`npm run build:dev-package` 完成 TypeScript 扩展、Windows x64 ReleaseSafe relay 和 Linux x64 ReleaseSafe relay；`npm run test:dev-package-smoke` 验证扩展 ZIP 根层 manifest、App ZIP 根层 executable、29/5/5 项包内 checksum、PE/ELF 格式和无 combined 旧入口。

| 包 | 字节 | SHA-256 |
|---|---:|---|
| `browser-key-automation-extension-dev.zip` | 78,312 | `868ee9b05297dc283c636ac70b28628c7fae6a53dda76652e47cef5170fdc645` |
| `browser-key-automation-local-app-windows-x86_64-dev.zip` | 371,231 | `b59242ec882274490cd322a2cb1aa09afac347afa8717169f54e8ec003860b79` |
| `browser-key-automation-local-app-linux-x86_64-dev.zip` | 1,258,493 | `fe851d81eb6e37611212f3e0c6dae10628fcdb202ef624f0dd5e3da11b8b00ba` |
