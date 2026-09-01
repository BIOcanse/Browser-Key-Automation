# 页面树展开状态与查看接口：交互示例及待确认方案

状态：核心状态模型与唯一 canonical tree 已由用户确认并落地；不设置 `selection`/“重点区”/快速入口。本文是现行首版合同，运行事实见实现切片与逐层真实样本。

## 1. 用户要求

> “有个操作区让你可以展开，但不是真的像文件系统那样只能看到展开后的，而是还是能看到整体。”

> “可以通过另一套指令去看特定部分，比如看指定层（看0层那就只看最上层，看1层那就是能同时看到所有已经展开的0层和1层（不会让没有展开的自己展开）），然后就是看特定区间，靠类似文件树的索引来看区间。”

> “选中某个页面后，会有操作树，操作树会缓存，你之后到了其他页面在回来，只要这个页面没刷新过就会保留，包括展开状态。然后你视图不一样是一次性的get指令。”

## 2. 最简无损理解

每一份尚未刷新的页面文档拥有一棵缓存的操作树。树结构和节点引用只保存一份；“哪些节点已经显式展开”按 Key 分开保存，同一 Key 的所有连接共享，不同 Key 的查看互不改变。

- 选中页面时取得该页面现有操作树；第一次选择才创建。切换到其他页面不删除它，回来时继续使用同一棵树和原展开状态。
- 页面刷新会产生新的精确文档，旧操作树随旧文档真实生命周期结束而失效；新文档建立新树。单纯切换当前选中的页面不属于刷新。若导航离开后浏览器把原文档保存在 BFCache，返回时仍是同一精确文档身份，则继续复用原操作树；若浏览器实际重建了文档，才得到新树。
- 操作指令只改变调用 Key 在该树上的展开标记，不负责充当主要阅读结果。
- 查看是一次性 GET：只读取当前操作树并返回一种投影，不保存“当前 view”，也不点击、不展开、不补齐隐藏层。
- 未展开节点仍作为一行留在整体轮廓中，并明确显示“还有子项、当前未展开”。
- 已展开过的不同分支同时保留；展开 B 不会让先前展开的 A 从结果里消失。
- 按层查看只是给当前轮廓加最大层级，不会为了凑够该层而自动展开任何节点。
- 按区间查看使用树路径索引，不用临时数组序号猜节点；真正的后续操作仍使用 TreeRef。

这取代了已退役 v1 的“expand 返回一批直接子项、调用方自行积累整体”；现行模型由扩展缓存操作树和展开状态，消费端用一次性 view GET 读取投影。

## 3. 状态所有权和生命周期

```text
未刷新的页面文档
└─ cached operation tree
   ├─ 唯一 canonical 节点/TreeRef
   └─ expanded state by Key

一次 view GET
└─ 读取上面的当前状态并返回投影；响应后不留下 view 状态
```

- cache key 必须落到精确文档身份，而不是“当前 tab”或当前选中状态。这样切到另一 tab、另一页面，再回来时仍能命中仍然存活的原树；refresh 或未命中原文档身份时才自然建立新树。
- rootRef 是操作树句柄，不另造 ViewId。对同一份未刷新的文档再次选择，返回同一 operation-tree rootRef。
- view 的 `maximumLevel/range/subtree` 都是本次 GET 参数，不写回操作树。
- TreeRef 跟随文档寿命，不使用普通 DOM/NodeRef TTL；NodeRef 仍维持自己的现有 TTL。background route 在页面 refresh/navigation/tab close 后清除，单纯切换 tab 不清除。

## 4. 建议的最少指令

### 选择/取得操作树

```text
page.tree.open({ targetRef })
  -> { rootRef, documentRef, reused }
```

同一份未刷新文档重复调用固定复用缓存树；`reused` 只是直接告诉消费端结果，不影响语义。该方法取得 operation tree，而不是创建一次性 view。

### 操作区

```text
page.tree.expand({ treeRef })
  -> { rootRef, treeRef, expanded: true }
```

`expand` 只给当前调用 Key 标记这个节点已展开；不会递归展开后代，也不返回一批目录让消费端自行拼树。重复展开同一节点是同结果的幂等操作。

用户当前只要求展开，没有要求折叠。首版不增加 `collapse`、`resetDescendants` 或隐藏清理语义；出现真实使用需要后再独立裁定。

### 查看区

```text
page.tree.view.get({ rootRef })
page.tree.view.get({ rootRef, maximumLevel: 0 })
page.tree.view.get({ rootRef, maximumLevel: 1 })
page.tree.view.get({ rootRef, range: { from: [1, 0], toExclusive: [1, 4] } })
page.tree.view.get({ rootRef, subtree: [1, 1, 2] })
```

建议只用一个 read 指令，参数可以组合：

- 不给 `maximumLevel/range/subtree`：看当前 Key 已展开轮廓的整体。
- `maximumLevel=N`：返回第 0 层到第 N 层中当前已经可见的所有行。
- `range`：`from` 与 `toExclusive` 必须是同一父节点下的 sibling 索引，只返回该 sibling 区间的当前行，不夹带某一 sibling 的后代。
- `subtree`：直接以指定 indexPath 的节点作为本次视图根；定位它不改变祖先展开状态，其内部仍只显示当前 Key 已显式展开的部分。
- 两者同时给出：先按当前显式展开状态和 `maximumLevel` 形成轮廓，再取 tree index 区间。

查看永远不改变 expanded 状态。响应按 inline byte 与 view item 上限截断时返回 `truncated=true` 和可继续作为下一次 `range.from` 的 `nextIndexPath`；服务端不保存 cursor/ViewId。

## 5. 树索引

对外显示可以写成文件树式编号：

```text
0
1
1.0
1.1
1.1.0
```

协议参数建议使用整数数组 `[1, 1, 0]`，避免字符串的 `1.10` 与 `1.2` 比较歧义。

每一段都是该父节点固定编排后的直接子项序号：attributes → live properties → open ShadowRoot → DOM childNodes。索引用于查看和选择区间；TreeRef 才是精确操作引用。因为当前对象是 live DOM，页面自身修改可能改变下一次 view 的路径排列，响应必须回显本次 `indexPath`，不能把路径冒充长期 Node 身份。

## 6. 层级查看的精确例子

假定当前轮廓是：

```text
0 html                         [expanded]
  0.0 head                    [collapsed]
  0.1 body                    [expanded]
    0.1.0 header              [collapsed]
    0.1.1 main                [expanded]
      0.1.1.0 article         [collapsed]
    0.1.2 iframe              [collapsed]
```

`maximumLevel: 0`：

```text
0 html                         [expanded]
```

`maximumLevel: 1`：

```text
0 html                         [expanded]
  0.0 head                    [collapsed]
  0.1 body                    [expanded]
```

`maximumLevel: 2`：

```text
0 html                         [expanded]
  0.0 head                    [collapsed]
  0.1 body                    [expanded]
    0.1.0 header              [collapsed]
    0.1.1 main                [expanded]
    0.1.2 iframe              [collapsed]
```

注意 `head` 没有因为请求第 2 层而自动展开；只有 `body` 已显式展开，所以第 2 层只出现 body 的子项。`main` 的 article 属于第 3 层，在 `maximumLevel: 2` 时不显示。

## 7. 区间查看的精确例子

对上面的当前轮廓：

```text
range: { from: [0, 1, 0], toExclusive: [0, 1, 2] }
```

只返回：

```text
0.1.0 header                   [collapsed]
0.1.1 main                     [expanded]
```

它不会返回 `main` 的后代，因为 `toExclusive` 已到 `[0,1,2]`；也不会展开 header。若要看 main 当前已经展开的整个分支，可提供以 `[0,1,1]` 为 subtree root 的 view，而不是猜一个足够大的字符串终点：

```text
page.tree.view.get({ rootRef, subtree: [0, 1, 1] })
```

`subtree` 与 sibling `range` 都保留，因为它们分别回答“看一整个分支”和“看同级的一段”，不需要消费端猜字符串终点。

## 8. 唯一入口与折叠摘要

现有 canonical 树严格按 DOM 编排。对烟测页面：

```text
Document root
├─ 0: doctype html
└─ 1: HTML
   ├─ 0: HEAD
   └─ 1: BODY
```

因此严格的第 0 层就是 Document 的直接子项：doctype 与 HTML。这里不再额外生成跨层的 `selection`、“重点区”或快速入口；同一个页面只有一套父子关系、一套路径索引和一套展开状态。

初次查看是否容易理解，由 canonical tree 的行摘要解决，而不是建立第二套重要性判断。折叠节点可返回确定性摘要，例如：

```text
1  HTML  [2 children]
1.1  BODY  [5 children, 8 interactive, 1 frame]
```

摘要只使用现有确定字段：`attributeCount`、`childCount`、`role`、`label`、`states` 与有界 `valuePreview`。它不签发另一份节点、不改变 indexPath、不展开后代，也不声称哪个节点“更重要”。

如果将来确实需要智能推荐目标，应另建显式指令（例如 `page.suggestTargets`），返回候选 TreeRef 和入选原因；它不进入 operation tree，不拥有展开状态，也不影响层级/区间查看。本轮不实现该能力。

## 9. 已确认实施边界

已确认：

- operation tree 按页面文档缓存；
- 切走再回来保留；
- 页面 refresh/document replacement 才失效；
- 展开状态属于 operation tree；
- view 是无状态、一次性的 GET，不拥有任何缓存。
- 页面只有唯一 canonical tree；第 0 层固定为 Document 的直接子项；
- 不设置 `selection`、“重点区”或快速入口；折叠行用确定性摘要帮助理解；
- 智能目标推荐若将来需要，必须是独立能力，不能污染 operation tree。
- canonical 节点只缓存一份；展开标记按 Key 保存，同 Key 共享、不同 Key 互不干扰；
- 首版只有 `open / expand / view.get`，不加入用户没有要求的 collapse/reset；
- TreeRef 跟随精确文档生命周期，NodeRef 继续遵守独立 TTL。

完整语义是：页面文档拥有唯一缓存 operation tree，操作面管理当前 Key 的显式展开状态，查看面用一次性 GET 读取整体/层级/sibling 区间/指定子树，三者没有隐藏联动。
