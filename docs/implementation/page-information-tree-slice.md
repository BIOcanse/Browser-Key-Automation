# 页面操作树实现切片

状态：2026-08-30 已实现、生成、构建，并通过真实 Chromium—MV3 extension—Zig relay 端到端验证。现行接口是唯一 canonical operation tree，不含 selection、“重点区”或快速入口。

## 1. 指令

- `page.tree.open.v1({ targetRef })`：接受 `TabRef | DocumentRef`，返回精确 `documentRef`、该文档唯一 `rootRef`、`reused` 与 limitations。
- `page.tree.expand.v2({ treeRef })`：只把该节点加入调用 Key 的展开集合，返回 `{ rootRef, treeRef, expanded: true }`；幂等，不返回子项，不递归展开。
- `page.tree.view.get.v1({ rootRef, maximumLevel?, range?, subtree? })`：一次性读取当前 Key 的已展开轮廓；不保存 ViewId/cursor，不改变树状态。
- 三条指令都要求独立 permission atom `page.tree.read`，不从 `page.dom.read`、`dom.query` 或 `js.execute` 推导。

当前 registry 为 39 条 active command、36 个 active permission。

## 2. 文档状态

每个仍存活的精确 Document 在 ISOLATED world 中保存一份有界 registry：

```text
Document
├─ canonical TreeRef registry（节点/长值属性）
├─ stable rootRef
└─ expanded TreeRef set by KeyId
```

- 同一文档重复 `open` 复用 rootRef；切换 tab、打开其他 frame 树再回来不会清除。
- canonical TreeRef 只保存一份；不同 Key 只分开保存展开集合，同一 Key 的所有客户端共享。
- 页面节点移动后，仍存活的 TreeRef 跟随节点对象；view 每次从 live DOM 重新形成路径。已断开的节点在下一次树操作时清理。
- 树路由由 trusted `chrome.storage.session` 保存，普通 worker 回收不影响旧 TreeRef 的 view/expand；tab close 或 frame navigation/refresh 清理旧文档路由，旧 TreeRef fail closed 为 `TARGET_REF_STALE`。如果浏览器恢复同一 BFCache Document，重新 `open` 可重新挂接页面侧原 registry。
- TreeRef 跟随 Document 生命周期，不套用 NodeRef TTL；返回的 NodeRef 仍遵守 DOM 服务自己的 TTL。

## 3. canonical 编排

对普通扩展权限可注入的精确 Document，固定顺序为：

1. Document、doctype 与 DOM childNodes；
2. 元素全部 attributes；
3. 没有被同值 attribute 表达的 live form properties；
4. 可观察的 open ShadowRoot；
5. 文本、CDATA、注释和 processing instruction 的原始值。

第 0 层严格是 Document 的直接子项。每行回显 canonical `indexPath`、`level`、`sourceOrder`、`expanded`、TreeRef/NodeRef，以及确定性摘要字段 `attributeCount/childCount/role/label/states/valuePreview`。摘要不改变父子关系，也不判断重要性。

长文本、attribute、live property 与 doctype 标识值的 preview 截断后仍有 TreeRef；显式展开会在原节点下生成有序 `value_chunk` 叶子。块不归一化、不排序，并避免切断 surrogate pair，可以精确拼回既定原值编码。

iframe 元素留在所属文档树中；子 frame 继续通过 `frames.list` 取得 DocumentRef 后独立 `open`，不拍平跨 frame 身份。closed ShadowRoot、Chromium 内部 AX tree 与未挂载应用数据固定列在 limitations。

## 4. view 语义

- 无参数：当前 Key 已显式展开的完整轮廓，折叠节点仍作为一行存在。
- `maximumLevel: N`：只显示绝对第 0 到 N 层中已经可见的行；不会为凑层级而展开节点。
- `range: { from, toExclusive }`：两条路径必须属于同一父节点，直接定位父节点和起点，只返回半开 sibling 区间，不扫描无关前缀、不夹带后代；未展开的祖先不会被自动展开。
- `subtree: indexPath`：从指定节点开始显示其当前已展开分支；定位祖先不会把祖先标成 expanded。
- 结果超过 item/inline/scan 门时返回 `truncated` 与 `nextIndexPath`；扩展不保存服务端 cursor。

路径用于本次查看定位和 sibling range，TreeRef 才是精确操作引用。live DOM 自身修改可能改变下一次 view 的 indexPath，因此路径不冒充长期节点身份。

## 5. Freedom Points

| Point | 默认值 | 约束 |
|---|---:|---|
| `command.page.tree.maximum_index_depth` | 128 | caller/response canonical path 深度 |
| `command.page.tree.maximum_label_scan_nodes` | 256 | 单行 label 的 descendant 扫描 |
| `command.page.tree.maximum_preview_characters` | 256 | 单行 preview；完整原值仍可展开 |
| `command.page.tree.maximum_refs_per_document` | 4096 | 单 Document live TreeRef registry |
| `command.page.tree.maximum_view_items` | 256 | 单次 view materialized 行数 |
| `command.page.tree.maximum_view_scan_nodes` | 20000 | 单次非递归轮廓扫描量 |

同时复用 inline JSON byte 门、NodeRef 容量/TTL 与 URL/title byte 门。生成器验证 active schema 可选字段、view/ref 容量关系、Command/Freedom consumer 反向引用和 schemaVersion 映射。

## 6. 实现与验证

- 浏览器实现：[page-tree-service.ts](../../apps/extension/src/background/page-tree-service.ts)
- closed schema、鉴权和 Key lane：[command-dispatcher.ts](../../apps/extension/src/background/command-dispatcher.ts)
- API 真值：[commands.registry.json](../../registries/commands.registry.json)
- 数值真值：[freedom.registry.json](../../registries/freedom.registry.json)
- 逐层实际交互：[page-tree-layer-by-layer-example.md](../experience/page-tree-layer-by-layer-example.md)
- 原始转录：[page-tree-actual-interaction.json](../../out/test-artifacts/page-tree-actual-interaction.json)

真实测试覆盖首次/重复 open、0/1/2 层、无隐式展开、sibling range、subtree 无状态、完整值重组、100-button 分段、子 frame、切走再回来、按 Key 隔离、权限拒绝、schema 负例与 reload 后旧 root 失效。

不包含 Cleaner/PageIR、重要性判断、CDP/DevTools、collapse/reset、自动点击或 background 全页 snapshot。

## 7. 同 Document 空置复核与路由修复

验收要求不变：浏览器页面没有刷新时，operation tree 和调用 Key 的展开状态应保留。补测普通 MV3 后台回收这一边界：记录 rootRef、DocumentRef 和已展开路径，停止请求 45 秒，再直接用旧 TreeRef 发 view/expand，随后 reopen 同一 TabRef 比较结果。不停止用户浏览器、不刷新网页、不用 debugger 保活，不改选择算法。

项目内手动复核脚本 `tools/probe-live-tree-idle.mjs` 只调用 `tabs.list` 和三条树指令；Key 从临时环境变量读取。旧引用测试之后，再显式列出标签页并用新 TabRef 打开同页，比较页面侧 root 和展开状态，区分路由失效与缓存丢失。每次真实 request/response 立即写到私密样本目录，保留失败与 delivery 信息，写入前检查完整 Key 形状。等待只能证明经过了空置窗口，是否真的发生后台回收需结合返回结果及独立回收测试判断。

修复前，真实个人 B 站页面两次空置 45 秒后，旧 root view/HTML expand 均收到 `TARGET_REF_STALE`，旧 TabRef reopen 收到 `TAB_REF_STALE`；重新 `tabs.list → open` 则返回同一 root、`reused: true`，HTML/BODY 展开状态不变。问题是 worker 内存路由丢失，不是页面树或传输丢失。

修复的最简逻辑：页面继续唯一保存树和按 Key 的展开集合；扩展把已签发 TreeRef 对应的 `{rootRef, tabId, frameId, documentId}` 路由放在 trusted `chrome.storage.session`，不另留内存副本。view/expand 按该路由取得当前 TabRef，并只向那个精确 Chromium Document ID 注入；页面再验证原 TreeRef 对象身份。worker 回收不清 session，因此旧树引用仍能使用；真实刷新、关闭或引用所指节点消失仍 stale。结果中的 TabRef/DocumentRef 是本次有效引用，不恢复旧的 runtime-scoped TabRef/NodeRef。

文件边界：`page-tree-service.ts` 替换临时路由表的存取及生命周期清理；`tab-service.ts` 提供仅内部使用的当前 tab 引用解析，树服务必须配合精确 Document ID 注入与回包校验，不能凭裸 tabId 执行动作；`chrome.d.ts` 补齐 session 全量读取/删除签名；`tests/extension-relay-smoke.mjs` 在独立测试浏览器中强制停止 worker，直接用原 root/子节点引用复测，再验证刷新后失效。不改变命令/schema/权限，不加后台保活或自动重放。

每次存储操作只包含路由元数据，无 DOM、页面文本、Key secret 或展开集合；写入失败向调用方返回 `STORAGE_UNAVAILABLE`。session 总容量仍受 Chromium 自身配额限制，不静默驱逐已签发活引用。树请求从 session 取有限候选，页面 prune 后回传其中确已失效者，后台仅删除这些路由；删除失败后的下一次请求会重新核验。tab close/replaced 清理该 tab；导航在短队列内读取当前全部 frame/document 对，只清消失者，保存路由前也核对当前精确文档。未知 frame 元数据不视为消失，不因主导航误删新子 frame。网页操作本身不进入这个存储队列，各 Key 的动作队列不变。

实现与验证已完成：`tests/page-tree-session.test.mjs` 覆盖 storage failure、有序清理、保留新 Document 和其他 tab；扩展—relay smoke 明确 stop worker 后第一笔直接 old BODY expand、再 old root view，两个展开路径保留；旧 TabRef 不复活，随后真实刷新使旧树引用 stale。用户真实个人浏览器更新后也已复测通过：空置 45,015 ms 后原 root view/HTML expand 成功，39 行与两条展开 TreeRef/路径保持不变；旧 TabRef 仍按既定规则失效。证据与私密文件位置见[交互记录](../experience/page-tree-idle-recovery.md)。

收尾审查补测已通过：通过实际 open/view 注册路径注入 session.set 失败，固定返回 `STORAGE_UNAVAILABLE`、不暴露底层错误内容、下一笔存储操作仍能继续；把新文档 open 的实际写入排在暂停的 navigation cleanup 后，确认写入先等待、清理完成后新路由保留。只补故障回归，不增加产品状态或接口。
