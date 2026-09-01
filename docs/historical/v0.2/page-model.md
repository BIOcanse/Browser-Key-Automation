# 历史：页面数据合同 v0.2（已撤下）

> 已撤下的清洗相关历史草稿，只供追溯，不是当前实施合同。PageIR/Snapshot/View、清洗算法和输出均等待用户后续说明。

版本：v0.2 / schema v1；2026-08-28。目标是让清洗资产不依赖浏览器运行时，同时保留操作所需证据。

## 1. 三层数据，不混用

| 层 | 生产者 | 内容与用途 |
|---|---|---|
| `PageIR` | 扩展的固定 JS 采集器 | 已观察的 DOM、名称/状态、布局事实、引用和来源；不是原始 HTML，也不是浏览器内部完整无障碍树 |
| `Snapshot` | Zig page_model + cleaner | 语义区域、记录/控件关系、压缩单元、证据索引、coverage、可操作引用 |
| `View` | Zig renderer | 面向 Agent 的 JSON/文本/Markdown；按预算选择内容，并指明省略及展开入口 |

`page.raw` 与 `resource.get` 是独立原始材料接口，不从 View 反向拼出“原始网页”。清洗器也不请求补抓页面；Agent 显式调用新读取时，扩展编排层才安排 JS 采集。

## 2. 责任边界

JS 必须处理只有浏览器活 DOM 才能正确获取的内容：文档/frame 身份，节点引用，实时 value/checked/selected/disabled，标签/ARIA命名依据，可见性与必要几何，以及 Shadow DOM/slot/frame 边界。名称算法采用明确版本的 DOM 实现；不宣称与 Chrome 内部无障碍树完全等价。

Zig 负责：校验 PageIR，连接关系，形成区域/表格/记录，识别重复与噪声，计算任务相关性和预算，渲染、检索、展开、差量。文章密度、导航去重等策略不放回 JS 重复实现。

采集器可以跳过 script/style 的正文或纯注释等明确非目标载荷，并记录跳过类型；这不代表它负责最终内容取舍。原始材料必须经 raw/GET 单独读取。

## 3. PageIR 字段

所有数组都扁平存储，用索引/ID 表达关系；不把 DOM 对象、Zig 指针或循环 JSON 发过边界。

| 对象 | 必要字段/语义 |
|---|---|
| 顶层 | schemaVersion、captureId、target、collectorVersion、capture窗口、frames、nodes、relations、coverage；可选有界metadata只存带来源的页面声明（如JSON-LD），不执行代码 |
| target | browserId、profileId、context、tabId、connectionEpoch；都由可信连接/浏览器来源补充 |
| frame | frameId、documentId、parentFrameId、实际origin/URL、title/lang、refEpoch、revisionStart/End、status；title/lang是页面数据，拒绝访问的frame只给允许公开的缺口信息 |
| node | nodeId、frameId、documentId、parentId、order、kind/tag、ref（可选）、directText（仅文本节点）、name/role、state、structure、links、source |
| name/role | value、依据（label/aria/HTML/文本推导）、evidenceNodeIds、算法版本；网页声明与算法推导分开 |
| state | value、checked、selected、expanded、disabled、required、invalid、readonly、focus等；不存在/未知不能强填false |
| structure | headingLevel、inputType、list标号/起点、whiteSpace模式，以及下述HTML/ARIA表格事实；不是无界属性转储 |
| structure.table | HTML的rowSpan/colSpan、scope、headerNodeIds、section（thead/tbody/tfoot）；可选物理domRowIndex/domCellIndex为0基。保留rowSpan=0的组内余行语义，不默认当1 |
| structure.aria | rowIndex/colIndex/rowSpan/colSpan/rowCount/colCount、posInSet/setSize；ARIA声明索引为1基，声明总数-1表示未知；缺失不推断为已观察数量 |
| visibility | rendered、inViewport、ariaHidden、occlusion；分别表达，未知遮挡不伪装成可点击 |
| links | href/src等已观察目标，保留原字符串及可解析的规范值；网页提供的URL不是已获抓取授权 |
| source | 已观察事实的来源节点/属性/文本区间；推断结果另带 evidence 和 derivation |
| relation | kind、fromId、toId、origin=observed/derived、evidence；用于标签、描述、错误、表头、所属记录等 |
| coverage | scannedNodes、limitsHit、omittedKinds、missingFrames、virtualized、consistency、warnings |

`nodeId` 是单次 PageIR 内的索引身份；`ref` 才用于后续操作，且必须绑定 documentId/refEpoch。`order` 保存阅读顺序，不能用对象键排列偶然决定输出。

文本采用一种规范编码：**每段DOM文本必须是独立、有序的 `kind=text` 节点，只有它可以携带 directText；element不再携带聚合文本**。例如 `<p>甲<a>乙</a>丙</p>` 编码为 p 的“甲”文本、a及其“乙”文本、p的“丙”文本，保留交错顺序。element的name/description是派生字段，不参与原文二次拼接；Zig合并文本时保留空白模式与来源区间。

HTML表格事实与ARIA声明分开保存；Zig据此展开跨行/列关系、映射表头并识别缺口。声明总数仅是网页自报，不能覆盖实采行数；非法/矛盾声明记录warning。缺字段、无权限与值确为0/-1需能区分，不能靠source中只有一个属性名代替其实际值。[HTML表格模型](https://html.spec.whatwg.org/multipage/tables.html#table-model)、[ARIA行数](https://www.w3.org/TR/wai-aria-1.2/#aria-rowcount)

几何字段按 CSS 像素定义，明确对应 frame 的 viewport；跨 frame 组合时不能直接把各 frame 坐标当同一坐标系。首版结构化 DOM 操作优先使用 ref，不依赖坐标推算。

## 4. 最小示例

以下为只有一个按钮及其有序文本节点的 PageIR 示例；文本节点没有操作 ref。

```json
{
  "schemaVersion": 1,
  "captureId": "cap-31",
  "collectorVersion": "dom-ir-1",
  "target": {
    "browserId": "browser-1",
    "profileId": "profile-1",
    "context": "regular",
    "tabId": 42,
    "connectionEpoch": "conn-c7"
  },
  "capture": {"startedAt": "2026-08-28T12:00:00Z", "durationMs": 12},
  "frames": [{
    "frameId": 0,
    "documentId": "doc-a",
    "parentFrameId": null,
    "origin": "https://shop.example",
    "url": "https://shop.example/orders",
    "title": "订单管理",
    "lang": "zh-CN",
    "refEpoch": "refs-b2",
    "revisionStart": "18",
    "revisionEnd": "18",
    "status": "captured"
  }],
  "nodes": [{
    "nodeId": 1,
    "frameId": 0,
    "documentId": "doc-a",
    "parentId": null,
    "order": 0,
    "kind": "element",
    "tag": "button",
    "ref": "ref-buy-7",
    "name": {"value": "支付", "basis": "contents", "evidenceNodeIds": [2], "algorithm": "dom-name-1"},
    "role": {"value": "button", "basis": "html"},
    "state": {"disabled": false},
    "visibility": {"rendered": true, "inViewport": true, "ariaHidden": false, "occlusion": "unknown"},
    "links": [],
    "source": {"kind": "dom", "fields": ["tagName", "disabled"]}
  }, {
    "nodeId": 2,
    "frameId": 0,
    "documentId": "doc-a",
    "parentId": 1,
    "order": 1,
    "kind": "text",
    "directText": "支付",
    "source": {"kind": "dom-text", "fields": ["data"]}
  }],
  "relations": [],
  "coverage": {
    "scannedNodes": 2,
    "limitsHit": [],
    "omittedKinds": [],
    "missingFrames": [],
    "virtualized": "unknown",
    "consistency": "best_effort",
    "warnings": []
  }
}
```

没有观察到变化也不等于跨 frame 原子快照；revision 是采集器版本，不是网页业务数据库版本。采样过程中发生变化时记录 start/end 和受影响范围，可按配置有界重采样；不能无限追求“页面完全静止”。

## 5. Snapshot、折叠与输出

- Snapshot 标识包含 snapshotId、captureId、ownerKeyId（内部）、schema/collector/cleaner/profile版本、policyVersion、目标与创建/到期时间。
- `regions` 保存区域类型、标题、阅读顺序、成员和子区域；`units` 保存不可随意拆开的信息包及依赖；`nodes/relations` 保留必要证据索引。
- `actionableRefs` 保存 ref 与动作种类、名称、状态、记录上下文、guard 指纹；它们来自实际节点，不因为模型猜测“应该有按钮”而生成。
- `omissions` 区分“已采集但未展示”和“未采集/不可访问”。前者可 `page.expand`，后者只能显式新采集或返回能力限制，不能给虚假可展开 ref。
- View 带 snapshotId、目标、coverage 摘要、正文、ref、省略目录与 token统计；`format=agent_text` 适合 Agent，JSON 用于结构消费，Markdown 用于阅读。所有格式共享同一语义结果。
- `page.search` 只检索指定快照内保留的已采集内容；`page.expand` 只重新选择/渲染该快照；都不暗中刷新网页。
- 敏感字段的具体接口脱敏策略在建立可返回的快照前应用；原始内部采集数据只短期存在，不因某个 snapshot 权限自动变成可下载 raw artifact。

## 6. ref、revision 与失效

- JS 使用 WeakMap 关联节点与 opaque ref，另有有界活引用索引用于查找；不向 DOM 插入 `data-agent-id`，不使用可被页面覆写的属性保存管理身份。
- 扩展侧快照所有权 + browser/profile/context + documentId + refEpoch 一起约束 ref；epoch指采集/执行器代次，不是Agent传输连接。换Agent连接不换Key主体；导航、内容脚本重建或执行器代次变化后旧操作拒绝，不猜测对应的新节点。
- `expectedRevision` 是调用者可选的严格页面版本检查；默认动作至少检查节点仍连接、实际文档一致以及名称/role/链接/相关记录上下文指纹。
- 虚拟列表复用同一 DOM 节点但换成另一条记录时，指纹变化使旧 ref 失效。没有可靠业务键时采取保守重新定位，不宣称能从任意页面推断恒定业务身份。
- guard 在动作前通过活 DOM 重新采集相关证据；状态检查与动作尽量在同一个内容脚本同步片段中完成。仍不承诺控制网页后续事件处理或业务副作用。
- 旧快照可在 TTL 内阅读，但 `live=false`、失效原因可见。diff 不证明旧 ref 可用；不能靠内容相似度把新节点绑定为旧引用。

## 7. 编码、验证与版本

- 字符串使用 UTF-8；JS 的不成对 surrogate 必须采用确定替换并记录规范化，不能产生非法 JSON。需要精确原始字节的文件走 artifact，不冒充字符串无损往返。
- tabId/frameId/nodeId/order 使用有界 JSON 整数；epoch/opaque ID 用字符串。policyVersion、revision、fence、事件序号等可能超过 JS 安全整数的计数器用十进制字符串。
- 数值不接受 NaN/Infinity；所有节点/关系/文本/深度有上限。父子关系不得成环；关系图允许合法多对多，但遍历必须去重。
- 先验证唯一 ID、父节点归属、frame/document 匹配、关系端点、来源范围与长度，再计算。跨 frame 关系需明确类型，不能偷偷当同一 DOM 的父子节点。
- 截断采集仍必须产生自洽 PageIR：缺失端点记在 coverage，不把半条关系当完整事实。非法结构返回 `INVALID_PAGE_MODEL`，不是空页面成功。
- 测试包含 JS→JSON→Zig→JSON 的样例往返、混排文本/空白、rowSpan/colSpan及ARIA声明索引、乱序字段、Unicode、极深/极宽数据、重复 ID、循环关系、未知枚举及超限输入；版本破坏性变化先更新 Schema，再更新两端与夹具。
