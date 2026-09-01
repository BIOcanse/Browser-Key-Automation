# `dom.click.real` Windows 首版实现与交互记录

2026-08-31。范围仅为隔离 Chromium、临时测试 profile 和临时 relay 端口；没有操作、重载或重启个人浏览器、个人 Key 或正在运行的个人 App。

## 实际调用路径

1. Root Key 在隔离扩展中取得主文档 `DocumentRef`，`dom.query #probe-button` 得到精确 `NodeRef`。
2. 先调用普通 `dom.click`，页面记录 `isTrusted=false`，作为对照。
3. 调用 `dom.click.real`，省略参数由 registry 展开为 `scrollIntoView=true / timeoutMs=10000`。
4. 扩展在能力检查后选中 tab、请求窗口聚焦、验证可见命中点，临时把精确文档标题改为每请求随机标记。
5. 同一 WebSocket 上的 native 子请求携带当前 pending `routeId`；Windows App 唯一匹配顶层 Chromium 窗口和内容 HWND，按 CSS/原生视口比例发送一次 move/down/up。
6. 扩展收到结果后恢复原页面标题；页面读回 `trusted=1 / untrusted=1`，命令返回 `status=input_sent`。

## 三轮可观察结果

- 第一轮：App 立即枚举时标题尚未传播到 HWND，返回 `NATIVE_INPUT_FAILED {reason:window_not_matched, phase:prepare, clickState:not_sent}`。没有误点。这暴露的不是页面命中问题，而是页面标题到原生窗口标题的异步边界。
- 第二轮：新增只在“尚未发送任何输入”的窗口/内容绑定阶段轮询后，真实点击成功；旧回归稍后仍写死总 `buttonClicks=1`，观察到实际为 2，因此该旧断言失败。该差值正是 ordinary + real 两次点击。
- 第三轮：完整链通过。最终输出为 `realInput={status:"input_sent",trusted:1,untrusted:1,titleRestored:true}`；页面树、JS、保存、截图、演示、Key 与 occupation 后续流程也全部继续通过。

最终生命周期修正后的原始输出保存在 `out/test-artifacts/isolated-wPM3NK/extension-relay.log`，隔离编排记录在同目录 `results.json`。首次完整成功样本位于 `out/test-artifacts/isolated-BxCH8t/`；前两轮失败样本分别位于 `out/test-artifacts/isolated-lkyr1X/` 与 `out/test-artifacts/isolated-mp0cY9/`。

## 合同结论

- `input_sent` 只证明完整原生消息序列被平台接受；网站业务结果仍要另读。
- ordinary `dom.click` 与 `dom.click.real` 权限互不蕴含，也没有隐式 fallback。
- down 前的失败均不重试输入；只允许对无输入的窗口绑定做有界轮询。`clickState=unknown` 永不自动重放。
- Windows 后端不调用 CDP Input、SendInput、SetCursorPos 或任意桌面坐标接口。Linux 包保留其他 App 能力，但不广告 `native.input.click.v1`。
