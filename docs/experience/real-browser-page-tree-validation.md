# 真实个人浏览器页面树验证

日期：2026-08-30

本轮直接连接用户日常使用的 Chromium 扩展实例，只执行读取、`page.tree.expand` 和一次性 view 请求。Browser Key 只从用户指定的桌面文件读入子进程环境变量，没有写入命令行、项目文件、样本或输出。

## 1. 本地 App 与实例恢复

第一次枚举得到一个在线扩展实例。随后本地 relay 退出，CLI 明确返回 `RELAY_UNREACHABLE / ECONNREFUSED`。重新启动已经构建好的 Windows 本地 App 后，扩展在一个 10 秒重连周期内重新接入；新 relay 签发的新实例号为 `1`。

这次过程直接验证了两项既定行为：

- 未连上时由扩展按 10 秒节拍继续尝试，不需要用户反复确认；
- 实例号只由当前本地 App 签发，relay 重启后不沿用旧实例号。

新 Key 随后的 `system.describe` 鉴权成功，`tabs.list` 返回 10 个真实标签页。

## 2. B 站首页逐层实际结果

选择一个已经打开、未刷新的 B 站首页。第一次 `page.tree.open` 返回 `reused=false`；之后所有 reopen 都返回同一个 `rootRef` 和 `documentRef`。

### 第 0 层

初始 view 严格只有两行：

```text
[0] doctype html
[1] HTML  childCount=6  expanded=false
```

HTML 的聚合 label 已经包含页面标题和顶部导航摘要，但没有产生第二套“重点区”。

### 第 1 层

显式展开 HTML 后，`maximumLevel=1` 返回 11 行。真实顺序不是测试页常见的 `HEAD/BODY`：

```text
[1,0] attribute lang
[1,1] attribute data-immersive-translate-page-theme
[1,2] attribute data-eusoft-scrollable-element
[1,3] BETTERCAMPUS-COMPONENTS
[1,4] HEAD  childCount=77
[1,5] #text
[1,6] BODY  childCount=26
[1,7] EUSOFT-CHROME-EXTENSION-ROOT-EN
[1,8] DIV
```

另一个扩展注入的属性和节点会参与完整 canonical tree，所以 BODY 的实际 indexPath 是 `[1,6]`，不能硬编码为 `[1,1]`。

### 第 2 层

展开 BODY 后，总体 view 为 39 行，其中第 2 层有 28 行：2 个属性、多个空白文本、9 个 SCRIPT、2 个 IFRAME、其他扩展注入节点，以及承载页面内容的 `[1,6,8] DIV`。

完整树没有把脚本、iframe、注释或注入节点删掉。Agent 依据 label 和 childCount 选择 `[1,6,8]` 继续下钻。

### 第 3 至 7 层

真实应用外壳包含多层 DIV 和框架注释边界：

```text
[1,6,8]
  -> [1,6,8,6] 应用根
    -> [1,6,8,6,7] MAIN role=main
      -> [1,6,8,6,7,2]
        -> [1,6,8,6,7,2,2]
          -> [1,6,8,6,7,2,2,3] 推荐内容容器 childCount=51
```

`MAIN` 在第 4 层第一次出现。其下仍有三层无 label 或重复 label 的结构包装。

### 第 8 层：页面主要内容第一次成组出现

展开推荐内容容器后，第 8 层出现 54 行。`[...3,6]` 至 `[...3,15]` 是连续 10 张推荐卡；每张卡的聚合 label 已包含标题、作者、时间、播放量、评论量、时长以及“不感兴趣”“稍后再看”等操作文本。后续同层还包含直播卡、占位节点、空白文本和未 materialize 的卡片外壳。

对这个宽父节点请求半开区间 `[...3,6] .. [...3,16)`，实际只返回这 10 个同父节点，`truncated=false`，没有夹带后代。

### 单张卡到精确操作节点

选择区间内一张普通推荐卡：

- 第 8 层卡片 DIV 已有 NodeRef，并有完整聚合 label；
- 第 9、10、11 层仍是重复 label 的 DIV 包装；
- 第 12 层第一次出现封面 `<A role=link>`，label 包含稍后再看、播放/评论和时长；
- 第 14 层出现 `<H3 role=heading>`，label 是干净标题；
- 第 15 层出现标题 `<A role=link>`，有 NodeRef，可作为精确导航操作目标。

因此，概览信息在第 8 层已经足够理解一张卡，但取得语义最精确的标题链接需要继续下钻到第 15 层。这个事实是以后设计“选择如何把完整信息编成树”的直接样本；当前实现没有擅自加入自动跳层或删除规则。

## 3. View 行为

实际验证：

- `maximumLevel=0` 在深层节点已经展开后仍只返回 doctype 和 HTML 两行；HTML 保持 `expanded=true`，请求没有折叠缓存。
- `range` 只返回同父半开区间，不包含后代。
- `subtree` 返回指定 canonical indexPath 自身以及已经展开的后代，不会让未展开节点自行展开。
- view 请求没有产生 ViewId，也没有改变任何展开状态。

## 4. 跨页面缓存

在 B 站已有 62 行可见结构、5 条已展开路径时，打开 ChatGPT 页面的独立操作树，再 reopen 未刷新的 B 站页面：

- `rootRef` 相同；
- `documentRef` 相同；
- `reused=true`；
- reopen 前后可见行数都为 62；
- 5 条已展开 canonical path 完全相同。

这验证了缓存绑定 live Document，而不是“当前标签页”或一次 get 视图。

## 5. 明确失败边界

同轮对已打开的 GitHub 首页调用 `page.tree.open`，返回：

```text
CAPABILITY_UNAVAILABLE
capabilityId=platform.extension.scripting
reason=CHROMIUM_API_FAILED
```

系统没有把失败页伪装成空树、没有刷新页面，也没有向其他标签页重试。该失败保留为真实 Chromium 边界样本，后续应单独复现原因，不影响本轮 B 站与 ChatGPT 的成功结果。

## 6. 当前结论

当前 operation tree 已证明：完整可观察信息、稳定 TreeRef/NodeRef、按 Key 展开缓存、level/range/subtree 一次性视图和跨页面恢复都能在真实个人浏览器工作。

尚未实现、也未在本轮暗中裁定的是选择算法。真实页面证据只确定了它必须面对的输入：扩展注入节点、属性先于 DOM 子节点、框架注释、重复包装、宽列表、聚合 label 中主信息与操作文本混合，以及“概览已足够但精确操作节点很深”的双重需求。

## 7. 原始样本

私密原始快照保存在：

```text
F:\code\浏览器自动化插件\browser-samples\2026-08-30T21-17-00-688Z-bilibili-home-operation-tree
|-- metadata.json
`-- operation-tree.json
```

- `operation-tree.json`：167,473 字节，SHA-256 `7258325b573c182d8038536169844310930fa9fff35e8dfd99dbdd40c5faf082`。
- `metadata.json`：1,090 字节，SHA-256 `fdbb837401488d4628caa8bb4c07a7d59cff418cfe560a6148b39f14b3ee3e09`。
- 完整 Browser Key 形状扫描结果为 0。
- 整体 expanded outline 保存 135 行并如实标记 `truncated=true`，截断点为 `[1,6,8,6,10]`，不得称为完整文档快照。
- 同一文件另存了独立 MAIN subtree，共 101 行，`truncated=false`；本报告使用的推荐区、单卡片和第 15 层标题链接都在这份完整子树中。

采集工具为 `tools/capture-live-page-tree.mjs`。它只读取现有展开状态，不自动 expand，不保存 Key，并在写文件前扫描完整 token 形状。

## 8. 后续空置测试

同一 Document 在普通后台空置后曾暴露出 TreeRef 路由仅保存在 worker 内存的问题：缓存和展开集合保留，但旧引用不能直接使用。真实复现、每一步所见、原始转录位置与 session 路由修复见[空置复现与修复](page-tree-idle-recovery.md)。修复通过独立 Chromium 强制回收测试；用户真实浏览器的新包复测状态以该记录为准。
