# 页面操作树逐层真实交互示例

日期：2026-08-30。来源是当前 `tests/extension-relay-smoke.mjs` 的真实链路：`Chromium → MV3 extension → offscreen worker → Zig relay → native client`。不是手写模拟，API Key 不写入文件。

最新一次完整原始 request/response 保存在 [page-tree-actual-interaction.json](../../out/test-artifacts/page-tree-actual-interaction.json)。每次运行都会生成新的不透明 TabRef、DocumentRef 与 TreeRef；下面保留真实 canonical index、字段和页面内容，随机引用以 `…` 省略。

测试页面标题为 `BKA core probe`。最终完整展开视图实际有 65 行，共执行 23 次新的节点展开；长 attribute 与长 text 都由 `value_chunk` 子项逐字符重组成功。

## 1. 刚选中页面

请求：

```json
{
  "method": "page.tree.open",
  "schemaVersion": 1,
  "params": { "targetRef": "tr1.…" }
}
```

真实结果的稳定部分：

```json
{
  "frameId": 0,
  "url": "http://127.0.0.1:<ephemeral-port>/",
  "title": "BKA core probe",
  "rootRef": "tr2.…",
  "reused": false,
  "limitations": [
    "browser_accessibility_tree_unavailable",
    "closed_shadow_roots_unobservable",
    "unmounted_content_unobservable"
  ]
}
```

`open` 只取得该文档唯一操作树，不返回第二套 selection，也不自动展开节点。对同一未刷新文档再次 `open`，真实测试得到同一个 `rootRef`、同一个 `documentRef` 和 `reused: true`。

## 2. 第一次整体查看：严格第 0 层

请求：

```json
{
  "method": "page.tree.view.get",
  "schemaVersion": 1,
  "params": { "rootRef": "tr2.…" }
}
```

真实返回只有 Document 的两个直接子项：

```text
[0]  level=0  doctype html  childCount=0  treeRef=null  expanded=false
[1]  level=0  HTML          childCount=2  treeRef=tr2.… expanded=false
```

HTML 行还带有有界 `label` 摘要，但摘要不改变树结构、不生成快速入口。`treeRef != null` 表示该行有可展开细节；doctype 是完整叶子。

## 3. 展开 HTML 后查看第 0 层

操作：

```json
{
  "method": "page.tree.expand",
  "schemaVersion": 2,
  "params": { "treeRef": "<HTML TreeRef>" }
}
```

结果只确认状态：

```json
{
  "rootRef": "tr2.…",
  "treeRef": "<HTML TreeRef>",
  "expanded": true
}
```

随后 `view.get({ maximumLevel: 0 })` 仍只返回同样两行；区别只是 HTML 变为 `expanded=true`。因此“查看第 0 层”没有把已展开的第 1 层混进来，也没有折叠 HTML。

```text
[0]  doctype html  expanded=false
[1]  HTML          expanded=true
```

## 4. 查看第 1 层

`view.get({ maximumLevel: 1 })` 的真实结果：

```text
[0]    level=0  doctype html  expanded=false
[1]    level=0  HTML          expanded=true
[1,0]  level=1  HEAD          childCount=2  expanded=false
[1,1]  level=1  BODY          childCount=5  expanded=false
```

这就是“同时看到已经展开的 0 层和 1 层”。HEAD、BODY 出现是因为 HTML 已显式展开；它们自身没有被查看指令自动展开。

## 5. 只展开 BODY，再查看第 2 层

先对 `[1,1]` 的 TreeRef 执行一次 `page.tree.expand`，不展开 HEAD。随后：

```text
[0]      level=0  doctype html                         expanded=false
[1]      level=0  HTML                                 expanded=true
[1,0]    level=1  HEAD       label="BKA core probe"   expanded=false
[1,1]    level=1  BODY                                 expanded=true
[1,1,0]  level=2  #comment   "tree-comment-sentinel"  expanded=false
[1,1,1]  level=2  HEADER     childCount=1              expanded=false
[1,1,2]  level=2  MAIN       role=main, childCount=7   expanded=false
[1,1,3]  level=2  IFRAME     attributeCount=2          expanded=false
[1,1,4]  level=2  SCRIPT     childCount=1              expanded=false
```

关键实测：HEAD 仍是 collapsed，且没有出现 `[1,0,*]`。请求 `maximumLevel: 2` 没有为了填满层级而展开 HEAD。

## 6. 同父区间

真实请求：

```json
{
  "rootRef": "tr2.…",
  "range": {
    "from": [1, 1, 1],
    "toExclusive": [1, 1, 4]
  }
}
```

真实结果正好三行：

```text
[1,1,1]  HEADER
[1,1,2]  MAIN
[1,1,3]  IFRAME
```

没有 comment、SCRIPT，也没有夹带 MAIN 的后代。100 个 button 的子 frame 在一次整体视图中会触发 inline 上限；真实测试用四段 `[0,25) / [25,50) / [50,75) / [75,100)` sibling range 完整读回 100 个互不重复的 button。这是区间指令的实际用途，不需要服务端 cursor。

## 7. MAIN 子树

展开 `[1,1,2]` 的 MAIN 后，请求：

```json
{
  "rootRef": "tr2.…",
  "subtree": [1, 1, 2]
}
```

真实结果从 MAIN 自身开始，不返回祖先：

```text
[1,1,2]    MAIN      role=main  expanded=true
[1,1,2,0]  attribute data-tree-long  valueTruncated=true
[1,1,2,1]  DIV       label="live DOM payload"
[1,1,2,2]  ARTICLE   label="tree-primary-title tree-long-text-字字……"
[1,1,2,3]  INPUT     role=textbox  valuePreview="before"
[1,1,2,4]  BUTTON    role=button   label="click"
[1,1,2,5]  SELECT    role=combobox label="A B"
[1,1,2,6]  IMG       role=img      label="probe-resource"
[1,1,2,7]  DIV       states=[open-shadow-root]
```

在子树 GET 前后各取一次整体视图，返回逐项相同，证明 `subtree` 只是一次性投影，不改展开状态。

## 8. 后续实际层级

继续逐节点显式展开后，主要路径如下。

第 3 层：

```text
[1,0,0]    TITLE
[1,0,1]    STYLE
[1,1,1,0]  NAV
[1,1,2,0]  @data-tree-long
[1,1,2,1]  DIV       "live DOM payload"
[1,1,2,2]  ARTICLE
[1,1,2,3]  INPUT
[1,1,2,4]  BUTTON
[1,1,2,5]  SELECT
[1,1,2,6]  IMG
[1,1,2,7]  DIV       states=[open-shadow-root]
[1,1,3,0]  @id
[1,1,3,1]  @src
[1,1,4,0]  #text     "window.pageOwnedValue=73;…"
```

第 4 层包括长 attribute 的 `value_chunk`、普通 attributes/properties、ARTICLE 子项和 open ShadowRoot：

```text
[1,1,2,0,0..2]  value_chunk  # 三块拼回完整 715-character attribute
[1,1,2,1,0]     @id="payload"
[1,1,2,1,1]     #text="live DOM payload"
[1,1,2,2,0]     H1
[1,1,2,2,1]     P
[1,1,2,2,2]     SECTION states=[hidden]
[1,1,2,3,*]     INPUT 的 id/value
[1,1,2,4,*]     BUTTON 的 id/onclick/live value/#text
[1,1,2,5,*]     SELECT 的 attributes/live value/OPTION
[1,1,2,7,1]     shadow_root
```

第 5 层：

```text
[1,1,1,0,0]    A role=link
[1,1,2,2,0,0]  #text="tree-primary-title"
[1,1,2,2,1,0]  @id="tree-long-text"
[1,1,2,2,1,1]  #text="tree-long-text-字字……" valueTruncated=true
[1,1,2,2,2,1]  #text="tree-hidden-sentinel"
[1,1,2,7,1,0]  #text="tree-shadow-sentinel"
```

第 6 层是长正文的三个 `value_chunk`：

```text
[1,1,2,2,1,1,0]
[1,1,2,2,1,1,1]
[1,1,2,2,1,1,2]
```

按 `sourceOrder` 拼接后，与原始 715 个 JavaScript characters 完全一致；块边界不会切断 surrogate pair。

## 9. 缓存、多 Key 与刷新

真实测试还验证：

- 先完整展开主页面，再打开子 frame 的另一棵树，然后重新 `open` 主页面：主页面 `rootRef` 不变、`reused=true`，HTML/BODY/MAIN 仍为 expanded。
- 第二个拥有 `page.tree.read` 的 Key 第一次看同一个 root 时只见 `[0]` 与 collapsed `[1]`；它展开 HTML 后只改变自己的状态。原 Key 的 BODY 仍保持 expanded。
- `tabs.reload` 产生新 DocumentRef 后，旧 root 的 `expand` 与 `view.get` 都返回 `TARGET_REF_STALE`；重新 `open` 得到新的 rootRef 和 `reused=false`。
- `page.tree.expand` 的旧 schemaVersion 1、反向 sibling range 都被 `SCHEMA_INVALID` 拒绝。

这份样本对应现行接口，不含 selection、“重点区”、ViewId、server cursor、collapse 或隐藏 reset。
