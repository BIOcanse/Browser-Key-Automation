# 浏览器核心指令扩展纵切（2026-08-30）

状态：已实现并通过真实 Chromium—relay 验证。本文件冻结本轮实际交付的接口与实现边界。后续新增的完整页面信息树由[页面信息树实现切片](page-information-tree-slice.md)单独冻结；CDP/DevTools、宏命令和额外占据语义仍不激活。

## 1. 不变的所有者与执行顺序

- 扩展是 Key、权限、设置、Artifact 和 Chromium 指令的唯一业务所有者；relay 只路由，不鉴权、不保存业务身份。
- 每个请求只认 API Key。Root 对本构建全部 active permission atom 动态为真；Regular 只拥有显式 atom。`js.execute` 与其他权限并列，互不蕴含。
- 同 Key 进入同一串行 lane；不同 Key 不共享动作 FIFO。
- tab/page/DOM effect 在真正调用 Chromium API 前检查 global 与目标 tab occupation。`tabs.create` 尚无目标 tab，只检查 foreign global occupation。纯读取不加 occupation 读锁。
- foreign acquire 只报冲突；解除和重新占据仍是两个独立指令，不提供 takeover/force/status/组合动作。

## 2. 本轮 active 指令和独立权限

| 指令 | 权限 | 性质 | 结果要点 |
|---|---|---|---|
| `system.describe` | `system.read` | 读 | active commands/permissions/capabilities |
| `control.acquire/release` | 同名权限 | authority | 保持既有两步语义 |
| `tabs.list/get` | `tabs.read` | 读 | opaque `TabRef` |
| `tabs.create/navigate/activate/reload/close` | 各自同名权限 | effect | 每种动作单独授权；create 的 windowId/active 显式 |
| `page.dom.get` | `page.dom.read` | 读 | 必填 `root=document|body`，只返回有界 preview |
| `page.dom.capture` | `page.dom.capture` | 读 | 当前完整 live DOM 冻结为 Artifact |
| `page.text.get` | `page.text.read` | 读 | 当前 `body.innerText` 的有界 preview，不宣称清洗 |
| `frames.list` | `frames.read` | 读 | 当前 frame/document 投影并签发短寿命 `DocumentRef` |
| `dom.query/describe` | `dom.query` / `dom.describe` | 读 | selector 查询签发短寿命 `NodeRef`；descriptor 有界 |
| `dom.click/setValue/select/focus/scroll` | 各自同名权限 | page effect | 固定 DOM 方法；不是 OS 可信输入 |
| `page.resources.list` | `page.resources.read` | 读 | DOM 与 Performance API 已发现的 URL；不宣称完整网络日志 |
| `resource.fetch` | `resource.fetch` | network effect | 新的显式 GET；绝不冒充页面原始 response |
| `page.archive.capture` | `page.archive.capture` | capture | Chrome 当前 MHTML；不是最初 HTTP 文件 |
| `page.screenshot.capture` | `page.screenshot.capture` | capture | 只抓当前可见 viewport；目标未 active 时明确失败且不暗中 activate |
| `artifact.read/release` | 各自同名权限 | 读 / 删除 | 默认只允许创建该 Artifact 的 Key；Root 也不跨 owner 隐式读取 |
| `keys.list/get/create/update/revoke/reveal` | 各自同名权限 | authority | 复用现有 strict-IDB Key 所有者与 mutation 去重 |
| `settings.get/update` | 各自同名权限 | authority | 版本化强类型设置；禁止通用 JSON merge |
| `js.execute` | `js.execute` | page effect | 保持 USER_SCRIPT/MAIN 两个显式 world |

## 3. 引用与大结果

- `ArtifactRef = ar1.<32-byte base64url>`，CSPRNG 生成。记录不可变、持久化于扩展 IndexedDB，并绑定 `ownerKeyId`。
- 正文按 rebuild Freedom Point `build.artifact.chunk_bytes=1048576` 保存为独立 ArrayBuffer chunk；metadata 与全部 chunk 在同一个 strict IndexedDB transaction 内提交。`artifact.read` 的 36000-byte raw 门保证一次读取最多相交两个存储 chunk，不因读取小块克隆整份大 Artifact。
- Artifact 元数据固定包含 `artifactRef/mediaType/byteLength/sha256/createdAt/expiresAt`。创建命令在完整内容通过大小门并成功提交后才返回引用。
- `artifact.read` 使用 `{artifactRef, offset, maximumBytes}`，返回 base64url chunk、`nextOffset|null` 和完整元数据；单块受 build Freedom Point 限制。`artifact.release` 是显式删除，返回是否删除。
- 本纵切不实现跨 Key `.any` 权限；知道引用不等于有权读取。未知、到期、已释放或非 owner 对外统一不披露正文存在性。
- `DocumentRef`/`NodeRef` 是当前 extension runtime 的短寿命 opaque 引用。service worker/文档/isolated world 连续性无法证明时返回 stale，不按 URL 或 selector 猜测复活。
- 所有可变 inline list 共用 rebuild Freedom Point `command.inline.maximum_result_json_bytes=49152`；frame、resource、DOM query、Key 和 header 投影均在添加下一项前按 JSON UTF-8 总字节停止，避免条数上限相乘后越过 65536-byte transport frame。

## 4. DOM 与 frame 语义

- `frames.list` 以 Chromium 当前 frame 数据为准；URL 文本有界。可动作 document 才获得 `DocumentRef`。
- `dom.query` 只接受一个 CSS selector 和显式 limit；在目标 isolated world 中建立有界 node token 表，不能返回 DOM 对象。
- `dom.describe` 返回 tag/id/classes/role/name/text/value/checked/disabled/selected/rect 等有界观察值。
- `dom.click` 调用元素 `click()`；`setValue` 设置 value 并派发 `input`、`change`；`select` 设置 option selection 并派发事件；`focus` 调用 focus；`scroll` 调用 `scrollIntoView`。这些是页面 DOM effect，不保证与物理鼠标键盘相同。

## 5. Key 管理边界

- Agent 路由直接复用受信管理 UI 已使用的 Key service；create/update/revoke 继续要求调用方预先生成 `am1.<13位毫秒>.<16-byte base64url>` mutationId，以便响应丢失后重发同一意图。
- Root 可以创建 Root 或 Regular。Regular 即使拥有管理指令，也只能创建/更新 Regular，且新增给目标的每个权限必须同时是当前 active atom并由调用 Key 自己拥有；删除权限、禁用或 revoke 不要求拥有被移除 atom。
- `keys.reveal` 是独立高风险 permission atom；获授权后可查看目标 Key 的已保存完整 token，符合本地管理页面的既定可再次查看语义。

## 6. 强类型设置

当前 `settings.v1` 只管理确有运行时 consumer 的 Artifact 策略：

```text
revision: safe integer
artifactRetentionMs: 60_000 .. 2_592_000_000
artifactMaximumBytes: 1_048_576 .. build hard maximum
artifactMaximumCount: 1 .. 256
artifactMaximumTotalBytes: 1_048_576 .. build hard total maximum
```

`settings.update` 必须提交 expectedRevision 和四个完整字段；成功时 revision 递增。降低上限不会隐式删除已有 Artifact，新建在空间不足时明确失败；到期/显式 release 才清理。10 秒 relay retry 仍是已确认的 rebuild Freedom Point，本轮不伪造成尚未接通 worker 的热设置。

## 7. 稳定失败详情

- `CAPABILITY_UNAVAILABLE` 必须带 `{capabilityId, reason}`。至少区分 `USER_SCRIPTS_NOT_ENABLED`、`RESTRICTED_PAGE`、`TARGET_TAB_NOT_VISIBLE`、`HOST_ACCESS_UNAVAILABLE`、`CHROMIUM_API_FAILED`。
- stale target、Artifact 不可访问、Key 不存在/已撤销、revision/mutation 冲突和容量超限使用独立稳定错误码；诊断不包含 API Key、页面正文或 Artifact chunk。
- `resource.fetch` 已发出后、DOM action 已调用后等错误不宣称可安全自动重试；本轮不增加隐藏 fallback 或自动组合。

## 8. 文件所有权

- Registry 与生成器：命令、权限、Capability、Error、Freedom Point 和 Manifest 投影。
- `command-dispatcher.ts`：闭合 schema、Key lane、鉴权和 effect gate 编排。
- `tab-service.ts`：TabRef 与 tabs API。
- `browser-service.ts`：DOM preview/text/JS 与稳定 capability 诊断。
- `dom-service.ts`：DocumentRef/NodeRef、frames、固定 DOM 操作。
- `artifact-service.ts`：Artifact 创建、读取、释放、lazy expiry 和容量。
- `capture-service.ts`：resources/fetch/MHTML/screenshot，统一写 Artifact。
- `settings-service.ts`：settings.v1 strict-IDB owner。
- `key-service.ts`：既有 Key owner，加 Agent 管理调用者的授权上界检查。

## 9. 明确不在本轮

- Cleaner/PageIR、摘要删除式页面处理；完整页面操作树已由独立切片实现为唯一 canonical tree + 按 Key 展开 + 一次性 view，不含 selection。
- CDP/DevTools 自动切换、Chrome 调试确认处理、浏览器级可信输入。
- control status/takeover/force、第二个 eval、宏命令、隐式 fallback。
- 把发现的 resource 列表称为完整 HAR，或把 fetch/MHTML/live DOM 称为服务器原始网页文件。
