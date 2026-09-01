# 页面操作树

状态：现行设计与运行时一致。详细交互合同见[展开状态与查看接口](page-tree-view-interaction-proposal.md)，落地事实见[实现切片](../implementation/page-information-tree-slice.md)，逐层真实响应见[实际示例](../experience/page-tree-layer-by-layer-example.md)。

页面信息不是先清洗删除，也不是从完整页面另选一份“重点区”。每份仍存活的精确 Document 只有一棵 canonical operation tree：完整可观察 DOM 信息按固定父子关系编入树，折叠行带有界确定性摘要，Agent 决定展开哪些分支。

```text
page.tree.open(targetRef)
  -> 取得/复用 Document 唯一 rootRef

page.tree.expand(treeRef)
  -> 只改变调用 Key 的展开标记

page.tree.view.get(rootRef, optional projection)
  -> 一次性读取当前整体/层级/区间/子树，不改变状态
```

展开状态按 KeyId 隔离；同一 Key 的客户端共享，不同 Key 互不改变。切换页面不清除，Document refresh/replacement 才让旧引用失效。TreeRef 是精确操作引用；canonical indexPath 是 live view 的结构位置，用于层级、sibling range 和 subtree，不冒充长期节点身份。

第 0 层固定为 Document 直接子项。行编排固定为 attributes → live properties → open ShadowRoot → DOM childNodes。完整长值通过显式展开后的 `value_chunk` 叶子无损到达。

当前不包含 selection、“重点区”、快速入口、collapse/reset、Cleaner/PageIR、模型推断、CDP/AX tree 或后台全页快照。未来若需要智能目标推荐，应作为独立指令返回候选 TreeRef 与原因，不能污染 canonical tree 或拥有展开状态。
