# Tabs 读取纵切

更新：2026-08-29。这里记录当前已经运行并通过 Chromium 端到端测试的 `tabs.list.v1` 与 `tabs.get.v1`，不预写后续 tab effect。

## 接口

`tabs.list` 请求：

```json
{
  "method": "tabs.list",
  "schemaVersion": 1,
  "params": {
    "afterTabId": null,
    "limit": 100
  }
}
```

结果为 `{items, nextAfterTabId}`。下一页把非空 `nextAfterTabId` 作为新的 `afterTabId`；这是 live keyset page，期间集合变化允许调用方看到新的实时页，要求一致快照时重新从第一页读取。不计算 collection revision，也不建立服务端 cursor。每个 item 含 opaque `tabRef`、window/index、active/highlighted/pinned/incognito/status，以及有显式 `titleTruncated | urlTruncated` 的 title/url。

`tabs.get` 请求：

```json
{
  "method": "tabs.get",
  "schemaVersion": 1,
  "params": {
    "tabRef": "tr1.<runtimeEpoch>.<tabId>.<generation>"
  }
}
```

结果在 `{tab}` 中返回同一 live TabRef 的当前 bounded metadata，并增加 audible/discarded/autoDiscardable/muted。客户端把 TabRef 当 opaque string；其中的 tabId 不构成可独立调用的目标身份。

## 权限与生命周期

- 两个命令都要求独立 `tabs.read`；`system.read` 不隐含它，Root 按 active permission universe 自动拥有它。
- 鉴权在入队前和该 Key 串行队列真正派发前各检查一次；派发后不再增加第三次结果披露鉴权。
- runtime epoch 由扩展生成并在 `chrome.storage.session` 的 `TRUSTED_CONTEXTS` 范围内回读确认；浏览器重启或连续性不可证明时旧引用失效。
- 每个 tabId 另有扩展内存 generation。`tabs.onRemoved/onReplaced` 删除映射；service worker 丢失映射也保守失效，而不是凭裸 tabId 猜测。
- syntactically invalid TabRef 返回 `SCHEMA_INVALID`；曾经合法但不再精确命中原 tab 的引用返回 `TAB_REF_STALE`，调用方重新 `tabs.list`。`tabs.get` 在异步 Chromium 读取返回后再次核对原 generation，响应路径不会隐式生成新 generation。

## Freedom Point

- `command.tabs.list.maximum_items = 100`
- `command.inline.maximum_result_json_bytes = 49152`
- `command.tabs.maximum_text_bytes = 2048`

文本按 UTF-8 code point 截断，不拆 surrogate/code point；list 在加入会越过整页预算的 item 前结束并返回 cursor。49152 为 65536-byte transport frame 留出 envelope 余量。

## 验证

`tests/extension-relay-smoke.mjs` 在真实 Chromium 中创建超长 title/data URL 标签页，经 native WebSocket client 完成 live keyset 分页、live get、无 `tabs.read` 的 FORBIDDEN、关闭后的 stale，以及 title/url byte bound；`tests/tab-service-races.test.mjs` 另固定复现并阻止 get 的 remove/read 竞态。relay 同时保持只路由、不鉴权。
