# 浏览器核心能力纵切

更新：2026-08-29。本文是当前实施切片的短合同；目标是先把基于 Chromium 扩展权限的核心能力跑通，不引入 CDP、清洗、Operation ledger、Artifact、DocumentRef/NodeRef 或额外身份。

## 本次 active 接口

所有请求继续使用现有 `route.request` 外壳和 API Key。扩展在入队前鉴权一次，并在该 Key 的串行队列真正派发前再次鉴权；不再做第三次“结果披露鉴权”。Root 动态拥有全部 active permission，Regular Key 只拥有显式勾选项。

### `control.acquire.v1`

权限：`control.acquire`。

```json
{"method":"control.acquire","schemaVersion":1,"params":{"scope":"tab","tabRef":"tr1.<opaque>"}}
```

`scope` 只能为 `global | tab`；global 必须带 `tabRef:null`，tab 必须带合法 TabRef。结果为 `{scope, tabRef, ownerKeyId, alreadyOwned}`。同 Key 对同一 scope 重复 acquire 是幂等成功；与其他 Key 冲突时返回 `CONTROL_OCCUPIED`，details 精确给出一个 `{scope, tabRef, ownerKeyId}` 冲突。不得隐式 release、takeover、force 或 replace；调用方必须先单独 release，再重试 acquire。

global 与其他 Key 的 global 或任意 tab occupation 冲突；tab 与其他 Key 的 global 或同一 tab occupation 冲突。同一 Key 可同时持有自己的 global 和 tab occupation。

### `control.release.v1`

权限：`control.release`。

请求 scope 形状与 acquire 相同。结果为 `{scope, tabRef, released, previousOwnerKeyId}`。拥有该 permission 的 Key 可以释放任何 Key 的对应 occupation；空位返回 `released:false`。接口不增加 own/any、OccupationId 或合并 acquire。

### `page.dom.get.v1`

权限：`page.dom.read`。

```json
{"method":"page.dom.get","schemaVersion":1,"params":{"tabRef":"tr1.<opaque>"}}
```

只读取目标 tab 当前主 frame 的 `document.documentElement.outerHTML`，结果为 `{tabRef, url, urlTruncated, html, htmlTruncated}`。输出按生成的 UTF-8/JSON 字节上限截断并显式标记。它是某个执行时刻的 live DOM：不是最初 HTTP response、MHTML、resource fetch 或自动清洗结果。

### `js.execute.v1`

权限：`js.execute`，与其他权限并行且不做闭包推导。

```json
{
  "method":"js.execute",
  "schemaVersion":1,
  "params":{
    "tabRef":"tr1.<opaque>",
    "world":"USER_SCRIPT",
    "code":"document.title",
    "timeoutMs":10000
  }
}
```

`world` 必须显式为 `USER_SCRIPT | MAIN`；`code` 是交给 `chrome.userScripts.execute` 的完整 JavaScript source。Chrome 会等待 source 的 completion value；若它是 Promise，则等待其 settle。结果统一为 `{tabRef, world, status, valueJson, valueTruncated, errorName, errorMessage}`，其中 status 为 `fulfilled | rejected | serialization_error | timed_out`。per-frame 脚本错误返回 `rejected`；整个 Chromium API 调用失败则返回顶层 `CAPABILITY_UNAVAILABLE`，不冒充代码已经执行。值只返回有界 JSON preview；异常文本同样有界。

`timeoutMs` 只限制扩展等待响应的时间，不取消已经注入的代码，也不声称页面 effect 停止。同步死循环、脚本留下的 timer/listener、host/restricted URL 和 Chromium 内部资源消耗都按真实平台边界处理；`USER_SCRIPT` 使用用户脚本 world，`MAIN` 与页面共享 world 并受页面自身干扰。Chrome 138+ 的 Allow User Scripts 开关未打开时返回 `CAPABILITY_UNAVAILABLE`，不自动切换 CDP。

## 占据状态与派发

occupation owner 只有 KeyId。状态只含一个可空 global owner 与当前 runtime 内的 `tabId -> {lastTabRef, KeyId}` 表，对外仍只接受/返回 TabRef。它保存在 trusted `chrome.storage.session`：service worker 回收后即使同一存活 tab 获得新的 generation，也会按同一 runtime tab 身份命中原占据；tab remove/replace 事件清除对应项，浏览器会话结束后整体自然清空。所有 acquire/release 与 effect 派发门通过一个很短的扩展内串行段原子检查并提交。

Key 被禁用、到期或吊销不在后台隐式改写 occupation；冲突返回的 exact scope/TabRef 允许任何持有 `control.release` 的协作者显式清除。因为 release 不带 OccupationId，旧 release 重试可能清除后来 owner，这是当前极简可信协作接口的已知语义，不用隐藏 generation 伪装成不存在。

只有页面 effect `js.execute` 在调用 Chromium API 前检查 occupation：foreign global 或目标 tab owner 会返回 `CONTROL_OCCUPIED`。`page.dom.get`、`tabs.list/get` 和 `system.describe` 是观察，不要求占据。不同 Key 仍各自串行；共享 occupation 锁只覆盖状态转换和 effect 派发门，不把所有 Key 的浏览器调用串成一个长队列。

## 本次 Freedom Point

- 保留 `transport.retry_interval_ms = 10000`。
- 保留 tabs 三个现有上限，但 `tabs.list` 改成仅 `{afterTabId, limit}` 的 live keyset page，不再计算 collection revision。
- 新增 DOM HTML JSON 字节上限、JS source 字节上限、JS value preview 字节上限、JS timeout 最大值。它们是 build-time 默认值/硬上界，不引入运行时 settings 系统。

## 明确不做

- 不实现清洗；等用户给算法后再设计，并优先作为可替换 Zig/WASM 纯计算模块。
- 不实现原始网络响应、页面归档、resource fetch、DOM selector/action、CDP/DevTools。
- 不把 relay、InstanceRef、Agent、配套软件或连接变成业务身份；鉴权与 occupation 都只认扩展侧 Key。
- 不为当前低频本地自动化提前加入集群调度、takeover、lease、renew、服务端 cursor 或通用插件框架。
